/**
 * M-12 指标 + 双门槛（方案 §14.7）。
 *
 * 五类指标全部来自已有机制，不新增组件：卡时长分布、阻塞率、越界检出率、回退率、共享文件冲突数。
 *
 * ── 双门槛（补 4）────────────────────────────────────────────────────
 *   ≥ 3 个独立工作周期 **且** ≥ 15 张卡，才允许给建议。
 *   判据看**趋势**：连续 2 个周期超阈值才建议，不看单点抖动。
 *   样本不足时只显示「数据不足」，**不显示建议** —— 这一条比阈值本身更重要：
 *   一个在 7 张卡上得出的「应该建 worktree」，事后无法与「数据支持」区分。
 *
 * ── 样本隔离（§14.6–14.7）─────────────────────────────────────────────
 *   注入样本（`card.sampleTag === 'injected'`）不进入任何比率的分母。
 *   隔离做在**卡**上、经 card join 过滤，所以一张卡内部不可能混样。
 *
 * ── 人工提前决策 ────────────────────────────────────────────────────
 *   允许人凭判断拍板，但必须记成「判断」而不是「证据」：
 *   `{ decision: 'early', sampleState: 'insufficient', decidedBy: 'human', reason, cardCount }`
 *   这样审计里能区分「有数据支持」与「凭判断拍板」，不会被后人误读。
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** 1970-01-05 是周一：周期按「自该日起的第几个 7 天」算，跨次运行稳定（不用「距今天数」）。 */
const EPOCH_MONDAY = Date.UTC(1970, 0, 5)

export const METRICS_SCHEMA = 'cto-office/metrics@1'
export const EARLY_DECISION_SCHEMA = 'cto-office/early-decision@1'

export const DEFAULT_METRICS = Object.freeze({
  cycleDays: 7,
  minCycles: 3,
  minCards: 15,
  consecutiveBreaches: 2,
  thresholds: Object.freeze({
    blockRate: 0.4,
    reworkRate: 0.3,
    outOfScopeRate: 0.2,
  }),
})

export function resolveMetricsConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  return {
    cycleDays: Number.isFinite(cfg.cycleDays) && cfg.cycleDays > 0 ? cfg.cycleDays : DEFAULT_METRICS.cycleDays,
    minCycles: Number.isFinite(cfg.minCycles) ? cfg.minCycles : DEFAULT_METRICS.minCycles,
    minCards: Number.isFinite(cfg.minCards) ? cfg.minCards : DEFAULT_METRICS.minCards,
    consecutiveBreaches: Number.isFinite(cfg.consecutiveBreaches) ? cfg.consecutiveBreaches : DEFAULT_METRICS.consecutiveBreaches,
    thresholds: { ...DEFAULT_METRICS.thresholds, ...(cfg.thresholds ?? {}) },
  }
}

/** 某个时间点落在第几个周期。 */
export function cycleIndexOf(at, cycleDays = DEFAULT_METRICS.cycleDays) {
  return Math.floor((at - EPOCH_MONDAY) / (cycleDays * DAY_MS))
}

export function cycleLabel(index, cycleDays = DEFAULT_METRICS.cycleDays) {
  const start = EPOCH_MONDAY + index * cycleDays * DAY_MS
  return new Date(start).toISOString().slice(0, 10)
}

function terminalAtOf(card) {
  for (const entry of card.history ?? []) {
    if (entry?.event === 'transition' && (entry.to === 'SETTLED' || entry.to === 'ABANDONED')) return entry.at ?? null
  }
  return null
}

/** 单张卡的事实抽取（纯函数，便于测试）。 */
export function cardFacts(card, evidence = [], now = Date.now()) {
  const judged = evidence.filter(item => item?.verdict === 'PASS' || item?.verdict === 'CHANGES')
  const violations = judged.flatMap(item => item?.violations ?? [])
  const outOfScope = violations.some(v => v?.kind === 'out-of-scope' || v?.kind === 'read-only-write')
  const history = card.history ?? []
  const blocked = Boolean(card.blockedBy) || history.some(entry => entry?.event === 'queued' || entry?.event === 'still-queued')
  const exclusiveExpired = history.some(entry => entry?.event === 'exclusive-expired')
  const terminalAt = terminalAtOf(card)
  const changed = new Set()
  for (const item of judged) for (const entry of item?.facts?.changed ?? []) if (entry?.path) changed.add(entry.path)
  for (const path of card.lastReceipt?.changed ?? []) changed.add(path)

  return {
    cardId: card.cardId,
    sampleTag: card.sampleTag ?? 'real',
    createdAt: card.createdAt ?? now,
    cycleIndex: cycleIndexOf(card.createdAt ?? now),
    state: card.state,
    rounds: card.rounds ?? 0,
    blocked,
    outOfScope,
    exclusiveExpired,
    judgedCount: judged.length,
    rework: (card.rounds ?? 0) >= 2,
    durationMs: terminalAt ? Math.max(0, terminalAt - (card.createdAt ?? terminalAt)) : null,
    inFlightMs: terminalAt ? null : Math.max(0, now - (card.createdAt ?? now)),
    changedPaths: [...changed],
    exclusive: card.authorization?.exclusive ?? [],
  }
}

const rate = (hit, total) => (total > 0 ? hit / total : null)

/** 共享文件冲突：两张卡的改动路径有交集 → 记一对冲突。 */
export function sharedFileConflicts(facts) {
  const conflicts = []
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i]
      const b = facts[j]
      const shared = a.changedPaths.filter(path => b.changedPaths.includes(path))
      if (shared.length > 0) conflicts.push({ cards: [a.cardId, b.cardId], paths: shared })
    }
  }
  return conflicts
}

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

/**
 * 计算指标并给出建议（或明确不给建议）。
 * @param cards 全部卡（含注入样本；本函数自己按 sampleTag 过滤）
 * @param evidenceFor (cardId) => evidence[]
 */
export function computeMetrics({ cards = [], evidenceFor = () => [], now = Date.now(), config = {} }) {
  const cfg = resolveMetricsConfig(config)
  const allFacts = cards.map(card => cardFacts(card, evidenceFor(card.cardId), now))
  const realFacts = allFacts.filter(f => f.sampleTag !== 'injected')
  const excludedInjected = allFacts.length - realFacts.length

  const judged = realFacts.filter(f => f.judgedCount > 0)
  const completed = realFacts.filter(f => f.durationMs !== null)

  const overall = {
    cardCount: realFacts.length,
    judgedCount: judged.length,
    blockRate: rate(realFacts.filter(f => f.blocked).length, realFacts.length),
    reworkRate: rate(judged.filter(f => f.rework).length, judged.length),
    outOfScopeRate: rate(realFacts.filter(f => f.outOfScope).length, realFacts.length),
    conflicts: sharedFileConflicts(realFacts),
    durationMs: {
      p50: percentile(completed.map(f => f.durationMs), 50),
      p90: percentile(completed.map(f => f.durationMs), 90),
      samples: completed.length,
    },
    inFlightCount: realFacts.filter(f => f.durationMs === null).length,
  }

  // 按周期聚合（周期键由 createdAt 决定：一张卡只属于一个周期）
  const byCycle = new Map()
  for (const fact of realFacts) {
    const list = byCycle.get(fact.cycleIndex) ?? []
    list.push(fact)
    byCycle.set(fact.cycleIndex, list)
  }
  const cycles = [...byCycle.keys()].sort((a, b) => a - b).map(index => {
    const list = byCycle.get(index)
    const judgedInCycle = list.filter(f => f.judgedCount > 0)
    return {
      index,
      label: cycleLabel(index, cfg.cycleDays),
      cardCount: list.length,
      judgedCount: judgedInCycle.length,
      blockRate: rate(list.filter(f => f.blocked).length, list.length),
      reworkRate: rate(judgedInCycle.filter(f => f.rework).length, judgedInCycle.length),
      outOfScopeRate: rate(list.filter(f => f.outOfScope).length, list.length),
      p50DurationMs: percentile(list.filter(f => f.durationMs !== null).map(f => f.durationMs), 50),
    }
  })

  const advice = advise({ overall, cycles, cfg })
  return {
    schema: METRICS_SCHEMA,
    generatedAt: now,
    config: cfg,
    sample: {
      total: allFacts.length,
      real: realFacts.length,
      excludedInjected,
      note: '比率的分母只含 sampleTag=real；注入样本经 card join 过滤，卡内不可能混样。',
    },
    overall,
    cycles,
    advice,
  }
}

/**
 * 双门槛判定。**数据不足时 recommendation 必须是 null**，不许给「倾向性建议」。
 */
export function advise({ overall, cycles, cfg }) {
  const cyclesWithData = cycles.filter(c => c.cardCount > 0)
  const problems = []
  if (overall.cardCount < cfg.minCards) problems.push(`卡数 ${overall.cardCount} < ${cfg.minCards}`)
  if (cyclesWithData.length < cfg.minCycles) problems.push(`周期数 ${cyclesWithData.length} < ${cfg.minCycles}`)
  if (problems.length > 0) {
    return {
      state: 'insufficient',
      recommendation: null,
      reasons: problems,
      message: `数据不足（${problems.join('；')}）。样本不足时不给建议 —— 凭判断拍板请用 action=early-decision 另记一笔。`,
      breaches: [],
    }
  }

  const recent = cyclesWithData.slice(-cfg.consecutiveBreaches)
  const enoughTrend = recent.length === cfg.consecutiveBreaches
  const breaches = []
  const checkTrend = (metric, threshold, toRecommendation) => {
    if (!enoughTrend) return
    const values = recent.map(c => c[metric])
    if (values.every(v => v !== null && v > threshold)) {
      breaches.push({ metric, threshold, values, cycles: recent.map(c => c.label), recommendation: toRecommendation })
    }
  }

  checkTrend('blockRate', cfg.thresholds.blockRate,
    '阻塞率连续超阈值：建议评估二期「解锁隔离」（worktree 并行），不要凭单点拍板')
  checkTrend('reworkRate', cfg.thresholds.reworkRate,
    '回退率连续超阈值：建议收紧卡粒度上限或强制拆卡（先别加并行，回退更贵）')
  checkTrend('outOfScopeRate', cfg.thresholds.outOfScopeRate,
    '越界率连续超阈值：建议收紧授权清单（include 写得更窄），或加派工前的路径预检')

  return {
    state: breaches.length > 0 ? 'suggest' : 'hold',
    recommendation: breaches.length > 0 ? breaches.map(b => b.recommendation) : null,
    reasons: breaches.length > 0 ? breaches.map(b => `${b.metric} 连续 ${cfg.consecutiveBreaches} 周期超 ${b.threshold}`) : ['趋势未连续超阈值，继续观察'],
    message: breaches.length > 0
      ? `建议：${breaches.map(b => b.recommendation).join('；')}`
      : `暂不建议动工（继续观察）：连续 ${cfg.consecutiveBreaches} 个周期的指标未同时超阈值。`,
    breaches,
  }
}

/** 人工提前决策记录（「判断」而非「证据」）。 */
export function makeEarlyDecision({ reason, cardCount, sampleState, decidedBy = 'human', now = Date.now() }) {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error('提前决策必须写 reason：审计里要能分清「有数据支持」和「凭判断拍板」。')
  }
  return {
    schema: EARLY_DECISION_SCHEMA,
    decision: 'early',
    sampleState: sampleState ?? 'insufficient',
    decidedBy,
    reason,
    cardCount: Number.isFinite(cardCount) ? cardCount : null,
    at: now,
  }
}

/** 一行摘要（给 office_status / 看板用）。 */
export function summarizeMetrics(metrics) {
  const { advice, overall, sample } = metrics
  const pct = value => (value === null ? '—' : `${Math.round(value * 100)}%`)
  return [
    `样本：真实 ${sample.real} 张（注入 ${sample.excludedInjected} 张已排除）`,
    `阻塞率 ${pct(overall.blockRate)}｜回退率 ${pct(overall.reworkRate)}｜越界率 ${pct(overall.outOfScopeRate)}｜共享冲突 ${overall.conflicts.length} 对`,
    `周期 ${metrics.cycles.length} 个｜时长 p50 ${overall.durationMs.p50 === null ? '—' : `${Math.round(overall.durationMs.p50 / 60000)} 分钟`}`,
    `判据：${advice.state === 'insufficient' ? '数据不足（不给建议）' : advice.state === 'suggest' ? '建议动工' : '继续观察'}`,
    advice.message,
  ].join('\n')
}
