/**
 * 卡仓库（方案 §14.2 事务语义 / §14.4 终止态复合动作）。
 *
 * 布局：<workspace>/.cto-office/cards/<cardId>/card.json
 * card.json 必须原地更新 → 用覆盖替换五步；证据文件用「一件一文件」主路径（见 lib/atomic.js）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { replaceJson, readJsonStrict, writeOnceJson, CorruptError } from './atomic.js'
import { CARD_SCHEMA, IllegalTransitionError, STATES, canTransition, isTerminal, BLOCK_REASONS } from './card.js'

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

  /** 最新一条证据（按 at / intentId 取最大）。没有则返回 undefined。 */
  latestEvidence(cardId) {
    const dir = this.evidenceDir(cardId)
    if (!existsSync(dir)) return undefined
    let best
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const ev = readJsonStrict(join(dir, name))
        if (!ev) continue
        if (!best || (ev.at ?? 0) >= (best.at ?? 0)) best = ev
      } catch {
        // 坏证据不参与“最新”判定；gate 会因缺证据而拒绝结算。
      }
    }
    return best
  }

  /** 计数：某卡某 source 类别的证据条数（供 evidence 白名单在 B 阶段使用）。 */
  countEvidence(cardId) {
    const dir = this.evidenceDir(cardId)
    if (!existsSync(dir)) return 0
    return readdirSync(dir).filter(name => name.endsWith('.json')).length
  }
}

export { BLOCK_REASONS }
