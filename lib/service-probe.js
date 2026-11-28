/**
 * 可选服务读取 —— cordis 4 的正确打开方式。
 *
 * 背景（2026-11-28 alpha.5 真机）：cordis 4 的 context 代理只对 inject 里声明过的
 * 服务开放；未 inject 的裸读会抛 `cannot get property "<name>" without inject`
 * （cordis/src/reflect.ts:152）。用 try/catch 包一层并不会让它变成 undefined 之后
 * 还能拿到服务 —— 只会把「读不到」永久缓存成 undefined。
 *
 * `ctx.get(name)` 是 cordis 文档里的「Read a service from the store without the
 * inject requirement」入口，DSH 自己在 dsh-agent-instructions / dsh-api-session-controller
 * 里也用它读可选服务。这里再兜一层 reflect.get，兼容没有 get mixin 的 context。
 *
 * 注意：**不要**为了拿服务把它加进 inject —— 可选服务缺失时，cordis 会让整个插件
 * 停在 PENDING、apply 不执行；对带守卫的插件来说那是静默 fail-open。
 */

export function optionalService(ctx, name) {
  if (!ctx || typeof name !== 'string' || !name) return undefined
  try {
    if (typeof ctx.get === 'function') return ctx.get(name)
  } catch {}
  try {
    return ctx.reflect?.get?.(name, false)
  } catch {}
  return undefined
}