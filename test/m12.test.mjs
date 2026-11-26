/**
 * M-12 指标与双门槛测试（方案 §14.7）。
 *
 * 守的是这几条，不是数字本身：
 *  1. 样本不足 → **不给建议**（recommendation 必须是 null）—— 这条比阈值更重要。
 *  2. 双门槛：≥ minCycles 个周期 且 ≥ minCards 张卡，两个都要满足。
 *  3. 看趋势：连续 2 个周期超阈值才建议，单点抖动不算。
 *  4. 样本隔离：injected 不进入任何比率的分母（经 card join 过滤）。
 *  5. 人工提前决策记成「判断」，必须带 reason。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CardStore } from '../lib/store.js'
import { makeCard } from '../lib/card.js'
import { buildTools } from '../lib/tools.js'
import { StoreRegistry } from '../lib/registry.js'
import {
  advise,
  cardFacts,
  computeMetrics,
  cycleIndexOf,
  cycleLabel,
  DEFAULT_METRICS,
  makeEarlyDecision,
  resolveMetricsConfig,
  sharedFileConflicts,
} from '../lib/metrics.js'

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-m12-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const DAY = 24 * 60 * 60 * 1000
/** 与实现同一个 epoch 对齐的周期起点（不能手写日期：2026-10-05 未必是周一）。 */
const EPOCH_MONDAY = Date.UTC(1970, 0, 5)
const WEEK0 = EPOCH_MONDAY + Math.floor((Date.UTC(2026, 9, 1) - EPOCH_MONDAY) / (7 * DAY)) * 7 * DAY
const week = n => WEEK0 + n * 7 * DAY

let seq = 0
/** 造一张卡（含被阻塞痕迹/终止时间/回执改动/样本标签）。 */
function fakeCard({ at, state = 'SETTLED', rounds = 0, blocked = false, sampleTag = null, changed = [], exclusive = [], durationMs = 2 * 60 * 60 * 1000 }) {
  seq += 1
  const card = makeCard({
    cardId: `T${seq}`,
    authorization: { mode: 'rw', include: ['**'], exclusive },
    baseSha: 'a'.repeat(40),
    sampleTag,
    now: at,
  })
  card.state = state
  card.rounds = rounds
  if (blocked) card.history.push({ at: at + 1000, event: 'queued', reason: 'serial-limit', holder: 'X' })
  if (state === 'SETTLED' || state === 'ABANDONED') {
    card.history.push({ at: at + durationMs, event: 'transition', from: 'DISPATCHED', to: state })
  }
  if (changed.length) card.lastReceipt = { changed, artifactsVersion: {} }
  return card
}

function judgedEvidence(changed = [], violations = []) {
  return { source: 'git-plumbing', verdict: violations.length > 0 || changed.length === 0 ? 'CHANGES' : 'PASS', violations, facts: { changed: changed.map(path => ({ path })) }, at: 1 }
}

// ── 周期 ────────────────────────────────────────────────────────────

test('周期：同一周同一周期，跨周递增；标签是周期起始日', () => {
  const monday = week(0)
  assert.equal(cycleIndexOf(monday), cycleIndexOf(monday + 6 * DAY), '同一周同一周期')
  assert.equal(cycleIndexOf(monday + 7 * DAY), cycleIndexOf(monday) + 1, '下一周 +1')
  assert.equal(cycleLabel(cycleIndexOf(monday)), new Date(monday).toISOString().slice(0, 10))
  // 周期长度可配：14 天周期下，第 8 天仍属同一周期
  assert.equal(cycleIndexOf(monday + 8 * DAY, 14), cycleIndexOf(monday, 14))
})

// ── 指标 ────────────────────────────────────────────────────────────

test('指标：阻塞率 / 回退率 / 越界率 / 冲突 / 时长 p50 都按定义算', () => {
  const cards = [
    fakeCard({ at: week(0), blocked: true, rounds: 2, changed: ['a.ts'] }),
    fakeCard({ at: week(0), blocked: false, rounds: 1, changed: ['a.ts', 'b.ts'] }),
    fakeCard({ at: week(0), blocked: false, rounds: 0, changed: ['c.ts'], durationMs: 4 * 60 * 60 * 1000 }),
  ]
  const evidence = new Map([
    [cards[0].cardId, [judgedEvidence(['a.ts'], [{ kind: 'out-of-scope', path: 'x.ts' }])]],
    [cards[1].cardId, [judgedEvidence(['a.ts', 'b.ts'])]],
    [cards[2].cardId, [judgedEvidence(['c.ts'])]],
  ])
  const report = computeMetrics({ cards, evidenceFor: id => evidence.get(id) ?? [], now: week(1) })

  assert.equal(report.overall.cardCount, 3)
  assert.equal(report.overall.blockRate, 1 / 3)
  assert.equal(report.overall.reworkRate, 1 / 3, 'rounds=2 算回退一次')
  assert.equal(report.overall.outOfScopeRate, 1 / 3)
  assert.equal(report.overall.conflicts.length, 1, 'a.ts 被两张卡改过 = 1 对冲突')
  assert.deepEqual(report.overall.conflicts[0].paths, ['a.ts'])
  assert.equal(report.overall.durationMs.samples, 3)
  assert.equal(report.cycles.length, 1)
})

test('样本隔离：injected 卡不进入比率分母，但计入 sample 统计', () => {
  const cards = [
    fakeCard({ at: week(0), blocked: false }),
    fakeCard({ at: week(0), blocked: true }),
    fakeCard({ at: week(0), blocked: true, sampleTag: 'injected' }),
    fakeCard({ at: week(0), blocked: true, sampleTag: 'injected' }),
  ]
  const report = computeMetrics({ cards, evidenceFor: () => [], now: week(1) })
  assert.equal(report.sample.real, 2)
  assert.equal(report.sample.excludedInjected, 2)
  assert.equal(report.overall.cardCount, 2, '分母只含真实样本')
  assert.equal(report.overall.blockRate, 0.5, '注入样本把阻塞率从 75% 拉到 50% —— 若混入就会失真')
})

// ── 双门槛 ──────────────────────────────────────────────────────────

const cfg = resolveMetricsConfig({})

test('双门槛：样本不足 → state=insufficient 且**没有建议**', () => {
  // 7 张卡、1 个周期：两个门槛都不够
  const cards = Array.from({ length: 7 }, () => fakeCard({ at: week(0), blocked: true }))
  const report = computeMetrics({ cards, evidenceFor: () => [], now: week(1) })
  assert.equal(report.advice.state, 'insufficient')
  assert.equal(report.advice.recommendation, null, '样本不足绝不给建议')
  assert.match(report.advice.message, /数据不足/)
  assert.deepEqual(report.advice.breaches, [])
})

test('双门槛：卡数够但周期不够 → 仍然 insufficient', () => {
  const cards = [
    ...Array.from({ length: 8 }, () => fakeCard({ at: week(0), blocked: true })),
    ...Array.from({ length: 8 }, () => fakeCard({ at: week(1), blocked: true })),
  ]
  const report = computeMetrics({ cards, evidenceFor: () => [], now: week(2) })
  assert.equal(report.overall.cardCount, 16, '卡数达标')
  assert.equal(report.cycles.length, 2, '周期只有 2 个')
  assert.equal(report.advice.state, 'insufficient', '两个门槛是 AND，不是 OR')
})

test('趋势：连续 2 个周期超阈值才建议；只超 1 个周期 → hold', () => {
  // 3 个周期 × 5 张，最近两个周期全阻塞 → suggest
  const sustained = [
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(0), blocked: false })),
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(1), blocked: true })),
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(2), blocked: true })),
  ]
  const a = computeMetrics({ cards: sustained, evidenceFor: () => [], now: week(3) })
  assert.equal(a.advice.state, 'suggest')
  assert.equal(a.advice.breaches[0].metric, 'blockRate')
  assert.match(a.advice.recommendation[0], /解锁隔离/)

  // 中间那个周期没超阈值 → 不构成「连续 2 周期」
  const single = [
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(0), blocked: false })),
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(1), blocked: false })),
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(2), blocked: true })),
  ]
  const b = computeMetrics({ cards: single, evidenceFor: () => [], now: week(3) })
  assert.equal(b.advice.state, 'hold')
  assert.equal(b.advice.recommendation, null, '单点抖动不给建议')
  assert.match(b.advice.message, /继续观察/)
})

test('阈值是参数：把 blockRate 门槛调到 1.01，同一个样本就不再建议', () => {
  const cards = [
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(0), blocked: false })),
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(1), blocked: true })),
    ...Array.from({ length: 5 }, () => fakeCard({ at: week(2), blocked: true })),
  ]
  const loose = computeMetrics({ cards, evidenceFor: () => [], config: { thresholds: { blockRate: 1.01 } }, now: week(3) })
  assert.equal(loose.advice.state, 'hold', '阈值必须真的生效，不能写死在代码里')
})

test('纯函数：advise 在双门槛不满足时一定返回 null 建议', () => {
  const verdict = advise({
    overall: { cardCount: 14, blockRate: 0.9, reworkRate: 0.9, outOfScopeRate: 0.9 },
    cycles: [{ label: 'w1', cardCount: 14, blockRate: 0.9, reworkRate: 0.9, outOfScopeRate: 0.9 }],
    cfg,
  })
  assert.equal(verdict.state, 'insufficient')
  assert.equal(verdict.recommendation, null)
})

test('卡时长：未终止的卡不算时长样本，但计入在飞数', () => {
  const done = fakeCard({ at: week(0), durationMs: 60 * 60 * 1000 })
  const flying = fakeCard({ at: week(0), state: 'DISPATCHED' })
  const report = computeMetrics({ cards: [done, flying], evidenceFor: () => [], now: week(1) })
  assert.equal(report.overall.durationMs.samples, 1)
  assert.equal(report.overall.inFlightCount, 1)
  assert.equal(report.overall.durationMs.p50, 60 * 60 * 1000)
})

test('共享文件冲突：只算真实样本之间的重叠路径', () => {
  const facts = [
    cardFacts(fakeCard({ at: week(0), changed: ['a.ts', 'b.ts'] })),
    cardFacts(fakeCard({ at: week(0), changed: ['b.ts', 'c.ts'] })),
    cardFacts(fakeCard({ at: week(0), changed: ['z.ts'] })),
  ]
  const conflicts = sharedFileConflicts(facts)
  assert.equal(conflicts.length, 1)
  assert.deepEqual(conflicts[0].paths, ['b.ts'])
})

// ── 人工提前决策 ────────────────────────────────────────────────────

test('人工提前决策：必须带 reason，且记成「判断」不是「证据」', () => {
  assert.throws(() => makeEarlyDecision({ reason: '  ', cardCount: 7 }), /reason/)
  const decision = makeEarlyDecision({ reason: '客户等着上线，先并行', cardCount: 7 })
  assert.equal(decision.decision, 'early')
  assert.equal(decision.sampleState, 'insufficient')
  assert.equal(decision.decidedBy, 'human')
  assert.equal(decision.cardCount, 7)
})

// ── 工具层 ──────────────────────────────────────────────────────────

test('office_metrics：report 返回指标；early-decision 落盘 jsonl 且不污染真实统计', async () => {
  const { dir, cleanup } = tmp()
  try {
    const store = new CardStore(dir)
    for (let i = 0; i < 3; i++) {
      const card = fakeCard({ at: week(0), blocked: i === 0 })
      store.save(card)
    }
    const config = { cardsDir: '.cto-office/cards', granularity: {}, supervisor: { enabled: false }, metrics: {} }
    const tools = buildTools({}, { registry: new StoreRegistry({ cardsDir: config.cardsDir }), config })

    const report = await tools.metrics.execute({ workspace: dir })
    assert.equal(report.cardCount, 3)
    assert.equal(report.adviceState, 'insufficient')
    assert.equal(report.conflicts, 0)
    assert.match(report.message, /数据不足/)

    const decided = await tools.metrics.execute({ workspace: dir, action: 'early-decision', reason: '先并行验证' })
    assert.equal(decided.decision.decision, 'early')
    const file = join(dir, '.cto-office', 'metrics', 'early-decisions.jsonl')
    const recorded = JSON.parse(readFileSync(file, 'utf8').trim().split('\n')[0])
    assert.equal(recorded.reason, '先并行验证')
    assert.equal(recorded.decidedBy, 'human')

    // 落盘的决策不影响指标口径
    const again = await tools.metrics.execute({ workspace: dir })
    assert.equal(again.cardCount, 3)
  } finally { cleanup() }
})
