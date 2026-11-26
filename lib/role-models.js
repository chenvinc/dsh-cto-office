/**
 * 岗位 → 模型/档位表（M-7 的可落地部分）。
 *
 * ── 为什么需要这一层 ──────────────────────────────────────────────
 * 宿主只给两种粒度：
 *   ① tool 级统一默认（`dsh-tool-subagent` 的 Config `agentOptions`）—— 所有子代理同一个路由；
 *   ② 每次派工显式传 `provider + model + reasoning_effort`。
 * 而我们要的是**按岗位分**：需要强思考的岗位用强模型，工程执行岗位用快模型。
 *
 * preset 行本身设不了默认档（W0 ⑥ 实测：`agentOptions` 被静默忽略），
 * 所以这张表只能由本插件维护，并在**派工守卫**里校验 —— 漏传、传错都拒，
 * 不是「在提示词里请求 CTO 记得传」。
 *
 * ── 路由从哪来 ────────────────────────────────────────────────────
 * 必须先在 DSH「设置 → 子代理 → 模型选择」里授权（Host 设置 `subagentModelSelection`），
 * 授权在**会话创建时**写进会话策略；没授权的路由即使传了也会被宿主拒。
 * 因此这里的默认值只是「本机此刻的授权清单」，换机器/换套餐要改配置。
 */
export const ROLE_MODELS_SCHEMA = 'cto-office/role-models@1'

/** 默认表：强思考岗 → hy4；工程执行岗 → Flash 1017。与用户 2026-11-26 的口径一致。 */
export const DEFAULT_ROLE_MODELS = Object.freeze({
  'cto-architect': { provider: 'magpie', model: 'opencode-go/hy4', reasoning_effort: 'high', tier: 'thinking' },
  'cto-reviewer': { provider: 'magpie', model: 'opencode-go/hy4', reasoning_effort: 'high', tier: 'thinking' },
  'cto-builder': { provider: 'magpie', model: 'opencode-zen/deepseek-v4.1-flash', reasoning_effort: 'high', tier: 'execution' },
  'cto-qa': { provider: 'magpie', model: 'opencode-zen/deepseek-v4.1-flash', reasoning_effort: 'low', tier: 'execution' },
  'cto-ux': { provider: 'magpie', model: 'opencode-zen/deepseek-v4.1-flash', reasoning_effort: 'low', tier: 'execution' },
  'cto-product': { provider: 'magpie', model: 'opencode-zen/deepseek-v4.1-flash', reasoning_effort: 'low', tier: 'execution' },
})

const EFFORTS = new Set(['off', 'low', 'high', 'max'])

function normalizeRoute(preset, route) {
  if (!route || typeof route !== 'object') return { preset, error: '路由必须是对象' }
  const provider = typeof route.provider === 'string' ? route.provider.trim() : ''
  const model = typeof route.model === 'string' ? route.model.trim() : ''
  if (!provider || !model) return { preset, error: 'provider 与 model 都必填' }
  const effort = route.reasoning_effort ?? route.reasoningEffort ?? undefined
  if (effort !== undefined && !EFFORTS.has(effort)) {
    return { preset, error: `reasoning_effort=${effort} 不在 ${[...EFFORTS].join('/')} 之内` }
  }
  return { preset, provider, model, reasoning_effort: effort, tier: route.tier ?? null }
}

/**
 * 合并默认表与配置覆盖。`null` 表示**该岗位不参与校验**（例如临时想让它继承父路由）。
 * 坏配置不静默吞掉：返回的 `problems` 会被 apply 时打印，且坏项从表里剔除（宁可少管，不要管错）。
 */
export function resolveRoleModels(raw) {
  const table = {}
  const problems = []
  for (const [preset, route] of Object.entries(DEFAULT_ROLE_MODELS)) table[preset] = normalizeRoute(preset, route)
  const config = raw && typeof raw === 'object' ? raw : {}
  for (const [preset, route] of Object.entries(config)) {
    if (route === null) { delete table[preset]; continue }
    const normalized = normalizeRoute(preset, route)
    if (normalized.error) {
      // 坏覆盖**连带摘除**默认项：留着默认值会让人以为配置生效了（宁可少管，不要管错）。
      problems.push(`${preset}: ${normalized.error}`)
      delete table[preset]
      continue
    }
    table[preset] = normalized
  }
  for (const [preset, route] of Object.entries(table)) {
    if (route.error) { problems.push(`${preset}: ${route.error}`); delete table[preset] }
  }
  return { table, problems }
}

/** 该岗位要求的路由；未配置返回 null。 */
export function routeForPreset(table, preset) {
  if (!table || !preset) return null
  const route = table[preset]
  if (!route || route.error) return null
  return route
}

export function describeRoute(route) {
  if (!route) return '（继承父 Agent 的路由）'
  return `${route.provider}/${route.model}${route.reasoning_effort ? ` @ ${route.reasoning_effort}` : ''}`
}

/**
 * 校验一次派工是否按岗位表带了路由。
 * @param args subagent 工具的实际参数
 * @returns {{ok: boolean, expected: object|null, actual: object, problems: string[]}}
 */
export function checkDispatchRoute(table, preset, args) {
  const expected = routeForPreset(table, preset)
  const actual = {
    provider: args?.provider ?? null,
    model: args?.model ?? null,
    reasoning_effort: args?.reasoning_effort ?? args?.reasoningEffort ?? null,
  }
  if (!expected) return { ok: true, expected: null, actual, problems: [] }

  const problems = []
  if (!actual.provider) problems.push(`缺 provider（应为 ${expected.provider}）`)
  else if (actual.provider !== expected.provider) problems.push(`provider=${actual.provider}，应为 ${expected.provider}`)

  if (!actual.model) problems.push(`缺 model（应为 ${expected.model}）`)
  else if (actual.model !== expected.model) problems.push(`model=${actual.model}，应为 ${expected.model}`)

  if (expected.reasoning_effort) {
    if (!actual.reasoning_effort) problems.push(`缺 reasoning_effort（应为 ${expected.reasoning_effort}）`)
    else if (actual.reasoning_effort !== expected.reasoning_effort) {
      problems.push(`reasoning_effort=${actual.reasoning_effort}，应为 ${expected.reasoning_effort}`)
    }
  }
  return { ok: problems.length === 0, expected, actual, problems }
}

/** 给 deny 的可执行说明：把该传的三个参数原样列出来。 */
export function routeDenyReason(table, preset, check) {
  const expected = check.expected
  const others = Object.keys(table).filter(key => key !== preset)
  return `派工 ${preset} 必须带上这个岗位的路由（模型按岗位定了，不许继承父 Agent 的路由）。\n`
    + `应传：provider="${expected.provider}", model="${expected.model}"`
    + (expected.reasoning_effort ? `, reasoning_effort="${expected.reasoning_effort}"` : '')
    + `\n实际：${describeRoute(check.actual.provider ? check.actual : null)}`
    + `\n问题：${check.problems.join('；')}`
    + `\n（岗位表：${[preset, ...others].map(key => `${key}→${describeRoute(routeForPreset(table, key))}`).join('，')}）`
}
