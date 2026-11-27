# 模型映射：全程 DSH 内、只用 OpenCode Go

> 2026-11-27 口径。取代 11-26 的「hy4 / Flash 1017」两档默认表（`lib/role-models.js` 已改）。
> 目标：把流程图里的 Claude（主控）/ Gemini 4 Neon / Codex（GPT-6.2 Astra/Sol）换成
> **本机 DSH 可连接、且属于 OpenCode Go 上游**的路由；没有或不可用的，给同类降级平替。
> 全程不引入外部 agent 软件，编排、子代理、审查、CD 都在 DSH 内。

---

## 1. 取证（含 1-token 出词探针，2026-11-27 补）

| 来源 | 结论 |
|---|---|
| `GET http://127.0.0.1:3425/v1/models` | 网关在线，104 个路由，每条带 `owned_by` / `context_window` / `modalities` / `reasoning_levels` / `pricing` |
| `GET /v1/magpie/accounts` | 4 个上游账号均 `on: true`：`opencode-zen`(key)、`opencode-go`(key)、`commandcode`(key)、`copilot`(Free) |
| `GET /v1/magpie/quotas` | `opencode-go` 健康（5h 剩 98% / 7d 剩 90% / 月剩 95%）；`commandcode` GOAT 套餐 **69.77/70 credits 已用，仅剩 0.325**；`opencode-zen` 网关读不到余额；`copilot` Free 剩 73.7 次 chat |
| 当前会话 `list_subagent_models()` | 只返回 `dsh-opencode-go/hy4`（`off`/`high`）——说明白名单**没有被采样进本会话策略**，改完设置必须新开会话 |
| **`POST /v1/chat/completions`（1 token 探针，见 §4）** | **目录 / 白名单 ≠ 订阅可用**：两条 `*-free` 路由在目录与白名单里都有，真发请求却分别 400 / 410；6 条岗位路由逐条实测 200 |

> **教训**：`list_subagent_models()` 与 `/v1/models` 只反映「会话策略 + 目录」，
> 不保证上游订阅包含该模型。DSH 的 route preflight 也只查这两者 —— 所以会出现
> 「能创建子代理、但一发请求就 `failed before it finished`」。选路由后必须真发一次
> 最小请求验证，换机器 / 换套餐后跑 `node scripts/probe-role-models.mjs` 复核。

### 图里模型的真实状态

| 图中名字 | 实际 |
|---|---|
| `GPT-6.2 Astra` / `GPT-6.2 Sol` | 目录里**确实存在**（`commandcode/gpt-6.2-*`），但 owner=`commandcode` 且额度耗尽 → **不可用**，必须降级 |
| `Gemini 4 Neon` | 目录里**没有**；同类且同上游的是 `auto/gemini-4-argon`（owner=`opencode-go`，1M 上下文，支持图片输入） |
| `Claude`（主控） | `auto/claude-*` owner=`opencode-zen`、`copilot/claude-*` owner=`copilot`，都不是 Go；`opencode-go/claude-haiku-5-5` 属 Go 但只是 Haiku 级。主控用 `opencode-go/hy4` 更稳 |

> 按用户口径，下表**全部只用 `owned_by=opencode-go`**，不碰 zen / commandcode / copilot。
> 历史文档 `W10-实现记录.md`、`交接-下一会话.md` 记的是 11-26 的旧口径与真机验收，属历史记录，不回改。

---

## 2. 映射表（`provider: magpie` + 目录 id）

| 图里角色 | cto-office preset | 首选 | 降级平替 | 理由 |
|---|---|---|---|---|
| Claude（主控） | root `cto-office`（会话模型选择器） | `opencode-go/hy4` @ `high` | `opencode-go/claude-haiku-5-5` @ `high`；或直连 `dsh-opencode-go/hy4` | 983K 上下文、强推理档；cto-office 原「强思考岗」默认 |
| Gemini（独立出一份方案） | `cto-architect` | `auto/gemini-4-argon` @ `high` | `opencode-go/kimi-k3.1-pro` @ `high`（视角差异更大）／`opencode-go/minimax-m3.1-flash` | owner=opencode-go、1M 上下文、与主控 Hy4 **不同家族** → 保住「两份独立方案」 |
| Gemini（审交互和文案） | `cto-ux` | `auto/gemini-4-argon` @ `high` | 同上 | 支持图片输入，能看设计稿截图；`read_image` 已在 ux 预设能力内 |
| GPT-6.2 Astra（写后端） | `cto-builder` | `opencode-go/deepseek-v4.1-flash` @ `high` | `opencode-go/minimax-m3.1-flash`／`opencode-go/glm-5.3-flash`／`opencode-go/longcat-2.5` | 编码执行向、1M 上下文、prompt 0.15/1M；builder 原本就指 Flash，只是上游前缀写错成 zen |
| GPT-6.2 Sol（审查，≤2 轮） | `cto-reviewer` | `opencode-go/glm-5.3-flash` @ `low` | `opencode-go/hy4-flash-free` @ `off`（实测可用）／`opencode-go/minimax-m3.1-flash`／`opencode-go/longcat-2.5` | 便宜、与 builder **不同家族**（满足「做的人不验收」）；2 轮封顶由 `rounds` 计数器把关 |
| QA / 业务 | `cto-qa` / `cto-product` | `opencode-go/minimax-m3.1-flash` @ `low`／`opencode-go/kimi-k3.1-pro` @ `low` | `opencode-go/longcat-2.5` | 与 builder/reviewer **都不同家族**；`minimax-m3.1-flash-free` 因不在 Go 订阅已弃用（§4） |
| 开 MR → 审查 → 检查 → 合并 → 发布 → 核实线上 | 不需要模型产品 | `gh` + bash + 可选 `dsh-experimental-forge-github` + `goal`/`schedule` + Host 固定脚本 | 本地 git + 测试 + 本地预览 | 所有编排在 DSH 内；GitHub 只是仓库/CI |

**「不跨厂商」怎么保住含金量**：原图值钱的是「两个不同视角 + 一次人为拍板」，不是三家 logo。
单一上游里用「不同模型家族 + 不同 preset 工具边界 + 不同 reasoning_effort」即可复现；
「两份方案必须来自不同路由」写进章程，由 `checkDispatchRoute` 机检，比换厂商名更硬。

**档位约束**：`lib/role-models.js` 的 `EFFORTS` 只认 `off/low/high/max`。
网关目录里的 `medium/xhigh/ultra` 是上游档位名，**不是** DSH 子代理参数，别填。

---

## 3. 子代理白名单（生效前必做）

`cordis.patch.yml` 里 root 的 `tool-subagent` 已经开了 `modelSelection: true` + `modelDiscovery: true`
+ `allowedAgentPresets`，**不用改 patch**。缺的是 Host 设置里的路由白名单。

建议走「设置 → 子代理 → 模型选择」界面加（不要手改 profile 的 `cordis.patch.yml`）：

```yaml
allowedModels:
  - { provider: magpie, model: opencode-go/hy4 }
  - { provider: magpie, model: auto/gemini-4-argon }
  - { provider: magpie, model: opencode-go/deepseek-v4.1-flash }
  - { provider: magpie, model: opencode-go/glm-5.3-flash }
  - { provider: magpie, model: opencode-go/minimax-m3.1-flash }
  - { provider: magpie, model: opencode-go/hy4-flash-free }
```

（替换原来两条 `opencode-zen/*`。2026-11-27 核对：本机 profile 的 `allowedModels`
**已经包含全部 6 条新路由**，无需再改设置；但 `lib/role-models.js` 是 Host 已加载的模块，
改完仍要 `set_bundle enabled=false` → `true` 或重启 Host，再新开会话才生效。）

> 白名单里有某条模型**不代表订阅能用**：`minimax-m3.1-flash-free` 就在白名单里，
> 真发请求却是 400（见 §4）。放行之前先用 `scripts/probe-role-models.mjs` 验一次。

**三步验收**：
1. 改完设置 → **新开会话**（策略在会话创建时采样，旧会话继承不到）；
2. 新会话里跑 `list_subagent_models()`，应能列出上面 6 条；
3. 用 `subagent` 派一次 `cto-architect`，应传 `provider="magpie", model="auto/gemini-4-argon", reasoning_effort="high"`；
   漏传会被 `pre-execute` 守卫 deny，且拒绝理由里给出应传的三个参数。

---

## 4. 当前改动范围（含后续三期）

| 文件 | 改动 |
|---|---|
| `lib/role-models.js` | `DEFAULT_ROLE_MODELS` 六行；头部注释补「2026-11-27 口径」与 `*-free` 教训 |
| `test/role-models.test.mjs` | 断言同步到默认表（守卫、describe、dispatch 回执的硬编码串） |
| `skills/cto-office/SKILL.md` | §二.3 四参数、§四 任务板状态机、§五 岗位路由表、§八/§九、铁律 8–10 |
| `lib/cd.js` / `lib/cd-gh.js` / `lib/cd-watch.js` / `lib/tools.js` / `lib/guards.js` | 一/二/三期：CD 状态机、`office_cd`、`gh` 命令契约、R5–R9 守卫、巡检定时器 |
| `client.js` | 右栏 CD chip、D1（`open-card`）修复 |
| `scripts/probe-role-models.mjs` | 1-token 出词探针（防「目录里有但订阅不含」复发） |
| 本文档 | 映射、取证、白名单、验收步骤、探针结果 |
| `W10-实现记录.md` / `交接-下一会话.md` | **不改**：11-26 的历史验收记录 |

章程每轮改动都过 `npm run sync` → `npm run check` → `npm test`；
`parseSteps` 始终解析到 6 步，`EXPECTED` 工具矩阵始终是 7 个 preset。

---

## 5. 2026-11-27 出词探针结果（1 token / 条）

对 magpie 网关 `POST /v1/chat/completions` 逐条发 `max_tokens:1` 的最小请求，
只记录 HTTP 状态与耗时，不打印凭据。

| 路由 | 状态 | 耗时 | 结论 |
|---|---|---|---|
| `opencode-go/minimax-m3.1-flash-free` | **400** | 1.4s | `Model ... isn't included in OpenCode Go` —— **不在订阅里**（旧 QA 路由，已弃用） |
| `opencode-go/longcat-2.5-free` | **410** | 1.7s | `ModelDeprecated: ... Use longcat-2.5 instead` —— **已废弃** |
| `opencode-go/minimax-m3.1-flash` | 200 | 1.1s | ✅ **新 QA 路由** |
| `opencode-go/glm-5.3-flash` | 200 | 0.6s | ✅ reviewer（报告 T2b `GATE: PASS`） |
| `opencode-go/deepseek-v4.1-flash` | 200 | 1.6s | ✅ builder（报告 N2 补参数后成功） |
| `auto/gemini-4-argon` | 200 | 4.3s | ✅ architect / ux（报告 T1 `RECEIPT: SMOKE-A-7F3C`） |
| `opencode-go/kimi-k3.1-pro` | 200 | 1.9s（另一次 15.9s，波动大） | ✅ product，但延迟不稳，未用作验收岗 |
| `opencode-go/hy4-flash-free` | 200 | 2.4s | ✅ 唯一可用的 `-free`，保留为 reviewer 降级档 |
| `opencode-go/longcat-2.5` | 200 | 1.7s | ✅ 非 free 版可用，作为降级平替 |

**由此定下的两条规则**：
1. 岗位表与降级清单**不用 `*-free`**（除非实测 200，目前只有 `hy4-flash-free` 例外）。
2. 每次换机器 / 换套餐 / 改映射后，先跑 `node scripts/probe-role-models.mjs`，
   再改 `allowedModels`、再重载 bundle、最后新开会话。顺序反了就会重演 T2。
