/**
 * CD 阶段巡检器（三期 / 模式 A）。
 *
 * 职责**只有只读告警**：扫描 `.cto-office/cd/<runId>/cd.json`，发现某个 run 长时间停在
 * `CHECKS/pending`、`BLOCKED` 或任何非终态就产出一句话报警。
 *
 * ── 为什么它不推进状态、不跑 gh ─────────────────────────────────────
 * 已拍板模式 A：外部命令由 CTO 用 bash 执行。插件没有可轮询的 checks 事实，
 * 定时器去「推进 pending」只会空转，甚至会用自己写的 cd.json 覆盖 CTO 刚写的状态。
 * 所以定时器的唯一输出是「提醒 CTO 去跑固化命令」，与 Supervisor 一样落在日志里。
 * 这是设计稿 §4.4「不判定、不写外部状态」的字面实现，也是 §9 备注 3 的落地。
 *
 * 纯逻辑，不碰文件系统、不碰 ctx —— 便于单测。
 */
import { CD_STATES, isCdTerminal } from './cd.js'

export const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000

export class CdWatcher {
  constructor({ staleAfterMs = DEFAULT_STALE_AFTER_MS, now = () => Date.now() } = {}) {
    this.staleAfterMs = staleAfterMs
    this.now = now
    this.lastAlerted = new Map()
  }

  /** 跑一轮；records 为 CdStore.list().records。返回本轮新产生的报警。 */
  tick(records = []) {
    const nowMs = this.now()
    const produced = []
    for (const record of records) {
      if (!record || isCdTerminal(record.state)) {
        this.lastAlerted.delete(record?.runId)
        continue
      }
      const idleMs = Math.max(0, nowMs - (record.updatedAt ?? nowMs))
      if (idleMs < this.staleAfterMs) continue

      let kind = 'stalled'
      let message = `CD ${record.runId} 停在 ${record.state} 已 ${Math.round(idleMs / 60000)} 分钟。`
      if (record.state === CD_STATES.CHECKS && record.checksState !== 'success') {
        kind = 'checks-pending'
        message += ` 请跑 office_cd action=status 取 checks 命令，把 gh pr checks 的 stdout 作 evidence 传回 action=checks。`
      } else if (record.state === CD_STATES.BLOCKED) {
        kind = 'blocked'
        message += ` BLOCKED 需要人工决策：修复后回到 REVIEW / CHECKS，或 office_cd action=abort。`
      } else {
        message += ` 下一步命令见 office_cd action=status。`
      }

      // 同一 (run, state, updatedAt, kind) 只报一次；状态或活动推进后才允许重报。
      const key = `${record.state}:${record.updatedAt ?? 0}:${kind}`
      if (this.lastAlerted.get(record.runId) === key) continue
      this.lastAlerted.set(record.runId, key)
      produced.push({ runId: record.runId, state: record.state, kind, idleMs, message })
    }
    return produced
  }
}
