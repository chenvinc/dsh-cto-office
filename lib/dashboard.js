/**
 * 每日看板 —— **一个入口、三块**（方案 §14.7 / M-11 / W9 完整版）。
 *
 * 三块固定，不增不减（§14.10「节奏一天一次」：多一个入口就等于多一次确认）：
 *
 *   ① 在飞卡：谁在写、卡了多久、占着什么锁、被谁挡着
 *   ② 昨日 gate 结果：PASS / CHANGES 计数 + 违规类型 top3（**只取真实样本**）
 *   ③ 异常信号：待处理报警、互斥过期、坏卡/坏证据、idle 超阈值的在飞卡
 *
 * 设计边界：
 *  - **只读、只展示**，不做判定、不改任何状态；数据全部来自已有机制
 *    （`card.json` + `evidence/` + 监督器报警 + M-12 指标）。
 *  - 「昨日」按**本地日**切，不按 UTC：人看的是自己那一天。
 *  - 样本隔离沿用 M-12：注入样本不进 gate 统计。
 */
import { computeMetrics } from './metrics.js'
import { STATES, isTerminal } from './card.js'

export const DASHBOARD_SCHEMA = 'cto-office/dashboard@1'

const MINUTE = 60 * 1000

/** 当天 00:00（本地时区）。 */
export function dayStartOf(at) {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** 前一天的 00:00（本地时区）。 */
export function previousDayStartOf(at) {
  const date = new Date(dayStartOf(at))
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime()
}

export function dayLabelOf(at) {
  const date = new Date(at)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 组装看板。
 * @param {object} args
 * @param {object} args.store     CardStore
 * @param {object} [args.supervisor] 监督器（提供 pending()）
 * @param {object} [args.config]  监督器阈值配置（用于判断「卡了多久算异常」）
 * @param {number} [args.now]
 */
export function buildDashboard({ store, supervisor, config = {}, now = Date.now() } = {}) {
  const { cards, corrupt } = store.list()
  const dayStart = dayStartOf(now)
  const prevStart = previousDayStartOf(now)
  const evidenceFor = cardId => {
    try { return store.scanEvidence(cardId).items } catch { return [] }
  }

  // ── ① 在飞卡 ──────────────────────────────────────────────────
  const cardIdleMs = config.cardIdleReclaimMs ?? 120 * MINUTE
  const exclusiveTtlMs = config.exclusiveTtlMs ?? 45 * MINUTE
  const inFlight = cards
    .filter(card => !isTerminal(card.state))
    .map(card => {
      const idleMs = Math.max(0, now - (card.updatedAt ?? now))
      const exclusive = card.authorization?.exclusive ?? []
      return {
        cardId: card.cardId,
        state: card.state,
        preset: card.preset ?? null,
        rounds: card.rounds ?? 0,
        baseSha: card.baseSha ? String(card.baseSha).slice(0, 8) : null,
        idleMinutes: Math.round(idleMs / MINUTE),
        idleBeyondReclaim: idleMs >= cardIdleMs,
        blockedBy: card.blockedBy ?? null,
        exclusive,
        exclusiveExpired: exclusive.length > 0 && idleMs >= exclusiveTtlMs,
      }
    })
    .sort((a, b) => b.idleMinutes - a.idleMinutes)

  // ── ② 昨日 gate 结果（只取真实样本）────────────────────────────
  const realCards = cards.filter(card => card.sampleTag !== 'injected')
  const violations = new Map()
  const judged = []
  let passCount = 0
  let changesCount = 0
  for (const card of realCards) {
    for (const item of evidenceFor(card.cardId)) {
      if (item?.verdict !== 'PASS' && item?.verdict !== 'CHANGES') continue
      const at = item.at ?? 0
      if (at < prevStart || at >= dayStart) continue
      if (item.verdict === 'PASS') passCount += 1
      else changesCount += 1
      judged.push({ cardId: card.cardId, verdict: item.verdict, at, intentSeq: item.intentSeq ?? null })
      for (const violation of item.violations ?? []) {
        const kind = violation?.kind ?? 'unknown'
        violations.set(kind, (violations.get(kind) ?? 0) + 1)
      }
    }
  }
  const topViolations = [...violations.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, count]) => ({ kind, count }))
  const gate = {
    day: dayLabelOf(prevStart),
    windowStart: prevStart,
    windowEnd: dayStart,
    judged: judged.length,
    pass: passCount,
    changes: changesCount,
    passRate: judged.length > 0 ? passCount / judged.length : null,
    topViolations,
    cards: judged.sort((a, b) => a.at - b.at).map(item => ({ cardId: item.cardId, verdict: item.verdict })),
  }

  // ── ③ 异常信号 ────────────────────────────────────────────────
  const anomalies = []
  for (const alert of supervisor?.pending?.() ?? []) {
    anomalies.push({ kind: 'alert', reason: alert.reason, cardId: alert.cardId, action: alert.action, escalation: alert.escalation ?? 1, summary: alert.message })
  }
  for (const entry of corrupt) {
    anomalies.push({ kind: 'corrupt-card', cardId: entry.cardId, summary: `卡文件读不出来：${entry.reason}` })
  }
  for (const card of cards) {
    const scanned = (() => { try { return store.scanEvidence(card.cardId) } catch { return { corrupt: [] } } })()
    if (scanned.corrupt?.length) {
      anomalies.push({ kind: 'corrupt-evidence', cardId: card.cardId, count: scanned.corrupt.length, summary: `证据文件损坏：${scanned.corrupt.map(c => c.file).join(', ')}` })
    }
    if ((card.history ?? []).some(entry => entry?.event === 'exclusive-expired')) {
      anomalies.push({ kind: 'exclusive-expired', cardId: card.cardId, summary: '互斥占用已过期（已记审计），确认是否仍需要该卡' })
    }
  }
  for (const card of inFlight) {
    if (card.idleBeyondReclaim) {
      anomalies.push({ kind: 'card-idle', cardId: card.cardId, summary: `在飞卡 idle ${card.idleMinutes} 分钟（阈值 ${Math.round(cardIdleMs / MINUTE)} 分钟）` })
    }
  }

  // ── M-12 指标摘要（判据只在这里出现，不在看板里另算一套）──────────
  const metrics = computeMetrics({ cards, evidenceFor, now, config: config.metrics ?? {} })

  const blocks = {
    inFlight,
    gate,
    anomalies,
    metrics: {
      state: metrics.advice.state,
      cardCount: metrics.sample.real,
      excludedInjected: metrics.sample.excludedInjected,
      blockRate: metrics.overall.blockRate,
      reworkRate: metrics.overall.reworkRate,
      outOfScopeRate: metrics.overall.outOfScopeRate,
      message: metrics.advice.message,
    },
  }

  return {
    schema: DASHBOARD_SCHEMA,
    generatedAt: now,
    day: dayLabelOf(now),
    blocks,
    counts: {
      inFlight: inFlight.length,
      gateJudged: gate.judged,
      anomalies: anomalies.length,
      realCards: metrics.sample.real,
    },
    message: renderDashboard(blocks, { day: dayLabelOf(now), thresholdMinutes: Math.round(cardIdleMs / MINUTE) }),
  }
}

const pct = value => (value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`)

/** 人话三块（贴在 office_dashboard 的响应里，CTO 一次读得完）。 */
export function renderDashboard(blocks, meta = {}) {
  const lines = [`# 每日看板 ${meta.day ?? ''}`.trim(), '']

  lines.push(`## ① 在飞卡（${blocks.inFlight.length} 张）`)
  if (blocks.inFlight.length === 0) lines.push('（无）')
  for (const card of blocks.inFlight) {
    lines.push(`- ${card.cardId} ${card.state}｜idle ${card.idleMinutes} 分钟｜rounds=${card.rounds}｜baseSha=${card.baseSha ?? '—'}`
      + (card.blockedBy ? `｜等 ${card.blockedBy.cardId}(${card.blockedBy.reason})` : '')
      + (card.exclusive.length ? `｜互斥 ${JSON.stringify(card.exclusive)}${card.exclusiveExpired ? ' ⚠ 已过期' : ''}` : '')
      + (card.idleBeyondReclaim ? ` ⚠ 超 ${meta.thresholdMinutes} 分钟阈值` : ''))
  }

  lines.push('', `## ② 昨日 gate 结果（${blocks.gate.day}，真实样本）`)
  lines.push(`判定 ${blocks.gate.judged} 次：PASS ${blocks.gate.pass} ｜ CHANGES ${blocks.gate.changes} ｜ 通过率 ${pct(blocks.gate.passRate)}`)
  if (blocks.gate.topViolations.length > 0) {
    lines.push(`主要违规：${blocks.gate.topViolations.map(v => `${v.kind}×${v.count}`).join('、')}`)
  }
  if (blocks.gate.judged === 0) lines.push('（昨日没有判定记录）')

  lines.push('', `## ③ 异常信号（${blocks.anomalies.length} 条）`)
  if (blocks.anomalies.length === 0) lines.push('（无）')
  const byKind = new Map()
  for (const item of blocks.anomalies) byKind.set(item.kind, [...(byKind.get(item.kind) ?? []), item])
  for (const [kind, items] of byKind) {
    lines.push(`- ${kind} ×${items.length}`)
    for (const item of items.slice(0, 5)) lines.push(`  - ${item.cardId ? item.cardId + '：' : ''}${item.summary}`)
    if (items.length > 5) lines.push(`  - ……另有 ${items.length - 5} 条`)
  }

  lines.push('', `## 指标（M-12）`)
  lines.push(`真实样本 ${blocks.metrics.cardCount} 张（排除注入 ${blocks.metrics.excludedInjected}）｜阻塞率 ${pct(blocks.metrics.blockRate)}`
    + `｜回退率 ${pct(blocks.metrics.reworkRate)}｜越界率 ${pct(blocks.metrics.outOfScopeRate)}`)
  lines.push(`判据：${blocks.metrics.state === 'insufficient' ? '数据不足（不给建议）' : blocks.metrics.state === 'suggest' ? '建议动工' : '继续观察'}`)
  lines.push(blocks.metrics.message)

  return lines.join('\n')
}
