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
import { approvalDenyReason, defaultApprovalPath, isJudgementPlaneEdit, readApproval } from './patch-approval.js'
import { checkDispatchRoute, resolveRoleModels, routeDenyReason } from './role-models.js'

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
