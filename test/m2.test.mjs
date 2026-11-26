/**
 * M-2 判定事务测试（方案 §14.2 / §14.3）。
 *
 * 这一组测试守的是三条不变量，不是实现细节：
 *  1. intent 先于判定落盘 → 崩溃最坏是「intent 有、result 无」，重跑幂等。
 *  2. 结果只新建不覆盖 → 重跑不毁已有结论。
 *  3. latest-wins → 旧孤儿绝不重跑，否则陈旧结论会盖掉新结论。
 * 外加一条由 M-2 带出的真缺陷回归：结算只认「有 verdict 的判定结论」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { CardStore } from '../lib/store.js'
import { INTENT_SCHEMA, INTENT_STATE, beginIntent, listIntents, markIntentState, recoverIntents, writeResult } from '../lib/intent.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { STATES, makeCard } from '../lib/card.js'
import { buildTools } from '../lib/tools.js'
import { StoreRegistry } from '../lib/registry.js'

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-m2-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const meta = (over = {}) => ({ cardId: 'C1', action: 'judge', baseSha: 'a'.repeat(40), artifactsVersion: { acceptance: 1 }, ...over })

function rigDirs(dir) {
  const intentsDir = join(dir, 'intents')
  const evidenceDir = join(dir, 'evidence')
  return { intentsDir, evidenceDir, resultPathFor: intentId => join(evidenceDir, `${intentId}.json`) }
}

// ── 纯事务层 ─────────────────────────────────────────────────────────

test('事务：坏 intent 文件名 / 坏 JSON / 重复 seq 都进 corrupt，不静默跳过', () => {
  const { dir, cleanup } = tmp()
  try {
    const { intentsDir } = rigDirs(dir)
    mkdirSync(intentsDir, { recursive: true })
    writeFileSync(join(intentsDir, 'not-an-intent.json'), '{}')
    writeFileSync(join(intentsDir, '000001-11111111-1111-1111-1111-111111111111.json'), '{broken')
    const a = beginIntent(intentsDir, meta(), 1)
    // 人为复制出同 seq 的第二条（现实中只会来自并发写坏）
    writeFileSync(join(intentsDir, `00000${a.intentSeq}-22222222-2222-2222-2222-222222222222.json`), JSON.stringify({ ...a, intentId: '22222222-2222-2222-2222-222222222222' }))

    const { corrupt, intents } = listIntents(intentsDir)
    assert.ok(corrupt.some(c => c.file === 'not-an-intent.json'), '无法识别的文件名要报')
    assert.ok(corrupt.some(c => /invalid json|0 bytes/i.test(c.reason)), '坏 JSON 要报')
    assert.ok(corrupt.some(c => /duplicate intentSeq/.test(c.reason)), '重复 seq 要报')
    assert.equal(intents.length, 2)
  } finally { cleanup() }
})

test('事务：崩溃点是「intent 有、result 无」→ 复用同一 intentId 重跑', () => {
  const { dir, cleanup } = tmp()
  try {
    const dirs = rigDirs(dir)
    const intent = beginIntent(dirs.intentsDir, meta(), 1000)
    assert.equal(intent.intentSeq, 1, '第一条 intent 的 seq 从 1 开始')

    const scan = recoverIntents({ ...dirs, now: 2000 })
    assert.equal(scan.resumable.intentId, intent.intentId, '要复用，不是新开')
    assert.equal(scan.resumable.intentSeq, 1)
    assert.deepEqual(scan.abandoned, [])
    assert.deepEqual(scan.corrupt, [])
  } finally { cleanup() }
})

test('latest-wins：只重跑最新 seq，旧孤儿标 abandoned 且落盘（不会被再次拾起）', () => {
  const { dir, cleanup } = tmp()
  try {
    const dirs = rigDirs(dir)
    const older = beginIntent(dirs.intentsDir, meta(), 1000)
    const newer = beginIntent(dirs.intentsDir, meta(), 1001)
    assert.equal(newer.intentSeq, older.intentSeq + 1)

    const scan = recoverIntents({ ...dirs, now: 2000 })
    assert.equal(scan.resumable.intentId, newer.intentId, '最新 seq 才重跑')
    assert.deepEqual(scan.abandoned.map(a => a.intentSeq), [older.intentSeq], '旧的必须作废')

    // 作废必须落盘：否则下次扫描会把它当孤儿再重跑
    const persisted = listIntents(dirs.intentsDir).intents.find(i => i.intentId === older.intentId)
    assert.equal(persisted.state, INTENT_STATE.ABANDONED)
    assert.equal(persisted.reason, 'stale-intent')

    const again = recoverIntents({ ...dirs, now: 3000 })
    assert.deepEqual(again.abandoned, [], '已作废的不会被反复处理')
    assert.equal(again.resumable.intentId, newer.intentId)
  } finally { cleanup() }
})

test('事务：已 result-written 的不重跑；结果文件丢了才判 corrupt', () => {
  const { dir, cleanup } = tmp()
  try {
    const dirs = rigDirs(dir)
    const intent = beginIntent(dirs.intentsDir, meta(), 1000)
    writeResult(dirs.resultPathFor(intent.intentId), { intentId: intent.intentId, verdict: 'PASS' }, 1001)
    markIntentState(dirs.intentsDir, intent, INTENT_STATE.RESULT_WRITTEN, { verdict: 'PASS' }, 1002)

    const scan = recoverIntents({ ...dirs, now: 2000 })
    assert.equal(scan.resumable, null, '已完成的事务不能再被重跑')
    assert.deepEqual(scan.corrupt, [])

    rmSync(dirs.resultPathFor(intent.intentId))
    const broken = recoverIntents({ ...dirs, now: 3000 })
    assert.equal(broken.corrupt.length, 1, '「说写了结果」但文件不在 = 损坏，不许当无事发生')
  } finally { cleanup() }
})

test('事务：结果只新建不覆盖 —— 同一 intentId 重写必须保留第一次的结论', () => {
  const { dir, cleanup } = tmp()
  try {
    const dirs = rigDirs(dir)
    const intent = beginIntent(dirs.intentsDir, meta(), 1000)
    const first = writeResult(dirs.resultPathFor(intent.intentId), { intentId: intent.intentId, verdict: 'CHANGES' }, 1001)
    const second = writeResult(dirs.resultPathFor(intent.intentId), { intentId: intent.intentId, verdict: 'PASS' }, 1002)

    assert.equal(first.created, true)
    assert.equal(second.created, false, 'EEXIST 是幂等命中，不是错误')
    assert.equal(JSON.parse(readFileSync(dirs.resultPathFor(intent.intentId), 'utf8')).verdict, 'CHANGES', '结论不能被后来者改写')
  } finally { cleanup() }
})

// ── 仓库层：结算只认判定结论 ─────────────────────────────────────────

test('结算口径：回执晚于 PASS 也不能顶掉判定结论（latestEvidence 会，latestJudgement 不会）', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const intent = store.beginIntent('C1', { action: 'judge', baseSha: 'x', artifactsVersion: { acceptance: 1 } })
    store.writeJudgement('C1', intent, { verdict: 'PASS', violations: [], stats: { files: 1, lines: 1 }, at: 100 })
    // 合规回执也是权威来源，但它没有 verdict —— 且时间更晚
    store.writeEvidence('C1', 'receipt-200', { source: 'subagent-session', cardId: 'C1', at: 200, receipt: { changed: ['a.ts'] } })

    assert.equal(store.latestEvidence('C1').at, 200, '旧的「最新证据」口径确实会拿到回执（这正是缺陷）')
    assert.equal(store.latestJudgement('C1').verdict, 'PASS', '结算必须只认判定结论')
    assert.equal(store.latestJudgement('C1').intentSeq, intent.intentSeq)
  } finally { cleanup() }
})

test('结算口径：证据损坏时 latestJudgement fail-closed（不许容错成「没有结论」）', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const intent = store.beginIntent('C1', { action: 'judge', baseSha: 'x', artifactsVersion: { acceptance: 1 } })
    store.writeJudgement('C1', intent, { verdict: 'PASS', violations: [], stats: {}, at: 100 })
    writeFileSync(join(store.evidenceDir('C1'), 'broken.json'), '')

    assert.equal(store.scanEvidence('C1').corrupt.length, 1)
    assert.throws(() => store.latestJudgement('C1'), error => error.code === 'CORRUPT')
    assert.equal(store.listEvidence('C1').length, 1, '面板视图仍可读（宽容），判定视图才严格')
  } finally { cleanup() }
})

// ── gate 集成 ────────────────────────────────────────────────────────

function makeRepoWith(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'cto-m2-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, '.gitignore'), '.cto-office/\n')
  for (const [name, content] of entries) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  git('add', '-A'); git('commit', '-qm', 'init')
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 一张已派工、工件已冻结、且回执与 diff 对齐的卡 + 可调用的 office_gate。 */
function makeGateRig() {
  const repo = makeRepoWith([['a.ts', 'v1\n']])
  const store = new CardStore(repo.dir)
  const artifacts = new ArtifactStore(store)
  artifacts.write('C1', 'acceptance', 'A1 可跑') // 工件先于卡
  const versions = artifacts.versions('C1')
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim()
  const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['a.ts'] }, baseSha, acceptance: ['A1 可跑'] })
  card.artifactsVersion = versions
  store.save(card)
  store.transition(card, STATES.DISPATCHED, {})
  store.save(card)

  // 真改一个文件并提交，再补与 diff 对齐的回执（否则 PASS 前会被 receipt-missing / overclaim 拦）。
  // 直接落 card.lastReceipt，不写 evidence —— 本组测试要数的是**判定证据**的条数。
  appendFileSync(join(repo.dir, 'a.ts'), 'v2\n')
  repo.git('add', '-A'); repo.git('commit', '-qm', 'work')
  card.lastReceipt = { at: Date.now(), changed: ['a.ts'], scope: [], acceptance: [], artifactsVersion: versions }
  store.save(card)

  const config = { cardsDir: '.cto-office/cards', granularity: {}, supervisor: { enabled: false }, maxConcurrentWriters: 1 }
  const tools = buildTools({}, { registry: new StoreRegistry({ cardsDir: config.cardsDir }), config })
  return { dir: repo.dir, store, tools, card, cleanup: repo.cleanup }
}

test('gate：每次判定一个新 intent，结论一件一文件、永不复用', async () => {
  const rig = makeGateRig()
  try {
    const first = await rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' })
    const second = await rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' })

    assert.equal(first.verdict, 'PASS')
    assert.match(first.message, /intent #1/)
    assert.match(second.message, /intent #2/)
    assert.equal(rig.store.read('C1').rounds, 2, '两次判定 = 两轮')
    assert.equal(rig.store.countEvidence('C1'), 2, '两次判定两份证据')

    const { intents } = listIntents(rig.store.intentsDir('C1'))
    assert.deepEqual(intents.map(i => i.intentSeq), [1, 2])
    assert.ok(intents.every(i => i.state === INTENT_STATE.RESULT_WRITTEN))
  } finally { rig.cleanup() }
})

test('gate：崩溃恢复复用同一 intentId —— 不重判、不重复计轮、不多写证据', async () => {
  const rig = makeGateRig()
  try {
    // 模拟崩溃现场：intent 已登记、结论已落盘，但卡上还没记账
    const intent = rig.store.beginIntent('C1', { action: 'judge', baseSha: rig.card.baseSha, artifactsVersion: rig.card.artifactsVersion })
    rig.store.writeJudgement('C1', intent, { baseSha: rig.card.baseSha, verdict: 'PASS', violations: [], stats: { files: 0, lines: 0, dirtyPaths: [] }, at: 5 })

    const resumed = await rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' })
    assert.match(resumed.message, /崩溃恢复/)
    assert.match(resumed.message, new RegExp(`intent #${intent.intentSeq}`), '复用同一条事务')
    assert.equal(rig.store.read('C1').rounds, 1, '崩溃恢复不能把轮次算两遍')
    assert.equal(rig.store.countEvidence('C1'), 1, '结论不能被重判覆盖')
    assert.equal(rig.store.listEvidence('C1')[0].verdict, 'PASS')

    // 收尾之后再判才是新事务
    const next = await rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' })
    assert.match(next.message, /intent #2/)
    assert.equal(rig.store.countEvidence('C1'), 2)
  } finally { rig.cleanup() }
})

test('gate：内容三元组只做有效性断言 —— baseSha 变了就作废旧 intent、开新事务', async () => {
  const rig = makeGateRig()
  try {
    const stale = rig.store.beginIntent('C1', { action: 'judge', baseSha: 'deadbeef'.repeat(5), artifactsVersion: rig.card.artifactsVersion })

    const result = await rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' })
    assert.equal(result.verdict, 'PASS', '作废旧 intent 后应照常完成判定')

    const { intents } = listIntents(rig.store.intentsDir('C1'))
    const abandoned = intents.find(i => i.intentId === stale.intentId)
    assert.equal(abandoned.state, INTENT_STATE.ABANDONED)
    assert.equal(abandoned.reason, 'stale-context')

    const fresh = intents.find(i => i.intentId !== stale.intentId)
    assert.equal(fresh.intentSeq, stale.intentSeq + 1, '作废重开必须拿更大的 seq')
    assert.equal(fresh.state, INTENT_STATE.RESULT_WRITTEN)
  } finally { rig.cleanup() }
})

test('gate：intent 损坏时拒绝判定，而不是当作没有在飞事务', async () => {
  const rig = makeGateRig()
  try {
    mkdirSync(rig.store.intentsDir('C1'), { recursive: true })
    writeFileSync(join(rig.store.intentsDir('C1'), '000009-33333333-3333-3333-3333-333333333333.json'), '{oops')
    await assert.rejects(
      () => rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' }),
      error => /判定事务状态损坏/.test(error.message),
    )
    assert.equal(rig.store.countEvidence('C1'), 0, '拒绝判定时不许落结论')
  } finally { rig.cleanup() }
})
