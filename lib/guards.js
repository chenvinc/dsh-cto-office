/**
 * pre-execute 守卫（方案 §4.2a A/F 层）。
 *
 * 两条规则：
 *  1. 写者名额：`subagent` 派写岗时，若名额被**别的卡**占用 → deny。
 *  2. 防篡改：`bash` 里出现 reset / rebase / amend / checkout -- 会洗掉提交边界 → deny。
 *
 * ── 两个必须处理的坑（真机反馈，2026-11-26）────────────────────────────
 *
 * 坑 1「开卡即自锁」：`office_dispatch` 会先占名额（卡 → DISPATCHED），紧接着的
 *   `subagent` 派工若只按「名额已满」判断，就会把**持锁的这张卡自己**拒掉 ——
 *   单卡永远开不了工。所以必须看派工 prompt 里的【任务卡 X】是不是持锁那张。
 *
 * 坑 2「省略 preset 即绕过」：宿主 `subagent` 的默认 preset 就是 `cto-builder`，
 *   调用方不写 `agent_preset` 时默认派的就是写岗。若守卫只看「声明的 preset」，
 *   省略一个参数就能同时绕过名额守卫与回执守卫。所以：**没声明就按默认写岗处理**（fail-closed）。
 */
import { cardIdFromPrompt } from './receipt.js'
import { approvalDenyReason, approvalPathFor, defaultApprovalPath, isJudgementPlaneEdit, readApproval } from './patch-approval.js'
import { planApprovalCovers, readPlanApproval } from './plan-approval.js'
import { checkDispatchRoute, resolveRoleModels, routeDenyReason } from './role-models.js'
import { CdStore, MAX_REVIEW_ROUNDS, cdActionAllowed } from './cd.js'

const DESTRUCTIVE_GIT = [
  /\bgit\s+reset\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+commit\b[^\n]*--amend\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+restore\s+(?!.*--staged)/,
  /\bgit\s+clean\s+-[a-z]*f/,
]

/** 派工目标的 preset：声明值优先；**未声明时按宿主默认写岗处理**（见坑 2）。 */
export function targetPreset(args, config = {}) {
  if (!args || typeof args !== 'object') return undefined
  const declared = args.agent_preset ?? args.agentPreset ?? args.preset
  if (typeof declared === 'string' && declared) return declared
  return config.defaultAgentPreset
}

export function isDestructiveGit(command) {
  if (typeof command !== 'string') return false
  return DESTRUCTIVE_GIT.some(re => re.test(command))
}

const PLAN_REASON_TEXT = {
  'no-approval': '还没有拍板审批文件',
  'unreadable-approval': '审批文件读不出来（JSON 损坏）',
  'bad-approval-schema': '审批文件 schema 不对',
  'bad-approval-ttl': '审批文件缺少有效期',
  'approval-expired': '拍板审批已过期',
  'card-unknown': '无法从这次调用里识别任务卡号',
  'out-of-scope': '这次拍板没有覆盖这张卡',
}

/**
 * R6 的可读拒绝原因。
 *
 * 关键要求（2026-11-28 issue P1）：失败时**模型必须能看到可执行的原因**，
 * 而不是 `the user rejected tool "subagent"`。所以这里给出：
 *   ① 为什么被拦（reason code 的人话）；② 首选自助修复路径（office_plan_approve 工具）；
 *   ③ 人在终端时的兜底路径（approve-phase.mjs）；④ 审批文件的真实位置。
 */
export function planDenyReason({ cardId, covered, approval, planPath, planTtlMs, ttlMs }) {
  const why = PLAN_REASON_TEXT[covered?.reason] ?? PLAN_REASON_TEXT['no-approval']
  const card = cardId ? `【任务卡 ${cardId}】` : '（未能识别卡号）'
  const ttlMinutes = Math.round((planTtlMs ?? ttlMs ?? 30 * 60 * 1000) / 60000)
  const lines = [
    `GATE: 拍板未通过 —— ${why}（${card}）。这不是用户拒绝，是缺一份有效的拍板审批凭据。`,
    '',
    '首选修复：直接调用 `office_plan_approve`（它会弹一次真实的人工确认，用户点「批准」后由 Host 写凭据）：',
    `  office_plan_approve workspace="<绝对路径>" cardIds=["${cardId ?? '<卡号>'}"] summary="<方案与关键取舍>"`,
    `  审批有效期默认 ${ttlMinutes} 分钟。`,
    '',
    '兜底（工具不可用、或用户想在自己的终端确认时）：',
    `  node scripts/approve-phase.mjs --kind plan --card ${cardId ?? '<卡号>'} --reason "已拍板"`,
    '',
    `审批文件：${planPath}（工作区之外，agent 沙箱写不到，这是有意的）。`,
  ]
  if (covered?.reason === 'approval-expired') {
    lines.push(`上次批准在 ${new Date(approval.expiresAt).toLocaleString()} 过期；重新拍板即可。`)
  }
  if (covered?.reason === 'out-of-scope') {
    lines.push(`已批准的卡：${(covered.approvedCards ?? []).join(', ')}；要派新卡需要重新拍板并把它列进 cardIds。`)
  }
  if (covered?.reason === 'card-unknown') {
    lines.push('派 `subagent` 时 prompt 里必须写 `【任务卡 <id>】`；`office_dispatch` 必须传 cardId。')
  }
  return lines.join('\n')
}

/**
 * @returns (exec, next) => Promise<PreToolDecision>
 */
export function makePreExecuteGuard({ registry, store, config }) {
  const writerPresets = new Set(config.writerPresets ?? ['cto-builder'])
  const patchApproval = config.patchApproval ?? {}
  // 岗位→模型表（M-7 可落地部分）：默认按表校验，漏传/传错都拒。
  const roleModelTable = resolveRoleModels(config.roleModels).table
  const enforceRoleModels = config.enforceRoleModels !== false
  const approvalPath = patchApproval.path ?? defaultApprovalPath()
  const approvalTtlMs = patchApproval.ttlMs ?? undefined
  const maxWriters = config.maxConcurrentWriters ?? 1
  const defaultPreset = config.defaultAgentPreset ?? 'cto-builder'
  // 二期：拍板关口与 CD 不可逆动作各用一份审批文件（工作区之外，agent 沙箱写不到）。
  const planApproval = config.planApproval ?? {}
  const cdApproval = config.cdApproval ?? {}
  const planPath = planApproval.path ?? approvalPathFor('plan')
  const cdPath = cdApproval.path ?? approvalPathFor('cd')
  const planTtlMs = planApproval.ttlMs ?? 30 * 60 * 1000
  const cdTtlMs = cdApproval.ttlMs ?? 30 * 60 * 1000
  const maxReviewRounds = config.cd?.maxReviewRounds ?? MAX_REVIEW_ROUNDS

  const allCards = () => (registry?.all ? registry.all() : [store]).flatMap(s => s.list().cards)
  const isActiveWriter = card => card.state === 'DISPATCHED' || card.state === 'CHANGES'

  return async (exec, next) => {
    try {
      // ── M-14 第一处：改判定器本身（cordis.patch.yml / preset 配置）需人工确认 ──
      // 守卫只能看「工具想改什么」，看不到「人有没有点过确认」，所以真正的边界在
      // 审批文件的**位置**（工作区之外，agent 沙箱写不到），见 lib/patch-approval.js。
      if (isJudgementPlaneEdit(exec?.name, exec?.arguments)) {
        const approval = readApproval({ path: approvalPath, now: Date.now() })
        if (!approval.approved) {
          return { kind: 'deny', reason: approvalDenyReason({ path: approvalPath, ttlMs: approvalTtlMs }) }
        }
      }

      if (exec?.name === 'subagent') {
        const preset = targetPreset(exec.arguments, { defaultAgentPreset: defaultPreset })

        // 岗位路由校验：模型按岗位定了，就不许悄悄继承父 Agent 的路由。
        // 放在名额检查之前 —— 路由错了的话，纠错成本比名额问题更低。
        if (enforceRoleModels && preset) {
          const check = checkDispatchRoute(roleModelTable, preset, exec.arguments)
          if (check.expected && !check.ok) {
            return { kind: 'deny', reason: routeDenyReason(roleModelTable, preset, check) }
          }
        }
        if (preset && writerPresets.has(preset)) {
          const prompt = exec.arguments?.prompt ?? exec.arguments?.message ?? ''
          const cardId = cardIdFromPrompt(prompt)
          const cards = allCards()
          const active = cards.filter(isActiveWriter)
          const named = cardId ? cards.find(c => c.cardId === cardId) : null

          // 坑 1：派工的就是持锁那张卡 → 放行
          //
          // 与 R6 的关系（2026-11-28 明确，别改错）：拍板是在**卡启动**时机的
          // `office_dispatch` 上校验的；卡一旦 DISPATCHED，后续 `subagent` 派工
          // 走这里早返回，不再重复要凭据 —— 否则 TTL 30 分钟内做不完的卡会在返工时
          // 被无故拦住。直接 `subagent` 派工（prompt 里的卡不在板上）仍会落到 R6。
          if (named && isActiveWriter(named)) return next()

          if (named && named.state === 'QUEUED') {
            return {
              kind: 'deny',
              reason: `卡 ${cardId} 还在 QUEUED（名额被 ${named.blockedBy?.cardId ?? '别的卡'} 占着）。`
                + ` 先办公 first 用 office_dispatch cardId=${cardId} 启动它，再派工。`,
            }
          }

          if (active.length >= maxWriters) {
            const holders = active.map(c => c.cardId).join(', ')
            const hint = cardId
              ? `派工 prompt 里写的是【任务卡 ${cardId}】，但持锁的是 ${holders}。`
              : `派工 prompt 里没有【任务卡 X】标记，无法判断这次派工属于哪张卡。`
            return {
              kind: 'deny',
              reason: `写者名额已满（maxConcurrentWriters=${maxWriters}，持锁：${holders}）。${hint}`
                + ` 请在 prompt 里写【任务卡 ${holders}】以证明是同一次派工，或先 office_release 释放。`,
            }
          }
        }
      }

      // ── R5 方案卡形态（铁律 8）────────────────────────────────────────
      if (exec?.name === 'office_dispatch' && exec.arguments?.role === 'plan') {
        const preset = exec.arguments?.preset ?? defaultPreset
        if (exec.arguments?.mode !== 'ro' || preset !== 'cto-architect') {
          return {
            kind: 'deny',
            reason: `方案卡必须是 mode=ro + preset=cto-architect（铁律 8：两份方案必须来自不同路由）。`
              + ` 实际 mode=${exec.arguments?.mode ?? '(空)'} preset=${preset}。`,
          }
        }
      }

      // ── R6 拍板关口（章程 §八 / 铁律 10）──────────────────────────────
      // 默认关闭，由 profile 的 planApproval.enabled 显式开启。
      //
      // 2026-11-28 修复（P0 issue）：原来是 `kind: 'ask'`，把人工确认委托给 DSH 的
      // 审批瀑布；而 DSH 在 ask 策略下只把 outcome 给模型（`the user rejected tool`），
      // 插件写的原因被吞掉，于是「用户刚在聊天里拍板」变成「用户拒绝了 subagent」。
      // 现在改为：人工确认在 `office_plan_approve` 工具里做（它内部弹 plan-review 问句，
      // 拿到真实批准后由 Host 写审批文件）；R6 只做机检，失败用 `deny` 把**可读原因**
      // 直接作为工具错误返回，模型能自助修复。
      if (planApproval.enabled === true) {
        const dispatchTarget = (() => {
          if (exec?.name === 'office_dispatch') {
            const a = exec.arguments ?? {}
            return { cardId: typeof a.cardId === 'string' ? a.cardId : null, fromArgs: a }
          }
          if (exec?.name === 'subagent') {
            const prompt = exec.arguments?.prompt ?? exec.arguments?.message ?? ''
            return { cardId: cardIdFromPrompt(prompt) ?? null, fromArgs: null }
          }
          return null
        })()

        if (dispatchTarget) {
          const { cardId, fromArgs } = dispatchTarget
          const named = cardId ? allCards().find(card => card.cardId === cardId) : null

          // 实现卡判定：优先用卡的元数据（role / mode），拿不到卡再退回 preset。
          // 见 P3：只看 preset 时，换写岗或绕过 preset 都能削掉这道门。
          const isImplCard = (() => {
            if (named) return (named.role ?? 'impl') !== 'plan' && named.authorization?.mode !== 'ro'
            if (fromArgs) return fromArgs.role !== 'plan' && fromArgs.mode !== 'ro'
            const preset = targetPreset(exec.arguments, { defaultAgentPreset: defaultPreset })
            return writerPresets.has(preset)
          })()

          if (isImplCard) {
            const approval = readPlanApproval({ path: planPath, now: Date.now() })
            const covered = planApprovalCovers(approval, cardId)
            if (!covered.covers) {
              return {
                kind: 'deny',
                reason: planDenyReason({
                  cardId, covered, approval, planPath, planTtlMs,
                }),
              }
            }
          }
        }
      }

      // ── R7 / R8 / R9 office_cd ───────────────────────────────────────
      if (exec?.name === 'office_cd') {
        const a = exec.arguments ?? {}
        if (a.workspace && a.runId) {
          const cdStore = new CdStore(a.workspace)
          let cdRecord
          try { cdRecord = cdStore.read(a.runId) } catch (error) {
            return { kind: 'deny', reason: `CD record 损坏，拒绝推进：${error.message}` }
          }
          if (a.action !== 'begin' && !cdRecord) {
            return { kind: 'deny', reason: `CD run ${a.runId} 不存在，先 office_cd action=begin。` }
          }
          if (!cdActionAllowed(a.action, cdRecord?.state ?? null)) {
            return {
              kind: 'deny',
              reason: `当前在 ${cdRecord?.state ?? '无 CD record'} 阶段，action=${a.action} 不允许（铁律 9：CD 不许跳步）。`,
            }
          }
          // R8：审查轮次封顶
          if (a.action === 'review' && cdRecord && cdRecord.round >= maxReviewRounds) {
            return {
              kind: 'deny',
              reason: `审查最多 ${maxReviewRounds} 轮，第 ${maxReviewRounds + 1} 次直接 deny 且不再派回，转人决策（章程 §九）。`,
            }
          }
          // R9：不可逆动作（策略 A，人工确认）
          if (a.action === 'merge' || a.action === 'release') {
            const approval = readApproval({ path: cdPath, now: Date.now() })
            if (!approval.approved) {
              return {
                kind: 'deny',
                reason: `${a.action} 是不可逆动作，策略 A 要求人工确认（铁律 6 / 设计稿 §4.6）。`
                  + `\n请让用户在自己的终端执行：\n  node scripts/approve-phase.mjs --kind cd --reason "允许 ${a.action}"\n`
                  + `审批文件：${cdPath}（工作区之外，agent 写不到）。`
                  + `\nTTL ${Math.round(cdTtlMs / 60000)} 分钟，一次一问；完全自动本次未实施。`,
              }
            }
          }
        }
      }

      if (exec?.name === 'bash' || exec?.name === 'pwsh') {
        const command = exec?.arguments?.command
        if (isDestructiveGit(command)) {
          return {
            kind: 'deny',
            reason: '该命令会破坏提交边界（reset / rebase / amend / checkout -- 会把越界改动从 baseSha..HEAD 区间里洗掉）。'
              + ' 请用一次新提交来修正，而不是改写历史。',
          }
        }
      }
    } catch {
      // 守卫失败即放行：判定层不能把会话卡死
    }
    return next()
  }
}
