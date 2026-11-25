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
