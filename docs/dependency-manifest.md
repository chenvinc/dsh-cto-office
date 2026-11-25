# 依赖清单（Dependency Manifest）

> 用途：本插件（`@swiper1881/dsh-cto-office`）v2.0 的设计建立在若干**非公开 API 与行号事实**上。DSH 每次 rc 升级都可能让它们失效。
> 本文是**唯一台账**：每个依赖点写清「怎么定位 / 失效后果 / 兜底方案」。
> 配套 `platform-probe`（见 §待建）把这些假设写成可执行断言，升级后跑一次即知哪些破了。
>
> 状态：骨架（2026-11-26 建立）。标记 `TBD` 的行需在 W0 实测时补齐行号与验证方式。

## 一、总表

| # | 依赖点 | 定位方式 | 失效后果 | 兜底方案 | 状态 |
|---|---|---|---|---|---|
| D1 | 面板 `retain` 数据源 `cto-office/liveboard` | `client.js:412 / 1079 / 1551`；`ctx.sessions.retain(target,{source})` | 面板不再收到会话事件流，整块信息流空白 | 保留轮询 `ctx.sessions.list` 降级（信息更少但可用） | 待复验 |
| D2 | 客户端注入面 `slots / locale / sidebarRightTabs / sidebarRight / sessions` | `client.js:2161` | 面板页签注册失败（已有 `guard()` 包裹，单点失败降级） | 已隔离：注册失败仅该块不显示 | 待复验 |
| D3 | `SessionReferenceSourceMap` 未登记 `cto-office/liveboard` | README:86 记录；`client.js:4-13` 注释 | 宿主不校验（当前无害），但一旦开始校验会直接抛错 | 在 `packages/api/session-controller/src/client/index.ts` 补登记 | 待复验 |
| D4 | root 预设工具边界（`write`/`edit` 在 root，`applyPatch:false`） | `cordis.patch.yml:46-49` | 判定层假设“CTO 可写、worker 分角色”，边界错位会让授权清单失去意义 | `npm run check` 的 `EXPECTED` 矩阵断言 | 有断言 |
| D5 | `agentPresets.presetForSession()` | Host Service 目录（`cordis_inspect` Service.listService → `agentPresets`） | P1 来源校验失效 → CTO 可伪造 `GATE:` | 退化为“按会话事件来源 + 白名单 sessionId”校验（弱一档） | 待复验 |
| D6 | `tools/pre-execute` 的 `deny` / `ask` 决策 | `@deepseek-ai/dsh-tools` `src/contracts.ts`：`PreToolDecision`（约 L375-383） | 串行写卡、防篡改拦截、三处宿主门槛全部失效 | 退化为工具不挂载（只有静态边界，无运行时拦截） | 待复验 |
| D7 | `tools.guard()` 单调否决 | 同上 `contracts.ts`：`ToolGuard`（约 L410-416） | 否决顺序可被反转的假设失效 | 只用 `pre-execute`，不依赖单调性 | 待复验 |
| D8 | `tools/post-execute` 的 `block` | 同上：`PostToolDecision`（约 L386-394） | 回执闸门无法打回 → 缺证据的完成能走到评审 | 退化为“评审前置检查”（靠人/模型自觉） | 待复验 |
| D9 | `worktrees.create` 返回 `{path, branch, baseCommit, repositoryRoot}` | `@deepseek-ai/dsh-experimental-worktree`（**可选 bundle**，宿主不一定已挂） | 二期 worktree 无法建立 | 二期缩减为「状态机 + 断点恢复」，不建 worktree（§7.3 已计） | 待复验 |
| D10 | `storageDomain.open(spec)` | Host Service 目录 → `storageDomain` | 备选持久化通道失效 | 直接写 `.cto-office/*.json`（本方案主路径就是文件，不依赖它） | 低风险 |
| D11 | `session-checkpoint-policy` 行存在 | 宿主 `dsh-base` rows | 检查点策略无法被 preset 覆盖 | 自建检查点文件（已是一期 A 设计） | 低风险 |
| D12 | `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic` | 包存在（零依赖），但**从插件目录解析会落到 npx 缓存 rc.1** | 用错版本、行为不一致 | **不依赖**：自实现 temp+fsync+rename+dir-fsync（§14.3） | **已处置** |
| D13 | `tokenMeter.measure / contextPressure` | Host Service 目录 → `tokenMeter` | 成本三元组的 token 读数缺失 | 只记档位与卡时长，成本列显示“不可用” | 待复验 |
| D14 | `subagent` 工具的 `modelSelection` / `agentOptions` | `patch:113-114`；`@deepseek-ai/dsh-tool-subagent` `src/index.ts`（`agentOptions?: AgentOptions`、`capabilities.agentOptions`） | 岗位档位无法生效 | 退化为“每次派工显式传档位”，最坏“全局统一档位” | 待实测（W0 ⑤⑥） |
| D15 | `pre-execute` **不能改写工具参数** | `@deepseek-ai/dsh-tools` 源码注释："Input rewriting is excluded" | `office_dispatch` 的“由自己完成整个派工动作”失去前提 | 改为“拦裸 subagent + 要求 CTO 走 office_dispatch” | 待复验 |
| D16 | 沙箱 `workspaceRoot` 是宿主级 | `@deepseek-ai/dsh-sandbox-policy` 源码：`workspaceRoot = config.workspaceRoot ?? process.cwd()` | “worktree 自动隔离写者”的假设不成立（但越界仍可由 diff 发现） | 话术与文档如实写明：隔离靠检出，限制靠沙箱 | 已确证 |
| D17 | 沙箱模式逐会话可切 | 同包文档：“每个会话则可以独立切换模式” | 只读岗“真只读”的兜底层失效 | 退化为 `pre-execute` 规则兜 bash 写模式 | 待复验 |
| D18 | `npm run check` 的 `EXPECTED` 矩阵与 `parseSteps` 断言 | `scripts/sync-office-data.mjs:83-100 / 283-334` | 生成物与 patch 漂移、面板显示错误矩阵 | —— 这是护栏本身，失效即需人工复查 | 有断言 |

## 二、升级自查流程

每次 DSH rc 升级后：

1. 跑 `platform-probe`（待建）：逐条断言上表可机检的项，输出 `PASS / FAIL / N-A`；
2. `FAIL` 项按“兜底方案”列降级，并把该行状态改为 `已降级（日期 / rc 版本）`；
3. 跑 `npm run check` 与面板冒烟（`scripts/preview-liveboard.html` 的 10 个场景）；
4. 把结果追加到 §四 变更记录。

## 三、待建：`platform-probe`

放在 `index.js` 的 Host 半内，或独立 `scripts/platform-probe.mjs`（优先后者，避免污染运行时）。断言形态：

```js
// 伪代码
const checks = [
  ['D6 pre-execute deny',  () => typeof ctx.tools.checkGuards === 'function'],
  ['D8 post-execute block',() => /* 观察 PostToolDecision 是否接受 block */],
  ['D14 agentOptions',     () => /* 子代理派工能否传入 model 并生效 */],
  ['D16 sandboxRoot',      () => /* workspaceRoot 是否随会话 cwd 变化 */],
];
```

约定：**probe 只读，不改任何状态**；输出人可读表格 + 退出码（有 FAIL 则非 0）。

## 四、变更记录

| 日期 | DSH 版本 | 结论 | 处理 |
|---|---|---|---|
| 2026-11-26 | 0.2.2-rc.5 | 建立骨架；D12 已实测失效（npx rc.1 解析）；D16 已确证 | D12 自实现；其余待 W0 复验 |
