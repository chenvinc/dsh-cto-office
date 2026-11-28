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

/**
 * 回执来自哪个 preset（P1 的来源校验，M-8 暴露的缺口）。
 *
 * 宿主 `agentPresets.presetForSession(session)` 返回的是 **preset id 字符串**
 * （projection schema = `string | null`），不是对象。
 *
 * 探测式使用：拿不到服务 / 抛错 → `null`，回执仍记账但标 `presetVerified: false`。
 * **为什么不 fail-closed 丢掉它**：丢回执会让正常派工永远凑不齐 receipt-missing，
 * 也就是说「接口不可用」会变成「整个办公室停摆」。所以这里记录事实，
 * 由 gate 在**明知来源不对**时判 CHANGES —— 判断留在判定层，采集层只记账。
 */
function presetOf(agentPresets, session) {
  try {
    // 兼容两种传法：直接给服务对象（旧用法/测试），或给 getter（tools-plugin 用，
    // 服务被替换后仍能拿到当前实现）。
    const service = typeof agentPresets === 'function' ? agentPresets() : agentPresets
    const preset = service?.presetForSession?.(session)
    return typeof preset === 'string' && preset ? preset : null
  } catch {
    return null
  }
}

export function makeReceiptCollector({ registry, agentPresets, getAgentPresets }) {
  const resolvePresets = typeof getAgentPresets === 'function' ? getAgentPresets : () => agentPresets
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
      const fromPreset = presetOf(resolvePresets(), session)
      store.recordReceipt(cardId, {
        changed: check.parsed.changed,
        scope: check.parsed.scope,
        acceptance: check.parsed.acceptance,
        artifactsVersion: check.parsed.artifactsVersion,
        fromPreset,
        presetVerified: fromPreset !== null,
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
