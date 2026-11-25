/**
 * 证据来源分级（方案 §14.1 / §14.2）。
 *
 * 核心规则：**可靠性是数据属性，不是论证**。
 * 判定只相信三类来源；`cto-narrative`（CTO 自述）可以记录、可以给人看，**一律不参与机器判定**。
 *
 * 为什么必须这样：P1 只挡住了「往文件里写一行 GATE」这一种伪造。
 * 但一期至少有四类证据（越界结论、测试是否真跑、成本数字、工件版本），
 * 如果每加一种证据都靠人再论证一次「这个能不能信」，那么迟早会漏。
 * 把来源写成枚举 + 白名单，就只需要论证一次。
 */
export const SOURCES = Object.freeze({
  /** 宿主事件：工具调用结果、会话事件、post-execute 抓取 */
  HOST_EVENT: 'host-event',
  /** git 原生命令输出 */
  GIT: 'git-plumbing',
  /** 子代理会话消息（GATE 行、RECEIPT 块） */
  SUBAGENT: 'subagent-session',
  /** CTO 自述：总结、复盘、口头结论 —— 只给人看 */
  CTO: 'cto-narrative',
})

/** 参与判定的来源白名单。`cto-narrative` 刻意不在其中。 */
export const AUTHORITATIVE_SOURCES = Object.freeze([SOURCES.HOST_EVENT, SOURCES.GIT, SOURCES.SUBAGENT])

const AUTHORITATIVE = new Set(AUTHORITATIVE_SOURCES)

export function isAuthoritative(source) {
  return AUTHORITATIVE.has(source)
}

/** 未知来源按不可信处理（fail-closed）。 */
export function classify(source) {
  if (!source) return { source: null, authoritative: false, reason: 'missing-source' }
  if (isAuthoritative(source)) return { source, authoritative: true, reason: 'whitelisted' }
  return { source, authoritative: false, reason: source === SOURCES.CTO ? 'self-report' : 'unknown-source' }
}

/**
 * 取「最新的权威证据」。
 * 非权威证据（含 cto-narrative）即使在时间上更新，也不影响结果 —— 这正是分级的意义。
 */
export function latestAuthoritative(evidence = []) {
  let best
  for (const item of evidence) {
    if (!item || typeof item !== 'object') continue
    if (!isAuthoritative(item.source)) continue
    if (!best || (item.at ?? 0) >= (best.at ?? 0)) best = item
  }
  return best
}

/** 按来源统计，并标出被排除的条数（供面板与 status 用）。 */
export function summarize(evidence = []) {
  const bySource = {}
  let excluded = 0
  for (const item of evidence) {
    const source = item?.source ?? '(missing)'
    bySource[source] = (bySource[source] ?? 0) + 1
    if (!isAuthoritative(item?.source)) excluded += 1
  }
  return { total: evidence.length, bySource, excluded }
}
