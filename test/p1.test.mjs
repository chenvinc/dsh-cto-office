/**
 * P1 来源校验（M-8 暴露的缺口）。
 *
 * 方案 §7.1c 把 P1 描述成「回执由宿主从子代理会话事件抓取 + **校验来源 preset**」。
 * 采集器此前只按卡号记账、不看 preset，所以只读岗（或任何被 CTO 拉进来的会话）
 * 都能替写卡交一份「我改了这些文件」的回执。这里补上：
 *
 *  - 采集层只**记事实**：`fromPreset` + `presetVerified`；
 *  - 判定层在**明知来源不对**时判 CHANGES（`receipt-source`）；
 *  - 拿不到 preset 时不据此打回 —— 否则接口不可用会把正常派工判成违规。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import { CardStore } from '../lib/store.js'
import { makeCard, crossCheckReceipt, STATES } from '../lib/card.js'
import { makeReceiptCollector } from '../lib/receipt-collector.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { buildTools } from '../lib/tools.js'
import { StoreRegistry } from '../lib/registry.js'

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-p1-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const RECEIPT = [
  'RECEIPT:',
  '- card: C1',
  '- artifactsVersion: acceptance=1',
  '- changed: a.ts',
  '- acceptance:',
  '  - A1 PASS 证据：pnpm test → 1 passed',
  'SELF-CHECK:',
  '- build: 无',
  '- tests: 无',
  '- scope: a.ts',
  '- gaps: 无',
].join('\n')

const eventOf = text => ({ type: 'assistant/message', data: { content: [{ type: 'text', text }] } })

function cardWithReceipt({ fromPreset, presetVerified, mode = 'rw' }) {
  const card = makeCard({ cardId: 'C1', authorization: { mode, include: ['a.ts'] }, baseSha: 'a', acceptance: ['A1 可跑'] })
  card.artifactsVersion = { acceptance: 1 }
  card.lastReceipt = { at: 1, changed: ['a.ts'], scope: [], acceptance: [], artifactsVersion: { acceptance: 1 }, fromPreset, presetVerified }
  return card
}

// ── 判定层（纯函数）──────────────────────────────────────────────────

test('来源校验：写卡收到只读岗的回执 → receipt-source 违规', () => {
  const violations = crossCheckReceipt(cardWithReceipt({ fromPreset: 'cto-architect', presetVerified: true }),
    { changed: [{ path: 'a.ts' }], untracked: [] })
  const hit = violations.find(v => v.kind === 'receipt-source')
  assert.ok(hit, '只读岗不能替写者交改动回执')
  assert.match(hit.detail, /只接受写岗/)
})

test('来源校验：写岗回执不产生违规', () => {
  const violations = crossCheckReceipt(cardWithReceipt({ fromPreset: 'cto-builder', presetVerified: true }),
    { changed: [{ path: 'a.ts' }], untracked: [] })
  assert.deepEqual(violations.filter(v => v.kind === 'receipt-source'), [])
})

test('来源校验：未知来源只记事实，不据此打回（接口不可用 ≠ 违规）', () => {
  const violations = crossCheckReceipt(cardWithReceipt({ fromPreset: null, presetVerified: false }),
    { changed: [{ path: 'a.ts' }], untracked: [] })
  assert.deepEqual(violations, [], '拿不到 preset 时不能把正常派工判成违规')
})

test('来源校验：只读卡不受这条约束（它本来就不该有回执）', () => {
  const violations = crossCheckReceipt(cardWithReceipt({ fromPreset: 'cto-architect', presetVerified: true, mode: 'ro' }),
    { changed: [], untracked: [] })
  // 只读卡上不该出现 receipt-source；其它类型的违规（如申报与实际不符）本函数仍照常报
  assert.deepEqual(violations.filter(v => v.kind === 'receipt-source'), [])
})

test('来源校验：写岗清单是参数，不是写死的 cto-builder', () => {
  const card = cardWithReceipt({ fromPreset: 'cto-qa', presetVerified: true })
  const facts = { changed: [{ path: 'a.ts' }], untracked: [] }
  assert.deepEqual(crossCheckReceipt(card, facts, { writerPresets: ['cto-builder'] }).filter(v => v.kind === 'receipt-source').length, 1)
  assert.deepEqual(crossCheckReceipt(card, facts, { writerPresets: ['cto-qa'] }).filter(v => v.kind === 'receipt-source').length, 0)
})

// ── 采集层 ──────────────────────────────────────────────────────────

test('采集：记录回执来自哪个 preset（宿主返回的是 preset id 字符串）', () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['a.ts'] }, baseSha: 'a', acceptance: ['A1 可跑'] })
    card.artifactsVersion = { acceptance: 1 }
    store.save(card)

    const collector = makeReceiptCollector({
      registry: { all: () => [store] },
      agentPresets: { presetForSession: () => 'cto-architect' },
    })
    collector({ id: 's1' }, eventOf(RECEIPT))

    const recorded = store.read('C1').lastReceipt
    assert.equal(recorded.fromPreset, 'cto-architect')
    assert.equal(recorded.presetVerified, true)
    const evidence = store.listEvidence('C1')[0]
    assert.equal(evidence.receipt.fromPreset, 'cto-architect', '证据里也要留痕，方便事后归因')
  } finally { cleanup() }
})

test('采集：拿不到 agentPresets / 抛错 → presetVerified=false，回执仍然记账', () => {
  const { dir, cleanup } = tmp()
  try {
    for (const agentPresets of [undefined, { presetForSession: () => { throw new Error('cannot get property') } }]) {
      const store = new CardStore(join(dir, Math.random().toString(36).slice(2)))
      const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['a.ts'] }, baseSha: 'a', acceptance: ['A1 可跑'] })
      card.artifactsVersion = { acceptance: 1 }
      store.save(card)

      const collector = makeReceiptCollector({ registry: { all: () => [store] }, agentPresets })
      collector({ id: 's1' }, eventOf(RECEIPT))
      const recorded = store.read('C1').lastReceipt
      assert.ok(recorded, '回执不能因为探测不到 preset 就丢掉')
      assert.equal(recorded.fromPreset, null)
      assert.equal(recorded.presetVerified, false)
    }
  } finally { cleanup() }
})

// ── 端到端：错误 preset 的回执让 gate 判 CHANGES ─────────────────────

function makeGateRig() {
  const dir = mkdtempSync(join(tmpdir(), 'cto-p1-git-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(dir, '.gitignore'), '.cto-office/\n')
  writeFileSync(join(dir, 'a.ts'), 'v1\n')
  git('add', '-A'); git('commit', '-qm', 'init')

  const store = new CardStore(dir)
  const artifacts = new ArtifactStore(store)
  artifacts.write('C1', 'acceptance', 'A1 可跑')
  const versions = artifacts.versions('C1')
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
  const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['a.ts'] }, baseSha, acceptance: ['A1 可跑'] })
  // 与 dispatch 同口径：只冻结版本 > 0 的工件（否则回执声明的 acceptance=1 会被判版本漂移）
  card.artifactsVersion = Object.fromEntries(Object.entries(versions).filter(([, v]) => v > 0))
  store.save(card)
  store.transition(card, STATES.DISPATCHED, {})
  store.save(card)

  appendFileSync(join(dir, 'a.ts'), 'v2\n')
  git('add', '-A'); git('commit', '-qm', 'work')

  const config = { cardsDir: '.cto-office/cards', granularity: {}, supervisor: { enabled: false }, maxConcurrentWriters: 1, writerPresets: ['cto-builder'] }
  const tools = buildTools({}, { registry: new StoreRegistry({ cardsDir: config.cardsDir }), config })
  return { dir, store, tools, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('端到端：只读岗交的回执 → gate 判 CHANGES（receipt-source）', async () => {
  const rig = makeGateRig()
  try {
    const collector = makeReceiptCollector({
      registry: { all: () => [rig.store] },
      agentPresets: { presetForSession: () => 'cto-architect' },
    })
    collector({ id: 's1' }, eventOf(RECEIPT))

    const res = await rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' })
    assert.equal(res.verdict, 'CHANGES')
    assert.ok(res.violations.some(v => v.kind === 'receipt-source'), JSON.stringify(res.violations))
  } finally { rig.cleanup() }
})

test('端到端：写岗交的回执 → gate 判 PASS（不误伤正常链路）', async () => {
  const rig = makeGateRig()
  try {
    const collector = makeReceiptCollector({
      registry: { all: () => [rig.store] },
      agentPresets: { presetForSession: () => 'cto-builder' },
    })
    collector({ id: 's1' }, eventOf(RECEIPT))

    const res = await rig.tools.gate.execute({ workspace: rig.dir, cardId: 'C1' })
    assert.equal(res.verdict, 'PASS', JSON.stringify(res.violations))
  } finally { rig.cleanup() }
})
