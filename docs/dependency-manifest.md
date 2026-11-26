# 依赖清单（Dependency Manifest）

> 用途：本插件（`@swiper1881/dsh-cto-office`）v2.0 的设计建立在若干**非公开 API 与行号事实**上。DSH 每次 rc 升级都可能让它们失效。
> 本文是**唯一台账**：每个依赖点写清「怎么定位 / 失效后果 / 兜底方案」。
> 配套 `platform-probe`（见 §三）把这些假设写成可执行断言，升级后跑一次即知哪些破了。
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
| D12 | `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic` | 包存在且可经安装锚点解析，**但源码明确写「Crash durability (fsync) is out of scope」**（含 `TODO(settings-atomic-durability)`） | 它是原子可见，不是崩溃持久：M-2 要处理的正是崩溃场景 | **偏离设计并说明原因**：保留自实现的 temp+fsync+rename+dir-fsync。若上游补上 fsync，本实现可删约 40 行 | **已确证（不满足需求）** |
| D19 | `picomatch@4.0.7`（宿主自带，全局匹配器） | `createRequire(DSH_INSTALL_DIR/package.json)('picomatch')` | 解析不到则退回内置最小匹配器（已实测两条路径都能跑通） | `lib/glob.js` 优先用 picomatch，`matchBackend()` 自报当前后端 | **已接入** |
| D20 | `ctx.timer.interval`（宿主 timer 服务） | `cordis-plugin-timer` 已挂载 | 超时监督器无法起定时器 | 探测不到就**明确跳过**，不改用 `setInterval` 偷跑 | **已接入** |
| D13 | `tokenMeter.measure / contextPressure` | Host Service 目录 → `tokenMeter` | 成本三元组的 token 读数缺失 | 只记档位与卡时长，成本列显示“不可用” | 待复验 |
| D14 | `subagent` 工具的 `modelSelection` / `agentOptions` | `patch:113-114`；`@deepseek-ai/dsh-tool-subagent` `src/index.ts`（`agentOptions?: AgentOptions`、`capabilities.agentOptions`） | 岗位档位无法生效 | 退化为“每次派工显式传档位”，最坏“全局统一档位” | 待实测（W0 ⑤⑥） |
| D15 | `pre-execute` **不能改写工具参数** | `@deepseek-ai/dsh-tools` 源码注释："Input rewriting is excluded" | `office_dispatch` 的“由自己完成整个派工动作”失去前提 | 改为“拦裸 subagent + 要求 CTO 走 office_dispatch” | 待复验 |
| D16 | 沙箱 `workspaceRoot` 是宿主级 | `@deepseek-ai/dsh-sandbox-policy` 源码：`workspaceRoot = config.workspaceRoot ?? process.cwd()` | “worktree 自动隔离写者”的假设不成立（但越界仍可由 diff 发现） | 话术与文档如实写明：隔离靠检出，限制靠沙箱 | 已确证 |
| D17 | 沙箱模式逐会话可切 | 同包文档：“每个会话则可以独立切换模式” | 只读岗“真只读”的兜底层失效 | 退化为 `pre-execute` 规则兜 bash 写模式 | 待复验 |
| D18 | `npm run check` 的 `EXPECTED` 矩阵与 `parseSteps` 断言 | `scripts/sync-office-data.mjs:83-100 / 283-334` | 生成物与 patch 漂移、面板显示错误矩阵 | —— 这是护栏本身，失效即需人工复查 | 有断言 |

## 二、升级自查流程

每次 DSH rc 升级后：

1. 跑 `npm run probe`（见 §三）：逐条断言上表可机检的项，输出 `PASS / FAIL / N-A / INFO`；
2. `FAIL` 项按“兜底方案”列降级，并把该行状态改为 `已降级（日期 / rc 版本）`；
3. 跑 `npm run check` 与面板冒烟（`scripts/preview-liveboard.html` 的 10 个场景）；
4. 把结果追加到 §四 变更记录。

## 三、`platform-probe`（已建，M-6）

```bash
# 普通 Node：跑本机可检项（patch 边界、装载形态、本插件自身契约、清单完整性）
npm run probe

# 进 asar：额外检查宿主源码面（D5/D6/D8/D12/D15/D16、宿主包存在性）
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  scripts/platform-probe.mjs
```

**为什么有两种运行方式**：`picomatch`、`@deepseek-ai/*` 的源码都在 `app.asar` 归档内部，
只有 App 自带的 Electron 的 Node fs 能读；普通 Node 下这些项一律标 `N-A`，
**不猜成 PASS**（这正是 W0 追加五记下的教训：用错运行时去判断宿主能力，会得出反向结论）。

状态含义：

| 状态 | 含义 | 处理 |
|---|---|---|
| `PASS` | 假设成立 | 无 |
| `FAIL` | 假设已破 | 按「兜底方案」列降级，并把该行状态改为 `已降级（日期 / rc 版本）`；退出码非 0 |
| `N-A` | 当前环境检不了 | 换运行时再跑，或按环境限制接受 |
| `INFO` | 成立但值得知道 | 例如 D9 worktree 已安装（二期可提前试）、D12 上游若补了 fsync 可删自实现 |

探针自身也是**只读**的：不写 `.cto-office`、不改 profile、不装包。

测点与清单的对应：

| 探针 id | 清单项 | 说明 |
|---|---|---|
| `D1`–`D3` | D1–D3 | 客户端面只能做**静态源码断言**（弱）：确认注册面没被误删，不等于运行时生效 |
| `D4-1`–`D4-3` | D4 | 只读岗 `write/edit` 被关、可写岗没被误关、`applyPatch:false` 计数 |
| `D5`–`D8`、`D15`、`D16` | 同名 | 宿主源码面断言（需 Electron） |
| `D9`–`D13`、`D20` | 同名 | 宿主包/可选包存在性（需 Electron） |
| `D14-1` | D14 | patch 里 `modelSelection: true`（档位前提）；实际行为见 W0 ⑤⑥ |
| `D19` | D19 | 宿主内应为 `picomatch`；普通 Node 下必然 `fallback`，标 `N-A` |
| `ENV-1`–`ENV-3` | — | 装载形态（`link:`）、profile bundles、`engines.dsh` |
| `SELF-1`–`SELF-3` | — | 本插件自身契约回归：M-12 双门槛默认值、M-2 intent schema、M-14 审批文件在工作区外 |
| `DOC-1` | — | 本清单 D1–D20 无缺项（防丢项） |

实测（2026-11-26，rc.5）：
- 普通 Node：`PASS 13 · FAIL 0 · N-A 13 · INFO 1`
- Electron：`PASS 25 · FAIL 0 · N-A 0 · INFO 2`（INFO = D9 worktree 已装、D3 宿主暂不校验）

## 四、变更记录

| 日期 | DSH 版本 | 结论 | 处理 |
|---|---|---|---|
| 2026-11-26 | 0.2.2-rc.5 | 建立骨架；D12 已实测失效（npx rc.1 解析）；D16 已确证 | D12 自实现；其余待 W0 复验 |
| 2026-11-26 | 0.2.2-rc.5 | W1 实现期复核：**D12 修正**——包可经安装锚点解析，但源码自认不提供 fsync；**新增 D19（picomatch 已接入）/ D20（timer 已接入）** | D12 保留自实现并写明偏离理由；D19/D20 改为「用系统的」 |
| 2026-11-26 | 0.2.2-rc.5 | M-6 建立 `platform-probe`：普通 Node `PASS 13/FAIL 0/N-A 13`，Electron `PASS 25/FAIL 0/N-A 0` | 探针写入 `scripts/platform-probe.mjs`，`npm run probe`；清单加「测点对应」表 |
