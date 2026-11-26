/**
 * 卡仓库（方案 §14.2 事务语义 / §14.4 终止态复合动作）。
 *
 * 布局：<workspace>/.cto-office/cards/<cardId>/card.json
 * card.json 必须原地更新 → 用覆盖替换五步；证据文件用「一件一文件」主路径（见 lib/atomic.js）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { replaceJson, readJsonStrict, writeOnceJson, CorruptError } from './atomic.js'
import { INTENT_STATE, beginIntent, markIntentState, recoverIntents, writeResult } from './intent.js'
import { CARD_SCHEMA, IllegalTransitionError, STATES, canTransition, isTerminal, BLOCK_REASONS } from './card.js'
import { SOURCES, isAuthoritative, latestAuthoritative, summarize } from './evidence.js'

export class CardStore {
  constructor(root, options = {}) {
    this.root = root
    this.dir = options.cardsDir ? join(root, options.cardsDir) : join(root, '.cto-office', 'cards')
    this.dirSyncedWarned = false
  }

  cardDir(cardId) {
    return join(this.dir, cardId)
  }

  cardPath(cardId) {
    return join(this.cardDir(cardId), 'card.json')
  }

  evidenceDir(cardId) {
    return join(this.cardDir(cardId), 'evidence')
  }

  /** 判定事务的登记目录（方案 §14.2）。与 evidence 分开：intent 是游标，evidence 是只读结论。 */
  intentsDir(cardId) {
    return join(this.cardDir(cardId), 'intents')
  }

  /** 一次判定的结论文件：`evidence/<intentId>.json`，只新建、永不覆盖。 */
  judgementPath(cardId, intentId) {
    return join(this.evidenceDir(cardId), `${intentId}.json`)
  }

  /** 读卡；损坏抛 CorruptError，缺失返回 undefined。 */
  read(cardId) {
    return readJsonStrict(this.cardPath(cardId))
  }

  /** 列出全部卡（坏卡单独归到 corrupt，不让一张坏卡炸掉整个列表）。 */
  list() {
    if (!existsSync(this.dir)) return { cards: [], corrupt: [] }
    const cards = []
    const corrupt = []
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const card = this.read(entry.name)
        if (card) {
          if (card.schema !== CARD_SCHEMA) corrupt.push({ cardId: entry.name, reason: `schema ${card.schema}` })
          else cards.push(card)
        }
      } catch (error) {
        corrupt.push({ cardId: entry.name, reason: error instanceof CorruptError ? error.message : String(error) })
      }
    }
    return { cards, corrupt }
  }

  save(card, now = Date.now()) {
    card.updatedAt = now
    const result = replaceJson(this.cardPath(card.cardId), card)
    if (!result.dirSynced && !this.dirSyncedWarned) {
      this.dirSyncedWarned = true
      card.platformWarning = 'durable-replace without directory fsync (unsupported on this platform)'
    }
    return card
  }

  /** 状态跃迁（含合法性检查与历史）。 */
  transition(card, to, detail = {}, now = Date.now()) {
    if (!canTransition(card.state, to)) throw new IllegalTransitionError(card.cardId, card.state, to)
    const from = card.state
    card.state = to
    card.history = card.history ?? []
    card.history.push({ at: now, event: 'transition', from, to, ...detail })
    card.updatedAt = now
    return card
  }

  /** 在飞卡（非终止态）。 */
  inFlight() {
    return this.list().cards.filter(card => !isTerminal(card.state))
  }

  /** 实际持写锁的卡（DISPATCHED / CHANGES 才占写者名额；QUEUED 不占）。 */
  activeWriters() {
    return this.inFlight().filter(card => card.state === STATES.DISPATCHED || card.state === STATES.CHANGES)
  }

  /**
   * 释放持有（方案 §14.4 第 2 步）+ 重新评估被它阻塞的卡（第 3 步）。
   * SETTLED / ABANDONED / 超时回收共用这一个入口。
   */
  releaseHold(cardId, now = Date.now()) {
    const released = []
    const unblocked = []
    const { cards } = this.list()

    for (const card of cards) {
      if (card.state === STATES.QUEUED && card.blockedBy && card.blockedBy.cardId === cardId) {
        card.blockedBy = null
        card.history.push({ at: now, event: 'unblocked', by: cardId })
        this.save(card, now)
        unblocked.push(card.cardId)
      }
    }

    // 串行名额释放后，按创建顺序重新放行第一张 QUEUED 卡
    const queued = cards
      .filter(card => card.state === STATES.QUEUED && !card.blockedBy)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    if (queued.length > 0 && this.activeWriters().length === 0) {
      const next = queued[0]
      next.history.push({ at: now, event: 'ready', note: '串行名额空出，可派工' })
      this.save(next, now)
      released.push(next.cardId)
    }

    return { released, unblocked }
  }

  /**
   * 终止态复合动作（§14.4）：归档 intent → 释放锁 → 重新评估 QUEUED → 落记录。
   * 目标状态只能是 SETTLED 或 ABANDONED。
   */
  finalize(cardId, to, reason, now = Date.now()) {
    if (to !== STATES.SETTLED && to !== STATES.ABANDONED) {
      throw new Error(`finalize only accepts terminal states, got ${to}`)
    }
    const card = this.read(cardId)
    if (!card) throw new Error(`card not found: ${cardId}`)
    if (isTerminal(card.state)) {
      return { card, alreadyTerminal: true, released: [], unblocked: [] }
    }
    this.transition(card, to, { reason: reason ?? null }, now)
    card.reason = reason ?? null
    this.save(card, now)
    const { released, unblocked } = this.releaseHold(cardId, now)
    return { card, alreadyTerminal: false, released, unblocked }
  }

  /**
   * 启动扫描：找回未完成的判定事务（方案 §14.2 latest-wins）。
   * `resumable` 只可能是最新 seq 的那一条；更旧的孤儿在本方法内被标 abandoned。
   */
  recoverIntents(cardId, now = Date.now()) {
    return recoverIntents({
      intentsDir: this.intentsDir(cardId),
      resultPathFor: intentId => this.judgementPath(cardId, intentId),
      now,
    })
  }

  /** 登记一次判定（intent 先于判定落盘）。 */
  beginIntent(cardId, meta, now = Date.now()) {
    return beginIntent(this.intentsDir(cardId), { cardId, ...meta }, now)
  }

  /** 推进 intent 状态（单文档兜底路径，五步覆盖替换）。 */
  markIntent(cardId, intent, state, detail = {}, now = Date.now()) {
    return markIntentState(this.intentsDir(cardId), intent, state, detail, now)
  }

  /**
   * 落判定结论。只新建不覆盖：同一 `intentId` 重跑时若结果已在，保持第一次的结论。
   * @returns {{created: boolean}}
   */
  writeJudgement(cardId, intent, payload, now = Date.now()) {
    return writeResult(this.judgementPath(cardId, intent.intentId), {
      source: SOURCES.GIT,
      intentId: intent.intentId,
      intentSeq: intent.intentSeq,
      cardId,
      ...payload,
    }, now)
  }

  /** 读某次判定的结论（崩溃恢复用）。缺失返回 undefined，坏文件抛 CorruptError。 */
  readJudgement(cardId, intentId) {
    return readJsonStrict(this.judgementPath(cardId, intentId))
  }

  /**
   * 读全部证据，坏文件**不静默跳过**。
   * 跳过坏证据的后果是「以为没有结论」—— 而「没有结论」和「结论坏了」必须区别对待。
   * @returns {{items: object[], corrupt: {file: string, reason: string}[]}}
   */
  scanEvidence(cardId) {
    const dir = this.evidenceDir(cardId)
    if (!existsSync(dir)) return { items: [], corrupt: [] }
    const items = []
    const corrupt = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const ev = readJsonStrict(join(dir, name))
        if (ev) items.push(ev)
      } catch (error) {
        corrupt.push({ file: name, reason: error instanceof CorruptError ? error.message : String(error) })
      }
    }
    return { items, corrupt }
  }

  /**
   * 最新一次**判定结论**（M-2 收口）。
   *
   * 与 `latestEvidence` 的区别：这里只认「有 verdict 的权威证据」。
   * 不加这条过滤会出一个真缺陷：合规回执本身也是 `subagent-session` 权威证据，
   * 若它比 PASS 晚到，`latestEvidence` 会返回回执（没有 verdict），结算时被误判成
   * 「最近一次结论是 undefined」而拒绝 —— 回执照正常记录，结论却不该被它顶掉。
   */
  latestJudgement(cardId) {
    const { items, corrupt } = this.scanEvidence(cardId)
    if (corrupt.length > 0) {
      const err = new CorruptError(this.evidenceDir(cardId), corrupt.map(c => `${c.file}: ${c.reason}`).join('; '))
      throw err
    }
    let best
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      if (item.verdict !== 'PASS' && item.verdict !== 'CHANGES') continue
      if (!isAuthoritative(item.source)) continue
      const seq = Number.isInteger(item.intentSeq) ? item.intentSeq : -1
      const bestSeq = best ? (Number.isInteger(best.intentSeq) ? best.intentSeq : -1) : null
      // 有 intentSeq 时按事务序号定序（latest-wins）；没有序号的老证据回落时间戳。
      if (!best) { best = item; continue }
      if (seq !== bestSeq) { if (seq > bestSeq) best = item; continue }
      if ((item.at ?? 0) >= (best.at ?? 0)) best = item
    }
    return best
  }

  /** 证据：一件一文件，写一次永不覆盖；已存在视为幂等命中。 */
  writeEvidence(cardId, intentId, payload) {
    const target = join(this.evidenceDir(cardId), `${intentId}.json`)
    try {
      writeOnceJson(target, payload)
      return { path: target, created: true }
    } catch (error) {
      if (error && error.code === 'EEXIST') return { path: target, created: false }
      throw error
    }
  }

  /**
   * 记录一次合规回执。
   * 同时落一份 `source: 'subagent-session'` 的证据（§14.1 四枚举之一），
   * 供后续 evidence 白名单阶段使用。
   */
  recordReceipt(cardId, receipt, now = Date.now()) {
    const card = this.read(cardId)
    if (!card) throw new Error(`card not found: ${cardId}`)
    const snapshot = {
      at: now,
      changed: receipt.changed ?? [],
      scope: receipt.scope ?? [],
      acceptance: receipt.acceptance ?? [],
      artifactsVersion: receipt.artifactsVersion ?? {},
    }
    card.lastReceipt = snapshot
    card.history = card.history ?? []
    card.history.push({ at: now, event: 'receipt', changed: snapshot.changed.length, scope: snapshot.scope.length })
    this.save(card, now)
    this.writeEvidence(cardId, `receipt-${now}`, { source: 'subagent-session', cardId, receipt: snapshot, at: now })
    return snapshot
  }

  /**
   * 读出全部证据。面板/统计用的宽容视图：坏文件跳过（避免一张坏文件炸掉 status）。
   * **判定路径不许用这个** —— 结算与闸门走 `latestJudgement` / `scanEvidence`，那里 fail-closed。
   */
  listEvidence(cardId) {
    return this.scanEvidence(cardId).items
  }

  /**
   * 最新一条**权威**证据（§14.1）。`cto-narrative` 即使更新也不会被返回 ——
   * 这是「自述不参与判定」的落点。
   */
  latestEvidence(cardId) {
    return latestAuthoritative(this.listEvidence(cardId))
  }

  /** 证据来源统计，含被排除的条数。 */
  evidenceSummary(cardId) {
    return summarize(this.listEvidence(cardId))
  }

  /**
   * 记录 CTO 自述（`cto-narrative`）。
   * 它**可以写**、可以给人读，但永远不参与机器判定。
   */
  recordNote(cardId, text, now = Date.now()) {
    const card = this.read(cardId)
    if (!card) throw new Error(`card not found: ${cardId}`)
    const entry = { source: SOURCES.CTO, cardId, text: String(text ?? ''), at: now }
    this.writeEvidence(cardId, `note-${now}-${Math.random().toString(36).slice(2, 8)}`, entry)
    card.history = card.history ?? []
    card.history.push({ at: now, event: 'note', chars: entry.text.length })
    this.save(card, now)
    return entry
  }

  /** 计数：某卡某 source 类别的证据条数（供 evidence 白名单在 B 阶段使用）。 */
  countEvidence(cardId) {
    const dir = this.evidenceDir(cardId)
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter(name => name.endsWith('.json')).length
  }
}

export { BLOCK_REASONS, INTENT_STATE }
