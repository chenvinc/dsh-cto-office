/**
 * M-14 三处宿主门槛测试（方案 §14.9）。
 *
 *  1. 改判定器本身（cordis.patch.yml / preset 配置）→ 需人工确认
 *  2. 进行期禁改工件 → 已由 artifacts.write 实现，另有测试覆盖（这里只做交叉确认）
 *  3. exclusive 锁 TTL → 过期不再阻塞，但必须留审计，且**审计不得把锁续上**
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { CardStore } from '../lib/store.js'
import { STATES, makeCard } from '../lib/card.js'
import { makePreExecuteGuard } from '../lib/guards.js'
import { DEFAULT_EXCLUSIVE_TTL_MS, exclusiveClaimState } from '../lib/card.js'
import { Supervisor } from '../lib/supervisor.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { buildTools } from '../lib/tools.js'
import { StoreRegistry } from '../lib/registry.js'
import {
  APPROVAL_SCHEMA,
  defaultApprovalPath,
  isJudgementPlaneEdit,
  mintApproval,
  readApproval,
} from '../lib/patch-approval.js'

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-m14-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const ALLOW = async () => ({ kind: 'allow' })

function runGuard(config, exec) {
  const store = new CardStore(config.__dir ?? tmpdir())
  const guard = makePreExecuteGuard({ registry: { all: () => [store] }, store, config })
  return guard(exec, ALLOW)
}

// ── 1. 判定器本身的人工闸门 ─────────────────────────────────────────

test('人工闸门：哪些工具调用算「改判定器」', () => {
  assert.equal(isJudgementPlaneEdit('write', { file_path: '/w/cordis.patch.yml' }), true)
  assert.equal(isJudgementPlaneEdit('edit', { file_path: 'cordis.patch.yml' }), true)
  assert.equal(isJudgementPlaneEdit('bash', { command: 'sed -i "s/a/b/" cordis.patch.yml' }), true)
  assert.equal(isJudgementPlaneEdit('bash', { command: 'cp /tmp/new.yml cordis.patch.yml' }), true)
  assert.equal(isJudgementPlaneEdit('bash', { command: 'cat cordis.patch.yml' }), false, '读不拦')
  assert.equal(isJudgementPlaneEdit('bash', { command: 'grep preset-cto cordis.patch.yml' }), false)
  assert.equal(isJudgementPlaneEdit('bash', { command: 'npm run check' }), false)
  assert.equal(isJudgementPlaneEdit('read', { file_path: 'cordis.patch.yml' }), false)
  assert.equal(isJudgementPlaneEdit('write', { file_path: 'lib/tools.js' }), false, '普通代码不拦')
  assert.equal(isJudgementPlaneEdit('bash', { command: 'git diff cordis.patch.yml' }), false)
})

test('人工闸门：无审批 → deny；有未过期审批 → 放行；过期 → 又 deny', async () => {
  const { dir, cleanup } = tmp()
  try {
    const approvalPath = join(dir, 'approval.json')
    const config = { writerPresets: [], maxConcurrentWriters: 1, patchApproval: { path: approvalPath, ttlMs: 60_000 }, __dir: dir }

    const denied = await runGuard(config, { name: 'write', arguments: { file_path: 'cordis.patch.yml' } })
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /需要人工确认/)
    assert.match(denied.reason, /approve-patch-edit\.mjs/, '要告诉人怎么批准')
    assert.match(denied.reason, /工作区之外/, '要说明为什么 agent 绕不过去')

    mintApproval({ path: approvalPath, reason: '测试', ttlMs: 60_000 })
    const allowed = await runGuard(config, { name: 'write', arguments: { file_path: 'cordis.patch.yml' } })
    assert.equal(allowed.kind, 'allow')

    // 过期审批必须失效（例外门，不是永久门）
    const expired = readApproval({ path: approvalPath, now: Date.now() + 120_000 })
    assert.equal(expired.approved, false)
    assert.equal(expired.reason, 'approval-expired')

    // 普通文件始终不受影响
    const normal = await runGuard(config, { name: 'write', arguments: { file_path: 'lib/store.js' } })
    assert.equal(normal.kind, 'allow')
  } finally { cleanup() }
})

test('人工闸门：审批文件缺失 / 坏 JSON / schema 不对，一律 fail-closed', () => {
  const { dir, cleanup } = tmp()
  try {
    const path = join(dir, 'approval.json')
    assert.deepEqual(readApproval({ path }), { approved: false, reason: 'no-approval' })

    writeFileSync(path, '{broken')
    assert.equal(readApproval({ path }).reason, 'unreadable-approval')

    writeFileSync(path, JSON.stringify({ schema: 'nope', expiresAt: Date.now() + 1000 }))
    assert.equal(readApproval({ path }).reason, 'bad-approval-schema')

    writeFileSync(path, JSON.stringify({ schema: APPROVAL_SCHEMA, expiresAt: 'soon' }))
    assert.equal(readApproval({ path }).reason, 'bad-approval-ttl')
  } finally { cleanup() }
})

test('人工闸门：审批文件默认落在工作区之外（agent 沙箱写不到）', () => {
  const path = defaultApprovalPath()
  assert.match(path, /\.dsh[\\/]cto-office-patch-approval\.json$/)
  assert.ok(!path.startsWith(process.cwd()), '默认路径不能落在当前工作区里')
})

// ── 3. 锁 TTL ───────────────────────────────────────────────────────

test('锁 TTL：判定是纯函数 —— 活动即续租，过期只表示「别人不用再等」', () => {
  const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['db/**'], exclusive: ['db/schema.ts'] }, baseSha: 'a' })
  const now = Date.now()
  card.updatedAt = now
  assert.equal(exclusiveClaimState(card, now, DEFAULT_EXCLUSIVE_TTL_MS).live, true)

  card.updatedAt = now - (DEFAULT_EXCLUSIVE_TTL_MS + 1)
  const stale = exclusiveClaimState(card, now, DEFAULT_EXCLUSIVE_TTL_MS)
  assert.equal(stale.live, false)
  assert.ok(stale.idleMs > DEFAULT_EXCLUSIVE_TTL_MS * 0.99)

  // 没有声明互斥的卡永远不占用
  const plain = makeCard({ cardId: 'C2', authorization: { mode: 'rw', include: ['a.ts'] }, baseSha: 'a' })
  assert.equal(exclusiveClaimState(plain, now, DEFAULT_EXCLUSIVE_TTL_MS).held, false)
})

function makeRepo(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'cto-m14-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, '.gitignore'), '.cto-office/\n')
  for (const [name, content] of entries) {
    const full = join(dir, name)
    mkdirp(full)
    writeFileSync(full, content)
  }
  git('add', '-A'); git('commit', '-qm', 'init')
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

import { mkdirSync } from 'node:fs'
const mkdirp = file => mkdirSync(join(file, '..'), { recursive: true })

function makeDispatchRig(exclusiveTtlMs) {
  const repo = makeRepo([['db/schema.ts', 'x\n']])
  const config = {
    cardsDir: '.cto-office/cards',
    maxConcurrentWriters: 2,
    writerPresets: ['cto-builder'],
    defaultAgentPreset: 'cto-builder',
    granularity: {},
    supervisor: { enabled: false },
    exclusiveTtlMs,
  }
  const tools = buildTools({}, { registry: new StoreRegistry({ cardsDir: config.cardsDir }), config })
  return { dir: repo.dir, store: new CardStore(repo.dir), tools, config, cleanup: repo.cleanup }
}

/** 把卡的 updatedAt 往回拨（模拟「这张卡很久没动静」）。**不走 save()**，否则会把锁续上。 */
function ageCard(store, cardId, ms) {
  const path = store.cardPath(cardId)
  const card = JSON.parse(readFileSync(path, 'utf8'))
  card.updatedAt = Date.now() - ms
  writeFileSync(path, JSON.stringify(card, null, 2) + '\n')
}

const dispatchArgs = (workspace, cardId, exclusive) => ({
  workspace,
  cardId,
  subject: '共享 schema 改动',
  mode: 'rw',
  include: ['db/**'],
  exclusive,
})

test('锁 TTL：未过期 → 第二张卡进 QUEUED（exclusive-held）', async () => {
  const rig = makeDispatchRig(DEFAULT_EXCLUSIVE_TTL_MS)
  try {
    await rig.tools.dispatch.execute(dispatchArgs(rig.dir, 'C1', ['db/schema.ts']))
    const second = await rig.tools.dispatch.execute(dispatchArgs(rig.dir, 'C2', ['db/schema.ts']))
    assert.equal(second.state, STATES.QUEUED)
    assert.equal(second.blockedBy.reason, 'exclusive-held')
  } finally { rig.cleanup() }
})

test('锁 TTL：过期 → 不再阻塞，并留审计；审计不得把锁续上', async () => {
  const rig = makeDispatchRig(DEFAULT_EXCLUSIVE_TTL_MS)
  try {
    await rig.tools.dispatch.execute(dispatchArgs(rig.dir, 'C1', ['db/schema.ts']))
    ageCard(rig.store, 'C1', DEFAULT_EXCLUSIVE_TTL_MS + 60_000)
    const agedAt = rig.store.read('C1').updatedAt

    const second = await rig.tools.dispatch.execute(dispatchArgs(rig.dir, 'C2', ['db/schema.ts']))
    assert.equal(second.state, STATES.DISPATCHED, '过期占用不该继续挡人')
    assert.match(second.message, /锁 TTL/)

    const holder = rig.store.read('C1')
    const audit = (holder.history ?? []).find(h => h.event === 'exclusive-expired')
    assert.ok(audit, '过期必须留审计，不能静默放行')
    assert.equal(audit.ttlMs, DEFAULT_EXCLUSIVE_TTL_MS)
    assert.equal(holder.updatedAt, agedAt, '记账不能推进 updatedAt —— 否则等于把锁又续上了')
    assert.equal(exclusiveClaimState(holder, Date.now(), DEFAULT_EXCLUSIVE_TTL_MS).live, false, '过期状态必须保持')

    // 同一张卡只记一次（不每派一张就刷一条）
    const third = await rig.tools.dispatch.execute(dispatchArgs(rig.dir, 'C3', ['db/schema.ts']))
    assert.equal(third.state, STATES.QUEUED, '名额 2 已满 → 串行排队')
    assert.equal(rig.store.read('C1').history.filter(h => h.event === 'exclusive-expired').length, 1)
  } finally { rig.cleanup() }
})

test('锁 TTL：监督器报 exclusive-expired，且不重复刷同一条', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['db/**'], exclusive: ['db/schema.ts'] }, baseSha: 'a' })
    store.save(card)
    store.transition(card, STATES.DISPATCHED, {})
    store.save(card)
    ageCard(store, 'C1', 60 * 60 * 1000)

    const supervisor = new Supervisor(store, { exclusiveTtlMs: 45 * 60 * 1000, queuedAlertMs: 60 * 60 * 1000 })
    const first = supervisor.tick()
    const alert = first.find(a => a.reason === 'exclusive-expired')
    assert.ok(alert, '过期了必须报，不能无声挂着')
    assert.equal(alert.action, 'suggest-abandon', '报警要带可执行选项')
    assert.match(alert.message, /office_release C1 action=abandon/)

    const second = supervisor.tick()
    assert.equal(second.filter(a => a.reason === 'exclusive-expired').length, 0, '同一条不重复报')
  } finally { cleanup() }
})

// ── 2. 进行期禁改工件（交叉确认，主测试在 w1）────────────────────────

test('进行期禁改工件：DISPATCHED 卡改 acceptance 直接 deny', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const artifacts = new ArtifactStore(store)
    artifacts.write('C1', 'acceptance', 'A1 ok')
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['a.ts'] }, baseSha: 'a', acceptance: ['A1 ok'] })
    store.save(card)
    store.transition(card, STATES.DISPATCHED, {})
    store.save(card)
    assert.throws(() => artifacts.write('C1', 'acceptance', 'A1 ok\nA2 新增'), error => error.code === 'CARD_IN_PROGRESS')
  } finally { cleanup() }
})
