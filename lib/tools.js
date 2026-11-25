/**
 * W1 三个工具：office_dispatch / office_gate / office_release。
 *
 * 注意：这里不用 `defineTool`——它来自 @deepseek-ai/dsh-tools，而在本机插件目录下
 * 该包会解析到 npx 缓存的 rc.1 旧副本（宿主 rc.5）。注册表接受原生 ToolDefinition，
 * 所以直接给字面量对象，零 @deepseek-ai 依赖。
 */
import { collectFacts, headSha, isClean, isRepository } from './git.js'
import { normalizePath } from './glob.js'
import { GRANULARITY, STATES, exclusivesConflict, judge } from './card.js'
import { randomUUID } from 'node:crypto'

const text = value => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

/**
 * 工作区解析：显式参数 > 配置 > 进程 cwd。
 * 宿主进程可能服务多个工作区，所以凡是能显式传的都要显式传。
 */
function resolveWorkspace(args, config) {
  const fromArgs = args && typeof args.workspace === 'string' && args.workspace ? args.workspace : null
  const fromConfig = typeof config.workspaceRoot === 'string' && config.workspaceRoot ? config.workspaceRoot : null
  return fromArgs || fromConfig || process.cwd()
}

const WORKSPACE_PARAM = {
  workspace: { type: 'string', required: false, description: 'Absolute path to the git workspace. Defaults to the configured workspace root.' },
}

const jsonSchemaOf = properties => ({
  type: 'object',
  additionalProperties: false,
  properties,
})

/**
 * @param ctx cordis context
 * @param opts { store, config }
 */
export function buildTools(ctx, { store, config }) {
  const maxWriters = () => config.granularity?.maxConcurrentWriters ?? config.maxConcurrentWriters ?? 1

  const dispatch = {
    name: 'office_dispatch',
    description:
      'Create a work card: freeze the current HEAD as baseSha, record the write-authorization checklist, '
      + 'and take a writer slot (serial when maxConcurrentWriters=1). Returns DISPATCHED, or QUEUED with a '
      + 'blockedBy reason when a slot or an exclusive glob is already held. CTO only.',
    parameters: {
      ...WORKSPACE_PARAM,
      cardId: { type: 'string', required: true, description: 'Stable card id, e.g. "C1".' },
      subject: { type: 'string', required: true, description: 'One-line deliverable.' },
      preset: { type: 'string', required: false, description: 'Worker preset to dispatch, e.g. cto-builder.' },
      mode: { type: 'string', required: true, enum: ['rw', 'ro'], description: 'rw = may write inside include; ro = read-only card.' },
      include: { type: 'array', required: false, items: { type: 'string' }, description: 'Globs the card may write, e.g. "db/**".' },
      deny: { type: 'array', required: false, items: { type: 'string' }, description: 'Globs always forbidden inside include.' },
      exclusive: { type: 'array', required: false, items: { type: 'string' }, description: 'Globs that only one in-flight card may hold.' },
      acceptance: { type: 'array', required: false, items: { type: 'string' }, description: 'Testable acceptance lines; must be numbered. Also caps observable behaviors.' },
      declaredFiles: { type: 'integer', required: false, description: 'Declared changed-file count (advisory, used for planning).' },
      declaredLines: { type: 'integer', required: false, description: 'Declared net changed lines (advisory).' },
    },
    output: {
      schema: jsonSchemaOf({
        cardId: { type: 'string', required: true },
        state: { type: 'string', required: true },
        baseSha: { type: 'string', required: true },
        blockedBy: { type: 'object', required: false, additionalProperties: true, properties: {} },
        message: { type: 'string', required: true },
      }),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      if (!(await isRepository(cwd))) throw new Error(`not a git repository: ${cwd}`)
      if (!(await isClean(cwd))) {
        throw new Error('working tree must be clean before dispatch (only .cto-office/ may be dirty); commit or stash first')
      }

      const head = await headSha(cwd)
      if (!head) throw new Error('repository has no commits yet; cannot freeze baseSha')

      const startIfPossible = (card, headShaNow) => {
        const activeNow = store.activeWriters().filter(other => other.cardId !== card.cardId)
        if (activeNow.length >= maxWriters()) {
          card.blockedBy = { cardId: activeNow[0].cardId, reason: 'serial-limit' }
          card.history.push({ at: Date.now(), event: 'still-queued', reason: 'serial-limit', holder: activeNow[0].cardId })
          store.save(card)
          return {
            cardId: card.cardId, state: card.state, baseSha: card.baseSha,
            blockedBy: card.blockedBy,
            message: `卡 ${card.cardId} 仍在 QUEUED：写者名额被 ${activeNow[0].cardId} 占用（maxConcurrentWriters=${maxWriters()}）。`,
          }
        }
        const conflictNow = store.inFlight()
          .filter(other => other.cardId !== card.cardId)
          .map(other => ({ other, conflict: exclusivesConflict(card, other) }))
          .find(hit => hit.conflict)
        if (conflictNow) {
          card.blockedBy = { cardId: conflictNow.other.cardId, reason: 'exclusive-held', glob: conflictNow.conflict.globA }
          card.history.push({ at: Date.now(), event: 'still-queued', reason: 'exclusive-held', holder: conflictNow.other.cardId })
          store.save(card)
          return {
            cardId: card.cardId, state: card.state, baseSha: card.baseSha,
            blockedBy: card.blockedBy,
            message: `卡 ${card.cardId} 仍在 QUEUED：互斥 glob ${conflictNow.conflict.globA} 被 ${conflictNow.other.cardId} 持有。`,
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
            + ` 授权 ${card.authorization.mode} ${JSON.stringify(card.authorization.include)}。`,
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

      const { makeCard } = await import('./card.js')
      const card = makeCard({
        cardId: args.cardId,
        subject: args.subject,
        preset: args.preset,
        authorization: { mode: args.mode, include: args.include ?? [], deny: args.deny ?? [], exclusive: args.exclusive ?? [] },
        baseSha: null,
        acceptance: args.acceptance ?? [],
        declared: { files: args.declaredFiles, lines: args.declaredLines, behaviors: (args.acceptance ?? []).length || null },
      })

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

      // 2) 互斥组
      const conflict = store.inFlight()
        .filter(other => other.cardId !== card.cardId)
        .map(other => ({ other, conflict: exclusivesConflict(card, other) }))
        .find(hit => hit.conflict)
      if (conflict) {
        card.blockedBy = { cardId: conflict.other.cardId, reason: 'exclusive-held', glob: conflict.conflict.globA }
        card.history.push({ at: Date.now(), event: 'queued', reason: 'exclusive-held', holder: conflict.other.cardId })
        store.save(card)
        return {
          cardId: card.cardId, state: card.state, baseSha: card.baseSha,
          blockedBy: card.blockedBy,
          message: `卡 ${card.cardId} 已建，但处于 QUEUED：互斥 glob ${conflict.conflict.globA} 被 ${conflict.other.cardId} 持有。冲突已在开卡时暴露，不必等到合并。`,
        }
      }

      return startIfPossible(card, head)
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
        cardId: { type: 'string', required: true },
        verdict: { type: 'string', required: true, enum: ['PASS', 'CHANGES'] },
        violations: { type: 'array', required: true, items: { type: 'object', additionalProperties: true, properties: {} } },
        stats: { type: 'object', required: true, additionalProperties: true, properties: {} },
        message: { type: 'string', required: true },
      }),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      const card = store.read(args.cardId)
      if (!card) throw new Error(`card not found: ${args.cardId}`)
      if (card.state === STATES.SETTLED || card.state === STATES.ABANDONED) {
        throw new Error(`card ${card.cardId} is already terminal (${card.state})`)
      }
      if (!card.baseSha) {
        throw new Error(`card ${card.cardId} has no baseSha yet (still QUEUED). Call office_dispatch with the same cardId to start it first.`)
      }

      const facts = await collectFacts(cwd, card.baseSha)
      const limits = { ...GRANULARITY, ...(config.granularity ?? {}) }
      const result = judge(card, {
        changed: facts.changed,
        untracked: facts.untracked,
        lines: facts.lines,
        acceptanceCount: card.acceptance?.length ?? 0,
      }, limits)

      // 行数只统计「已提交」的改动。工作区还脏时行数会偏小，必须显式告知，
      // 否则粒度上限会被悄悄绕过。
      const dirtyPaths = facts.workingTree.filter(entry => !facts.committedPaths.includes(normalizePath(entry.path)))

      const intentId = randomUUID()
      store.writeEvidence(card.cardId, intentId, {
        source: 'git-plumbing',
        intentId,
        cardId: card.cardId,
        baseSha: card.baseSha,
        headSha: await headSha(cwd),
        facts: { changed: facts.changed, untracked: facts.untracked, lines: facts.lines },
        verdict: result.verdict,
        violations: result.violations,
        stats: { ...result.stats, dirtyPaths },
        at: Date.now(),
      })

      card.rounds = (card.rounds ?? 0) + 1
      if (result.verdict === 'CHANGES') {
        if (card.state === STATES.DISPATCHED) store.transition(card, STATES.CHANGES, { round: card.rounds })
      }
      store.save(card)

      const head = result.violations.slice(0, 8).map(v => `- [${v.kind}] ${v.path ?? v.count} — ${v.detail}`).join('\n')
      let message = result.verdict === 'PASS'
        ? `GATE: PASS（${card.cardId}）\n变更 ${result.stats.files} 文件 / ${result.stats.lines} 行，全部在授权清单内。`
        : `GATE: CHANGES（${card.cardId}，第 ${card.rounds} 轮）\n${head}`
          + (card.rounds >= 3 ? '\n\n已达 3 轮：按章程 deny，不再派回，转人决策。' : card.rounds >= 2 ? '\n\n已达 2 轮：按章程应转人确认。' : '')

      const stats = { ...result.stats, dirty: dirtyPaths.length > 0, dirtyPaths }
      if (dirtyPaths.length > 0) {
        message += `\n\n⚠ 工作区仍有 ${dirtyPaths.length} 个未提交改动（${dirtyPaths.slice(0, 5).map(e => e.path).join(', ')}）。`
          + ' 行数统计只算已提交部分，粒度上限可能被低估 —— 先提交再判。'
      }
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
        cardId: { type: 'string', required: true },
        state: { type: 'string', required: true },
        released: { type: 'array', required: true, items: { type: 'string' } },
        unblocked: { type: 'array', required: true, items: { type: 'string' } },
        message: { type: 'string', required: true },
      }),
      render: (_args, value) => text(value.message),
    },
    async execute(args) {
      const cwd = resolveWorkspace(args, config)
      if (args.action === 'settle') {
        if (!(await isClean(cwd))) {
          throw new Error('cannot settle: working tree is dirty. A dirty tree bleeds into the next card — commit or clean first.')
        }
        // 未过闸门不许结算：只查工作区干净是不够的，越界改动提交后工作区同样干净。
        const gate = store.latestEvidence(args.cardId)
        if (!gate) {
          throw new Error(`cannot settle: ${args.cardId} 还没有闸门结论。先跑 office_gate，拿到 PASS 才能结算。`)
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

  return { dispatch, gate, release }
}
