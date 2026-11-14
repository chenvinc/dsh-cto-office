/**
 * CTO 办公室 bundle 的 Host 半。
 *
 * 该包原本只是 preset + skill 的 bundle；C22 增加了浏览器半的「办公室信息流」
 * 面板。Host 半不注册任何服务，只作为 Claude 兼容的 cordis 插件存在：
 * bundle patch 末尾把它插进 profile，客户端半由 package.json 的 dsh.client
 * 声明，由 Web 客户端按 `exports["./client"]` 以 classic script 加载。
 */

export const name = '@chy/dsh-cto-office'

export const inject = []

/** Host 侧无行为；保留入口是为了让 patch 的 insert 能解析到本包。 */
export function apply() {}
