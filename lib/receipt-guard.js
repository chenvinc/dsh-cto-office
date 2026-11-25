/**
 * 回执闸门（方案 §4.3 2c / §14.1 P1）—— 挂在 `tools/post-execute`。
 *
 * 规则：如果一次 `subagent` 派工的 prompt 里带了 `【任务卡 Cx】`，且目标 preset 是写岗，
 * 那么子代理交回的文本必须含合规 RECEIPT；否则 **block**，让它补齐重交。
 *
 * 为什么 fail-closed：回执是判定的**输入**，输入不齐没法判。这与「判定器自身校验失败
 * 只告警不阻塞」不矛盾 —— 后者是防止把自己锁死，前者是防止没证据的完成流入闸门。
 *
 * 如实报告的边界：本实现校验的是「宿主看到的子代理返回文本」，这已经是 host-event 级事实
 * （不是 CTO 自述）；但**对来源 preset 的校验只做到「派工时声明的 preset 是写岗」**，
 * 没有对子会话实际 preset 做二次核对 —— 后者需要从子会话投影里取，列为 W2 遗留。
 */
import { validateReceipt, cardIdFromPrompt } from './receipt.js'

const WRITE_PRESET_DEFAULT = ['cto-builder']

/** 从 post-execute 的 result 里抽出模型可见文本。 */
export function resultText(result) {
  const content = result?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (block && typeof block === 'object' && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

/**
 * @returns (exec, result, next) => Promise<PostToolDecision>
 */
export function makePostExecuteReceiptGuard({ store, config }) {
  const writePresets = new Set(config.writerPresets ?? WRITE_PRESET_DEFAULT)

  return async (exec, result, next) => {
    try {
      if (exec?.name !== 'subagent') return next()

      const preset = exec.arguments?.agent_preset ?? exec.arguments?.agentPreset ?? exec.arguments?.preset
      if (!preset || !writePresets.has(preset)) return next()

      const prompt = exec.arguments?.prompt ?? exec.arguments?.message ?? ''
      const cardId = cardIdFromPrompt(prompt)
      if (!cardId) return next() // 没声明卡号就不拦：不猜

      const card = store.read(cardId)
      if (!card) return next() // 卡不存在（可能是别的用途），放行

      const check = validateReceipt(resultText(result), card)
      if (check.ok) return next()

      const details = [...check.missing.map(m => `缺字段 ${m}`), ...check.problems]
      return {
        kind: 'block',
        feedback: [{
          type: 'text',
          text: [
            `回执不合格，卡 ${cardId} 的这次交付不能进闸门：`,
            ...details.map(d => `- ${d}`),
            '',
            '请补齐后重交，格式见 §4.3：',
            'RECEIPT:',
            '- card: ' + cardId,
            '- artifactsVersion: ' + Object.entries(card.artifactsVersion ?? {}).map(([k, v]) => `${k}=${v}`).join(', '),
            '- changed: <文件列表>',
            '- acceptance:',
            '  - A1 PASS 证据：<命令与输出>',
            'SELF-CHECK:',
            '- build: <命令> → <退出码>',
            '- tests: <命令> → <结果>',
            '- scope: <文件列表>',
            '- gaps: <未覆盖项>',
          ].join('\n'),
        }],
      }
    } catch {
      // 守卫自身失败不得阻断调用
      return next()
    }
  }
}
