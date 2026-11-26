/**
 * 卡超时监督器 —— 一期 B 完整版（方案 §14.5 / W9）。
 *
 * 三个超时合成**一个**监督器，不各做一套（§14.5 的合并要求）：
 *
 *   queuedAlert      等待者的持有者 idle 太久 → 报**持有者**（不是等待者），带可执行选项
 *   exclusiveTtl     互斥占用过期 → 不再阻塞别人 + 审计（M-14 第三处）
 *   cardIdleReclaim  在飞卡自己 idle 太久 → 建议 abort（续租靠活动：任何 save 推进 updatedAt）
 *
 * 三条修正（照规格）：
 *  1. **阈值全是参数**，不写死 —— 小卡 30 分钟该报，大卡 2 小时才合理；
 *  2. **报警对象是持有者**，消息里必须带可执行选项（释放 / 作废 / 继续等）；
 *  3. **升级（escalate）是一条新报警**，不是把旧的改一改 —— 否则警告升级永远看不见。
 *
 * 历史：一期 A 的最小版只做 queued 这一条，因为它对应「A 自身的结构性缺陷」
 * （C1 卡住 → C2 永远 QUEUED → 整个办公室停摆且没有任何东西会响）。
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

    // 三段阈值都支持「嵌套写法」与「老的扁平写法」，老配置不会因为这次升级静默失效。
    const queued = options.queuedAlert ?? {}
    const ttl = options.exclusiveTtl ?? {}
    const reclaim = options.cardIdleReclaim ?? {}
    this.queuedAlertMs = queued.thresholdMs ?? options.queuedAlertMs ?? 60 * 60 * 1000
    this.escalateAfter = queued.escalateAfter ?? options.escalateAfter ?? 2
    this.exclusiveTtlMs = ttl.thresholdMs ?? options.exclusiveTtlMs ?? 45 * 60 * 1000
    // 漏洞二：在飞卡自己挂着不动，也要有人管（A 版只盯 QUEUED 等待者）
    this.cardIdleReclaimMs = reclaim.thresholdMs ?? options.cardIdleReclaimMs ?? 120 * 60 * 1000

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
          const escalated = holderIdleMs >= this.queuedAlertMs * this.escalateAfter
          produced.push(this.makeAlert(card, holder, now, 'holder-idle',
            escalated ? 'suggest-abort' : 'suggest-release', escalated ? 2 : 1))
        }
      }

      // 在飞卡自己 idle 太久：没人等它，但它占着名额/互斥，同样会把办公室拖停。
      for (const card of cards) {
        if (card.state !== 'DISPATCHED' && card.state !== 'CHANGES') continue
        const idleMs = now - (card.updatedAt ?? now)
        if (idleMs >= this.cardIdleReclaimMs) {
          produced.push(this.makeCardIdleAlert(card, now, idleMs))
        }
      }

      // 锁 TTL 到期：占用已不阻塞别人，但卡还在飞 —— 报给持有者，别让它无声地挂着。
      for (const holder of this.store.expiredExclusiveHolders(now, this.exclusiveTtlMs)) {
        produced.push(this.makeExclusiveExpiredAlert(holder, now))
      }

      // 同一张卡同一原因同一级别只报一次（避免每 15 分钟刷一条同样的噪音）；
      // 但**升级要能报出来** —— 所以去重键含 escalation，warn → escalate 会再响一次。
      const fresh = produced.filter(alert => !this.alertsSinceCheck.some(seen =>
        seen.cardId === alert.cardId && seen.reason === alert.reason && (seen.escalation ?? 1) === (alert.escalation ?? 1)))
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

  makeAlert(card, holder, at, reason, action = 'suggest-release', escalation = 1) {
    return {
      at,
      cardId: card.cardId,
      reason,
      action,
      escalation,
      blockedBy: card.blockedBy?.cardId ?? null,
      holderIdleMinutes: holder ? Math.round((at - (holder.updatedAt ?? at)) / 60000) : null,
      message: holder
        ? `卡 ${card.blockedBy?.cardId} 已 idle ${Math.round((at - (holder.updatedAt ?? at)) / 60000)} 分钟，${card.cardId} 仍在等（${card.blockedBy.reason}）。可选：office_release ${card.blockedBy.cardId} action=abandon 释放，或继续等。`
        : `卡 ${card.cardId} 的持有者 ${card.blockedBy?.cardId} 已不存在，需人工处理。`,
    }
  }

  makeExclusiveExpiredAlert(card, at) {
    const idleMinutes = Math.round((at - (card.updatedAt ?? at)) / 60000)
    const globs = card.authorization?.exclusive ?? []
    return {
      at,
      cardId: card.cardId,
      reason: 'exclusive-expired',
      action: 'suggest-abandon',
      globs,
      idleMinutes,
      message: `卡 ${card.cardId} 的互斥占用 ${JSON.stringify(globs)} 已超过锁 TTL（idle ${idleMinutes} 分钟）：`
        + `该占用不再阻塞别的卡（授权本身不变，判定仍按原授权），但卡仍在 ${card.state}。`
        + `可选：office_release ${card.cardId} action=abandon 释放，或让它继续产出后立刻 office_gate。`,
    }
  }

  /**
   * 在飞卡 idle 超阈值（漏洞二）。续租是隐式的：任何 gate / 回执 / note 都会推进 updatedAt，
   * 所以「有活动」自然就不会进这条；这里只负责把「挂着不动」的卡捞出来。
   */
  makeCardIdleAlert(card, at, idleMs) {
    const idleMinutes = Math.round(idleMs / 60000)
    const thresholdMinutes = Math.round(this.cardIdleReclaimMs / 60000)
    return {
      at,
      cardId: card.cardId,
      reason: 'card-idle',
      action: 'suggest-abort',
      escalation: idleMs >= this.cardIdleReclaimMs * this.escalateAfter ? 2 : 1,
      idleMinutes,
      state: card.state,
      message: `卡 ${card.cardId} 在 ${card.state} 已 idle ${idleMinutes} 分钟（阈值 ${thresholdMinutes} 分钟）：`
        + '它可能占着写者名额或互斥占用。可选：office_release ' + card.cardId + ' action=abandon 释放、'
        + '或让它先产出一次改动并 office_gate（任何活动都会续租）。',
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
