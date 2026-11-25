/**
 * W1 单元测试（node --test）。
 * 覆盖纯逻辑与 IO 契约：glob / 授权判定 / 卡粒度 / 状态机 / 持久化 / 守卫 / 卡仓库生命周期。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { matchGlob, matchAny, isAuthorized, normalizePath } from '../lib/glob.js'
import { STATES, canTransition, isTerminal, makeCard, judge, IllegalTransitionError } from '../lib/card.js'
import { CardStore } from '../lib/store.js'
import { isDestructiveGit, targetPreset, makePreExecuteGuard } from '../lib/guards.js'
import { writeOnceJson, replaceJson, readJsonStrict, CorruptError } from '../lib/atomic.js'

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-w1-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('glob: 双星、单星、目录前缀、花括号', () => {
  assert.equal(matchGlob('db/**', 'db/schema.ts'), true)
  assert.equal(matchGlob('db/**', 'db/a/b/c.ts'), true)
  assert.equal(matchGlob('db/**', 'api/x.ts'), false)
  assert.equal(matchGlob('**/*.ts', 'a.ts'), true)
  assert.equal(matchGlob('app/import/', 'app/import/x/y.ts'), true, '结尾斜杠=整目录')
  assert.equal(matchGlob('src/*.ts', 'src/a/b.ts'), false, '单星不跨目录')
  assert.equal(matchGlob('shared/{types,env}.ts', 'shared/env.ts'), true)
  assert.equal(matchGlob('shared/{types,env}.ts', 'shared/other.ts'), false)
  assert.equal(normalizePath('./a//b.ts'), 'a/b.ts')
})

test('授权：rw/include/deny 与 ro', () => {
  const auth = { mode: 'rw', include: ['db/**'], deny: ['db/secret/**'], exclusive: [] }
  assert.equal(isAuthorized(auth, 'db/a.ts'), true)
  assert.equal(isAuthorized(auth, 'db/secret/k.ts'), false, 'deny 优先')
  assert.equal(isAuthorized(auth, 'api/a.ts'), false)
  assert.equal(isAuthorized({ mode: 'ro', include: ['**'] }, 'a.ts'), false, 'ro 一律不可写')
  assert.equal(isAuthorized({ mode: 'rw', include: [] }, 'a.ts'), false, '空 include 不放行')
})

test('状态机：合法与非法跃迁', () => {
  assert.equal(canTransition(STATES.QUEUED, STATES.DISPATCHED), true)
  assert.equal(canTransition(STATES.DISPATCHED, STATES.CHANGES), true)
  assert.equal(canTransition(STATES.CHANGES, STATES.DISPATCHED), true)
  assert.equal(canTransition(STATES.SETTLED, STATES.DISPATCHED), false, '终止态不可复活')
  assert.equal(isTerminal(STATES.ABANDONED), true)
})

test('判定：越界 / 未跟踪 / 粒度上限', () => {
  const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['db/**'] }, baseSha: 'abc' })
  const ok = judge(card, { changed: [{ path: 'db/a.ts' }], untracked: [], lines: { added: 10, removed: 2 } })
  assert.equal(ok.verdict, 'PASS')

  const out = judge(card, { changed: [{ path: 'shared/types.ts' }], untracked: ['tmp/x.log'], lines: { added: 1, removed: 0 } })
  assert.equal(out.verdict, 'CHANGES')
  assert.deepEqual(out.violations.map(v => v.path).sort(), ['shared/types.ts', 'tmp/x.log'], 'diff 与 status 都要看')

  const big = judge(card, {
    changed: Array.from({ length: 11 }, (_, i) => ({ path: `db/f${i}.ts` })),
    untracked: [], lines: { added: 500, removed: 0 },
  })
  const kinds = big.violations.map(v => v.kind)
  assert.ok(kinds.includes('granularity-files'))
  assert.ok(kinds.includes('granularity-lines'))
})

test('持久化：写一次永不覆盖 + 覆盖替换 + 严格读', () => {
  const { dir, cleanup } = tmp()
  try {
    const target = join(dir, 'e', 'intent-1.json')
    writeOnceJson(target, { v: 1 })
    assert.equal(readJsonStrict(target).v, 1)
    assert.throws(() => writeOnceJson(target, { v: 2 }), /EEXIST/, '不能覆盖')
    assert.equal(readJsonStrict(target).v, 1, '原内容未被破坏')

    const card = join(dir, 'card.json')
    replaceJson(card, { v: 1 })
    replaceJson(card, { v: 2 })
    assert.equal(readJsonStrict(card).v, 2)

    writeFileSync(join(dir, 'empty.json'), '')
    assert.throws(() => readJsonStrict(join(dir, 'empty.json')), CorruptError, '0 字节判 CORRUPT')
    writeFileSync(join(dir, 'bad.json'), '{oops')
    assert.throws(() => readJsonStrict(join(dir, 'bad.json')), CorruptError)
    writeFileSync(join(dir, 'arr.json'), '[]')
    assert.throws(() => readJsonStrict(join(dir, 'arr.json')), CorruptError)
    assert.equal(readJsonStrict(join(dir, 'missing.json')), undefined, '缺失返回 undefined 而非抛错')
  } finally { cleanup() }
})

test('守卫：破坏提交边界的命令一律拒', () => {
  for (const cmd of ['git reset --hard HEAD~1', 'git rebase -i main', 'git commit --amend -m x', 'git checkout -- .', 'git clean -fd']) {
    assert.equal(isDestructiveGit(cmd), true, cmd)
  }
  for (const cmd of ['git status', 'git commit -m ok', 'pnpm test', 'git restore --staged .']) {
    assert.equal(isDestructiveGit(cmd), false, cmd)
  }
})

test('守卫：写者名额已满时拒第二个写岗，只读岗放行', async () => {
  const store = { activeWriters: () => [{ cardId: 'C1' }] }
  const guard = makePreExecuteGuard({ store, config: { maxConcurrentWriters: 1, writerPresets: ['cto-builder'] } })
  const deny = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-builder' } }, async () => ({ kind: 'allow' }))
  assert.equal(deny.kind, 'deny')
  const allow = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-qa' } }, async () => ({ kind: 'allow' }))
  assert.equal(allow.kind, 'allow', '只读岗不占写者名额')
  assert.equal(targetPreset({ agent_preset: 'cto-builder' }), 'cto-builder')
  assert.equal(targetPreset({ agentPreset: 'cto-qa' }), 'cto-qa')
})

test('卡仓库：终止态释放互斥并解除 QUEUED 阻塞', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const c1 = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['db/**'], exclusive: ['shared/types.ts'] }, baseSha: 'aaa' })
    store.save(c1)
    const c2 = makeCard({ cardId: 'C2', authorization: { mode: 'rw', include: ['app/**'], exclusive: ['shared/types.ts'] }, baseSha: 'aaa' })
    c2.blockedBy = { cardId: 'C1', reason: 'exclusive-held' }
    store.save(c2)

    store.transition(c1, STATES.DISPATCHED)
    store.save(c1)
    assert.deepEqual(store.activeWriters().map(c => c.cardId), ['C1'], 'QUEUED 不占写者名额')

    const result = store.finalize('C1', STATES.SETTLED, 'done')
    assert.equal(result.card.state, STATES.SETTLED)
    assert.deepEqual(result.unblocked, ['C2'], '放开时解除 blockedBy')
    assert.equal(store.read('C2').blockedBy, null)
    assert.equal(store.read('C2').state, STATES.QUEUED)
  } finally { cleanup() }
})

test('卡仓库：非法跃迁抛错且不落盘', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'ro' }, baseSha: 'aaa' })
    store.save(card)
    assert.throws(() => store.transition(card, STATES.SETTLED), IllegalTransitionError, 'QUEUED 不能直接结算')
  } finally { cleanup() }
})

test('卡仓库：坏卡不炸列表', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const good = makeCard({ cardId: 'C1', authorization: { mode: 'ro' }, baseSha: 'aaa' })
    store.save(good)
    mkdirSync(join(store.dir, 'BROKEN'), { recursive: true })
    writeFileSync(join(store.dir, 'BROKEN', 'card.json'), '{nope')
    const { cards, corrupt } = store.list()
    assert.equal(cards.length, 1)
    assert.equal(corrupt.length, 1)
    assert.equal(corrupt[0].cardId, 'BROKEN')
  } finally { cleanup() }
})

test('证据：一件一文件，重复写幂等命中', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const first = store.writeEvidence('C1', 'intent-1', { source: 'git-plumbing' })
    const second = store.writeEvidence('C1', 'intent-1', { source: 'git-plumbing' })
    assert.equal(first.created, true)
    assert.equal(second.created, false)
    assert.equal(store.countEvidence('C1'), 1)
    assert.equal(readJsonStrict(first.path).source, 'git-plumbing')
  } finally { cleanup() }
})

// ── W1e 超时监督器 ────────────────────────────────────────────────
import { Supervisor } from '../lib/supervisor.js'

test('监督器：持有者 idle 超阈值才报警，且报警对象是持有者', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const t0 = 1_000_000
    const holder = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['db/**'] }, baseSha: 'a', now: t0 })
    store.save(holder, t0)
    store.transition(holder, STATES.DISPATCHED); store.save(holder, t0)
    const waiter = makeCard({ cardId: 'C2', authorization: { mode: 'rw', include: ['app/**'] }, baseSha: 'a', now: t0 })
    waiter.blockedBy = { cardId: 'C1', reason: 'serial-limit' }
    store.save(waiter, t0)

    const fresh = new Supervisor(store, { queuedAlertMs: 3_600_000, now: () => t0 })
    assert.equal(fresh.tick().length, 0, '刚 idle 不该报警')

    const stale = new Supervisor(store, { queuedAlertMs: 3_600_000, now: () => t0 + 90 * 60_000 })
    const alerts = stale.tick()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].cardId, 'C2', '报警针对等待卡')
    assert.equal(alerts[0].blockedBy, 'C1', '但message点出持有者')
    assert.match(alerts[0].message, /C1 已 idle 90 分钟/)

    assert.equal(stale.tick().length, 0, '同一原因不重复刷')
    assert.equal(stale.pending().length, 1)
    assert.equal(stale.ack(), 1)
    assert.equal(stale.pending().length, 0)
  } finally { cleanup() }
})

test('监督器：持有者消失也要报', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const wait = makeCard({ cardId: 'C2', authorization: { mode: 'rw' }, baseSha: 'a' })
    wait.blockedBy = { cardId: 'GONE', reason: 'serial-limit' }
    store.save(wait)
    const sup = new Supervisor(store, { now: () => Date.now() })
    const alerts = sup.tick()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].reason, 'holder-missing')
  } finally { cleanup() }
})

test('glob 后端自报：有宿主时用 picomatch，无宿主时兜底', async () => {
  const { matchBackend } = await import('../lib/glob.js')
  assert.ok(['picomatch', 'fallback'].includes(matchBackend()))
})

// ── W2 工件层与回执闸门 ──────────────────────────────────────────
import { ArtifactStore, ArtifactError } from '../lib/artifacts.js'
import { validateReceipt, parseReceipt, cardIdFromPrompt } from '../lib/receipt.js'
import { makePostExecuteReceiptGuard, resultText } from '../lib/receipt-guard.js'

const GOOD_RECEIPT = `RECEIPT:
- card: C1
- artifactsVersion: acceptance=1
- changed: api/a.ts
- acceptance:
  - A1 PASS 证据：pnpm test → 5 passed
SELF-CHECK:
- build: pnpm build → 0
- tests: pnpm test → 5 passed
- scope: api/a.ts
- gaps: 大文件未测`

test('回执：合规通过；缺 SELF-CHECK 字段判缺失', () => {
  const card = { cardId: 'C1', authorization: { mode: 'rw', include: ['api/**'], deny: [], exclusive: [] }, artifactsVersion: { acceptance: 1 }, acceptance: ['A1 可跑'] }
  const ok = validateReceipt(GOOD_RECEIPT, card)
  assert.equal(ok.ok, true, JSON.stringify(ok.problems))

  const missingSelf = GOOD_RECEIPT.split('SELF-CHECK:')[0]
  const bad = validateReceipt(missingSelf, card)
  assert.equal(bad.ok, false)
  assert.ok(bad.missing.includes('SELF-CHECK.gaps'))
})

test('回执：版本漂移与越界都要报出来（返工责任可归因）', () => {
  const card = { cardId: 'C1', authorization: { mode: 'rw', include: ['api/**'], deny: [], exclusive: [] }, artifactsVersion: { acceptance: 3 }, acceptance: ['A1 可跑'] }
  const stale = GOOD_RECEIPT.replace('acceptance=1', 'acceptance=2')
  const r = validateReceipt(stale, card)
  assert.equal(r.ok, false)
  assert.ok(r.problems.some(p => /acceptance=2/.test(p) && /3/.test(p)), '要说明读的是哪版、卡是哪版')

  // 越界不由回执闸门判（否则 worker 会学会隐瞒）；回执只如实申报，越界结论交给 gate。
  const cardV1 = { ...card, artifactsVersion: { acceptance: 1 } }
  const outOfScope = GOOD_RECEIPT.replace('changed: api/a.ts', 'changed: shared/types.ts')
  const r2 = validateReceipt(outOfScope, cardV1)
  assert.equal(r2.ok, true, '格式合规就放行，不因越界拒绝回执')
  assert.deepEqual(r2.parsed.outOfScope, ['shared/types.ts'], '但要标出越界，供 gate 用')
})

test('回执：卡号从派工 prompt 的【任务卡 X】取', () => {
  assert.equal(cardIdFromPrompt('【任务卡 C12】导入页'), 'C12')
  assert.equal(cardIdFromPrompt('没有标记'), null)
  assert.equal(parseReceipt('无关文本'), null)
})

test('工件：进行期（含 QUEUED）禁改，终止后可改', async () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const art = new ArtifactStore(store)
    art.write('C1', 'acceptance', 'A1 可跑')
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['api/**'] }, baseSha: null, acceptance: ['A1 可跑'] })
    card.artifactsVersion = { acceptance: 1 }
    store.save(card)

    assert.throws(() => art.write('C1', 'acceptance', '改口径'), (e) => e instanceof ArtifactError && e.code === 'CARD_IN_PROGRESS')

    store.transition(card, STATES.ABANDONED); store.save(card)
    const w = art.write('C1', 'acceptance', 'A1 新口径')
    assert.equal(w.version, 2)
  } finally { cleanup() }
})

test('工件：verify 只要求 acceptance，contracts 可选', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const art = new ArtifactStore(store)
    const card = makeCard({ cardId: 'C2', authorization: { mode: 'rw', include: ['app/**'] }, baseSha: null, acceptance: ['A1 空态'] })
    assert.equal(art.verify(card).ok, false, '没有 acceptance 不能通过')
    art.write('C2', 'acceptance', 'A1 空态有引导')
    card.artifactsVersion = { acceptance: 1 }
    assert.equal(art.verify(card).ok, true, '没有 contracts 也应通过')
  } finally { cleanup() }
})

test('回执闸门：写岗缺回执 block，只读岗与无卡号放行', async () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['api/**'] }, baseSha: null, acceptance: ['A1 可跑'] })
    card.artifactsVersion = { acceptance: 1 }
    store.save(card)
    const guard = makePostExecuteReceiptGuard({ store, config: { writerPresets: ['cto-builder'] } })
    const next = async () => ({ kind: 'accept' })

    const blocked = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '【任务卡 C1】x' } }, { content: [{ type: 'text', text: '完成了' }] }, next)
    assert.equal(blocked.kind, 'block')
    assert.match(blocked.feedback.map(b => b.text).join('\n'), /RECEIPT/)

    const passed = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '【任务卡 C1】x' } }, { content: [{ type: 'text', text: GOOD_RECEIPT.replace('card: C1', 'card: C1') }] }, next)
    assert.equal(passed.kind, 'accept')

    const ro = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-qa', prompt: '【任务卡 C1】x' } }, { content: [{ type: 'text', text: '无' }] }, next)
    assert.equal(ro.kind, 'accept')

    const noCard = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '随便看看' } }, { content: [{ type: 'text', text: '无' }] }, next)
    assert.equal(noCard.kind, 'accept')
  } finally { cleanup() }
})

// ── 回执与 git 事实的交叉核对 ────────────────────────────────────
import { crossCheckReceipt } from '../lib/card.js'

test('交叉核对：漏报、虚报、缺回执三种都要抓', () => {
  const base = { cardId: 'C1', authorization: { mode: 'rw', include: ['api/**'], deny: [], exclusive: [] } }
  const facts = { changed: [{ path: 'api/a.ts' }, { path: 'api/b.ts' }], untracked: [] }

  const under = crossCheckReceipt({ ...base, lastReceipt: { changed: ['api/a.ts'], scope: [] } }, facts)
  assert.deepEqual(under.map(v => v.kind + ':' + v.path), ['receipt-underclaim:api/b.ts'], '声明少了')

  const over = crossCheckReceipt({ ...base, lastReceipt: { changed: ['api/a.ts', 'api/ghost.ts'], scope: ['api/b.ts'] } }, facts)
  assert.deepEqual(over.map(v => v.kind + ':' + v.path), ['receipt-overclaim:api/ghost.ts'], '声明多了')

  const missing = crossCheckReceipt({ ...base, lastReceipt: null }, facts)
  assert.deepEqual(missing.map(v => v.kind), ['receipt-missing'])

  const ro = crossCheckReceipt({ cardId: 'C2', authorization: { mode: 'ro' }, lastReceipt: null }, facts)
  assert.equal(ro.length, 0, '只读卡不要求回执')

  const aligned = crossCheckReceipt({ ...base, lastReceipt: { changed: ['api/a.ts'], scope: ['api/b.ts'] } }, facts)
  assert.equal(aligned.length, 0, 'changed ∪ scope 覆盖事实即对齐')
})

// ── W4 证据来源分级 ─────────────────────────────────────────────
import { SOURCES, AUTHORITATIVE_SOURCES, classify, latestAuthoritative, summarize } from '../lib/evidence.js'

test('证据分级：只有三类来源权威，自述与未知来源都不参与判定', () => {
  assert.deepEqual([...AUTHORITATIVE_SOURCES], ['host-event', 'git-plumbing', 'subagent-session'])
  assert.equal(classify(SOURCES.GIT).authoritative, true)
  assert.equal(classify(SOURCES.CTO).authoritative, false)
  assert.equal(classify(SOURCES.CTO).reason, 'self-report')
  assert.equal(classify('rumor').authoritative, false, '未知来源 fail-closed')
  assert.equal(classify(undefined).authoritative, false)

  const ev = [
    { source: SOURCES.GIT, at: 10, verdict: 'CHANGES' },
    { source: SOURCES.CTO, at: 99, verdict: 'PASS' },   // 更新，但不算数
  ]
  assert.equal(latestAuthoritative(ev).verdict, 'CHANGES', '自述更新也不影响结论')
  const s = summarize(ev)
  assert.equal(s.total, 2)
  assert.equal(s.excluded, 1)
  assert.equal(s.bySource[SOURCES.CTO], 1)
})

test('卡仓库：自述写 PASS 不解锁结算，且被统计为排除项', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['api/**'] }, baseSha: 'a', acceptance: ['A1 可跑'] })
    card.artifactsVersion = { acceptance: 1 }
    store.save(card)
    store.transition(card, STATES.DISPATCHED); store.save(card)

    // 先落一条真实 CHANGES
    store.writeEvidence('C1', 'gate-1', { source: SOURCES.GIT, cardId: 'C1', verdict: 'CHANGES', at: 100 })
    // 再写一条「自述 PASS」，时间更新
    store.recordNote('C1', '我认为没问题 GATE: PASS')

    const latest = store.latestEvidence('C1')
    assert.equal(latest.verdict, 'CHANGES', '权威结论仍是 CHANGES')
    assert.equal(latest.source, SOURCES.GIT)

    const summary = store.evidenceSummary('C1')
    assert.equal(summary.bySource[SOURCES.CTO], 1)
    assert.equal(summary.excluded, 1)
  } finally { cleanup() }
})

// ── 宿主契约回归（真机安装暴露的两条） ──────────────────────────
import { apply as applyPlugin } from '../index.js'

test('apply 在「严格 ctx」下不抛：未 inject 的服务属性一律不得裸读', () => {
  // 模拟 cordis：访问未 inject 的服务属性直接抛错
  const registered = []
  const strict = new Proxy({
    tools: { register: () => () => {} },
    on: () => {},
    effect: fn => fn(),
    log: { warn: () => {} },
  }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (typeof prop === 'string' && /^(timer|agentPresets|workingDirectory|sandboxPolicy)$/.test(prop)) {
        throw new Error(`cannot get property "${prop}" without inject`)
      }
      return undefined
    },
  })
  assert.doesNotThrow(() => applyPlugin(strict, {}))
})

test('输出 schema 用标准 JSON Schema 方言：required 在对象上，不在属性上', async () => {
  const { buildTools } = await import('../lib/tools.js')
  const tools = buildTools({}, { registry: { get: () => ({}) }, config: {} })
  for (const [name, tool] of Object.entries(tools)) {
    const schema = tool.output?.schema
    assert.ok(schema, `${name} 缺 output.schema`)
    if (schema.required !== undefined) {
      assert.ok(Array.isArray(schema.required), `${name}: required 必须是数组`)
    }
    for (const [prop, spec] of Object.entries(schema.properties ?? {})) {
      assert.ok(!('required' in spec), `${name}.${prop}: 属性上不能写 required（宿主会拒绝）`)
    }
  }
})
