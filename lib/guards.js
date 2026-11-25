/**
 * pre-execute 守卫（方案 §4.2a F 层「防篡改」+ A 层「串行名额」）。
 *
 * 两条规则，都不依赖工具内部实现：
 *  1. 写者名额：`subagent` 派写岗时，若名额已满 → deny。
 *  2. 防篡改：`bash` 里出现 reset / rebase / amend / checkout -- , 会洗掉提交边界 → deny。
 *     不拦这条，提交边界反而让攻击面变大（方案 §4.2a 原文）。
 */

/** 破坏提交边界的命令模式。命中即拒。 */
const DESTRUCTIVE_GIT = [
  /\bgit\s+reset\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+commit\b[^\n]*--amend\b/,
  /\bgit\s+checkout\s+--\s/,
  /\bgit\s+restore\s+(?!.*--staged)/,
  /\bgit\s+clean\s+-[a-z]*f/,
]

/** 从 subagent 参数里取目标 preset（两种命名都认，未知则返回 undefined）。 */
export function targetPreset(args) {
  if (!args || typeof args !== 'object') return undefined
  const value = args.agent_preset ?? args.agentPreset ?? args.preset
  return typeof value === 'string' ? value : undefined
}

export function isDestructiveGit(command) {
  if (typeof command !== 'string') return false
  return DESTRUCTIVE_GIT.some(re => re.test(command))
}

/**
 * 建一个 pre-execute 处理器。
 * @returns (exec, next) => Promise<PreToolDecision>
 */
export function makePreExecuteGuard({ store, config }) {
  const writerPresets = new Set(config.writerPresets ?? ['cto-builder'])
  const maxWriters = config.maxConcurrentWriters ?? 1

  return async (exec, next) => {
    // 守卫自身出错必须放行：判定层不能把会话卡死（方案 §6.1）。
    try {
      if (exec?.name === 'subagent') {
        const preset = targetPreset(exec.arguments)
        if (preset && writerPresets.has(preset)) {
          const active = store.activeWriters()
          if (active.length >= maxWriters) {
            return {
              kind: 'deny',
              reason: `写者名额已满（maxConcurrentWriters=${maxWriters}）：${active.map(c => c.cardId).join(', ')} 正在写。`
                + ' 等它结算（office_release action=settle）或释放后再派工；并行写入是当前设计明确禁止的。',
            }
          }
        }
      }

      if (exec?.name === 'bash' || exec?.name === 'pwsh') {
        const command = exec?.arguments?.command
        if (isDestructiveGit(command)) {
          return {
            kind: 'deny',
            reason: '该命令会破坏提交边界（reset / rebase / amend / checkout -- 会把越界改动从 baseSha..HEAD 区间里洗掉）。'
              + ' 请用一次新提交来修正，而不是改写历史。',
          }
        }
      }
    } catch {
      // fall through：守卫失败即放行
    }
    return next()
  }
}
