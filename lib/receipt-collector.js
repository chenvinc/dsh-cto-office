/**
 * 从会话事件里捡回执（W0 真机反馈 ③ 的修法）。
 *
 * 真机行为：`subagent` 工具**立即**返回「started subagent X」，
 * worker 的最终答案稍后以「完成通知」形式作为消息回到父会话 ——
 * **不经过 `tools/post-execute`**。所以回执闸门挂在 post-execute 上永远看不到 RECEIPT。
 *
 * 这里监听 `session/event`，把事件里所有文本拼起来找 `RECEIPT:` 块；
 * 找到就按卡号记账（合规才记）。找不到不报错 —— 缺回执由 `office_gate` 的
 * `receipt-missing` 兜住，这是最后一道，也是可靠的那道。
 *
 * 如实报告的边界：消息已经落库，**无法在这里「打回」**。
 * 自动打回需要能拦住完成通知，当前宿主没有这个钩子。
 */
import { createHash } from 'node:crypto'
import { parseReceipt, validateReceipt } from './receipt.js'

/** 把事件里所有字符串收集起来（不依赖具体事件形状）。 */
export function collectText(value, out = [], depth = 0) {
  if (depth > 6 || out.length > 200) return out
  if (typeof value === 'string') { out.push(value); return out }
  if (Array.isArray(value)) { for (const item of value) collectText(item, out, depth + 1); return out }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectText(item, out, depth + 1)
  }
  return out
}

/** 事件里是否包含回执块。 */
export function receiptTextOf(event) {
  const text = collectText(event).join('\n')
  if (!text.includes('RECEIPT:')) return null
  const at = text.indexOf('RECEIPT:')
  return text.slice(at)
}

export function makeReceiptCollector({ registry }) {
  return (session, event) => {
    try {
      const text = receiptTextOf(event)
      if (!text) return
      const parsed = parseReceipt(text)
      if (!parsed) return
      const cardId = parsed.receipt?.card?.[0]
      if (!cardId) return
      const store = registry.all().find(s => s.read(cardId))
      if (!store) return
      const card = store.read(cardId)
      if (!card || card.state === 'SETTLED' || card.state === 'ABANDONED') return
      const check = validateReceipt(text, card)
      if (!check.ok) return // 不合规不记账：gate 会因 receipt-missing 拒绝

      // 去重（真机反馈 P3）：同一份回执会随多条会话事件重复到达，
      // 不去重会把证据条数刷虚。用内容摘要比对，不比较时间。
      // 摘要必须含正文指纹：builder 与 reviewer 的回执结构可能一样（同 changed、同验收），
      // 只比结构会把两份不同回执误判成重复（真机反馈：证据条数偏低）。
      const digest = createHash('sha256').update(
        JSON.stringify({
          changed: [...new Set(check.parsed.changed ?? [])].sort(),
          acceptance: (check.parsed.acceptance ?? []).map(a => `${a.id}:${a.outcome}:${a.note ?? ''}`).sort(),
          artifactsVersion: check.parsed.artifactsVersion ?? {},
          body: text.replace(/\s+/g, ' ').trim(),
        }),
      ).digest('hex').slice(0, 16)
      if (card.lastReceiptDigest === digest) return
      store.recordReceipt(cardId, {
        changed: check.parsed.changed,
        scope: check.parsed.scope,
        acceptance: check.parsed.acceptance,
        artifactsVersion: check.parsed.artifactsVersion,
      })
      const fresh = store.read(cardId)
      if (fresh) {
        fresh.lastReceiptDigest = digest
        store.save(fresh)
      }
    } catch {
      // 采集失败不得影响会话
    }
  }
}
