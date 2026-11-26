/**
 * W9 测试：监督器完整版（三段阈值 + 升级 + 续租）与每日看板（一个入口、三块）。
 *
 * 守的几条：
 *  1. 阈值是参数（改阈值必须真的改变行为，不能写死）；
 *  2. 升级要**多响一次**（warn → escalate），不能因为去重而永远看不见升级；
 *  3. 报警对象是持有者（不是等待者），且带可执行选项；
 *  4. 在飞卡自己 idle 也要管（漏洞二），活动即续租；
 *  5. 看板三块固定，昨日按**本地日**切，注入样本不进 gate 统计；
 *  6. 看板只读：不写任何状态。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CardStore } from '../lib/store.js'
import { STATES, makeCard } from '../lib/card.js'
import { Supervisor } from '../lib/supervisor.js'
import { buildDashboard, dayLabelOf, previousDayStartOf } from '../lib/dashboard.js'
import { buildTools } from '../lib/tools.js'
import { StoreRegistry } from '../lib/registry.js'

const MIN = 60 * 1000
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-w9-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function queuedBehind(store, holderId, waiterId, now) {
  const holder = makeCard({ cardId: holderId, authorization: { mode: 'rw', include: ['**'] }, baseSha: 'a', now: now - 10 * MIN })
  store.save(holder, now - 10 * MIN)
  store.transition(holder, STATES.DISPATCHED, {})
  store.save(holder, now - 10 * MIN)

  const waiter = makeCard({ cardId: waiterId, authorization: { mode: 'rw', include: ['**'] }, baseSha: null, now: now - 5 * MIN })
  waiter.blockedBy = { cardId: holderId, reason: 'serial-limit' }
  store.save(waiter, now - 5 * MIN)
  return { holder, waiter }
}

function ageCard(store, cardId, idleMs, now) {
  const card = store.read(cardId)
  card.updatedAt = now - idleMs
  const path = store.cardPath(cardId)
  writeFileSync(path, JSON.stringify(card, null, 2) + '\n')
}

// ── 监督器：queued 段与升级 ────────────────────────────────────────

test('监督器：阈值是参数 —— 未超不报，超了才报，且报的是持有者', () => {
  const { dir, cleanup } = tmp()
  try {
    const now = Date.UTC(2026, 10, 26, 4)
    const store = new CardStore(dir)
    queuedBehind(store, 'C1', 'C2', now)
    ageCard(store, 'C1', 30 * MIN, now)

    const fresh = new Supervisor(store, { queuedAlert: { thresholdMs: 60 * MIN }, now: () => now })
    assert.deepEqual(fresh.tick(), [], '30 分钟 < 60 分钟阈值，不报')

    ageCard(store, 'C1', 90 * MIN, now)
    const idle = new Supervisor(store, { queuedAlert: { thresholdMs: 60 * MIN }, now: () => now })
    const alerts = idle.tick()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].reason, 'holder-idle')
    assert.equal(alerts[0].cardId, 'C2', '报警挂在等待者身上，但文案说的是持有者')
    assert.equal(alerts[0].action, 'suggest-release')
    assert.match(alerts[0].message, /C1 已 idle/, '要报持有者')
    assert.match(alerts[0].message, /office_release C1 action=abandon/, '要带可执行选项')
  } finally { cleanup() }
})

test('监督器：升级是一条新报警（去重不能把升级吃掉）', () => {
  const { dir, cleanup } = tmp()
  try {
    const now = Date.UTC(2026, 10, 26, 4)
    const store = new CardStore(dir)
    queuedBehind(store, 'C1', 'C2', now)
    ageCard(store, 'C1', 70 * MIN, now)

    const supervisor = new Supervisor(store, { queuedAlert: { thresholdMs: 60 * MIN, escalateAfter: 2 }, now: () => now })
    const first = supervisor.tick()
    assert.equal(first[0].escalation, 1)
    assert.equal(supervisor.tick().length, 0, '同级别不重复刷')

    ageCard(store, 'C1', 130 * MIN, now) // > 60 × 2
    const escalated = supervisor.tick()
    const holderAlert = escalated.find(alert => alert.reason === 'holder-idle')
    assert.ok(holderAlert, '升级必须再响一次（去重不能把升级吃掉）')
    assert.equal(holderAlert.escalation, 2)
    assert.equal(holderAlert.action, 'suggest-abort')
    // 同一轮里在飞卡自己也超了 reclaim 阈值 → 另一条 card-idle（两个超时是独立的两件事）
    assert.ok(escalated.some(alert => alert.reason === 'card-idle'))
    assert.deepEqual(supervisor.pending().filter(a => a.reason === 'holder-idle').map(a => a.escalation), [1, 2])
    assert.equal(supervisor.ack(), escalated.length + 1)
  } finally { cleanup() }
})

test('监督器：老配置的扁平键（queuedAlertMs）仍然生效', () => {
  const { dir, cleanup } = tmp()
  try {
    const now = Date.UTC(2026, 10, 26, 4)
    const store = new CardStore(dir)
    queuedBehind(store, 'C1', 'C2', now)
    ageCard(store, 'C1', 90 * MIN, now)
    const supervisor = new Supervisor(store, { queuedAlertMs: 60 * MIN, now: () => now })
    assert.equal(supervisor.tick().length, 1, '升级不能把老配置静默弄失效')
  } finally { cleanup() }
})

test('监督器：在飞卡自己 idle 超阈值 → card-idle 建议 abort；有活动就不报', () => {
  const { dir, cleanup } = tmp()
  try {
    const now = Date.UTC(2026, 10, 26, 4)
    const store = new CardStore(dir)
    const card = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['**'] }, baseSha: 'a', now })
    store.save(card)
    store.transition(card, STATES.DISPATCHED, {})
    store.save(card)

    const fresh = new Supervisor(store, { cardIdleReclaim: { thresholdMs: 120 * MIN }, now: () => now })
    assert.deepEqual(fresh.tick(), [], '刚有活动 → 不报（活动即续租）')

    ageCard(store, 'C1', 150 * MIN, now)
    const idle = new Supervisor(store, { cardIdleReclaim: { thresholdMs: 120 * MIN }, now: () => now })
    const alerts = idle.tick()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0].reason, 'card-idle')
    assert.equal(alerts[0].action, 'suggest-abort')
    assert.match(alerts[0].message, /idle 150 分钟/)
  } finally { cleanup() }
})

// ── 每日看板 ────────────────────────────────────────────────────────

function boardFixture() {
  const { dir, cleanup } = tmp()
  const now = new Date(2026, 10, 26, 12, 0, 0).getTime() // 本地 2026-11-26 12:00
  const yesterday = new Date(2026, 10, 25, 10, 0, 0).getTime()
  const store = new CardStore(dir)

  // 在飞卡
  const flying = makeCard({ cardId: 'C1', authorization: { mode: 'rw', include: ['**'], exclusive: ['db/x.ts'] }, baseSha: 'abc12345678', now: now - 200 * MIN })
  store.save(flying, now - 200 * MIN)
  store.transition(flying, STATES.DISPATCHED, {})
  store.save(flying, now - 200 * MIN)

  // 已结算的真卡 + 昨日判定（PASS / CHANGES）
  const settled = makeCard({ cardId: 'C2', authorization: { mode: 'rw', include: ['**'] }, baseSha: 'b', now: now - 3 * 24 * 60 * MIN })
  store.save(settled, now - 3 * 24 * 60 * MIN)
  // QUEUED 不能直接 SETTLED：先 DISPATCHED 再结算（状态机是硬的）
  store.transition(settled, STATES.DISPATCHED, {})
  store.save(settled, now - 3 * 24 * 60 * MIN)
  store.transition(settled, STATES.SETTLED, {})
  store.save(settled, now - 3 * 24 * 60 * MIN)
  store.writeJudgement('C2', { intentId: 'i-pass', intentSeq: 1 }, { verdict: 'PASS', violations: [], stats: {}, at: yesterday })
  store.writeJudgement('C2', { intentId: 'i-changes', intentSeq: 2 }, { verdict: 'CHANGES', violations: [{ kind: 'out-of-scope', path: 'x' }], stats: {}, at: yesterday + MIN })

  // 今天的判定：不该进「昨日」
  store.writeJudgement('C2', { intentId: 'i-today', intentSeq: 3 }, { verdict: 'PASS', violations: [], stats: {}, at: now })

  // 注入样本的判定：不该进 gate 统计
  const injected = makeCard({ cardId: 'C3', authorization: { mode: 'rw', include: ['**'] }, baseSha: 'c', now: now - 60 * MIN, sampleTag: 'injected' })
  store.save(injected, now - 60 * MIN)
  store.transition(injected, STATES.DISPATCHED, {})
  store.save(injected, now - 60 * MIN)
  store.transition(injected, STATES.SETTLED, {})
  store.save(injected, now - 60 * MIN)
  store.writeJudgement('C3', { intentId: 'i-inj', intentSeq: 1 }, { verdict: 'PASS', violations: [], stats: {}, at: yesterday })

  return { dir, now, yesterday, store, cleanup }
}

test('看板：三块齐全，昨日按本地日切，注入样本不进 gate 统计', () => {
  const { store, now, yesterday, cleanup } = boardFixture()
  try {
    const board = buildDashboard({ store, config: {}, now })
    assert.equal(board.day, '2026-11-26')
    assert.equal(board.blocks.gate.day, dayLabelOf(previousDayStartOf(now)))
    assert.equal(board.blocks.gate.judged, 2, '昨天的 2 次（今天那次、注入那次都不算）')
    assert.equal(board.blocks.gate.pass, 1)
    assert.equal(board.blocks.gate.changes, 1)
    assert.deepEqual(board.blocks.gate.topViolations, [{ kind: 'out-of-scope', count: 1 }])
    assert.equal(board.blocks.inFlight.length, 1)
    assert.equal(board.blocks.inFlight[0].cardId, 'C1')
    assert.equal(board.blocks.inFlight[0].baseSha, 'abc12345', 'baseSha 只显示前 8 位')
    assert.match(board.message, /## ① 在飞卡/)
    assert.match(board.message, /## ② 昨日 gate 结果/)
    assert.match(board.message, /## ③ 异常信号/)
  } finally { cleanup() }
})

test('看板：异常信号收齐报警 / 互斥过期 / 坏证据 / idle 超阈值', () => {
  const { store, now, cleanup } = boardFixture()
  try {
    // 坏证据
    mkdirSync(store.evidenceDir('C2'), { recursive: true })
    writeFileSync(join(store.evidenceDir('C2'), 'broken.json'), '')
    // 互斥过期审计
    const card = store.read('C1')
    card.history = card.history ?? []
    card.history.push({ at: now, event: 'exclusive-expired', ttlMs: 45 * MIN })
    writeFileSync(store.cardPath('C1'), JSON.stringify(card, null, 2) + '\n')

    const supervisor = new Supervisor(store, {
      cardIdleReclaim: { thresholdMs: 120 * MIN },
      exclusiveTtl: { thresholdMs: 45 * MIN },
      now: () => now,
    })
    supervisor.tick()

    const board = buildDashboard({ store, supervisor, config: { cardIdleReclaimMs: 120 * MIN, exclusiveTtlMs: 45 * MIN }, now })
    const kinds = new Set(board.blocks.anomalies.map(a => a.kind))
    assert.ok(kinds.has('alert'), '待处理报警要在异常块里')
    assert.ok(kinds.has('corrupt-evidence'), '坏证据不能让看板装作没看见')
    assert.ok(kinds.has('exclusive-expired'), '互斥过期是异常信号')
    assert.ok(kinds.has('card-idle'), '在飞卡 idle 超阈值要进异常')
    assert.match(board.message, /## ③ 异常信号（\d+ 条）/)
  } finally { cleanup() }
})

test('看板：只读 —— 跑完不写任何状态', () => {
  const { store, dir, now, cleanup } = boardFixture()
  try {
    const cardCount = store.list().cards.length
    const evidenceCount = store.countEvidence('C2')
    buildDashboard({ store, config: {}, now })
    assert.equal(store.list().cards.length, cardCount)
    assert.equal(store.countEvidence('C2'), evidenceCount, '看板不许落新证据')
    assert.equal(store.list().corrupt.length, 0)
  } finally { cleanup() }
})

// ── 工具层 ──────────────────────────────────────────────────────────

test('office_dashboard：返回三块 + 人类可读摘要，指标判据与 M-12 同源', async () => {
  const { dir, now, store, cleanup } = boardFixture()
  try {
    const config = {
      cardsDir: '.cto-office/cards',
      granularity: {},
      supervisor: { enabled: false, cardIdleReclaim: { thresholdMs: 120 * MIN } },
      metrics: {},
    }
    const tools = buildTools({}, { registry: new StoreRegistry({ cardsDir: config.cardsDir }), config })
    const res = await tools.dashboard.execute({ workspace: dir })
    assert.equal(res.day, dayLabelOf(Date.now()))
    assert.equal(res.counts.inFlight, 1)
    // 工具层的「昨日」按**真实 now** 切，所以这里不断言具体次数（会随运行日期漂移）；
    // 日期窗口的精确行为由上面的 buildDashboard 用例显式传 now 验证。
    assert.equal(res.gate.day, dayLabelOf(previousDayStartOf(Date.now())))
    assert.equal(typeof res.gate.judged, 'number')
    assert.equal(res.gate.judged, res.gate.pass + res.gate.changes, '计数必须自洽')
    assert.equal(res.counts.realCards, 2, '注入样本不计入真实卡数')
    assert.equal(res.inFlight[0].cardId, 'C1')
    assert.match(res.message, /判据：数据不足/)
    assert.equal(store.list().cards.length, 3, '看板不创建/删除卡')
  } finally { cleanup() }
})
