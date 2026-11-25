/**
 * CTO 办公室 bundle 的 Host 半（入口）。
 *
 * 自 v2.0 W0 起，工具与守卫**不再挂在全局 host 半**，而是挂在
 * `cto-office` 预设自己的 plugins 里（见 tools-plugin.js 与 cordis.patch.yml）。
 *
 * 原因（W0 真机反馈 ①）：全局注册 + 运行时 `when` 收窄会在拿不到 `agentPresets`
 * 服务时 fail-open —— 结果是 standard 会话和 worker 子会话都能调用 `office_*`。
 * 改为预设作用域后，隔离由组装层负责，不存在 fail-open 路径。
 *
 * 本文件保留 `apply` 是为了让 bundle patch 的 insert 能解析到本包（客户端半由
 * package.json 的 `dsh.client` 声明）。
 */

export const name = '@swiper1881/dsh-cto-office'

/** Host 侧不再依赖任何服务。 */
export const inject = []

/** 无行为；工具与守卫在预设作用域内注册。 */
export function apply() {}
