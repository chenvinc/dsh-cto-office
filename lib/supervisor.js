/**
 * 卡超时监督器 —— 一期 A 最小版（方案 §14.5 / W1e）。
 *
 * 只用宿主已有的 timer 服务（`ctx.timer.interval`），不自建定时器。
 *
 * 一期只做一件事：`QUEUED` 卡的持有者长时间没有动静 → 报警。
 * 为什么这条必须在 A 就做：一期是串行形态，C1 卡住不结算 → C2 永远 QUEUED →
 * 整个办公室停摆，而且**没有任何东西会响**。这是 A 自身的结构性缺陷。
 *
 * 报警对象是**持有者**，不是等待者：报「C1 已 idle 90 分钟，C2 在等」，
 * 而不是「C2 等了 2 小时」—— 后者不可行动。
 *
 * 如实报告的边界：本插件拿不到向会话推送消息的服务，所以报警只能落在
 * `alerts.jsonl` + 日志 + 下一次 office_status/gate/release 的响应里，
 * **做不到「主动在会话里冒一句话」**。这是与设计的一处偏差，已记入实现记录。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export class Supervisor {
  constructor(store, options = {}) {
    this.store = store
    this.root = store.root
    this.pollIntervalMs = options.pollIntervalMs ?? 15 * 60 * 1000
    this.queuedAlertMs = options.queuedAlertMs ?? 60 * 60 * 1000
    this.escalateAfter = options.escalateAfter ?? 2
    this.alertsSinceCheck = []
    this.now = options.now ?? (() => Date.now())
  }

  alertPath() {
    return join(this.root, '.cto-office', 'alerts.jsonl')
  }

  /** 跑一轮检查；返回本轮新产生的报警。 */
  tick() {
    const now = this.now()
    const produced = []
    try {
      const { cards } = this.store.list()
      const byId = new Map(cards.map(card => [card.cardId, card]))

      for (const card of cards) {
        if (card.state !== 'QUEUED' || !card.blockedBy) continue
        const holder = byId.get(card.blockedBy.cardId)
        if (!holder) {
          produced.push(this.makeAlert(card, null, now, 'holder-missing'))
          continue
        }
        const holderIdleMs = now - (holder.updatedAt ?? now)
        if (holderIdleMs >= this.queuedAlertMs) {
          produced.push(this.makeAlert(card, holder, now, 'holder-idle',
            holderIdleMs >= this.queuedAlertMs * this.escalateAfter ? 'suggest-abort' : 'suggest-release'))
        }
      }

      // 同一张卡同一原因只报一次（避免每 15 分钟刷一条同样的噪音）
      const fresh = produced.filter(alert => !this.alertsSinceCheck.some(seen =>
        seen.cardId === alert.cardId && seen.reason === alert.reason))
      if (fresh.length > 0) {
        this.alertsSinceCheck.push(...fresh)
        this.persist(fresh)
      }
      return fresh
    } catch {
      // 监督器自身失败不得影响主流程
      return []
    }
  }

  makeAlert(card, holder, at, reason, action = 'suggest-release') {
    return {
      at,
      cardId: card.cardId,
      reason,
      action,
      blockedBy: card.blockedBy?.cardId ?? null,
      holderIdleMinutes: holder ? Math.round((at - (holder.updatedAt ?? at)) / 60000) : null,
      message: holder
        ? `卡 ${card.blockedBy?.cardId} 已 idle ${Math.round((at - (holder.updatedAt ?? at)) / 60000)} 分钟，${card.cardId} 仍在等（${card.blockedBy.reason}）。可选：office_release ${card.blockedBy.cardId} action=abandon 释放，或继续等。`
        : `卡 ${card.cardId} 的持有者 ${card.blockedBy?.cardId} 已不存在，需人工处理。`,
    }
  }

  persist(alerts) {
    try {
      mkdirSync(join(this.root, '.cto-office'), { recursive: true })
      appendFileSync(this.alertPath(), alerts.map(a => JSON.stringify(a)).join('\n') + '\n')
    } catch {
      // 落盘失败不影响判定
    }
  }

  /** 尚未被确认过的报警（供 office_status 返回）。 */
  pending() {
    return [...this.alertsSinceCheck]
  }

  /** 人工确认后清空。 */
  ack() {
    const cleared = this.alertsSinceCheck.length
    this.alertsSinceCheck = []
    return cleared
  }

  /** 挂到宿主 timer 服务；返回 disposer。 */
  attach(ctx) {
    const timer = ctx?.timer
    if (!timer || typeof timer.interval !== 'function') return () => {}
    return timer.interval(() => {
      const fresh = this.tick()
      for (const alert of fresh) {
        try { ctx.log?.warn?.(alert.message) } catch {}
      }
    }, this.pollIntervalMs)
  }
}
