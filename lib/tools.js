/**
 * W1 三个工具：office_dispatch / office_gate / office_release。
 *
 * 注意：这里不用 `defineTool`——它来自 @deepseek-ai/dsh-tools，而在本机插件目录下
 * 该包会解析到 npx 缓存的 rc.1 旧副本（宿主 rc.5）。注册表接受原生 ToolDefinition，
 * 所以直接给字面量对象，零 @deepseek-ai 依赖。
 */
import { collectFacts, headSha, isClean, isRepository } from './git.js'
import { normalizePath } from './glob.js'
import { ArtifactStore, ARTIFACT_KINDS } from './artifacts.js'
import { validateReceipt, cardIdFromPrompt } from './receipt.js'
import { assertRequired, coerceArgs, toStandardSchema } from './args.js'
import { DEFAULT_EXCLUSIVE_TTL_MS, GRANULARITY, STATES, crossCheckReceipt, exclusivesConflict, isTerminal, judge } from './card.js'
import { CdStore, CD_ACTIONS, CD_STATES, cdActionAllowed, cdLine, checksStateToState, isCdTerminal, makeCdRecord, reviewVerdictToState, transitionCd } from './cd.js'
import { classifyGhFailure, nextCommand, parseChecks, parsePrView } from './cd-gh.js'
import { SOURCES } from './evidence.js'
import { INTENT_STATE } from './intent.js'
import { computeMetrics, makeEarlyDecision, resolveMetricsConfig, summarizeMetrics } from './metrics.js'
import { buildDashboard } from './dashboard.js'
import { describeRoute, resolveRoleModels, routeForPreset } from './role-models.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const text = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/**
 * 工作区解析：显式参数 > 配置 > **拒绝猜测**。
 *
 * 不回落 `process.cwd()`：宿主进程的 cwd 是 DSH 安装目录，不是用户的工作区。
 * 猜错的后果是「在 app 目录里建 .cto-office、对着 app 目录跑 git 判定」——
 * 比报错危险得多。宁可让调用方显式传绝对路径。
 */
function resolveWorkspace(args, config) {
  const fromArgs = args && typeof args.workspace === 'string' && args.workspace ? args.workspace : null
  const fromConfig = typeof config.workspaceRoot === 'string' && config.workspaceRoot ? config.workspaceRoot : null
  const resolved = fromArgs || fromConfig
  if (!resolved) {
    throw new Error(
      '必须指定工作区：请传 workspace 参数（绝对路径），或在插件配置里设 workspaceRoot。'
      + ' 不回落进程 cwd —— 宿主进程的 cwd 是 DSH 安装目录，在那里判定会得出毫无意义的结论。',
    )
  }
  return resolved
}

const WORKSPACE_PARAM = {
  workspace: {
    type: 'string',
    required: true,
    description: 'Absolute path to the git workspace. Required: the host process cwd is the DSH install dir, so it is never guessed.',
  },
}

/**
 * 输出对象的 JSON Schema。
 *
 * 注意方言：DSH 的 *输出* schema 走标准 JSON Schema —— `required` 必须是**对象上的
 * 字符串数组**；写成 `properties.x.required: true`（参数 schema 的写法）会被宿主拒绝：
 *   JsonSchemaError: schema.properties.cardId.required is not supported on type "string"
 * 这条是真机安装时才暴露的，见 docs/W0-实测清单.md。
 */
const jsonSchemaOf = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required && required.length ? { required } : {}),
})

/**
 * @param ctx cordis context
 * @param opts { store, config }
 */
/**
 * 把「紧凑参数声明」包成宿主能校验的标准 JSON Schema，并在 execute 前做强校验。
 * 见 lib/args.js 与 docs/W0-实测清单.md 的「发现 3」。
 */
function wrap(tool, spec) {
  return {
    ...tool,
    parameters: toStandardSchema(spec),
    async execute(rawArgs, exec) {
      assertRequired(tool.name, spec, rawArgs ?? {})
      const { args, corrections } = coerceArgs(tool.name, spec, rawArgs ?? {})
      const result = await tool.execute(args, exec)
      if (corrections.length && result && typeof result === 'object') {
        result.message = `${result.message ?? ''}\n（参数已归一：${corrections.join('；')}）`
      }
      return result
    },
  }
}

export function buildTools(ctx, { registry, config }) {
  const maxWriters = () => config.granularity?.maxConcurrentWriters ?? config.maxConcurrentWriters ?? 1
  /** 每个工具先解析工作区，再取该工作区的仓库 —— 不共用全局 store。 */
  const openStore = args => registry.get(resolveWorkspace(args, config))

  const dispatch = {
    name: 'office_dispatch',
    description:
      'Create a work card: freeze the current HEAD as baseSha, record the write-authorization checklist, '
      + 'and take a writer slot (serial when maxConcurrentWriters=1). Returns DISPATCHED, or QUEUED with a '
      + 'blockedBy reason when a slot or an exclusive glob is already held. CTO only.',
    parameters: {
      ...WORKSPACE_PARAM,
      cardId: { type: 'string', required: true, description: 'Stable card id, e.g. "C1".' },
      subject: { type: 'string', required: false, description: 'One-line deliverable (new cards only).' },
      preset: { type: 'string', required: false, description: 'Worker preset to dispatch, e.g. cto-builder.' },
      role: { type: 'string', required: false, enum: ['plan', 'impl'], description: 'plan = 方案卡（章程 §八：必须 mode=ro + preset=cto-architect）；impl = 实现卡。省略按 impl 处理。' },
      mode: { type: 'string', required: false, enum: ['rw', 'ro'], description: 'rw = may write inside include; ro = read-only card (new cards only).' },
      include: { type: 'array', required: false, items: { type: 'string' }, description: 'Globs the card may write, e.g. "db/**".' },
      deny: { type: 'array', required: false, items: { type: 'string' }, description: 'Globs always forbidden inside include.' },
      exclusive: { type: 'array', required: false, items: { type: 'string' }, description: 'Globs that only one in-flight card may hold.' },
      acceptance: { type: 'array', required: false, items: { type: 'string' }, description: 'Testable acceptance lines; must be numbered. Also caps observable behaviors.' },
      declaredFiles: { type: 'integer', required: false, description: 'Declared changed-file count (advisory, used for planning).' },
      declaredLines: { type: 'integer', required: false, description: 'Declared net changed lines (advisory).' },
      sampleTag: { type: 'string', required: false, enum: ['real', 'injected'], description: 'Sample tag for metrics isolation (M-8). injected cards never mix with real statistics.' },
    },
    output: {
      schema: jsonSchemaOf({
        cardId: { type: 'string' },
        state: { type: 'string' },
        baseSha: { type: 'string' },
        blockedBy: { type: 'object', additionalProperties: true, properties: {} },
        message: { type: 'string' },
      }, ['cardId', 'state', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      const store = registry.get(cwd)
      const artifacts = new ArtifactStore(store)
      if (!(await isRepository(cwd))) throw new Error(`not a git repository: ${cwd}`)
      if (!(await isClean(cwd))) {
        throw new Error('working tree must be clean before dispatch (only .cto-office/ may be dirty); commit or stash first')
      }

      const head = await headSha(cwd)
      if (!head) throw new Error('repository has no commits yet; cannot freeze baseSha')

      const ttlMs = config.exclusiveTtlMs ?? DEFAULT_EXCLUSIVE_TTL_MS

      /**
       * 互斥冲突 + 锁 TTL 审计（M-14 第三处）。**两处入口共用**（新建卡 / 启动排队卡），
       * 否则新旧两套逻辑会漂移 —— 这正是本轮修掉的现场：startIfPossible 里还留着
       * 不看 TTL 的旧判定，导致「审计说已忽略，却仍然排队」。
       */
      const exclusiveConflictFor = (card, nowMs = Date.now()) => {
        const expiredAudit = []
        for (const expired of store.expiredExclusiveHolders(nowMs, ttlMs)) {
          if (expired.cardId === card.cardId) continue
          if ((expired.history ?? []).some(h => h.event === 'exclusive-expired')) continue
          // 审计走 appendHistory：用 save() 会推进 updatedAt，等于顺手把锁续上。
          store.appendHistory(expired.cardId, {
            at: nowMs,
            event: 'exclusive-expired',
            ttlMs,
            note: '锁 TTL 到期：占用不再阻塞其他卡（该卡 authorization 不变，判定仍按原授权）',
          })
          expiredAudit.push(expired.cardId)
        }
        const conflict = store.liveExclusiveHolders(nowMs, ttlMs)
          .filter(other => other.cardId !== card.cardId)
          .map(other => ({ other, conflict: exclusivesConflict(card, other) }))
          .find(hit => hit.conflict)
        return { conflict, expiredAudit }
      }

      const ttlNote = cardIds => (cardIds.length
        ? `\n\n（锁 TTL：${cardIds.join(', ')} 的互斥占用已过期并被忽略，已记审计。如那是活卡，让它先有活动或作废重开。）`
        : '')

      const roleModelTable = config.roleModelTable ?? resolveRoleModels(config.roleModels).table
      /** 派工路由提示：把该岗位应传的三个参数写进响应，CTO 不用再猜。 */
      const routeHint = card => {
        const preset = card.preset ?? config.defaultAgentPreset
        const route = routeForPreset(roleModelTable, preset)
        return route ? `\n\n派工路由（按岗位表，pre-execute 会校验）：${preset} → ${describeRoute(route)}` : ''
      }

      const startIfPossible = (card, headShaNow) => {
        const activeNow = store.activeWriters().filter(other => other.cardId !== card.cardId)
        if (activeNow.length >= maxWriters()) {
          card.blockedBy = { cardId: activeNow[0].cardId, reason: 'serial-limit' }
          card.history.push({ at: Date.now(), event: 'still-queued', reason: 'serial-limit', holder: activeNow[0].cardId })
          store.save(card)
          return {
            cardId: card.cardId, state: card.state, baseSha: card.baseSha,
            blockedBy: card.blockedBy,
            message: `卡 ${card.cardId} 仍在 QUEUED：写者名额被 ${activeNow[0].cardId} 占用（maxConcurrentWriters=${maxWriters()}）。` + routeHint(card),
          }
        }
        const { conflict: conflictNow, expiredAudit: expiredNow } = exclusiveConflictFor(card)
        if (conflictNow) {
          card.blockedBy = { cardId: conflictNow.other.cardId, reason: 'exclusive-held', glob: conflictNow.conflict.globA }
          card.history.push({ at: Date.now(), event: 'still-queued', reason: 'exclusive-held', holder: conflictNow.other.cardId })
          store.save(card)
          return {
            cardId: card.cardId, state: card.state, baseSha: card.baseSha,
            blockedBy: card.blockedBy,
            message: `卡 ${card.cardId} 仍在 QUEUED：互斥 glob ${conflictNow.conflict.globA} 被 ${conflictNow.other.cardId} 持有。` + ttlNote(expiredNow) + routeHint(card),
          }
        }
        // 名额空出 → 冻结 baseSha 并启动
        card.baseSha = headShaNow
        card.blockedBy = null
        store.transition(card, STATES.DISPATCHED, { baseSha: headShaNow })
        store.save(card)
        return {
          cardId: card.cardId, state: card.state, baseSha: card.baseSha,
          message: `卡 ${card.cardId} 已启动：baseSha=${headShaNow.slice(0, 8)}（此刻冻结，不含此前已合并的他人改动）。`
            + ` 授权 ${card.authorization.mode} ${JSON.stringify(card.authorization.include)}。` + routeHint(card),
        }
      }


      // 已建但仍在排队的卡：同 id 再调一次 = 启动它，此刻才冻结 baseSha。
      const existing = store.read(args.cardId)
      if (existing) {
        if (existing.state !== STATES.QUEUED) {
          throw new Error(`card ${args.cardId} already exists in state ${existing.state}`)
        }
        const started = startIfPossible(existing, head)
        return started
      }

      // 工件先于卡存在：验收基线是判定的对照物，没有它闸门无从判起。
      const versions = artifacts.versions(args.cardId)
      if (versions.acceptance === 0 && (args.acceptance ?? []).length > 0) {
        throw new Error(
          `派工前必须先用 office_artifact 写入验收基线（acceptance），否则 QA 没有对照物。`
          + ` 当前 contracts=${versions.contracts}, acceptance=${versions.acceptance}。`,
        )
      }

      if (!args.subject || !args.mode) {
        throw new Error('建新卡必须给 subject 与 mode（只启动已存在的 QUEUED 卡时才可以省略）')
      }

      const { makeCard } = await import('./card.js')
      const card = makeCard({
        cardId: args.cardId,
        subject: args.subject,
        preset: args.preset,
        authorization: { mode: args.mode, include: args.include ?? [], deny: args.deny ?? [], exclusive: args.exclusive ?? [] },
        baseSha: null,
        acceptance: args.acceptance ?? [],
        declared: { files: args.declaredFiles, lines: args.declaredLines, behaviors: (args.acceptance ?? []).length || null },
        sampleTag: args.sampleTag ?? null,
      })
      card.role = args.role ?? 'impl'
      card.artifactsVersion = Object.fromEntries(Object.entries(versions).filter(([, v]) => v > 0))

      // 1) 串行名额
      const active = store.activeWriters()
      if (active.length >= maxWriters()) {
        card.blockedBy = { cardId: active[0].cardId, reason: 'serial-limit' }
        card.history.push({ at: Date.now(), event: 'queued', reason: 'serial-limit', holder: active[0].cardId })
        store.save(card)
        return {
          cardId: card.cardId, state: card.state, baseSha: card.baseSha,
          blockedBy: card.blockedBy,
          message: `卡 ${card.cardId} 已建，但处于 QUEUED：写者名额被 ${active[0].cardId} 占用（maxConcurrentWriters=${maxWriters()}）。等它结算或释放后再派工。`,
        }
      }

      // 2) 互斥组（M-14 第三处：锁 TTL —— 过期占用不再阻塞，但必须留审计）
      const { conflict, expiredAudit } = exclusiveConflictFor(card)
      if (conflict) {
        card.blockedBy = { cardId: conflict.other.cardId, reason: 'exclusive-held', glob: conflict.conflict.globA }
        card.history.push({ at: Date.now(), event: 'queued', reason: 'exclusive-held', holder: conflict.other.cardId })
        store.save(card)
        return {
          cardId: card.cardId, state: card.state, baseSha: card.baseSha,
          blockedBy: card.blockedBy,
          message: `卡 ${card.cardId} 已建，但处于 QUEUED：互斥 glob ${conflict.conflict.globA} 被 ${conflict.other.cardId} 持有。冲突已在开卡时暴露，不必等到合并。` + ttlNote(expiredAudit),
        }
      }

      const started = startIfPossible(card, head)
      if (expiredAudit.length > 0) started.message += ttlNote(expiredAudit)
      const limits = { ...GRANULARITY, ...(config.granularity ?? {}) }
      if ((args.acceptance ?? []).length > limits.maxBehaviors) {
        started.message += `\n\n⚠ 声明了 ${args.acceptance.length} 条验收条目 > 粒度上限 ${limits.maxBehaviors}（1 条可观测行为/卡）。`
          + ' 开卡时只记声明值，硬拦在 office_gate —— 但大概率会被打回，建议现在拆卡。'
      }
      return started
    },
  }

  const gate = {
    name: 'office_gate',
    description:
      'Judge one card against its authorization checklist using facts only: git diff baseSha..HEAD plus '
      + 'git status (catches untracked/deleted/renamed). Also enforces card granularity limits. '
      + 'Returns PASS or CHANGES with the offending paths.',
    parameters: {
      ...WORKSPACE_PARAM,
      cardId: { type: 'string', required: true, description: 'Card to judge.' },
    },
    output: {
      schema: jsonSchemaOf({
        cardId: { type: 'string' },
        verdict: { type: 'string', enum: ['PASS', 'CHANGES'] },
        violations: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        stats: { type: 'object', additionalProperties: true, properties: {} },
        message: { type: 'string' },
      }, ['cardId', 'verdict', 'violations', 'stats', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      const store = registry.get(cwd)
      const artifacts = new ArtifactStore(store)
      const card = store.read(args.cardId)
      if (!card) throw new Error(`card not found: ${args.cardId}`)
      if (card.state === STATES.SETTLED || card.state === STATES.ABANDONED) {
        throw new Error(`card ${card.cardId} is already terminal (${card.state})`)
      }
      if (!card.baseSha) {
        throw new Error(`card ${card.cardId} has no baseSha yet (still QUEUED). Call office_dispatch with the same cardId to start it first.`)
      }

      const artifactCheck = artifacts.verify(card)
      if (!artifactCheck.ok) {
        throw new Error(`工件不齐，无法判定：${artifactCheck.problems.join('；')}。先补 office_artifact 再判。`)
      }

      const limits = { ...GRANULARITY, ...(config.granularity ?? {}) }
      const versions = artifactCheck.versions

      // ── M-2 判定事务（方案 §14.2）─────────────────────────────────────
      // 顺序不可换：先找回/登记 intent → 再判定 → 最后落结论。
      // 崩溃点因此只可能是「intent 有、result 无」，而那是安全状态（复用同一 intentId 重跑）。
      const recovery = store.recoverIntents(card.cardId)
      if (recovery.corrupt.length > 0) {
        throw new Error(
          '判定事务状态损坏，拒绝判定（CORRUPT 不许容错成空对象）：'
          + recovery.corrupt.map(c => `${c.file} — ${c.reason}`).join('；')
          + `。请人工检查 .cto-office/cards/${card.cardId}/intents/ 与 evidence/ 后再处理。`,
        )
      }
      let intent = recovery.resumable
      // 内容三元组退一步只做**有效性断言**：与 intent 登记不一致 → 该 intent 作废重开，不复用。
      // 注意 `versions` 必须是**全量**（含 0 版本），与 beginIntent 登记时同一口径；
      // 卡里的 `artifactsVersion` 是过滤掉 0 的冻结子集，两者不可混用，否则每次都判 stale。
      const artifactsSame = JSON.stringify(intent?.artifactsVersion ?? {}) === JSON.stringify(versions)
      if (intent && (intent.baseSha !== card.baseSha || !artifactsSame)) {
        store.markIntent(card.cardId, intent, INTENT_STATE.ABANDONED, {
          reason: 'stale-context',
          note: `intent 登记 baseSha=${intent.baseSha} artifacts=${JSON.stringify(intent.artifactsVersion ?? {})}；`
            + `当前 baseSha=${card.baseSha} artifacts=${JSON.stringify(versions)}`,
        })
        intent = null
      }
      const resumed = Boolean(intent)
      if (!intent) intent = store.beginIntent(card.cardId, { action: 'judge', baseSha: card.baseSha, artifactsVersion: versions })

      let result
      let stats
      let dirtyPaths
      let reusedResult = false
      // 崩溃恢复：结论已落盘就**绝不重判** —— 重判会用当下事实覆盖崩溃前那次判定的结论。
      const existing = store.readJudgement(card.cardId, intent.intentId)
      if (existing) {
        reusedResult = true
        result = { verdict: existing.verdict, violations: existing.violations ?? [], stats: existing.stats ?? {} }
        stats = existing.stats ?? {}
        dirtyPaths = existing.stats?.dirtyPaths ?? []
      } else {
        const facts = await collectFacts(cwd, card.baseSha)
        // 回执与 git 事实对齐：声明与事实不一致就不算过闸。
        const receiptViolations = crossCheckReceipt(card,
          { changed: facts.changed, untracked: facts.untracked },
          { writerPresets: config.writerPresets ?? ['cto-builder'] })
        result = judge(card, {
          changed: facts.changed,
          untracked: facts.untracked,
          lines: facts.lines,
          acceptanceCount: card.acceptance?.length ?? 0,
        }, limits)

        // 行数只统计「已提交」的改动。工作区还脏时行数会偏小，必须显式告知，
        // 否则粒度上限会被悄悄绕过。
        dirtyPaths = facts.workingTree.filter(entry => !facts.committedPaths.includes(normalizePath(entry.path)))

        result.violations.push(...receiptViolations)
        if (receiptViolations.length > 0) result.verdict = 'CHANGES'
        stats = { ...result.stats, dirty: dirtyPaths.length > 0, dirtyPaths }

        store.writeJudgement(card.cardId, intent, {
          baseSha: card.baseSha,
          headSha: await headSha(cwd),
          artifactsVersion: versions,
          facts: { changed: facts.changed, untracked: facts.untracked, lines: facts.lines },
          verdict: result.verdict,
          violations: result.violations,
          stats: { ...result.stats, dirtyPaths },
          at: Date.now(),
        })
      }

      // 卡上记账只做一次：按 intentId 去重，避免「结果已落、卡没写」崩溃后重复计轮。
      const booked = (card.history ?? []).some(entry => entry.intentId === intent.intentId)
      if (!booked) {
        card.rounds = (card.rounds ?? 0) + 1
        if (result.verdict === 'CHANGES') {
          if (card.state === STATES.DISPATCHED) store.transition(card, STATES.CHANGES, { round: card.rounds, intentId: intent.intentId })
        }
        card.history = card.history ?? []
        card.history.push({ at: Date.now(), event: 'gate', intentId: intent.intentId, intentSeq: intent.intentSeq, verdict: result.verdict })
        store.save(card)
      }
      store.markIntent(card.cardId, intent, INTENT_STATE.RESULT_WRITTEN, { verdict: result.verdict })

      dirtyPaths = Array.isArray(dirtyPaths) ? dirtyPaths : []
      const intentTag = `intent #${intent.intentSeq}${resumed ? '，崩溃恢复' : ''}${reusedResult ? '，复用已落结论' : ''}`
      const head = result.violations.slice(0, 8).map(v => `- [${v.kind}] ${v.path ?? v.count} — ${v.detail}`).join('\n')
      let message = result.verdict === 'PASS'
        ? `GATE: PASS（${card.cardId}，${intentTag}）\n变更 ${stats.files ?? result.stats.files ?? 0} 文件 / ${stats.lines ?? result.stats.lines ?? 0} 行，全部在授权清单内。`
        : `GATE: CHANGES（${card.cardId}，第 ${card.rounds} 轮，${intentTag}）\n${head}`
          + (card.rounds >= 3 ? '\n\n已达 3 轮：按章程 deny，不再派回，转人决策。' : card.rounds >= 2 ? '\n\n已达 2 轮：按章程应转人确认。' : '')
      if (dirtyPaths.length > 0) {
        message += `\n\n⚠ 工作区仍有 ${dirtyPaths.length} 个未提交改动（${dirtyPaths.slice(0, 5).map(e => e.path).join(', ')}）。`
          + ' 行数统计只算已提交部分，粒度上限可能被低估 —— 先提交再判。'
      }
      const supervisorForWs = config.supervisorInstance?.get?.(cwd) ?? config.supervisorInstance
      const pendingAlerts = supervisorForWs ? supervisorForWs.pending() : []
      if (pendingAlerts.length > 0) message += `\n\n（另有 ${pendingAlerts.length} 条超时报警待处理，调用 office_status 查看。）`
      return { cardId: card.cardId, verdict: result.verdict, violations: result.violations, stats, message }
    },
  }

  const release = {
    name: 'office_release',
    description:
      'Close a card: settle (done) or abandon (discarded). Both are compound actions — archive evidence, '
      + 'release the exclusive globs this card held, and re-evaluate the QUEUED cards blocked by it. '
      + 'A card must be committed before it can settle.',
    parameters: {
      ...WORKSPACE_PARAM,
      cardId: { type: 'string', required: true, description: 'Card to close.' },
      action: { type: 'string', required: true, enum: ['settle', 'abandon'], description: 'settle = accepted; abandon = discarded.' },
      reason: { type: 'string', required: false, description: 'Why. Required in spirit for abandon; recorded either way.' },
    },
    output: {
      schema: jsonSchemaOf({
        cardId: { type: 'string' },
        state: { type: 'string' },
        released: { type: 'array', items: { type: 'string' } },
        unblocked: { type: 'array', items: { type: 'string' } },
        message: { type: 'string' },
      }, ['cardId', 'state', 'released', 'unblocked', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      const store = registry.get(cwd)
      if (args.action === 'settle') {
        if (!(await isClean(cwd))) {
          throw new Error('cannot settle: working tree is dirty. A dirty tree bleeds into the next card — commit or clean first.')
        }
        // 未过闸门不许结算：只查工作区干净是不够的，越界改动提交后工作区同样干净。
        // 只认权威来源：cto-narrative 哪怕写「PASS」也不算数。
        // 且只认**判定结论**（有 verdict 的证据）：合规回执本身也是权威来源，
        // 若它比 PASS 晚到，按「最新证据」取会拿到没有 verdict 的回执，把结算误判成失败。
        const gate = (() => {
          try {
            return store.latestJudgement(args.cardId)
          } catch (error) {
            if (error && error.code === 'CORRUPT') {
              throw new Error(`cannot settle: 证据文件损坏（${error.message}）。按方案 §14.3 转人工确认，不自动放行。`)
            }
            throw error
          }
        })()
        if (!gate) {
          const summary = store.evidenceSummary(args.cardId)
          const hint = summary.excluded > 0
            ? `（有 ${summary.excluded} 条非权威证据被排除：自述不能当闸门结论）`
            : ''
          throw new Error(`cannot settle: ${args.cardId} 还没有**权威**闸门结论。先跑 office_gate，拿到 PASS 才能结算。${hint}`)
        }
        if (gate.verdict !== 'PASS') {
          throw new Error(
            `cannot settle: ${args.cardId} 最近一次闸门结论是 ${gate.verdict}（第 ${gate.stats?.files ?? '?'} 个文件 / ${(gate.violations ?? []).length} 条违规）。`
            + ' 修完重跑 office_gate 拿 PASS，或 office_release action=abandon 作废重开。',
          )
        }
      }
      const to = args.action === 'settle' ? STATES.SETTLED : STATES.ABANDONED
      const { card, alreadyTerminal, released, unblocked } = store.finalize(args.cardId, to, args.reason)
      const message = alreadyTerminal
        ? `卡 ${card.cardId} 已是终止态（${card.state}），无操作。`
        : `卡 ${card.cardId} → ${card.state}。${card.authorization?.exclusive?.length ? `释放互斥 glob ${JSON.stringify(card.authorization.exclusive)}；` : ''}`
          + `${unblocked.length ? `解除阻塞 ${unblocked.join(', ')}；` : ''}${released.length ? `可派工：${released.join(', ')}。` : ''}`
      return { cardId: card.cardId, state: card.state, released, unblocked, message }
    },
  }

  const status = {
    name: 'office_status',
    description:
      'Read-only snapshot: in-flight cards, each card state and rounds, pending timeout alerts, and which '
      + 'glob matcher backend is active. Use it to check whether a QUEUED card is stuck behind an idle holder.',
    parameters: {
      ...WORKSPACE_PARAM,
      ack: { type: 'boolean', required: false, description: 'Acknowledge and clear pending alerts.' },
    },
    output: {
      schema: jsonSchemaOf({
        cards: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        alerts: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        backend: { type: 'string' },
        backendAnchor: { type: 'string' },
        message: { type: 'string' },
      }, ['cards', 'alerts', 'backend', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const store = openStore(args)
      const workspace = resolveWorkspace(args, config)
      const { cards } = store.list()
      const supervisor = config.supervisorInstance?.get?.(workspace) ?? config.supervisorInstance
      const alerts = supervisor ? supervisor.pending() : []
      if (args.ack && supervisor) supervisor.ack()
      const rows = cards.map(card => {
        const evidence = store.evidenceSummary(card.cardId)
        return {
          cardId: card.cardId,
          state: card.state,
          rounds: card.rounds ?? 0,
          baseSha: card.baseSha ? card.baseSha.slice(0, 8) : null,
          blockedBy: card.blockedBy ?? null,
          exclusive: card.authorization?.exclusive ?? [],
          evidence,
        }
      })
      const { matchBackend, matchBackendAnchor } = await import('./glob.js')
      const lines = rows.map(r => `- ${r.cardId} ${r.state}${r.blockedBy ? ` (等 ${r.blockedBy.cardId}: ${r.blockedBy.reason})` : ''} rounds=${r.rounds}`
        + `｜证据 ${r.evidence.total} 条（${Object.entries(r.evidence.bySource).map(([k, v]) => `${k}=${v}`).join(', ')}）`
        + (r.evidence.excluded ? `，其中 ${r.evidence.excluded} 条非权威已排除` : ''))
      const message = [
        `卡 ${rows.length} 张：`, ...(lines.length ? lines : ['（无）']),
        alerts.length ? `\n待处理报警 ${alerts.length} 条：` : '\n无待处理报警。',
        ...alerts.map(a => `- ${a.message}`),
        `\nglob 后端：${matchBackend()}${matchBackendAnchor() ? `（锚点：${matchBackendAnchor()}）` : '（⚠ 主路径未生效，正在跑内置兜底）'}`,
      ].join('\n')
      return { cards: rows, alerts, backend: matchBackend(), backendAnchor: matchBackendAnchor(), message }
    },
  }

  const artifact = {
    name: 'office_artifact',
    description:
      'Write or read the frozen reference artifacts for a card: `contracts` (interface contract) and '
      + '`acceptance` (numbered acceptance baseline). Writing is CTO-only and is REFUSED while the card is '
      + 'in progress — abandon and reopen instead. Versions freeze into the card at dispatch, and every '
      + 'receipt must declare which version it read.',
    parameters: {
      ...WORKSPACE_PARAM,
      action: { type: 'string', required: true, enum: ['write', 'read', 'verify'], description: 'Operation.' },
      cardId: { type: 'string', required: true, description: 'Card the artifacts belong to.' },
      kind: { type: 'string', required: false, enum: [...ARTIFACT_KINDS], description: 'Artifact kind (write/read).' },
      content: { type: 'string', required: false, description: 'Artifact body (write). Numbered lines like "A1 ...".' },
    },
    output: {
      schema: jsonSchemaOf({
        ok: { type: 'boolean' },
        versions: { type: 'object', additionalProperties: true, properties: {} },
        content: { type: 'string' },
        problems: { type: 'array', items: { type: 'string' } },
        message: { type: 'string' },
      }, ['ok', 'versions', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const store = openStore(args)
      const artifacts = new ArtifactStore(store)
      const card = store.read(args.cardId)
      if (args.action === 'write') {
        if (!card) {
          // 卡还没建：允许先落工件（dispatch 会读取版本并冻结）
          const written = artifacts.write(args.cardId, args.kind, args.content)
          return { ok: true, versions: artifacts.versions(args.cardId), message: `已写入 ${args.kind} v${written.version}（卡尚未创建，派工时冻结）。` }
        }
        const written = artifacts.write(args.cardId, args.kind, args.content)
        return { ok: true, versions: artifacts.versions(args.cardId), message: `已写入 ${args.kind} v${written.version}（上一版 v${written.previous}）。` }
      }
      if (args.action === 'read') {
        const doc = artifacts.read(args.cardId, args.kind)
        if (!doc) throw new Error(`工件不存在：${args.cardId}/${args.kind}`)
        return { ok: true, versions: artifacts.versions(args.cardId), content: doc.content, message: doc.content }
      }
      if (!card) throw new Error(`卡不存在：${args.cardId}（verify 需要已建卡）`)
      const check = artifacts.verify(card)
      return {
        ok: check.ok,
        versions: check.versions,
        problems: check.problems,
        message: check.ok
          ? `工件完备：${Object.entries(check.versions).map(([k, v]) => `${k}=${v}`).join(', ')}`
          : `工件有问题：${check.problems.join('；')}`,
      }
    },
  }

  const metrics = {
    name: 'office_metrics',
    description:
      'Compute the five metrics (card duration, block rate, out-of-scope rate, rework rate, shared-file conflicts) '
      + 'from real samples and apply the double threshold: advice requires >= minCycles cycles AND >= minCards cards, '
      + 'and a metric must stay above threshold for consecutiveBreaches cycles. Injected samples (card sampleTag) '
      + 'never enter the rates. Insufficient data returns no recommendation at all.',
    parameters: {
      ...WORKSPACE_PARAM,
      action: { type: 'string', required: false, enum: ['report', 'early-decision'], description: 'report (default) computes metrics; early-decision records a human judgement instead of evidence.' },
      reason: { type: 'string', required: false, description: 'Required for action=early-decision: why you decided early.' },
    },
    output: {
      schema: jsonSchemaOf({
        cardCount: { type: 'integer' },
        // 宿主的 schema 子集只接受**单一 type**：`type: ['number','null']` 会被
        // JsonSchemaError 拒掉，而工具注册一抛错，挂这颗插件的 preset 就整条激活失败
        // （真机表现：模式选择里 CTO 消失，只剩 6 个岗位）。用 oneOf 表达可空。
        blockRate: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        reworkRate: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        outOfScopeRate: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        conflicts: { type: 'integer' },
        cycles: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        adviceState: { type: 'string' },
        message: { type: 'string' },
        report: { type: 'object', additionalProperties: true, properties: {} },
        decision: { type: 'object', additionalProperties: true, properties: {} },
      }, ['cardCount', 'conflicts', 'cycles', 'adviceState', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      const store = registry.get(cwd)
      const { cards, corrupt } = store.list()
      const cfg = resolveMetricsConfig(config.metrics)
      const evidenceFor = cardId => store.scanEvidence(cardId).items
      const realCount = cards.filter(card => card.sampleTag !== 'injected').length

      if (args.action === 'early-decision') {
        // 人工提前决策：记成「判断」，不是「证据」（§14.7）。样本不足也允许，但必须留 reason。
        const report = computeMetrics({ cards, evidenceFor, config: cfg })
        const decision = makeEarlyDecision({
          reason: args.reason,
          cardCount: realCount,
          sampleState: report.advice.state === 'insufficient' ? 'insufficient' : report.advice.state,
        })
        const dir = join(cwd, '.cto-office', 'metrics')
        mkdirSync(dir, { recursive: true })
        appendFileSync(join(dir, 'early-decisions.jsonl'), JSON.stringify(decision) + '\n')
        return {
          cardCount: realCount,
          conflicts: report.overall.conflicts.length,
          cycles: report.cycles,
          adviceState: report.advice.state,
          decision,
          report,
          message: `已记录人工提前决策（decision=early，sampleState=${decision.sampleState}，卡数 ${realCount}）。\n`
            + `原因：${decision.reason}\n`
            + '这条记录**不是证据**：审计里与「有数据支持的结论」分开，不会被误读成有数据。',
        }
      }

      const report = computeMetrics({ cards, evidenceFor, config: cfg })
      const head = summarizeMetrics(report)
      const corruptNote = corrupt.length > 0
        ? `\n\n⚠ 有 ${corrupt.length} 张卡读不出来（${corrupt.map(c => c.cardId).join(', ')}），已排除在指标之外。`
        : ''
      return {
        cardCount: report.overall.cardCount,
        blockRate: report.overall.blockRate,
        reworkRate: report.overall.reworkRate,
        outOfScopeRate: report.overall.outOfScopeRate,
        conflicts: report.overall.conflicts.length,
        cycles: report.cycles,
        adviceState: report.advice.state,
        report,
        message: head + corruptNote,
      }
    },
  }

  const dashboard = {
    name: 'office_dashboard',
    description:
      'Daily dashboard: ONE entry with THREE fixed blocks — (1) in-flight cards, (2) yesterday\'s gate results '
      + 'over real samples only, (3) anomaly signals (pending alerts, expired exclusive claims, corrupt cards or '
      + 'evidence, cards idle beyond the reclaim threshold). Read-only: it never judges and never mutates state.',
    parameters: {
      ...WORKSPACE_PARAM,
    },
    output: {
      schema: jsonSchemaOf({
        day: { type: 'string' },
        inFlight: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        gate: { type: 'object', additionalProperties: true, properties: {} },
        anomalies: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
        counts: { type: 'object', additionalProperties: true, properties: {} },
        message: { type: 'string' },
      }, ['day', 'inFlight', 'gate', 'anomalies', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      const store = registry.get(cwd)
      const supervisorForWs = config.supervisorInstance?.get?.(cwd) ?? config.supervisorInstance
      const supCfg = config.supervisor ?? {}
      // 阈值只认一处实现（Supervisor / card.js），看板不另算一套常量。
      const thresholds = {
        cardIdleReclaimMs: supCfg.cardIdleReclaim?.thresholdMs ?? config.cardIdleReclaimMs,
        exclusiveTtlMs: supCfg.exclusiveTtl?.thresholdMs ?? config.exclusiveTtlMs,
        metrics: config.metrics ?? {},
      }
      const board = buildDashboard({ store, supervisor: supervisorForWs, config: thresholds })
      return {
        day: board.day,
        inFlight: board.blocks.inFlight,
        gate: board.blocks.gate,
        anomalies: board.blocks.anomalies,
        counts: board.counts,
        message: board.message,
      }
    },
  }

  const note = {
    name: 'office_note',
    description:
      'Record a CTO narrative note on a card (summary, reasoning, retrospective). Notes are for humans only: '
      + 'they are stored with source `cto-narrative` and NEVER count as evidence for any verdict. Use it to '
      + 'explain a decision; do not use it to claim that a gate passed.',
    parameters: {
      ...WORKSPACE_PARAM,
      cardId: { type: 'string', required: true, description: 'Card the note belongs to.' },
      text: { type: 'string', required: true, description: 'Human-facing note. Not evidence.' },
    },
    output: {
      schema: jsonSchemaOf({
        ok: { type: 'boolean' },
        source: { type: 'string' },
        authoritative: { type: 'boolean' },
        message: { type: 'string' },
      }, ['ok', 'source', 'authoritative', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const store = openStore(args)
      const card = store.read(args.cardId)
      if (!card) throw new Error(`card not found: ${args.cardId}`)
      store.recordNote(args.cardId, args.text)
      return {
        ok: true,
        source: 'cto-narrative',
        authoritative: false,
        message: `已记录自述（source=cto-narrative，不参与判定）。卡 ${args.cardId} 的闸门结论只认 git-plumbing / subagent-session / host-event。`,
      }
    },
  }

  /**
   * office_cd —— CD 阶段状态机（设计稿 §4.2，模式 A）。
   *
   * 不执行外部命令：`gh pr create` / `gh pr checks` / 合并 / 发布 / 健康探测一律由 CTO
   * 用现有 `bash` 跑，stdout 作为 `evidence` 传回。本工具只做三件事：
   *   ① 按状态机推进；② 落 cd.json 与证据；③ 校验前置条件（与 pre-execute 守卫双保险）。
   * 不可逆动作（merge / release）的人工确认在 R9 守卫，工具内不重复读审批文件。
   */
  const cd = {
    name: 'office_cd',
    description:
      'Drive the CD phase after settlement (mode A): begin / review / checks / merge / release / verify / abort / status. '
      + 'The CTO runs gh and health checks with bash and passes stdout as `evidence`; this tool only advances '
      + 'the CD state machine and persists the record. Irreversible actions need a human approval file outside the workspace.',
    parameters: {
      ...WORKSPACE_PARAM,
      runId: { type: 'string', required: true, description: 'Stable CD run id, e.g. "CD1".' },
      action: { type: 'string', required: true, enum: [...CD_ACTIONS], description: 'CD action; fixed order in charter §九.' },
      prNumber: { type: 'integer', required: false, description: 'Pull request number (begin only).' },
      headSha: { type: 'string', required: false, description: 'Full 40/64 hex sha (begin); must equal the frozen sha for merge.' },
      verdict: { type: 'string', required: false, enum: ['PASS', 'CHANGES'], description: 'Reviewer GATE verdict (review only).' },
      checksState: { type: 'string', required: false, enum: ['pending', 'success', 'failure'], description: 'gh pr checks result (checks only).' },
      evidence: { type: 'string', required: false, description: 'stdout / evidence text from the bash command (mode A).' },
      healthUrl: { type: 'string', required: false, description: 'Health endpoint checked for verify (recorded).' },
      repo: { type: 'string', required: false, description: 'owner/name; fills in the gh command templates returned by status / commands.' },
      reason: { type: 'string', required: false, description: 'Why (abort).' },
    },
    output: {
      schema: jsonSchemaOf({
        runId: { type: 'string' },
        state: { type: 'string' },
        round: { type: 'integer' },
        cdLine: { type: 'string' },
        message: { type: 'string' },
      }, ['runId', 'state', 'round', 'cdLine', 'message']),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      const cardStore = registry.get(cwd)
      const cdStore = new CdStore(cwd)
      const runId = args.runId
      const action = args.action
      const maxRounds = config.cd?.maxReviewRounds ?? 2
      let record = cdStore.read(runId)

      const respond = detail => {
        const line = cdLine(record)
        return {
          runId: record.runId,
          state: record.state,
          round: record.round,
          cdLine: line,
          message: `${line}\n${detail}`,
        }
      }

      /** 模式 A 的证据：`bash` 输出走 host-event，reviewer 回执走 subagent-session。 */
      const saveEvidence = (kind, state) => {
        if (!args.evidence) return []
        const source = action === 'review' ? SOURCES.SUBAGENT : SOURCES.HOST_EVENT
        const written = cdStore.recordEvidence(runId, {
          at: Date.now(),
          source,
          state,
          kind,
          payload: { stdout: String(args.evidence).slice(0, 20000), action },
        })
        return [written.id]
      }
      const commit = (to, event, extra, detail) => {
        record = transitionCd(record, to, { event, ...extra })
        record.evidence = [...(record.evidence ?? []), ...saveEvidence(event, record.state)]
        cdStore.save(record)
        return respond(detail)
      }

      const cmdContext = () => ({ ...(config.cd ?? {}), repo: args.repo })
      const ghWhy = () => classifyGhFailure(args.evidence)

      // status / commands：只读。把「下一步该跑哪条 gh 命令」固化在响应里（三期）。
      if (action === 'status' || action === 'commands') {
        if (!record) throw new Error(`CD run not found: ${runId}；先 office_cd action=begin`)
        const n = nextCommand(record, cmdContext())
        const snapshot = `CD 快照：state=${record.state} round=${record.round} PR=#${record.prNumber} `
          + `headSha=${record.headSha.slice(0, 8)} checksState=${record.checksState} `
          + `evidence=${(record.evidence ?? []).length} 条。`
        if (action === 'commands') {
          const list = Object.keys(n.all).map(k => `  ${k}: ${n.all[k]}`).join('\n')
          return respond(
            `当前 ${record.state} 的下一步：\n  stage=${n.stage ?? '(终态)'}\n  ${n.command ?? n.hint}\n  ${n.hint}`
            + `\n\n全量命令契约（模式 A：CTO 用 bash 跑，stdout 作 evidence）：\n${list}`,
          )
        }
        return respond(`${snapshot}\n下一步：stage=${n.stage ?? '—'} → ${n.command ?? n.hint}`)
      }

      if (action === 'begin') {
        if (record) throw new Error(`CD run ${runId} already exists (state=${record.state})`)
        if (!args.prNumber) throw new Error('begin 需要 prNumber（先由 CTO 用 bash 跑 gh pr view --json number,headRefOid,state,url）')
        if (!args.headSha) throw new Error('begin 需要 headSha（完整 40/64 位十六进制）')
        if (!args.evidence) throw new Error('模式 A：begin 需要 evidence（gh pr view 的 JSON stdout），本工具不自己跑外部命令')
        // 铁律 3：evidence 能解析出 headRefOid 时，必须与声明的 headSha 一致。
        const pr = parsePrView(args.evidence)
        if (pr.ok && pr.headSha && pr.headSha !== args.headSha) {
          throw new Error(`begin 前置：evidence 的 headRefOid=${pr.headSha} 与传入 headSha=${args.headSha} 不一致（铁律 3：证据优先）。`)
        }
        if (!pr.ok && ghWhy() !== 'unknown') {
          throw new Error(`begin 前置：evidence 不是 gh pr view 的 JSON 输出，且看起来是 gh 报错（${ghWhy()}）。先修好命令再传 stdout。`)
        }
        const { cards } = cardStore.list()
        const inFlight = cards.filter(c => !isTerminal(c.state))
        if (inFlight.length) {
          throw new Error(`还有 ${inFlight.length} 张在飞卡（${inFlight.map(c => c.cardId).join(', ')}），CD 只能在结算之后开始`)
        }
        const settled = cards.filter(c => c.state === STATES.SETTLED)
        if (!settled.length) {
          throw new Error('没有 SETTLED 卡：CD 只能在结算之后开始（office_release action=settle 已保证权威闸门 PASS）')
        }
        record = makeCdRecord({ runId, prNumber: args.prNumber, headSha: args.headSha, now: Date.now() })
        record.evidence = saveEvidence('pr-create', record.state)
        cdStore.save(record)
        return respond(`开合并请求：PR #${record.prNumber}，冻结 headSha=${record.headSha.slice(0, 8)}。等待 review。`)
      }

      if (!record) throw new Error(`CD run not found: ${runId}；先 office_cd action=begin`)
      if (!cdActionAllowed(action, record.state)) {
        throw new Error(`当前在 ${record.state} 阶段，action=${action} 不允许（铁律 9：CD 不许跳步）。`)
      }
      if (isCdTerminal(record.state)) throw new Error(`CD run ${runId} 已终止（${record.state}）`)

      if (action === 'review') {
        if (!args.verdict) throw new Error('review 需要 verdict（PASS / CHANGES），来自 cto-reviewer 的 GATE: 行')
        const outcome = reviewVerdictToState(record, args.verdict, maxRounds)
        const tail = outcome.escalate
          ? `已达 ${maxRounds} 轮仍未过：转人决策（第 ${maxRounds + 1} 次 review 会被 deny）。`
          : outcome.reason === 'review-pass'
            ? '审查通过，进入自动检查。'
            : '审查有 CHANGES，派回修复后再审。'
        record = transitionCd(record, outcome.to, { event: 'review', verdict: args.verdict, round: outcome.round })
        record.round = outcome.round
        record.evidence = [...(record.evidence ?? []), ...saveEvidence('review', record.state)]
        cdStore.save(record)
        return respond(`review ${args.verdict}（第 ${record.round} 轮）→ ${record.state}。${tail}`)
      }

      if (action === 'checks') {
        if (!args.checksState) throw new Error('checks 需要 checksState（pending / success / failure）')
        // 铁律 3：gh pr checks 的 JSON stdout 能解析时，聚合作必须与声明一致。
        const parsed = parseChecks(args.evidence)
        if (parsed.ok && parsed.checksState !== args.checksState) {
          throw new Error(
            `checks 前置：evidence 解析出 ${parsed.checksState}（${parsed.count} 项），但声明 ${args.checksState}`
            + '（铁律 3：证据优先，不许拿自述覆盖事实）。',
          )
        }
        if (!parsed.ok && ghWhy() !== 'unknown') {
          throw new Error(`checks 前置：evidence 不是 gh pr checks 的 JSON 输出，且看起来是 gh 报错（${ghWhy()}）。`)
        }
        const outcome = checksStateToState(record, args.checksState)
        record = transitionCd(record, outcome.to, { event: 'checks', checksState: args.checksState })
        record.checksState = args.checksState
        record.evidence = [...(record.evidence ?? []), ...saveEvidence('checks', record.state)]
        cdStore.save(record)
        const tail = outcome.mergeReady
          ? 'checks 全绿；可 office_cd action=merge（合并前需人工确认）。'
          : outcome.escalate ? '检查失败，BLOCKED 转人。' : '检查仍在进行，继续轮询。'
        return respond(`checks=${args.checksState} → ${record.state}。${tail}`)
      }

      if (action === 'merge') {
        if (record.checksState !== 'success') {
          throw new Error('merge 前置：checksState 必须为 success（先 office_cd action=checks checksState=success）')
        }
        if (!args.headSha || args.headSha !== record.headSha) {
          throw new Error(`merge 前置：headSha 与冻结值不一致（stale）。期望 ${record.headSha}，收到 ${args.headSha ?? '(空)'}`)
        }
        if (!args.evidence) throw new Error('模式 A：merge 需要 evidence（gh api ... merge 的 stdout）')
        return commit(CD_STATES.MERGED, 'merge', { headSha: args.headSha },
          `已合并（headSha=${record.headSha.slice(0, 8)}），等待发布。`)
      }

      if (action === 'release') {
        if (!args.evidence) throw new Error('模式 A：release 需要 evidence（gh workflow run / tag 的 stdout）')
        const wf = config.cd?.releaseWorkflow ?? ''
        return commit(CD_STATES.RELEASED, 'release', { workflow: wf },
          `发布指令已发出，等待核实线上。${wf ? '' : '（cd.releaseWorkflow 未配置；命令模板见 action=status。）'}`)
      }

      if (action === 'verify') {
        if (!args.evidence) throw new Error('模式 A：verify 需要 evidence（线上健康探测的输出）')
        const url = args.healthUrl ?? config.cd?.healthUrl ?? ''
        // 非 HTTP 输出（健康检查 JSON 等）也允许，不强行拦；只在响应里提示人工确认。
        const httpOk = /\b(200|204)\b/.test(String(args.evidence))
        record = transitionCd(record, CD_STATES.VERIFIED, { event: 'verify', healthUrl: url, httpOk })
        record.healthUrl = url
        record.evidence = [...(record.evidence ?? []), ...saveEvidence('verify', record.state)]
        cdStore.save(record)
        return respond(
          `线上核实通过，CD 阶段完结。${url ? `healthUrl=${url}` : '（cd.healthUrl 未配置；命令模板见 action=status。）'}`
          + `${httpOk ? '' : ' 注意：evidence 里未见 200/204，请人工确认探测确实通过。'}`,
        )
      }

      if (action === 'abort') {
        return commit(CD_STATES.ABORTED, 'abort', { reason: args.reason ?? '' },
          `CD 已中止：${args.reason ?? '(未写原因)'}`)
      }

      throw new Error(`unknown CD action: ${action}`)
    },
  }

  // 所有工具统一归一：紧凑参数声明 → 标准 JSON Schema，并加必填/类型校验。
  const raw = { dispatch, gate, release, status, artifact, note, metrics, dashboard, cd }
  const normalized = {}
  for (const [key, tool] of Object.entries(raw)) {
    const compact = tool.parameters && tool.parameters.type === undefined ? tool.parameters : null
    normalized[key] = compact ? wrap(tool, compact) : tool
  }
  return normalized
}
