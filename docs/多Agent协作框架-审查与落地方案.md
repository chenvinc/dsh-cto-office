# 多 Agent 协作框架：审查结论与落地方案

> 对象：`@swiper1881/dsh-cto-office@0.2.4` + `docs/多Agent协作框架设计-设计目标与改进建议.md`
> 目的：先审查（事实核对 + 可行性取证），再给可施工的落地方案。**本文件不含任何代码改动，实施待拍板。**
> 取证环境：DSH `@deepseek-ai/dsh@0.2.2-rc.5`（Desktop，profile=`desktop`；`web` profile 同时装有本包）

---

## 0. 结论先行

**远程状态**：`origin/main` 与本地 `HEAD`（`8e53055`）无差异，**无需拉取**。工作区只有 1 个未跟踪文件，就是待评审的建议文档本身。

**对建议文档的判断**：六条建议方向全部成立，但**文档对"哪些能做到硬约束"的判断偏保守，对"已达标项"的判断偏乐观**，且遗漏了 6 项会直接影响工期的既有事实（见 2.4 节）。

| 判断 | 文档 | 审查结论 |
|---|---|---|
| 能力层硬边界（工具不挂载） | 已达标 | **部分成立**：5 个只读岗的 `tool-fs` 已配置关闭写工具，但 `bash`/`pwsh` 在 6 个角色里全部挂载，重定向写文件不被拦（README:92 自认）。硬边界只覆盖了 2/3 的写路径 |
| Reflection Loop 带回退 | 基本达标 | **文档级达标**：`≥2 次回退升级` 只写在 SKILL.md:40，没有计数器、没有闸门，`revision` CAS 只管任务板并发不管回退计数 |
| 禁止 fork / 星型拓扑 / 单一 Orchestrator | 已达标 | **成立**，可确证（patch 未挂 `tool-subagent-fork`、未挂 `workflow`，六岗位无横向信道） |
| Worker 无自检 | 缺口① | **成立但表述需修正**：builder 规程已有"小步自测 + 交可验证证据"的要求（builder SKILL:18、26），缺的是**提交前的自检闸门与结构化回执字段**，不是"完全没有自检" |
| UI/UX 执行后无归属 | 缺口② | **成立**：reviewer SKILL:36 明确"不做产品与视觉判断"，qa 不评风格，ux 不落盘且无执行后职责 |
| 对照物不落盘 | 缺口③ | **成立**，且已有可复用的先例：`GATE:` 行是全仓唯一的机器可读回执协议（office SKILL:33、client.js:348） |
| 无强制状态机 | 缺口④ | **成立**，但 `agentTeams` 任务板本身已是 durable + CAS + `blocked_by` 的弱状态存储，缺的是阶段定义与非法跃迁拒绝 |
| 跨模块并行写 | 风险⑤ | **成立且比文档描述更严重**：`subagent` 可并发 spawn 任意多个 builder，没有任何并发上限 |

**最关键的一点**：文档假设"流程约束只能靠提示词，所以只能尽量写清楚"。**这个假设不成立** —— 当前 DSH 已暴露足够的硬机制，可以让建议一、二、五、六变成"物理上做不到"而不是"被劝阻"：

- `tools/pre-execute`（waterfall，可返回 `deny`/`ask`）—— 工具调用级否决，且带 `exec.agent` 身份
- `tools.guard(guard)` —— **单调**否决，监听器顺序无法把 deny 变回 allow
- `tools.restrict({allow, deny})` —— 按作用域收窄工具可见性（运行时动态）
- `ToolRegistrationOptions.when` —— 按 step 决定某工具是否参与本步
- `tools/post-execute`（`block`）—— 子代理回执不合格可以直接打回而不必人工发现
- `subagents.startActivation` / `agentTeams.*` / `storageDomain.open` —— 受控派工、durable CAS 任务板、插件状态持久化

**落地方案规模（按批注 D1 重排为两期）**：

- **一期 · 补可判定性（约 8–11 人日）**：串行写卡（`maxConcurrentWriters=1`）+ 授权清单 + `baseSha` 提交边界 + diff/status 双读判定 + `exclusive` 互斥组 + 工件层 + `RECEIPT`/`SELF-CHECK` 闸门 + 回退计数器。**交付即可兑现核心主张：越界必现、纪律可判定、做的人不验收。**
- **二期 · 解锁并行（约 9–14 人日）**：worktree 隔离（判定路径不改，只改 `baseSha` 取值来源与并发上限）+ 状态机 + 检查点 + UX 走查 + 模型档位 + 面板。

方案把纪律从提示词迁到宿主插件 + 生成式校验，并保持现有的 `patch → office.json → 面板/文档` 单一来源链路不破。**一期不验证并行收益**（见 §6.3）。

---

## 1. 事实基线（可复现）

### 1.1 仓库与安装形态

| 项 | 事实 | 证据 |
|---|---|---|
| HEAD | `8e53055 chore: 忽略 npm pack 产物` | `git log -1` |
| 与远程 | 无领先/落后提交 | `git log HEAD..origin/main` 为空 |
| 未跟踪 | 仅建议文档 1 个 | `git status -sb` |
| 安装位置 | `~/.dsh/profiles/{desktop,web}/node_modules/@swiper1881/dsh-cto-office` | `ls` |
| 安装形态 | **独立副本**（inode 不同、无 `node_modules`），非软链 | `stat -f %i` 对比 |
| profile 依赖 | `"@swiper1881/dsh-cto-office": "^0.2.4"` | `profiles/desktop/package.json` |
| bundle 行 | 7 个 preset + `cto-office-live`，`overrides: ["agent-team"]` | `plugin_manager list_bundles` |

> ⚠️ **README:80 与事实冲突**：README 写"安装用的是 `link:` 协议，所以改这里的文件就是改运行时"。实测 profile 里是副本，且依赖声明是版本范围而非 `file:`/`link:`。→ 每次改 patch / 新增 host 插件后必须重新安装或重载，**迭代回路要先修**（见工作包 W0.3）。

### 1.2 版本兼容

| 项 | 插件声明 | 实际环境 | 风险 |
|---|---|---|---|
| DSH | `>=0.2.2-rc.3`，兼容表到 `0.2.2-rc.4` | `0.2.2-rc.5` | **未声明兼容**，需在阶段 0 实测 |
| profiles | `["web"]` | `desktop` 在用、`web` 也装了 | 声明与实际不符 |

### 1.3 生成物链路（必须保持的单一来源）

```
cordis.patch.yml ─┐
                  ├─→ docs/office.json ─→ docs/architecture.html   （注入 facts）
skills/*/SKILL.md ┘                    └─→ client.js OFFICE_FACTS （注入 facts）
```

- `scripts/sync-office-data.mjs`：`npm run sync` 生成、`npm run check` 校验（`prepublishOnly` 挂着）。
- 校验强度：`assertFixture` 要求**恰好 7 个 preset**、`order` 唯一、**工具矩阵逐项等于 `EXPECTED`**（sync:83-100、283-315）；`parseSteps` 要求 SKILL.md 里**恰好解析出六步**（sync:317-334）；office.json 记录 patch 的 `sha256`（office.json:5-12）。
- 含义：**任何给 patch 加角色/加工具、给章程改步骤的改动，都会先被 `npm run check` 拦住** —— 这是本仓库最好的资产，方案里所有新机制都必须接入这条链路，否则又会退化成提示词。

### 1.4 patch 结构与重复度

| 事实 | 数字/位置 |
|---|---|
| preset 数量 | 7（root 18-137、architect 141-224、builder 228-306、reviewer 310-388、qa 392-470、ux 474-557、product 561-644） |
| `agent-team` 覆盖 | 10-13（`maxTasks: 256`、`defaultEnabled: true`） |
| 只读岗写工具 | 6 处 `write:false/edit:false/applyPatch:false`（168-173、337-342、419-424、501-506、588-593；root 无此项 → 46-49 可写） |
| bash 挂载 | 6 个角色全部挂载（162-167、331-336、413-418、495-500、582-587）→ **只读岗可 `echo > file`** |
| `skill-filesystem` 的 `!!js` 块 | 同一段 19 行 JS 重复 **7 次**（56-74、178-196、265-283、347-365、429-447、511-529、598-616），7 份 **sha256 完全相同** |
| `compaction` 组 | 同一段 17 行重复 7 次（81-97、208-224、290-306、372-388、454-470、541-557、628-644），sha256 相同 |
| 复制样板总量 | **≈350 / 653 行（≈54%）** 是复制粘贴 |
| 派工组 | 100-122：`provider: spawn`、`agentPreset: cto-builder`、`allowedAgentPresets` 6 项、`interrupt: false`；**无并发上限参数** |

两个附带的维护陷阱：

- 技能目录探测失败时**静默降级**：`candidates.find(hasSkills) ?? candidates[0]`（patch:73，7 处同）→ 改漏一处，该岗位拿不到 skills，没有任何报错。
- sync 解析器靠**缩进常量硬匹配**（sync:169、196-199、200、209、244）→ 任一处缩进漂移就整段漏解析，`--check` 才报错。

→ 任何"给全部角色加一层机制"的改动都是 **×7** 的成本，且要同步改 `EXPECTED`/`ALLOWLIST`。文档的成本估计没算这一项。

---

## 2. 审查：逐条核验建议文档

### 2.1 已达标五项

| 文档结论 | 核验 | 降级/备注 |
|---|---|---|
| 星型拓扑零横向连线 | ✅ 成立 | 六岗位 preset 内均无 `subagent` 挂载，只能经 CTO 中转（patch 141-644 无 `tool-subagent`） |
| 单一 Orchestrator | ✅ 成立 | root 同时持拆解与闸门 |
| Reflection Loop 带回退 | ⚠️ **降级为"文档级"** | `≥2 次` 只在 SKILL.md:40；没有回退计数器，没有机制拦截第 3 次派工 |
| 能力层硬边界 | ⚠️ **部分成立** | `write`/`edit`/`applyPatch` 在 5 个只读岗被配置关闭 ✅（168-173、337-342、419-424、501-506、588-593）；`bash`/`pwsh` 全部挂载 ✗（162-167、331-336、413-418、495-500、582-587）。README:92 自认"不是内核级沙盒"，铁律 4 也承认"bash 重定向也算"→ 作者知道这是软约束。**另注**：README:9 与 SKILL:23 说"根本没挂 write/edit"不准确 —— 实际是挂了 `tool-fs` 再关配置；关闭后是否从工具声明中消失，仓库内无法验证，列入 W0.1 实测 |
| 禁止 fork | ✅ 成立 | patch:17 注释 + 98-99；未挂 `tool-subagent-fork`/`workflow` |

**结论**：五项里 3 项真达标、1 项文档级、1 项部分达标。文档的"最难的部分已完成"判断基本正确，但**"硬边界"这一项被高估**，而它恰好是建议一的立论基础 —— 所以建议一不能只靠"收敛写者"，还必须补 bash 路径。

### 2.2 四处缺口

| 缺口 | 核验 | 修正 |
|---|---|---|
| ① Worker 无自检 | ⚠️ 成立但表述偏差 | builder 规程已有"小步自测/交证据"（SKILL:18-26）；缺的是**提交前的强制自检闸门 + 机器可读自检字段**。改法不是"加人"，是"加闸门 + 加回执段" |
| ② UX 执行后无归属 | ✅ 成立 | 三方证据：reviewer SKILL:36 **明文**排除视觉；qa 只有隐含排除（SKILL:8"只看验收标准是否真的成立"，无明文视觉条款）；ux 只做执行前且"不写文件"（SKILL:3、26）。补充：ux 挂载 `tool-fs`，而 `tool-fs` 同时提供 `read_image` → **视觉走查在能力上可行**（需 image-capable 模型 + 附件存储），缺的是流程与对照物 |
| ③ 对照物不落盘 | ✅ 成立 | 契约/验收标准只活在对话里；`GATE:` 行是全仓唯一结构化回执（office SKILL:33、45；reviewer SKILL:21；qa SKILL:29；client.js:348 解析）→ 可直接扩展成"回执块协议" |
| ④ 无状态机与检查点 | ✅ 成立 | 六步只是文档编号；`agentTeams` 提供 durable + CAS + `blocked_by` 的卡级弱状态，但**没有阶段定义、没有非法跃迁拒绝、没有检查点** |

### 2.3 风险⑤（并行写）

成立，且比文档描述更严重：

- `subagent` 可并发 spawn 多个 builder（`provider: spawn`，无并发参数）；CTO 并行派两张实现卡时，两个 builder 同时写同一个工作区。
- `write_scopes` 在 `agentTeams` 里是**建议性字段**（工具描述原文："advisory, not a lock"），`revision` CAS 只保护任务板记录本身，不保护文件。
- 面板侧的"卡片级"视图按会话事件渲染，冲突发生时**没有任何一处在报警**。

### 2.4 文档未覆盖的 6 项（本次新增）

| 编号 | 发现 | 影响 |
|---|---|---|
| N1 | patch 的 7 份重复样板（1.4 节，占 54% 行数） | 每条改进都要 ×7 手改 + 改 sync 白名单；不先治结构，六条建议的维护成本被低估 3-5 倍 |
| N2 | rc.5 未在兼容表内；`profiles:["web"]` 与实际 desktop 不符 | 可能已经在不兼容组合上运行；阶段 0 必须先验 |
| N3 | 安装是副本不是 link，README:80 的描述与事实冲突 | 每次改动的生效路径不明确 → 迭代回路必须先修，否则会反复"改了没效果" |
| N4 | 面板只读，数据源是**会话事件流**（`ctx.sessions.retain`，client.js:412/1079/1551），注入面只有 `slots/locale/sidebarRightTabs/sidebarRight/sessions`（client.js:2161） | 新机制若不产出结构化回执行，面板看不见；且面板**读不到任务板与文件系统** —— 阶段视图只能从会话事件推，无法直接读 `.cto-office/` 或 `team_task` |
| N5 | 宿主已有整套强制机制未被文档识别（见第 3 章） | 决定了六条建议**能做到"架构约束"而不是"提示词"** —— 这是本次审查最重要的结论 |
| N6 | **文档口径漂移已有前科**：README:37 仍把"把写对了和做对了拆成两道闸"当卖点，而章程 SKILL:33 已改成"默认只过一道闸"，sync:39-41 甚至把「过双闸」列为**禁用词**并扫描（但扫描只覆盖 html，不覆盖 README） | 证明"写进校验"是唯一稳态；README 必须纳入机检或复查清单，否则下一轮升级还会留下自相矛盾的说明 |

### 2.5 审查顺带发现的小缺陷（可直接修，不等大改造）

| # | 缺陷 | 位置 | 修法 |
|---|---|---|---|
| D1 | 面板的六步是启发式推断，且 `inferStep` **永不返回 `open-card`** → 第 2 步在面板上永远不亮 | client.js:989-1016，调用处 1666 | 阶段机落地后替换为真实阶段；短期可补分支 |
| D2 | 面板看不出 facts 陈旧（`provenance`/`sha256` 不进 client facts，client.js 无相关消费点） | sync:504-523 | facts 带 `sha256Short` 并显示 |
| D3 | `npm run check` **只挂在 `prepublishOnly`**：commit/push 无门禁，无 CI、无 husky | package.json scripts | W0.4 |
| D4 | `package.json` 的 `files` 含 `docs` → 未跟踪的评审 md 会随 npm 包发布 | package.json | 发布前显式决定保留/排除 |
| D5 | README:55 "只有 10 个文件" 与事实不符（`git ls-files` = 18） | README | 随 README 重写一并修 |
| D6 | `architecture.html` 里另有一份**手写的**富步骤说明（entry/exit/产出/阻塞），不在生成区间、`--check` 不校验其内容 | architecture.html:1305-1371 | 阶段机落地时把它并进生成区间 |

---

## 3. 可行性：每条建议能做成多硬

证据均为宿主实机取证（`cordis_inspect` 的 Service/Event 目录 + 包源码类型定义）。

| 建议 | 可用机制（已确证） | 强度 | 落点 |
|---|---|---|---|
| 一 单写者（一期） | **并发**：`maxConcurrentWriters=1` + `pre-execute` 拦第二个写岗；**归属**：`baseSha` + 结算必须已提交；**判定**：`git diff --name-status <baseSha>..HEAD` + `git status --porcelain` 对清单做 glob；**互斥**：`exclusive` 组；**防篡改**：拦 `reset`/`rebase`/`amend` | **硬**（判定可复跑、可归因） | Host 插件（新）+ 章程 |
| 一b 单写者（二期） | 叠加 `ctx.worktrees.create`（新分支 + 独立检出，源检出不变）+ `subagents.startActivation` 带 `cwd`；`baseSha` 改取 `baseCommit` | **硬**（判定路径不变） | Host 插件 |
| 一′ 模型预算 | subagent 工具的 `modelSelection` + 会话级 `allowedModels` 策略放行 + `agentOptions`（spawn 后端 `capabilities.agentOptions: true`）+ `tokenMeter` | 硬（需先放行） | patch 配置 + `office_dispatch` |
| 二 Worker 自检 | `tools/post-execute` → `block`（把反馈变成错误结果打回）；回执协议扩展 | **硬** | Host 插件 + builder/reviewer SKILL |
| 三 对照物落盘 | 工作区文件（`.cto-office/`）+ `storageDomain.open(spec)`（durable JSON）+ `fs/write-intent`（`createIfAbsent`/`replaceIfVersion` 乐观并发） | **硬**（存在性可校验） | Host 插件 + 章程 |
| 四 UX 后置走查 | ux 已有 `read_image`（tool-fs）；走查结果走回执协议 + `post-execute` 校验 | 半硬 | SKILL + Host 插件 + 面板 |
| 五 状态机 + 检查点 | `tools/pre-execute` 拒绝非法跃迁；`storageDomain` 持久化阶段；`session/flush` 事件；`session-checkpoint-policy` 行已存在 | **硬** | Host 插件 |
| 六 人工关口 | `approval.request`（带 session 策略）或 `userQuestions.ask`；在阶段边界强制 | **硬** | Host 插件 + 章程 |

关键 API 形状（摘自宿主源码，可用于估工）：

```ts
// @deepseek-ai/dsh-tools src/contracts.ts:375-383
type PreToolDecision =
  | { kind: 'allow' } | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' } | { kind: 'ask'; reason?: string; displayReason?: ... }

// contracts.ts:410-416 —— 单调，顺序无法翻案
type ToolGuard = (execution: Readonly<ToolExecution>) => string | ToolGuardDenial | undefined

// contracts.ts:392-400 —— 按作用域的全局工具过滤
interface ToolRestriction { allow?: readonly string[]; deny?: readonly string[] }

// contracts.ts:175-213 —— 守卫能拿到调用者身份
interface ToolExecutionInput { callId; name; arguments; agent?: Agent; toolSet?; signal }

// contracts.ts:386-394 —— 子代理回执可以被打回
type PostToolDecision =
  | { kind: 'accept'; ... } | { kind: 'block'; feedback: ContentBlock[]; info?; ... }
```

服务侧（`cordis_inspect` Service 目录原文）：

- `tools`：`register(def, options)` / `restrict(filter)` / `guard(guard)` / `checkGuards(exec)`
- `subagents`：`startActivation(spec)` / `resolveName` / `sendMessage` / `listDescendants` / `waitForTreeWork` / `resolveMaxDepth`
- `agentTeams`："backed by the exact live Lead Session log"：`createTask` / `getTask` / `listTasks` / `updateTask`
- `storageDomain`：`open(spec)` / `get(name)` / `closeAll`；`domain/changed` 事件在落盘确认后触发
- `approval`：`request(req)` / `setPolicy(agent, policy)`；`userQuestions.ask/askTimed`

**必须标注为"待验证"的三点**（阶段 0 的 spike 项，不要写进承诺）：

1. `tools.restrict` 在 preset 子上下文里的作用域是否**只作用于该 agent**（签名说明是"per-scope filter over global tools"，需实测）。
2. 沙箱能否**按角色**只读（`sandbox-policy` 的文档措辞是"each session's mode"，倾向**按会话**而非按 agent；若是按会话，只读岗的 bash 兜底只能靠 `pre-execute` 规则）。
3. `session-checkpoint-policy` 能否被 preset 覆盖为"每步一次检查点"。

---

## 4. 落地方案

### 4.0 设计原则（先立规矩，避免又退化成提示词）

1. **每条纪律必须有可机检的落点**：要么是 host 插件的 `deny` 规则，要么是 `npm run check` 的断言，要么是面板可见的回执行。三者都没有的，不写进章程。
2. **单一来源不破**：所有"角色/工具/阶段/跃迁"的事实，仍然只在 `cordis.patch.yml` 与 `SKILL.md` 里定义，其余是生成物；新常量尽量进 patch 注释块或 SKILL 表格，由 `sync` 解析。
3. **回执协议统一扩展**：现有的 `GATE:` 行升级为"回执块"（`GATE:` / `SELF-CHECK:` / `WALK:` / `PHASE:`），面板与 `post-execute` 都只认这一套。
4. **能拦就不劝**：同一件事若能 `deny`，就不要只在章程里写"不要"。
4. **一个概念一个名字**：`baseSha` 一期二期间字段名不变、只改取值来源；已废弃的租约概念不复活（由「在飞卡登记 + `exclusive`」取代）。
5. **判定逻辑不 fail-closed，判定输入 fail-closed**：回执缺失 → 打回（输入不齐没法判）；插件自身校验失败 → 告警不阻塞（否则把自己锁死）。
6. **一期不验证并行**：串行形态下不产出任何并行数据，不得用它替二期结论担保。
7. **阈值是参数，不是常量**：`rounds` 的 2/3、TTL、轮询间隔、指标门槛全部进配置。硬编码的"回退 2 次""30 分钟"会随模型能力上升变成错误约束（见 §14.11）。
8. **「恰好 7 个 preset」是实现约束，不是设计不变量**：它来自 `npm run check` 的数量断言（`sync-office-data.mjs:284`）。真实类型只有三类 —— **写者 / 只读者 / 判定者**。未来要不要加第 8 个角色，是成本决策（×3 处返工），不是被一个数字挡住。

### 4.1 阶段 0：前置、迭代回路与去重（1–2 天）

| 工作包 | 内容 | 验收 |
|---|---|---|
| W0.1 兼容实测 | 在 rc.5 + `desktop` profile 下跑：装→开预设会话→派 6 个角色各一次。**必测六项**：① 只读岗 `tool-fs` 的 `write:false/edit:false` 是否真让工具从声明中消失；② ux 能否 `read_image`；③ `tools.restrict` 是否按 agent 作用域生效；④ **worker 能否按绝对路径只读主检出的 `.cto-office/`**（**二期开门条件，一期 A/B 均不受影响** —— 一期 worker 就在主检出里，同目录不存在跨界读）；⑤ **`reasoning_effort` 是否受会话级 `allowedModels` 限制**；⑥ **preset 能否设默认档** | 六项实测记录；④失败只影响二期 worktree，**不得据此把一期 M4 降级为复制注入**；⑤⑥不通过 → §4.7 退化为「每次派工显式传档位」 |
| W0.2 声明修正 | `package.json`：`compatibility.dshReleases` 补 rc.5；`profiles` 补 `desktop`；`engines.dsh` 下限复核 | `npm run check` 通过 |
| W0.3 迭代回路 | 明确"改仓库 → 生效"的确定路径（脚本化 `set_bundle enabled=false/true` 或重装），写进 README 并修 README:80 的错误描述 | 改一行 patch → 一条命令 → 新会话生效，可复现 |
| W0.4 门禁 | **现状**：`check` 只挂 `prepublishOnly`，commit/push 无门禁（无 CI、无 husky）。补：`check` 进 CI 或 pre-commit；把 README 的对外口径纳入机检（或至少纳入复查清单，参见 N6/D5）；facts 注入 `sha256Short` 让面板能显示陈旧（D2） | 故意改 patch 不 sync → 门禁红；README 口径与章程不一致 → 被扫出 |
| W0.5 去重 | **前移到阶段 0**：把 7 份 `skill-filesystem` `!!js` 块与 `compaction` 组收成 1 处（`cordis:group` 公共块或生成式 patch），`EXPECTED`/`ALLOWLIST` 同步改造 | 全局机制只改 1 处即可对全部 7 个角色生效；`npm run check` 仍全绿；面板快照无变化 |
| W0.6 依赖清单 + probe | 建立 `docs/dependency-manifest.md`（依赖点／定位方式／失效后果／兜底），并把可机检的假设写成 `platform-probe`（只读断言，有 FAIL 则退出码非 0） | 升级后跑一次即知哪些破了；首次 rc 升级即回本 |

> W0.5 必须排在阶段 1 之前：阶段 1–4 每一包都要给"全部角色"加机制，不去重就是 ×7 手改 + ×7 出错机会（改漏一处还是**静默失效**）。

### 4.2 阶段 1：可判定性 + 串行写卡（P0，3–4 天）

> **本节按批注 D1 重排。** 一期不再上 worktree 隔离，而是先补"可判定性"：单检出、写卡串行、每卡提交边界、授权清单、diff 判定、互斥组。worktree 隔离与并行放到二期（§4.2b）。
>
> 理由：硬伤 A1/A2/A3 未闭合就上隔离，一期交付的会是"跑起来但不可判定"的系统；而"并行"恰恰是最需要先拿真实数据说服人的部分。

#### 4.2a 一期：单检出 + 串行写卡（`maxConcurrentWriters = 1`）

| 层 | 机制 | 行为 |
|---|---|---|
| A 并发控制 | 配置项 **`maxConcurrentWriters`**（一期取值 `1`）；`pre-execute` 拦第二个写岗派工 → `deny`，理由写明当前在飞卡与持卡人 | 一期**不存在并行写**，"分不清谁写的"这个漏洞从根上消失。二期只改这个数值 + 挂 worktree，判定路径不动 |
| B 授权层 | 卡的授权清单 `{ mode: ro\|rw, include: [glob], deny: [glob], exclusive: [glob], expiresAt }` 落 `.cto-office/cards/<id>/card.json`；`office_dispatch` 建卡时写入，子代理无权限改 | 授权是派单时写死的，不是模型临场决定 |
| C 提交边界 | 卡 JSON 记 **`baseSha`**（开卡时的 `HEAD`）；卡完成时必须**已提交**（工作区除 `.cto-office/` 外干净） | 归属清晰：`baseSha..HEAD` 就是这张卡的全部改动，可归因、可复跑 |
| D 判定层 | `office_gate` **双读**：`git diff --name-status <baseSha>..HEAD` **加** `git status --porcelain`（未跟踪/删除/重命名都不在前者里），逐条对清单做 glob 匹配；越界 → 打回并列出文件名 | 越界必然可见，且判定可复跑、可审计 |
| E 互斥组 | `exclusive: [glob]`：同一 glob 同时只能被一张在飞卡持有；第二张卡在 `office_dispatch` 时直接进 `blocked_by` 排队，**不许并行** | 共享文件双写从"合并时暴露"提前到"开卡时暴露"（修复 A5） |
| F 防篡改 | `pre-execute` **显式拦截** `reset` / `rebase` / `amend`（以及 `git commit --amend`、`git checkout -- .`） | 不拦这条，提交边界反而让攻击面变大：worker 提交越界文件后 `reset` 掉，`baseSha..HEAD` 就看不到了 |
| G 兜底层 | 只读岗：保持无 `write/edit`；沙箱按会话切 read-only（逐会话可切，见 §10.3）；必要时 `pre-execute` 规则兜 bash 写模式 | 只读岗始终只能读 |

**结算纪律**：串行下脏工作区会传染 —— 前一张卡的残留会被算进下一张卡的 diff。所以卡结算动作里强制"提交或清理"，否则不允许开下一张卡。

**在飞卡登记（替代已删除的"租约"概念）**：

```
inFlight: [{ cardId, owner, preset, baseSha, startedAt, lastHeartbeat, exclusive: [glob] }]
```

- 超时回收：卡 `idle` 超过阈值（默认 30 分钟无心跳），CTO 可**显式释放**（`office_release(cardId, reason)`），释放写进审计账本。
- 不自动释放：自动释放会让"正在长跑的任务"被误抢，宁可显式。
- 这条是二期并行的前提 —— 没有回收规则，互斥组会留下永久阻塞的卡。

**验收（机检）**：第二个写岗派工 → deny 且理由可读；某卡改授权外文件 → `office_gate` 打回并列出文件名；卡未提交就结算 → 拒绝并提示；`git reset` → 被拦；两张卡声明同一 `exclusive` glob → 第二张进 `blocked_by`；释放后卡可再派。

#### 4.2b 二期：worktree 隔离 + 并行（解锁，不是地基）

一期判定路径全部复用，二期只做三件事：

1. `maxConcurrentWriters` 改 `> 1`；
2. `office_dispatch` 建 worktree 并让子代理 `cwd` 指向它（`ctx.worktrees.create` → `{ path, branch, baseCommit, repositoryRoot }`）；
3. **`baseSha` 取值来源改为 `worktrees.create` 返回的 `baseCommit`** —— 字段名不变（批注：一个字段名，不要两个）。

其余（授权清单、双读判定、互斥组、防篡改、结算纪律）**一行不改**。这才是"两次迭代可复用"的关键。

**二期限定**：每卡一个检出是否要独立装依赖（`node_modules`）未实测，可能显著拖慢"能跑测试"；worktree 会累积，结算后需 `worktrees.cleanupOf` 回收。

---

### 4.3 阶段 2：工件层 + 自检闸门（P1，3–4 天）

#### 2a 工件可见性契约（修复 A1，本方案唯一会直接导致机制不成立的漏洞）

**契约：工件只存在于主检出、只由 CTO 或宿主插件写；worker 通过绝对路径只读引用；回执不进文件系统。**

```
<workspace>/.cto-office/
  cards/<id>/card.json          # 卡 = 授权清单 + baseSha + artifactsVersion + revisions + 历史
  cards/<id>/receipts.jsonl     # 回执（宿主写入；worker 不写这个文件）
  contracts/<id>.md             # 契约（CTO 落盘，架构师仍只读）
  acceptance/<id>.md            # 验收基线（逐条编号）
  checkpoints/<seq>.json        # 阶段检查点
  audit.jsonl                   # 审计账本（插件写、CTO 只读、进 git）
  price-table.json              # 离线折算价格表（见 §4.7）
```

三条必须写死的规则：

1. **只有主检出有工件目录**。worker 在自己检出里**只读**（绝对路径），不写。
2. **回执不进文件系统**：子代理把回执作为回复返回，宿主在 `post-execute` 抓取后写入 `cards/<id>/receipts.jsonl`。这同时解决三件事：worker 不会污染 diff（否则回执会被判越界）、`receipts/` 不需要独立顶层目录（修复 B4-2）、与 §12 的 P1"闸门证据来自会话事件"同源。
3. **`.cto-office/` 进 git**（可 review、可随仓库交接），但 `git status` 判定时排除该路径 —— 否则 CTO 的工件写入会被算进 worker 的 diff。

**冻结所读版本（批注新增，必须补）**：卡里保存 **`artifactsVersion`**（contracts / acceptance 的版本三元组）；回执必须写明**实际读取的版本**，由闸门校验与卡内版本一致。不一致 → 打回并说明"你读的是 v1，卡已定稿 v2"。

> 不补这一条的后果：CTO 中途定稿 v2，worker 按 v1 做完，你按 v2 验收 —— 返工责任无法归因。

**跨检出读权限（计入 W0.1 实测）**：worker 在 worktree 中按绝对路径读取主检出的 `.cto-office/` **读**权限是否被沙箱允许。若不允许，降级方案：复制注入 + `git exclude`（此时工件版本漂移由 `artifactsVersion` 校验兜住）。

#### 2b 新工具 `office_artifact`（Host 半新增，最小面）

| 方法 | 行为 |
|---|---|
| `write(kind, cardId, content)` | 校验必需小节 → `replaceIfVersion` 写入 → 返回新版本号 |
| `read(kind, cardId)` | 返回正文 + 版本 |
| `verify(cardId)` | 检查契约/验收/回执是否齐、版本是否最新、`artifactsVersion` 是否与卡一致 |

只挂给 **CTO**（root）；其余岗位通过 `verify` 的结果与回执被约束，不直接拿写权限。

#### 2c 自检闸门（含回执协议）

回执是结构化块，**固定字段**：

```
RECEIPT:
- card: C1
- artifactsVersion: contracts=3, acceptance=2
- changed: api/import.ts, app/import/page.tsx        （必须 ⊆ 授权清单）
- acceptance:                                        （逐条判定）
  - A1 PASS
  - A2 PASS 证据：pnpm test import → 12 passed
  - A3 FAIL 原因：>10 万行 CSV 未测
- selfRisk: 大文件内存占用未验证
SELF-CHECK:
- build: pnpm build → 0
- tests: pnpm test import → 12 passed
- scope: api/import.ts, app/import/page.tsx
- gaps: >10 万行 CSV 未压测
```

- **`post-execute` 匹配结构化块**：缺 `RECEIPT` / 缺 `SELF-CHECK` / 缺任一固定字段 → **视为缺少证据，直接 `block` 打回**，反馈"补齐后重交"。
- 这里用 **fail-closed 是正确的**：回执是判定的**输入**，不是判定器本身的自我校验 —— 与 §12 的 B3（自校验不 fail-closed）不矛盾。
- 评审岗新增前置动作：先核 `SELF-CHECK` 与 `artifactsVersion` 是否成立（可复跑），再做四件事。

**验收**：缺 `SELF-CHECK` 的回执 → 子代理返回即被 `block`；回执写的 `artifactsVersion` 与卡不一致 → 打回并提示；worker 试图写 `.cto-office/` → 判越界；契约更新后旧回执 `verify` 报 stale。

---

### 4.4 阶段 3：状态机 + 检查点（P2，4–5 天）

#### 3a 状态定义（进 `SKILL.md` 表格 + sync 解析，保证单一来源）

| 阶段 | 进入条件 | 退出条件（可机检） |
|---|---|---|
| `clarify` | 会话开始 | 歧义点已问（或明确无歧义）且用户确认 |
| `open-card` | clarify 完成 | 至少 1 张卡含 acceptance 工件 + `baseSha` + 授权清单 |
| `dispatch` | 卡就绪 | 每张在飞卡有 owner（`maxConcurrentWriters` 未超） |
| `follow` | 已派工 | 所有在飞卡有回执 |
| `gate` | 回执齐 | 每张卡有 `GATE:` 且无 `CHANGES` 未处理；卡粒度未超限 |
| `settle` | 闸门通过 | 卡已提交 + 四行汇报 + 检查点落盘 |

> 删除原表里的"租约"字段：概念已由「在飞卡登记 + `exclusive` 组」取代（见 §4.2a）。

#### 3b 非法跃迁拒绝

Host 插件在 `pre-execute` 拦 `subagent` / `office_artifact` / `team_task_update` / `office_dispatch`，按当前阶段与目标操作查跃迁表；非法 → `deny` + 提示"当前在 X 阶段，Y 需要先完成 Z"。

#### 3c 检查点（精简为四项，修复 B4-1）

原稿五项里"阶段与时间"可由检查点文件名与 mtime 推导，"patch sha"可由 git 推导，真正不可重建的只有四项：

```json
{ "cardIds": [...], "artifactsVersion": {...}, "inFlight": [...], "taskBoardHash": "..." }
```

加一个头部字段 `phase` + `at` 便于人读，但**判定只依赖这四项**。**回滚**：`office_rollback(seq)` 恢复工件版本 + 提示任务板回退方式（任务板不自动重写，避免凭空改写历史）。

#### 3d 卡粒度硬上限（修复 C1，执行点在 gate 而非 dispatch）

开卡时无法预知实际改多少文件，"dispatch 拒绝建卡"实现不出来。改为两层：

| 时机 | 行为 |
|---|---|
| 开卡 | 记**声明值**（`declaredFiles` / `declaredLines` / `declaredBehaviors`），用于排期预警与 CTO 自查 |
| `office_gate` | **硬拦**：实际改动 > 10 文件 / > 400 净变更行 / 行为变化 > 1 条（对应 acceptance 条目数）→ 打回并要求拆卡 |

> 无这条上限，一张巨型卡永远是"授权内"的，worktree 隔离、清单、闸门全部退化为形式。

**验收**：跳过 `open-card` 直接派工 → deny；中断后重开会话 → 能报出"当前阶段 + 最近检查点 + 在飞卡"；回滚到 n-1 → 工件版本恢复且面板可见；超 10 文件的卡 → gate 打回。

---

### 4.5 阶段 4：UX 后置走查 + 人工关口（P2/P3，2–3 天）

- **4a 走查**：复用 `cto-ux`（不新增角色，避免破坏"恰好 7 个 preset"的断言）：`WALK` 以 `acceptance/<cardId>.md` 为唯一依据逐条核验，回执末行 `GATE: WALK PASS n/m`；未过走查的卡在 `settle` 阶段被 deny。
- 视觉证据：ux 用 `read_image` 看截图/产物；渲染由 CTO 在 bash 里做，ux 只读结果。
- **4b 人工关口**：三个触发点写进章程并强制 —— 需求确认（`clarify` 出口必须有一次用户确认）、中期抽查（长任务回退达阈值或触及不可逆动作时 `ask`）、最终验收（`settle` 前 `approval.request`）。用 `pre-execute` 的 `ask` 决策，而不是章程里的"建议问一下"。
- **4c 回退阈值（统一为一句、一个数字，修复 A4）**：

> **回退计数达 2 即转人；第 3 次直接 `deny` 且不再派回。**

计数落 `cards/<id>/card.json` 的 `revisions`，**由插件写、CTO 只读**（防止 CTO 自己清零）。四处文案（M5 图 / 05 章 / 06 章 / 本章）全部同步为这一句。

**验收**：走查条目与 acceptance 1:1 可对照；未过走查 → `settle` 被拒；第 2 次回退 → 触发 `ask` 转人；第 3 次 → deny 且回执说明不可再派。

---

### 4.6 阶段 5：工程化收尾（1–2 天）

| 工作包 | 内容 |
|---|---|
| W5.1 面板 | 右栏新增"阶段 / 在飞卡 / 走查 / 成本"四个只读块；数据源受限于现有注入面（读不到任务板与文件系统），阶段信息由**会话事件里的回执行**提供；`office.json` schema 升 `@3`；顺带修 D1（`open-card` 永不亮）与 D2（看不出陈旧） |
| W5.2 文档 | README 的工具矩阵、已知边界、迭代回路重写；architecture.html 由 sync 重新生成；D6 的手写步骤区并入生成区间 |
| W5.3 发布 | 版本 `0.3.0`（有破坏性：新增 host 半、工作区新增 `.cto-office/`），兼容表补齐 |

---

### 4.7 模型预算与成本策略（0.5–1 天，横跨阶段 1–2）

**现状（已取证）**：root 的 subagent 工具已开 `modelSelection: true` + `modelDiscovery: true`；子代理可选 `provider` / `model` / `reasoning_effort`。spawn 后端 `capabilities.agentOptions: true`（"merged over the parent"）。但放行卡在**会话级策略**：`subagent/model-selection-policy` 的 `allowedModels` 缺省 null ⇒ 显式选择被限制在父路由；用户级设置出厂 `enabled: false`。

**三级设计（不写死模型名）**：

| 级 | 内容 | 为什么 |
|---|---|---|
| L1 岗位约束 | 只写能力与隐私要求（CTO=长上下文+强推理；评审=允许高档但需可热调；QA/UX/业务=可弱；全部 ZDR） | 模型目录三个月一变，写死必过期 |
| L2 路由候选 | 运行时从宿主读实际可用路由（`llm.listProviders()` / `listModels(provider)` / `discoverModels`），与 L1 求交 | 环境里没有的不进配置 |
| L3 用户覆盖 | 设置页按岗位选"路由 + 档位"，默认来自 L2，存 settings 文档 | 不同机器可用模型不同 |

**本期落地粒度：岗位 → 推理档位（不是岗位 → 模型）。** 实测当前只授权一条路由 `magpie/auto/deepseek-v4.1-flash`，档位 `low/high/max`。

- 档位映射：OpenCode `variant`（`#high`）↔ DSH `reasoning_effort`，1:1。
- 默认档位：CTO / 架构师 / 评审 / 工程师 = `high`；QA / UX / 业务 = `low`；**禁止 `xhigh`/`max` 做工位默认**（thinking 按 output 价计费、且换档打断 prompt cache）。
- 评审特例：允许临时升档，但优先选支持运行时热调的模型，否则切档=切 variant=缓存失效。

**W0.1 必须实测的两项（修复 A6，降级路径先写下来）**：

1. `reasoning_effort` 单独是否也受会话级 `allowedModels` 策略限制；
2. preset 能否设默认档（而不是每次派工显式传）。

> **降级路径**：若实测不通过，§4.7 退化为"每次派工显式传档位"（仍可用），最坏退化为"全局统一档位 + 只在 CTO 关键判定点用人确认"。**§4.7 的任何承诺都以这两项实测为前提，不以"已定"的口气写在汇报封面。**

**上下文额度**：各 preset 的 compaction 阈值按岗位分开（W0.5 去重后只改 1 处）；CTO 抬阈值，worker 更激进压缩；可进 `EXPECTED` 断言。

**成本口径（修复 C3，四点绑定）**：

| 要求 | 做法 |
|---|---|
| 价格表外置 | `.cto-office/price-table.json`（可编辑、进 git），插件缺省用内置兜底。烘焙进插件意味着每次调价都要发版 |
| 版本化 + 过期提示 | 带 `priceTableVersion` 与生效日期；估算结果标注用了哪一版；超期未更新**面板告警**，不静默算错 |
| 定位写清 | **事后归因与趋势，不做事前闸门**。token 是估的、价格是折的，误差相乘 —— 不做精确到小数点的假账 |
| 窗口挤占不并入 | 5 小时额度挤占无法折算，只能实测，留在 §6 风险表 |

记录三元组 **「模型 + 档位 + token」**，按价格表离线折算"估算点数"（**不联网、不拉 usage、不需要 key**）。

**护栏**：弱模型**不进评审与闸门**；每卡记录 token/缓存命中率/估算点数，异常卡结算时标出。

**验收**：同一张卡分别用 `low`/`high` 派工 → 三元组与估算点数可读出；岗位默认档位有 `npm run check` 断言；派工请求未授权路由 → 被拒且理由可读；价格表过期 → 面板告警。

---

## 5. 改动面清单（按文件）

| 文件 | 阶段 | 改动性质 |
|---|---|---|
| `index.js` | 1–4 | 从空壳变成真 Host 插件：`office_dispatch`（授权清单 + `baseSha` + 受控 spawn + 档位；**二期**才建 worktree）、`office_gate`（`diff`+`status` 双读对清单判定 + 卡粒度硬拦）、`office_artifact`（工件读写与 `artifactsVersion`）、`office_release`（在飞卡超时释放）、`office_rollback`（检查点回滚），以及 `pre-execute`/`post-execute` 监听与 `guard`（含 `reset`/`rebase`/`amend` 拦截） |
| `cordis.patch.yml` | 1–5 | ① 所有 preset 增加机制挂载（去重后 1 处）；② root 的裸 `subagent` 收窄/让位给 `office_dispatch`；③ `maxConcurrentWriters` 配置项（一期 `1`）；④ `subagent-model-selection-settings` 的初始 `allowedModels` 白名单；⑤ 各 preset 的 compaction 阈值按岗位分开；⑥ **二期**才需要 `@deepseek-ai/dsh-experimental-worktree`（可选 bundle，先建档） |
| `skills/cto-office/SKILL.md` | 1–4 | 新增「串行写卡与提交边界」「阶段机」「回执协议」「在飞卡与释放」；六步补进入/退出条件（sync 会强校验六步数量，需同步改 `parseSteps`）。**删去原「写入租约」一节** |
| `skills/cto-builder/SKILL.md` | 2 | `RECEIPT` + `SELF-CHECK` 固定字段与 `artifactsVersion` |
| `skills/cto-reviewer/SKILL.md` | 2,4 | 前置核自检与工件版本；引用契约版本 |
| `skills/cto-ux/SKILL.md` | 4 | 执行后走查动作与回执行 |
| `scripts/sync-office-data.mjs` | 1–5 | `EXPECTED` 新断言（含岗位档位）、解析阶段表、新字段注入、README 口径校验（可选） |
| `docs/office.json` / `docs/architecture.html` / `client.js` `OFFICE_FACTS` | 3,5 | 生成物，跑 `sync`；D6：把 architecture.html:1305-1371 的手写步骤说明并入生成区间 |
| `README.md` | 0,5 | 修 D5（文件数）、修 N6（"两道闸"口径）、修 README:9/80 的措辞与事实冲突、"已知边界"补 bash 泄漏与沙箱现状、补 `.cto-office/` 说明 |
| `package.json` | 0,5 | 兼容表、profiles、版本；D4：决定 `files.docs` 是否保留 |
| `.cto-office/price-table.json` | 4.7 | 新增（进 git、可编辑、带版本与生效日期） |

**不改**：六个岗位 preset 的工具边界（只读/可写划分保持不变）—— 这轮不新增角色、不放宽权限。

---

## 6. 风险、失败信号与取舍

### 6.1 风险与应对

| 风险 | 应对 |
|---|---|
| bash 写路径无法 100% 封死 | 兜底层是"规则级"，不承诺内核级；章程与 README 如实写明。**沙箱按角色只读若能验通，直接升级为硬约束** |
| `tools.restrict` 作用域存疑 | W0.1 先验；验不通退回"`pre-execute` deny"单机制（仍硬，只是多一跳） |
| Host 插件带来崩溃面 | 监听器必须"失败即放行"（自己抛错不能把会话卡死）；判定逻辑本身不 fail-closed（见 §12 B3） |
| 状态机过严导致流程卡顿 | 保留显式逃生口：`office_phase force` 需 `approval` 通过（人确认），不悄悄绕过 |
| 去重（W0.5）是重构，可能引入回归 | 阶段 0 单独成一包，以 `npm run check` + 面板快照对比作回归门 |
| 恰好 7 个 preset 的硬断言 | 不新增角色，UX 走查复用 `cto-ux` |
| **提交边界被 `reset`/`amend` 绕过** | `pre-execute` 显式拦截（§4.2a F 层）+ 判定双读 diff 与 `status` |
| **工件跨检出读权限未实测** | W0.1 实测；不通过则降级为"复制注入 + `git exclude`"，版本漂移由 `artifactsVersion` 兜住 |
| **并行对时间窗额度的挤占** | 折算不出来，只能实测：记录同窗口并发派工数与窗口末剩余量；降级策略为并发上限或高峰串行。**这条比 worktree 依赖安装更早撞墙** |
| **干净检出跑全量的成本** | 不每卡都跑（会吃掉串行全部时间收益），只在**合并门跑一次**；用 `git worktree add` 到临时目录 + 依赖走缓存，不重新 clone |

### 6.2 失败信号表（修复 C2 + E2：必须成对读）

单看一个指标必然误读，所以每条信号都给出**配对读法**：

| 信号 | 单独读会怎样 | 配对指标 | 判定 |
|---|---|---|---|
| 闸门一次通过率 ≈ 100% | 像是质量好 | **变更分散度**（每卡改动文件数分布） | 分散度高 → **判据太松或没人看（失败信号）**；分散度正常 → 可能真的简单 |
| 回退次数恒为 0 | 像是很顺 | **卡粒度**（文件数/行数） | 卡都很小 → 合理；卡很大且零回退 → 闸门没在拦（失败信号） |
| 授权清单持续变宽（提权率上升） | 像是需求变化 | **提权理由分布** | 集中在共享文件 → 该建 `exclusive` 组；分散 → 卡拆得不好 |
| 每卡 token 持续上升 | 像是任务变难 | **卡粒度 + 回退次数** | token 涨而粒度没涨 → 上下文在漏（失败信号） |
| 工件版本长期不变 | 像是稳定 | **卡数量** | 卡在涨而工件不涨 → M4 没落盘（失败信号） |
| 走查记录高度雷同 | 像是一致性好 | **走查条数与 acceptance 条数** | 不等 → 走查没逐条（失败信号） |

> **「闸门 100% 通过」与「回退恒 0」必须当失败信号读，不能当质量指标** —— 否则面板一上线就会被误读成"机制运行良好"。

### 6.3 一期不验证什么（修复 E1）

一期是串行 + 无 merge，**并行相关机制在一期没有任何验证样本**。必须写明：

> **一期只验证"可判定性"（越界必现、自检有效、工件不漂移），不验证并行收益、不验证 worktree 隔离、不验证合并冲突处理。** 这三项只在二期验证，二期不得引用一期数据当担保。

---

## 7. 排期与工作量（按 M-12 双门槛与 A/B 切分）

### 7.0 分期对账表（终版 · 每个组件只能有一个归属）

| 组件 | 一期 A | 一期 B | 二期 |
|---|---|---|---|
| 串行写卡 `maxConcurrentWriters=1` | ✅ | | 改为 `>1` |
| `baseSha` 提交边界 + `reset`/`rebase`/`amend` 拦截 | ✅ | | `baseSha` 改取 `baseCommit` |
| `diff` + `status` 双读判定 | ✅ | | 路径不变 |
| `exclusive` 互斥组 | ✅ | | 同左 |
| `QUEUED` 态 + `blockedBy`（`serial-limit` / `exclusive-held`） | ✅ | | 增 `exclusive-held` 场景 |
| **卡粒度硬上限（10 文件 / 400 行 / 1 行为）** | ✅ | | 同左 |
| 工件单写入点 + 绝对路径只读 + `artifactsVersion` 冻结 | ✅ | | 同左 |
| `RECEIPT` / `SELF-CHECK` 闸门 | ✅ | | 同左 |
| 回执协议（宿主 `post-execute` 抓取，P1） | ✅ | | 同左 |
| `evidence.json`（`source` 四枚举） | ✅ **仅记录** | ✅ **判定白名单生效** | 同左 |
| `rounds` 计数器（回退 + 重试合并为一个） | ✅ | | 同左 |
| 超时监督器 | ✅ **最小报警** | ✅ 完整（续租 / escalate / abort） | 同左 |
| `abandoned` / `settled` 终止态（含释放 `exclusive`） | ✅ | | 同左 |
| 每日看板（一个入口、三块） | ✅ 最小版 | 完整版 | 同左 |
| M-2 事务 + `intentId` + latest-wins | | ✅ | |
| M-8 故障注入（9 用例） | | ✅ | 跨检出用例二期复跑 |
| M-12 指标 + 双门槛 + `sampleTag` | | ✅ | 二期开工判据 |
| M-14 三处宿主门槛 | | ✅ | |
| M-6 依赖清单 + `platform-probe` | | ✅ | |
| worktree 隔离 | | | ✅（依 M-12 判据） |
| 阶段机 + 检查点 + 回滚（完整） | | | ✅ |
| UX 走查 + 三处人工关口（完整） | | | ✅ |
| 岗位档位 + 离线成本折算 | | | ✅ **最后做**（M-7） |

> 对账表的两条硬规则：① **每个组件只出现在一列**，防止像上一版那样“工件层/闸门/回执”在三份清单里都找不到归属；② **A 列必须能独立交付并断言结果**，不依赖 B 列任何一项。

### 7.1 一期 A · 可判定内核（约 9–12 人日）

| 工作包 | 内容 | 估算 |
|---|---|---|
| W0 | 兼容实测六项 + 声明修正 + 迭代回路 + 门禁 | 1–2 天 |
| W1 | 串行写卡 + 授权清单 + `baseSha` 提交边界 + 双读判定 + `exclusive` + 防篡改拦截 | 3–4 天 |
| W2 | 工件单写入点 + `artifactsVersion` + `RECEIPT`/`SELF-CHECK` + 回执抓取 | 3–4 天 |
| W1c | 卡粒度硬上限 + `rounds` 计数器（回退与重试合并） | 0.7 天 |
| W1d | `QUEUED` 态 + `abandoned`/`settled` 终止态（含释放 `exclusive`） | 0.5 天 |
| W1e | 超时监督器**最小报警**（15 分钟轮询，一句话推送） | 0.3 天 |
| W1f | `evidence.json` **仅记录**（`source` 四枚举落盘，不参与判定） | 0.5 天 |
| **A 合计** | | **≈ 9–12 人日** |

**A 交付后可断言的只有三条**：越界必现、改动可归因、证据来源可区分。崩溃仍不可恢复，机制有效性仍未被证明。**另：`GATE` 防伪只完成一半 —— 挡得住「写一行假 GATE」，挡不住「造空壳 preset」，后者在 B（见 §7.1c）。**

### 7.1b 三个停点（你随时可以停）

| 停点 | 内容 | 人日 | 能断言什么 | 不能断言什么 |
|---|---|---|---|---|
| **停点 0 · W1** | 串行写卡 + 授权清单 + `baseSha` + 双读判定 + `exclusive` + 防篡改 | **3–4** | **越界必现** —— 核心主张里最硬的一半 | 没有对照物、没有闸门，自检无法落地 |
| **停点 1 · 一期 A** | A 全部 | 9–12 | + 改动可归因、证据来源可区分 | 崩溃不可恢复、有效性未证、**`GATE` 防伪仍不完整**（见 §7.1c） |
| **停点 2 · 一期 B** | B 全部 | 5–6 | + 崩溃可恢复、机制有效性可证、二期判据可算 | 并行未验证 |

> **停点 0 的意义**：3–4 天就能验证「越界必现」这条最硬的断言，而不是 9 天起跳。对一个还没跑过一行代码的框架，第一个可验证点不该在 12 天后。

### 7.1c A 阶段的防伪边界（漏 3 修正：说清 A 到底防住什么）

**先纠正一处误读**：P1（回执由宿主从子代理会话事件抓取 + 校验来源 preset）**在一期 A，不在 B**（见 §7.0 对账表）。所以 A 阶段并非「`GATE` 可被随意伪造」。准确的三分：

| 伪造路径 | A 阶段状态 | 门在哪 |
|---|---|---|
| 直接写一行 `GATE: PASS` 进文件 | ❌ **不可能** —— P1 只认子代理会话事件，文件里的文本不参与判定 | A（W2） |
| 造一个空壳 preset 冒充 `cto-reviewer` | ✅ **仍可能** —— CTO 改 patch 即可 | **B（W7 第一道门：改 patch/preset 需人工确认）** |
| 让真评审橡皮图章（反复派工直到某次 PASS） | ⚠️ **部分** —— 标 `suspicious_pass` 并进看板，但不阻塞 | A 有 `suspicious_pass` + `rounds` 上限；彻底堵需人 |

因此 A 阶段的准确定位是：**「越界与归属可信，证据来源可区分，但证据本身的可靠性分级尚未生效」** —— M-1 的判定白名单在 B（W4）。这条必须写清楚，否则「P1 是关键」容易被读成「A 结束就防伪完整了」。

### 7.2 一期 B · 机制加固（约 4–6 人日）

| 工作包 | 内容 | 估算 |
|---|---|---|
| W3 | M-2 事务（`intentId` + latest-wins + 持久化替换 fsync） | 0.7 天 |
| W4 | M-1 `evidence.json` 判定白名单生效（`cto-narrative` 不参与判定） | 0.5 天 |
| W5 | M-8 故障注入 9 用例 + 脚本化 + 报告视图 | 0.8 天 |
| W6 | M-12 指标 + 双门槛 + `sampleTag`/克隆隔离 | 1 天 |
| W7 | M-14 三处宿主门槛 | 1 天 |
| W8 | M-6 依赖清单 + `platform-probe` | 1 天 |
| W9 | 超时监督器完整版（续租 / escalate / abort）+ 每日看板完整版 | 0.7 天 |
| **B 合计** | | **≈ 5–6 人日**（分解 0.7+0.5+0.8+1+1+1+0.7 = **5.7**） |

### 7.3 二期 · 解锁隔离（约 9–14 人日，**可能缩减**）

> **标题已按 M-5 更改：」解锁并行」→「解锁隔离」。** 三条外部证据（CooperBench 50%→25%、Cognition 写入单线程、Anthropic 协调能力不足）同向否定“多写者同时改更快”；被支持的只有“隔离”价值。
>
> **二期是否建 worktree，由一期 B 跑满 M-12 双门槛后的数据决定。** 若排队阻塞率低，二期缩减为「状态机 + 检查点 + 断点恢复」，不建 worktree。

| 工作包 | 内容 | 估算 |
|---|---|---|
| W2b | worktree 隔离 + 并发上限放开（**判定路径不改**） | 2–3 天 |
| W3b | 阶段机 + 检查点 + 回滚（完整） | 4–5 天 |
| W4b | UX 走查 + 三处人工关口（完整） | 2–3 天 |
| W5b | 岗位档位 + 离线成本折算（**最后做**） | 0.5–1 天 |
| W6b | 面板 + 文档 + 0.3.0 | 1–2 天 |

### 7.4 关于"去重（W0.5）"的处置

批注建议砍掉（不解决阻塞、动 653 行核心区、风险收益比最差）。**部分接受**：移出**一期关键路径**，改为二期的独立工作包，且降级为"只抽 `skill-filesystem` 探测块"（7 份 sha 相同的 19 行），不动 `compaction` 组。

### 7.5 工时口径说明（防止再被低估）

| 版本 | 一期 | 说明 |
|---|---|---|
| 初版 | 8–11 人日 | 只看 W0+W1+W2+回退计数器 |
| 本轮修订 | **A 9–12 + B 5–6 = 14–18 人日** | +70%；B 下限按分解 5.7 取 5，不取 4 |

> **涨幅本身就是 M-7 的示范**：把「半天搞定」按真实成本记账，比事后延期诚实。**如果你只想先看到效果，停在一期 A（9–12 人日）是合理的** —— 它已覆盖核心主张里最硬的一半。

---

## 8. 决策状态

> **原 7 项（2026-11-24 确认）**：全部按推荐执行。
> **追加 5 项（2026-11-25 确认）**：worktree 派工 → 采纳并重排为二期；模型预算 → 只做岗位档位；不做 usage 拉取；分模型分档等宿主放开；CTO 写盘 → 一次会话授权一次 + 逐条留痕。
> **本轮批注（2026-11-25）**：A1–A6 / B1–B4 / C1–C4 / D1 / E1–E3 的处置见 §13。

### 唯一的未定项

| # | 待定 | 为什么还没定 |
|---|---|---|
| 12 | **`reasoning_effort` 是否受会话级 `allowedModels` 限制、preset 能否设默认档** | 只能实测（W0.1 第 ⑤、⑥ 项）。实测前 §4.7 的全部档位承诺都是**有条件**的 |

其余全部已定。这一项不是"等你拍板"，而是"等实测结果"—— 结果出来我直接回填，不需要你再决策。

---

## 9. 决策记录：派工形态用子代理，不用「看板开新会话」

**结论：cto-office 的派工通道继续用子代理（`tool-subagent` + `provider: spawn` + `agentPreset`），任务板只做状态容器，不做派工通道。** 现行 patch 已经是这个形态（patch:100-122），本轮不需要换。

### 9.1 先把概念校正：DSH 里不是「两种派工」

| 你的说法 | 实际结构 | 证据 |
|---|---|---|
| ① 子智能体 | **派工通道**：`subagent` seam，后端可以是 `spawn`（新空会话）/ `fork`（带父级已完成轮次）/ 外部（ACP、SDK、Codex、Claude Code，执行一次） | `dsh-subagent` 中文概述：本地 spawn 与 fork 子级**保留持久会话**以接受后续消息 |
| ② 插件 task-board 开新会话 | **台账 + 独立会话**：板子本身不下发活；社区的看板插件是「每张卡在自己的会话里跑」 | `dsh-agent-team`：「为现有 subagent 树添加**持久化共享任务板**」「Team **不创建**隔离工作目录、不跨进程协调」；`dsh-tool-agent-team`：板工具只提供 create/claim/complete |

两个关键事实：

1. **子代理本身就是会话**：`dsh-subagent` 明说本地子级「保留持久会话以接受后续消息」，`subagents` 服务提供 `listDescendants` / durable discovery / `resume`。所以「子代理短命、看板会话持久」这个直觉在 DSH 里**不成立**。
2. **看板会话缺的正是原生回程**：本机 `web` profile 里装的 `dsh-task-settle-notify`（作者同一人）README 开篇：「卡跑完了，消息自己敲门。**发起那张卡的会话，会收到一条结算消息**」，并指出看板卡会遇到「提问面板没人守着，卡就停在那儿等」。**这个插件存在的理由，就是独立会话没有原生完成通知。**

### 9.2 为什么不能换成看板派卡（四条硬理由）

| # | 理由 | 后果 |
|---|---|---|
| 1 | **拦截点消失** | 本方案的单写者互斥（L1）、非法跃迁拒绝（3b）、自检闸门（2c）全挂在 `tools/pre-execute` / `post-execute` 上 —— 它们只拦**本会话内**的工具调用。派工若变成「另一个独立会话」，那个会话的写操作不经过 CTO 的工具管线，`deny` 拦不住 |
| 2 | **没有原生等待/通知/续聊/中断** | 树内独有：完成通知、`wait_agent`、`send_message`、`interrupt`、`waitForTreeWork`/`drainDescendants`。跨会话要自己补（见 9.1 第 2 点） |
| 3 | **`ask_user` 无人值守** | 章程第 1 步「一次问全」依赖 CTO 汇总子代理的疑问；看板卡各自提问没人守（这是已存在的实测痛点） |
| 4 | **角色边界退化回提示** | 子代理通过 preset 组合获得全新工具作用域（`spawn`/`fork` README 均强调「不继承父级的任何权限」），只读岗的 `write/edit` 关闭才真实生效；独立会话的 preset 由人点选或看板插件决定，没人保证它就是那个岗位 |

**一句话**：换形态会同时废掉本轮 4 条建议里的 3 条（一、二、五），把项目从「架构约束」打回「提示词」。这是不换的唯一决定性理由。

### 9.3 看板形态的正当用途（并存，不替换）

看板/独立会话适合：跨机器或跨进程、人需要**直接接管某个会话**继续对话、粒度是「给人看的工地」。这类需求应该做成**另一个并存模式**，而不是塞进 cto-office 的派工链路。

**可复用的衔接点**：阶段 2 规划的 `.cto-office/cards/*.json` 是工作区内的持久台账，不依赖 Team 模式。将来若做看板 bundle，直接消费同一份台账即可 —— 一份数据，两种视图（CTO 树内推进 / 人肉看板），不必再造第二套状态。

### 9.4 市场里的看板插件现状（只读核对，未安装验证）

本机 market 缓存（`profiles/web/.dsh-market`）里至少有 4 个：`taskboard-workbench@0.3.5`（`enginesDsh >=0.2.1-rc.3`）、`@kira905/dsh-task-board-local@1.2.2`（`>=0.1.1-rc.1`）、`dsh-taskboard@0.10.0`、`dsh-plugin-taskboard@0.1.0`（后两个未声明 engines）。「作者未更新到支持 rc.5」这个判断**至少要逐包核对**——其中 `taskboard-workbench` 的引擎区间是覆盖 rc.5 的，其余是否真不兼容要装前看 `engines/peerDependencies`，不能凭 README 推断。本方案不依赖其中任何一个。

---

## 10. 决策记录（二）：git worktree 派工 + 模型预算

> **后续修订**：本节记录的是 2026-11-25 中段的讨论结论。同日稍后的审查批注（D1）把 worktree 从“一期骨架”调整为**二期**（一期先做单检出的可判定性），理由见 §7 与 §13.4。本节保留原判断以便追溯，**前置章节（§4.2）以重排后的版本为准**。

### 10.1 「用 git 实现权限与范围」这个设计

**判断：采纳；但有四处要修正，且它并不能替代 diff 判定本身。**（按 D1 重排后，它是**二期的骨架**，一期只做单检出的判定层。）

先对齐 DSH 现成能力（不用自己造）：`ctx.worktrees.create(agent, { name?, from? })` —— 从本地提交创建**新具名分支 + 隔离检出目录**，源检出保持不变，返回 `{ path, branch, baseCommit, repositoryRoot }`，并自动把会话工作目录切进去；另有 `restore()`（检出被删时重建）与 `cleanupOf()`（归档时回收干净且无引用的检出）。服务文档原文：「所有写入均受现有沙箱约束」。

四处修正：

| # | 你的原设想 | 修正 |
|---|---|---|
| 1 | 「让子 agent 拉一个新 git 分支走」 | 只用分支不够：多个 agent 在**同一个工作区**切分支会互相踩文件。必须用 **worktree**（独立检出目录），DSH 的 `worktrees.create` 正是这个 |
| 2 | 派工时「直接规定权限+范围」 | 派工参数**改不了**（`pre-execute` 源码原话："Input rewriting is excluded"）→ 必须由我们自己的 `office_dispatch` 工具完成「写清单 + 记 `baseSha` + 受控 spawn」（二期再加 `建 worktree`），不能靠拦裸 `subagent` |
| 3 | 靠授权清单**阻止**越界 | 清单+diff 是**事后判定**，不是事前阻止。阻止只有三层：工具不挂（已做）、沙箱工作区边界（宿主级）、模式只读（逐会话可切）。要如实告诉模型"越界必被发现"，而不是"越界不可能" |
| 4 | diff 比对 | 必须同时看 `git status --porcelain`：未跟踪、删除、重命名都不在 `git diff --name-status` 里；非 git 仓库要回退到快照 hash；构建产物要让 `.gitignore` 兜住，否则噪声淹没判定 |

为什么它比原方案强（这是本轮最重要的一次方案升级）：

- 原方案的"单写者"= **禁止并行**（锁/否决），代价是把并行能力彻底放弃；新方案的"单写者"= **并行可见性隔离 + 写主线串行合并**，并行保留在"读+改各自的副本"层面，合并由 CTO 串行执行。这与外部证据的教训完全对齐（冲突来自同目录并发写，不来自并行本身）。
- 边界从"提示"变成"可复跑的判定"：`git diff base..card/<id>` 是**客观事实**，不是谁"确认过范围不重叠"。
- review 的"干净环境"天然成立：`spawn` 子代理以空对话开始（不继承 worker 思考链），review 只拿 diff + 契约 + 验收基线。
- 冲突从"两个写者互相覆盖、难以定位"降级为"合并时一次可见的冲突，由 CTO 串行解决"。

新增的实操成本（必须写进章程）：

- 派工前工作区要干净：未提交改动不会带进 worktree，worker 会看不到最新代码。
- 每个 worktree 的依赖安装成本（JS 项目尤甚）—— 未实测，可能显著拖慢"能跑测试"。
- worktree 会累积，要有清理策略（结算后回收）。

### 10.2 「CTO 用强模型 / worker 用 flash」这个判断

**判断：你的判断正确，而原方案确实没有设计（已在 4.7 补齐）。** 现状是「能开、但没放行」：patch 已开 `modelSelection`/`modelDiscovery`，但放行靠会话级 `allowedModels` 策略，出厂是空列表 ⇒ 今天给某个岗位换 flash 大概率不生效。落地走 **A（patch 预置白名单）+ C（受控派工按卡预算注入）**，B（双工具实例 `agentOptions`）作为过渡。护栏：**弱模型不进评审与闸门**。

### 10.3 两个已确证、但会决定成败的沙箱事实

1. **工作区根是宿主级的**：`workspaceRoot = config.workspaceRoot ?? process.cwd()`（沙箱策略包源码），不是逐会话 cwd。⇒ worktree 不会自动把写者"关"在自己的目录里；它提供的是**隔离与可判定**，不是**禁止**。
2. **沙箱模式是逐会话可切的**：策略包文档原文「部署方选择默认模式和回退工作区根目录，**每个会话则可以独立切换模式**」。⇒ "只读岗真的只读"这条路是通的，但要看**谁能切**（是用户 UI/命令，还是 agent 也能切）。这决定了兜底层能做到多硬，是 W0.1 的第三个实测项。

结论：**你的 git 方案是必要的那一层**——因为文件级授权（"只准改这 3 个文件"）在沙箱与工具层都做不到，只有在 diff 上判定。

### 10.4 当时的两个确认问（均已确认）

| # | 决策 | 结果 |
|---|---|---|
| 8 | 是否按 worktree 方案重写阶段 1 | **已采纳，但按 D1 重排为二期**；一期改为单检出 + 串行写卡 + 提交边界（§4.2a） |
| 9 | 模型预算策略 | **只做岗位档位**（不拉 usage、不按模型分档），见 §4.7 |

---

## 11. 核证记录：OpenCode Go 模型分档建议（2026-11-25）

**核证方法**：① 直接拉官方模型端点 `https://opencode.ai/inference/go/v1/models`（HTTP 200，返回 31 个 chat + 3 个 decision + 3 个 embedding 的完整元数据）；② 读官方文档 `https://opencode.ai/docs/console/go`（额度与隐私条款）；③ 在本机 DSH 里实测可授权路由（`list_subagent_models`）。

### 11.1 逐项核对

| 顾问主张 | 核证结果 |
|---|---|
| 31 个对话模型、档位分组（5/6/5/4/3/3…） | ✅ **全部正确**：每个模型的 `reasoning.effort` 数组与分组逐条吻合 |
| Kimi K3 只有 `max`；Hy4 只有 `none`/`high` | ✅ 正确（Kimi K3 `effort:["max"]`；Hy4/hy4-preview/hy4-flash-free `["none","high"]`） |
| 只有 3 个模型支持运行时热调档 | ✅ 正确：`effort_updates: true` 仅 GPT-5.6 Luna、GPT-6 Luna、Claude Haiku 5.5 |
| 各家额度（$15/$30/$60/$100/$200） | ✅ 与 `go.monthly_usage.go` 逐条吻合（DeepSeek Flash 100、GLM-5.3 200、Haiku 15、MiMo 60…） |
| 输出价、缓存读价、每点可买 token 的推导 | ✅ 价格全部吻合，四列推导重算无误 |
| 单池共享（不是各模型独立额度） | ✅ 官方文档原文："The paid models you use on Go **share one allowance**"；5h = 月额度 **20%**、周 = **50%**（周一 00:00 UTC 重置） |
| 20 点 / 50 点 / $10 | ✅ 20% × 100 = 20 点、50% = 50 点；$2/5h 是"20% × $10 订阅价"的口径 |
| 触顶后可回落免费模型或 Extra Usage | ✅ 文档确认，且免费模型不占额度（`monthly_usage: null`） |
| `opencode run --model provider/model#variant`、TUI `Ctrl+T` | ⚠️ **未核实**（属 OpenCode 客户端行为，文档未明写；对 DSH 落地无影响） |
| "花的美元 ÷ 该模型额度 = 点数" | ❌ **公式口误**：应为 **美元 × 100 ÷ 额度**。其后的例子（$1 在 $100 额度 = 1 点；$1 在 $60 额度 = 1.67 点）与"每 1 点 = 额度 ÷ 100 美元"都正确，只有这句表述反了 |
| "xhigh/max 常设主写手 → 5h 窗口撑不到一个迭代周期" | ⚠️ **方向对、条件要补**：单会话远不触顶；触顶发生在"多角色长上下文 fan-out + 白天 ×2 倍数"叠加时。粗算：7 角色 × 100k 上下文 × 30 步，`high` 约 13 点、`xhigh` 约 25 点，而窗口只有 20 点 —— cto-office 正好是最吃这个窗口的形态，所以对该项目警告成立 |

### 11.2 顾问漏掉的 6 件事（都影响选型）

| # | 遗漏 | 影响 |
|---|---|---|
| 1 | **时段价格倍数**：DeepSeek V4.1 Flash / V4 Pro 在工作日 UTC 01–04、06–10（**北京时间 09:00–12:00、14:00–18:00**）`factor: 2`；Gemini 4 Argon 的 5 折优惠到 2026-11-30，之后 ×2 | 首选主写手恰好在中文用户的白天工作时段翻倍；夜间跑同一任务省一半点数 |
| 2 | **长上下文价格台阶**：Claude Haiku 5.5 >100k 上下文输入/输出各 ×5；GPT Luna >272k、Qwen3.7 Plus >256k、Grok 4.7 >200k 均上调 | "评审用 Haiku"这条建议在跨文件审查（天然超 100k）时会贵 5 倍，表里的每点 token 直接失效 |
| 3 | **隐私位**：`training` / `zdr` / 保留期各不相同——Claude Haiku 5.5、GPT-6 Luna、Grok 4.7 保留 30 天，Gemini 55 天，GLM/MiMo/Qwen/Kimi/DeepSeek 为 0 天；DeepSeek 的 ZDR 协议**每月续签、当前有效期到 2026-11-30** | 私有代码被"省钱"送到 30 天保留或训练用途上是实打实的风险；顾问表里最省的 Muse Spark 1.3 Contributor 明确 **train on your data** |
| 4 | **点数效率更好的模型被整体漏掉**：Muse Spark 1.3 Contributor（额度 $60、输出 $0.20/M ⇒ **3.0M token/点**，比表里最好的 MiMo 还高 40%） | 若不接受"用你的数据训练 + 区域受限"，它是不可选项；若接受，它才是第一名 —— 这个取舍必须显式做，不能靠漏掉来回避 |
| 5 | **免费兜底模型**：Hy4 flash Free（免费、ZDR、1M 上下文、只能 `none`/`high`）、HungerG Free、Beam Free（中国区不可用） | 这是撞到 5h 窗口时最实际的降级路径，比"切 Extra Usage 花钱"更好；Hy4 flash Free 因为没有中间档，适合当"要么不想、要么想透"的兜底 |
| 6 | **DSH 被 OpenCode 官方列为 known problematic client**：session header 在部分模型路径缺失，影响路由与 prompt cache | 整套省钱逻辑重度依赖缓存命中（缓存读比未缓存输入便宜 50–100 倍），缓存打折就等于成本模型失效 → 必须实测命中率，不能只看账面 |

另外一条结构性事实：**Go Teams 每个成员有独立额度**（$20/人，2 人起）。如果将来要"多角色并行且预算互不挤占"，Teams 比在单池里做分配更容易。

### 11.3 DSH 侧可行性（决定性）

| 检查项 | 实测结果 | 含义 |
|---|---|---|
| 可授权子代理路由 | **只有 1 条**：`magpie/auto/deepseek-v4.1-flash`（routing group），档位 `low/high/max` | 顾问那张"8 个角色 8 个模型"的表，在当前环境**一条也配不出来** |
| 模型标识形式 | DSH 是 `provider / model / reasoning_effort` 三段，不是 `provider/model#variant` | OpenCode 的 variant 可 1:1 映射到 `reasoning_effort`（档位名已实测一致） |
| 换模型是否已放行 | 会话级 `allowedModels` 缺省为 null + 用户设置出厂 `enabled:false` | 今天显式换模型会被限制在父路由 |
| 运行时自动组装 | `llm.listProviders()` / `llm.listModels(provider)` / `discoverModels(settingsNs)` 均可用 | L2「按环境可用路由自动组装」**可落地** |
| 设置页自定义 | 已有 settings 服务、`ui-settings-subagent` 页与 `subagent-model-selection-settings` 文档 | 可复用现成页面，不必自建 UI |
| 点数预算感知 | DSH 只有 token 计数（`tokenMeter`），无"点数/滚动窗口" | 要显示 Go 用量只能插件请求 `/v1/usage`（需 key）→ 本期只做 token 计量 |

**结论**：顾问的**方法论正确、数字正确**（一处公式口误），但**缺 6 个会改变结论的维度**；而**在 DSH 里当前只能落地"岗位 → 档位"，不能落地"岗位 → 模型"**。所以 §4.7 改成三级设计：约束 → 自动组装 → 用户覆盖，本期只做档位分档。

### 11.4 当时的确认问（已确认）

| # | 决策 | 结果 |
|---|---|---|
| 10 | 模型策略本期做到哪一层 | **只做岗位档位**（while 不拉 usage、不按模型分档）。usage 拉取需把 Go key 交给插件，未授权；按模型分档等 `allowedModels` 放开 |

---

## 12. CTO 由谁监管

### 12.1 结论

**机器管得住过程，管不住自述；所以 CTO 的监管者只能是「不可伪造的事实 + 你本人」，不能是另一个 agent。**

三层监管，按可信度排序：

| 层 | 监管者 | 能管什么 | 不能管什么 |
|---|---|---|---|
| L0 事实层 | 宿主事件、`git`、CI | 谁改了什么、命令退出码、测试是否真跑过、合并是否发生 | 判断对不对、方向要不要做 |
| L1 流程层 | 状态机 / 门禁 / 审计账本 | 能不能跳步、能不能不派闸门、CTO 有没有自己动手 | CTO 是否"想清楚了" |
| L2 人层 | 你（Owner） | 目标、范围、不可逆动作、最终验收 | 逐条 diff（注意力不够，只能抽查） |

**明确否决一个方案：不做「CTO 监督 Agent」。** 理由与「做的人不验收」同构——监督者若由被监督者任命、与被监督者共享同一套上下文与同样的偏差，它只会复述 CTO 的结论。真要第二意见，必须是**你召唤**的独立只读会话，而不是 CTO 派出去的卡。

### 12.2 CTO 目前被约束到什么程度

| 机制 | 对 CTO 的约束力 | 缺口 |
|---|---|---|
| 工具边界 | ❌ 无：root 挂全量工具，`write`/`edit` 都在（patch:46-49），铁律 5「先说明并取得同意」只是提示 | CTO 亲自改代码是完全合规路径，且不留痕 |
| 派工 | ⚠️ 弱：CTO 决定派谁、派几轮、派不派评审 | 可以不派评审直接进结算，无机制拦 |
| 闸门证据 | ❌ 无：`GATE:` 行写在**回执文本**里 | CTO 完全可以自己写一行 `GATE: PASS` 进 `receipts/`，与真评审无法区分 |
| 状态机（v2.0 计划） | ✅ 能拦住跳步 | 拦不住"我在被允许的阶段里伪造结论" |
| 授权清单 | ❌ 不适用：清单是给 worker 的，CTO 不受限 | CTO 直接写主检出，diff 判定也无从比对 |
| 成本 | ⚠️ 弱：每卡 token 由 CTO 记录 | 记录本身是自述 |
| 审计 | ❌ 目前没有 | 没有 append-only 账本 |

一句话：**v2.0 的现有设计能防"岗位乱来"，防不了"CTO 美化报表"和"CTO 自己下手"。**

### 12.3 三个真实漏洞

1. **自述当证据**：闸门结论、测试结果、成本数字都是 CTO 转述。凡是 CTO 能自己写出来的证据，都不算证据。
2. **CTO 不受清单约束**：所有隔离与判定都围绕 worker 建立，CTO 自己写主检出是"合法"的。
3. **被监管者能改监管者**（当工作对象就是本插件时）：CTO 可以让工程师改 `index.js` 里的判定逻辑，或改 patch 里的规则常量 —— 监管因此自我失效。

### 12.4 四道补丁（已按批注降级）

| # | 补丁 | 机制 | 拦住什么 | 批注处置 |
|---|---|---|---|---|
| P1 | **闸门证据改由宿主提取** | 门禁不读文件里的文本，而是在 `post-execute` 时从**子代理会话事件**的末行解析 `GATE:`，并用 `agentPresets.presetForSession()` 校验来源 preset ∈ {cto-reviewer, cto-qa}。面板已经这么做（client.js:348），把同一份解析搬到宿主即可 | CTO 伪造 PASS | **保留（最关键）** |
| P2 | **CTO 写盘留痕 + 一次人确认** | `pre-execute` 对 root 的 `write`/`edit`/`applyPatch` 首次返回 `ask`（一次会话一次授权），之后每条记 `actor: cto`；工件落盘走 `office_artifact`，另记一条 | CTO 悄悄改代码 / 改工件 | **保留** |
| P3 | **审计账本 → 降级为普通 jsonl** | `.cto-office/audit.jsonl`：派工、阶段跃迁、授权变更、人工确认、`actor: cto` 的写，全部由**插件**写入、CTO 只读、**进 git 可 review**。**去掉 hash 链** —— 有写权限即可重算整条链，链只防自己 | 事后追溯、可 review | **降级（B2）** |
| P4 | **外部锚点 → 降级为干净检出** | 不在本期接 CI。合并门跑**一次**全量测试：`git worktree add` 到临时目录 + 依赖走缓存，不重新 clone | 本地"绿"不等于干净环境"绿" | **降级（B1+E3）** |

**为什么 P4 不接 CI**：单人仓库里"本地测试撒谎"的受益者与受害者是同一人，没有对手就没有外部锚定的动机 —— 批注说得对。但 CI 的另一半价值是**环境纯净度**（本机 Node 版本、全局依赖、依赖装没装），这半价值用一个临时干净检出就能拿到约 80%，成本却低一个数量级。CI 留到出现第二个人写代码时再装。

**为什么 P3 去掉 hash 链**：hash 链只有在"写账本的人不能改账本"时才有意义。插件跑在用户机器上、仓库写权限也在同一人手里。**"能 review"比"能验 hash"更实用**。

关于第 3 个漏洞（自改监管），改为**告警不阻塞**（批注 B3）：

- 插件启动时校验自身文件 hash 与登记值一致；**不一致 → 大声告警 + 面板常亮 + 不阻塞判定**；
- 原设计的 fail-closed 被否决，理由很实在：一次升级后 hash 对不上，整个判定层拒绝启用，而判定层恰恰是救援工具 —— **会把自己锁死**；
- 规则常量尽量放受 git 管理的配置里，改配置本身也走 P3 审计。

### 12.5 无法被监管的部分（要接受）

- **目标与范围**：做不做、先做哪个、愿意付多少成本 —— 这是你的职责，机器不该替你决定。
- **判断质量**：「这个设计合理吗」只能靠人复核 + 你召唤的独立第二意见。机器只能验证「结论与证据是否一致」，不能验证「结论是否正确」。

所以监管的边界应当是：**过程可审计、结果可复算、目标由人定** —— 而不是"给 CTO 配一个上级"。

### 12.6 相关决策（已定）

| # | 决策 | 结果 |
|---|---|---|
| 11 | CTO 写盘硬门粒度 | **一次会话授权一次 + 之后逐条留痕**（不做“每条都 ask”，太吵） |

---

## 13. 批注处理记录（2026-11-25）

对本轮审查批注 `docs/cto-office-v2.0-汇报-批注.md` 的逐条处置。**A/B/C/D/E 共 18 条：完全采纳 15、部分采纳 2、以更强形态替代 1。**

### 13.1 硬伤（A）

| 编号 | 批注结论 | 处置 | 落点 |
|---|---|---|---|
| A1 工件可见性 | 成立，机制会悬空 | **采纳并强化**：工件只在主检出、单写入点、worker 绝对路径只读、**回执不进文件系统**（宿主抓取入 `cards/<id>/receipts.jsonl`）；补 `artifactsVersion` 冻结所读版本；跨检出读权限计入 W0.1 | §4.3 2a |
| A2 三类检查在哪跑 | 成立 | **采纳**：`office_gate` 检出无关（纯文本比对）；`SELF-CHECK` 在 worker 检出内；**人工走查与终验在合并后主检出**（唯一出口）。"越界判定与检出无关，行为验收只在合并后"写入 M3 结论 | §4.3 2c、§4.5 |
| A3 `base` 未定义 | 成立，真 bug | **采纳**：卡 JSON 记 `baseSha`；一期取开卡时 `HEAD`，二期取 `worktrees.create` 的 `baseCommit`。**字段名不变，只改取值来源** | §4.2a C 层、§4.2b |
| A4 回退阈值不一致 | 成立 | **采纳**：统一为「**达 2 即转人；第 3 次 `deny` 且不再派回**」，四处文案同步；计数由插件写、CTO 只读 | §4.5 4c |
| A5 共享文件双写 | 成立，D5-6 是反证 | **采纳**：`exclusive: [glob]` 互斥组，第二张卡开卡时进 `blocked_by` 排队；冲突从"合并时"提前到"开卡时"。05 章 D5-6 改写为反例 | §4.2a E 层 |
| A6 档位缺证据 | 方向成立，风险面需收窄 | **部分采纳**：事实层面已实测（`agentOptions: true`、路由暴露 `low/high/max`），但 `effort` 是否受会话策略限制、preset 能否设默认档**确实未验** → 进 W0.1，降级路径写进文档，封面不再用"已定"口气 | §4.7、§8 |

### 13.2 过度设计（B）

| 编号 | 处置 | 说明 |
|---|---|---|
| B1 外部锚点 CI | **降级** | 不接 CI；合并门跑一次"临时 worktree + 依赖缓存"的全量测试。CI 留到有第二个人写代码时 |
| B2 hash 链 | **降级** | 普通 `audit.jsonl`（无 hash 链），保留"插件写、CTO 只读、进 git 可 review" |
| B3 自校验 fail-closed | **降级** | 改"告警 + 面板常亮 + 不阻塞判定"。理由：判定层是救援工具，fail-closed 会把自己锁死 |
| B4 五项冗余 / receipts 拆分 / 租约未定义 | **采纳，其中第 3 项改法不同** | 检查点精简为四项；`receipts/` 并入 `cards/<id>/`；**"租约"删除而非补定义** —— 其职责已由「在飞卡登记 + `exclusive`」取代，补定义只会留两套并发机制 |

### 13.3 缺失（C）

| 编号 | 处置 | 落点 |
|---|---|---|
| C1 卡粒度无上限 | **采纳，执行点改到 gate** | 开卡记声明值（预警）+ `office_gate` 硬拦（>10 文件 / >400 行 / >1 条行为变化）。开卡无法预知文件数，"dispatch 拒绝"实现不出来 |
| C2 失效信号单薄 | **采纳** | 补 6 条信号表，且全部**成对读**（见 13.4 E2） |
| C3 token ≠ 额度消耗 | **采纳** | 价格表外置 + 版本化 + 超期告警 + 定位为"事后归因与趋势，不做事前闸门" + 窗口挤占不进点数表 |
| C4 "待确认 1 项"没指明 | **采纳** | 收敛为**唯一未定项**（§8），封面直接写名字 |

### 13.4 路线与新增（D/E）

| 编号 | 处置 |
|---|---|
| D1 一期重排 | **采纳**：一期 = 可判定性（串行写卡 + 授权清单 + 提交边界 + diff 判定 + 互斥组），二期 = worktree 并行 + 状态机 + 走查 |
| E1 一期无并行验证样本 | **采纳**：§6.3 明确"一期不验证并行收益/隔离/合并冲突，二期不得引用一期数据当担保" |
| E2 高通过率需双向读 | **采纳**：§6.2 每条信号都配了"单独读会怎样 + 配对指标" |
| E3 干净检出成本未估 | **采纳**：只在合并门跑一次，用 `git worktree add` + 依赖缓存，不重新 clone |

### 13.5 比批注更强的三处（说明为什么没完全照办）

1. **A1 没选"复制注入"**：批注给了三个方案，我选的是它推荐的 ① 的强化版 —— 顺带解决 B4-2（`receipts/` 不需要独立目录）和 §12 P1（闸门证据与会话事件同源），一处改动闭合三个问题。
2. **D1 补了两条批注没写的**：单检出下 `git status` 分不清"哪行是谁写的"，所以一期必须配 `maxConcurrentWriters=1`（写卡串行）+ 每卡提交边界；否则 M2 的"每卡判定"一期就失效。另外提交边界会引入 `reset`/`amend` 绕过路径，必须显式拦截。
3. **B4-3 租约改删不改补**：批注建议补定义，但补定义会留下两套并发机制；删除后用「在飞卡登记 + 超时显式释放」覆盖其最后一项职责（避免二期并行上线后出现永久阻塞的卡）。

### 13.6 仍未闭合的项（诚实记账）

| 项 | 状态 | 何时闭合 | 影响范围 |
|---|---|---|---|
| `reasoning_effort` 是否受会话策略限制 / preset 能否设默认档 | 只能实测 | W0.1 第 ⑤⑥ 项 | 二期（岗位档位）；一期不受影响 |
| 跨检出读 `.cto-office/` 的沙箱读权限 | 只能实测 | **二期 W0**（见 §4.1 第④项标注） | **仅二期 worktree**；一期不适用 |
| 插件目录解析 `@deepseek-ai/*` 会落到 npx 缓存旧版 | **已实测**（解析到 rc.1，宿主 rc.5） | 已处置：持久化替换自实现（§14.3），其它依赖点进 M-6 依赖清单 | 全局 |

---

## 14. 本轮机制增补（14 建议 + 6 补丁 + 5 收紧 + 2 漏洞 + 6 补充，共 33 项）

### 14.1 证据来源分级（M-1）

`.cto-office/cards/<id>/evidence/<intentId>.json`，每条证据必带 `source`，取值锁四枚举：

| `source` | 含义 | 参与判定 |
|---|---|---|
| `host-event` | 宿主事件（工具调用结果、会话事件、`post-execute` 抓取） | ✅ |
| `git-plumbing` | git 原生命令输出（`diff`/`status`/`log`/`rev-parse`） | ✅ |
| `subagent-session` | 子代理会话消息（`GATE:` 行等） | ✅ |
| `cto-narrative` | CTO 自述、总结、复盘文字 | ❌ **一律不参与机器判定**，只进给人看的摘要 |

两条规则：① 判定器维护 source 白名单，取不到白名单来源 → **fail-closed**（打回并说明缺哪类证据）；② `cto-narrative` 不是“禁止记录”，而是“禁止作为结论依据”——人要读它，机器不能信它。

> 一期 A 只做**记录**；判定白名单在一期 B 生效（见 §7.0 对账表）。

### 14.2 判定事务（M-2）

**幂等键 = `intentId`（每次判定动作新建 UUID），不是内容三元组。** 上一版用 `(cardId, baseSha, artifactsVersion)` 是错的：修复后重跑时三者全不变，会把卡永久钉在 `CHANGES`。

| 场景 | 处理 |
|---|---|
| 崩溃恢复：intent 有、result 无 | **复用同一 `intentId` 重跑**，天然幂等 |
| 修复后重跑（`CHANGES` → 改码 → 再判） | **新 `intentId`**，必须重新判定 |

**latest-wins 规则（补 1）**：启动扫描孤儿 intent 时，只有当 `intentSeq == max(intentSeq for card)` 且无 result 才重跑；否则标 `abandoned`，**不重跑** —— 否则会用旧证据产出陈旧结论覆盖新结论。

**内容三元组只做证据有效性断言**：判定时断言 `baseSha`、`artifactsVersion` 与 intent 登记的一致，不一致 → 该 intent 作废重开。

**作废重开**必须生成新 `cardId`（或新 `attemptSeq`），否则旧 `intentId` 会被错误复用。

### 14.3 证据持久化：一件一文件为主，覆盖替换为兜底（漏 1 修正）

**主路径（证据）**：每条证据一个文件，**只新建、永不覆盖**。

```
.cto-office/cards/<id>/evidence/<intentId>.json     ← 写一次，之后只读
```

写入序列：

```js
1. 写 temp（同目录，随机后缀）
2. fsync(tempFd)                   // 数据落盘
3. close(tempFd)
4. rename(temp, <intentId>.json)   // 原子「出现」，目标名保证此前不存在
```

**为什么它比覆盖替换强一档**：覆盖的危险在于「可能毁掉一份已有的好数据」；写新建的最坏情况是「新文件不存在」—— 而**不存在是安全状态**（无 result → 按 §14.2 重跑该 `intentId`）。因此：

- 目录 fsync **降为可选**：漏了的后果只是「崩溃后可能看不到这条证据」，重跑即可恢复；而覆盖替换若漏了目录 fsync，后果是「看不到目标文件」——性质相同，但**旧数据已被毁掉**。
- 不存在「替换到一半」的窗口。

**兜底路径（单文档）**：`card.json` 这类必须原地更新的汇总游标，才用覆盖替换五步，顺序不可调换：

```js
1. 写 temp → 2. fsync(tempFd) → 3. close → 4. rename(temp, card.json) → 5. fsync(dirFd)
```

第 5 步最容易漏：只用 rename 而不 fsync 目录项，崩溃后可能连目标都看不到。

**读侧（两条路径共用）**：

- 读到 0 字节、JSON 解析失败、或 schema 不完整 → 判 `CORRUPT`，**不许容错为空对象**（空对象会被当成「无证据」，可能做出比「没有 evidence」更坏的结论）。
- `CORRUPT` → 该卡标 `abandoned` 并转人工确认（走 §14.4 复合动作）。
- **Windows**：目录 fsync 不支持（`EPERM`/`EISDIR`），`try/catch` 降级并记录「该平台无目录护栏」，不静默假装成功。

**不依赖 `@deepseek-ai/dsh-atomic-write`**：已实测该包在插件目录下解析到 **npx 缓存的 rc.1 副本**（宿主 rc.5，profile 的 `@deepseek-ai/` 是空目录）。自实现约 30 行 + 一个单测。

### 14.4 状态集补全（M-3 + 补 6）

```
clarify → open-card → QUEUED → dispatch → follow → gate → settled
                        ↑                              ↓
                        └──────── CHANGES ─────────────┘
        (任意态) ────────────────→ abandoned（终止态）
```

- `QUEUED` 携带 `blockedBy: { cardId, reason }`，`reason` 只有两种：`serial-limit`（一期）／`exclusive-held`（二期）。
- **`abandoned` 是复合动作，必须在一个事务内四步完成**（补 6）：

```
abandoned(cardId, reason):
  1. 归档 intent + evidence
  2. 释放该卡持有的全部 exclusive glob          ← 漏这步，重开卡永远卡在 QUEUED
  3. 重新评估 blockedBy 指向它的 QUEUED 卡（可 dispatch 就放行）
  4. 落 abandoned 记录（含原因）
```

- 第 3 步同样关键：C1 被放弃与 C1 完成，对 C2 而言在“阻塞已解除”上等价。
- `settled` / `abandoned` / 超时回收三处**共用同一个 `releaseHold(cardId)`**，不各写一套。
- 复合动作本身也要可重启：写 intent → 执行各步（每步幂等）→ 写 result（沿用 §14.2）。

### 14.5 超时监督器（漏洞二，合并三个超时）

**三个超时合成一个监督器**，不各做一套：

```yaml
supervisor:
  poll_interval: 15m
  queued_alert:      { threshold: 60m,  on_breach: surface_to_human, escalate_after: 2x }
  exclusive_ttl:     { threshold: 45m,  renew_on: activity,  on_expire: auto_release + audit }
  card_idle_reclaim: { threshold: 120m, on_breach: suggest_abort }
```

两条修正（来自 Marvis）：

- **阈值全部做成配置项**，不写死 —— 小卡 30 分钟该报，大卡 2 小时才合理（M-7）。
- **报警对象是持有者，不是等待者**：报“C1 已 idle 90 分钟，C2 在等”，而不是“C2 等了 2 小时”。且报警必须带可执行选项（释放 / 作废 / 继续等），否则就是噪音。

**一期 A 只做最小版**（约 0.3 天）：每 15 分钟检查“`QUEUED` 卡的 `blockedBy.cardId` 已 idle 超阈值”→ 会话内一句话推送。完整版（续租 / escalate / abort）在一期 B。

> 理由：一期 A 就是串行形态，C1 卡住 → C2 永停 → 办公室停摆，这是 **A 自身的结构性缺陷**，不能等到 B 才补。

### 14.6 故障注入（M-8）：9 个用例 + 执行位置分工

| # | 用例 | 执行位置 | 期望 |
|---|---|---|---|
| 1 | 人为改授权外文件 | scratch | gate 打回并列出文件名 |
| 2 | 跳过开卡直接派工 | scratch | 非法跃迁拒绝 |
| 3 | 伪造 `GATE: PASS`（错误 preset） | scratch | P1 来源校验拦截 |
| 4 | 提交后 `reset` 洗越界 | scratch | `pre-execute` 拦截 |
| 5 | 超粒度巨型卡 | scratch | gate 硬拦 |
| 6 | `artifactsVersion` 不一致 | scratch | gate 打回并提示读了哪版 |
| 7 | 崩溃恢复：intent 有、result 无 | scratch | 重跑判定，不产生第二结论 |
| 8 | **进行期改 `artifactsVersion`** | 真实结构 | `office_artifact.write` 直接 deny |
| 9 | **两张卡声明同一 `exclusive` glob** | 真实结构 | 第二张进 `QUEUED` |

**执行位置的分工标准（补 3 修正）**：Marvis 说“8/9 必须真实仓库，因为 glob 依赖真实文件树”——这一点不完全对：glob 匹配是 `(glob, 变更路径)` 的纯函数，scratch 里造同样的树也能测。

真正需要真实结构的是**端到端保真**（真实沙箱策略、真实 git 钩子、真实插件接线）。所以更稳的做法是：

> **1–7 在 scratch；8–9 在“一次性克隆的真实项目”里跑**（`git clone` 到临时目录，跑完即删）。这样同时拿到端到端保真和零污染，比“真实仓库 + `sampleTag`”更干净。

`sampleTag: injected` 仍保留作为兜底（万一有人在真实仓库里注入了），且**挂在 card 上而不是 evidence 上** —— 聚合只能经 card join，防止一张卡内混样。

### 14.7 指标与双门槛（M-12）

五类指标（数据全部来自现有机制，不新增组件）：卡时长分布、阻塞率、越界检出率、回退率、共享文件冲突数。

**双门槛（补 4）**：**≥ 3 个独立工作周期 且 ≥ 15 张卡**；判据看**趋势**（阻塞率连续 2 个周期超阈值才建议动工），不看单点。样本不足时面板只显示“数据不足”，**不显示建议**。

**允许人工提前决策，但必须记为“判断”而非“证据”**：

```json
{ "decision": "early", "sampleState": "insufficient",
  "decidedBy": "human", "reason": "...", "cardCount": 7 }
```

这样“凭判断拍板”和“有数据支持”在审计里可区分，不会被后人误读成有数据。

**闸门通过率与回退率统计只取 `sampleTag: real`**，注入样本另建“验收报告”视图，两者永不合并。

### 14.8 三权分离（M-9，写进 §0 与 §12）

| 权力 | 属于谁 | 为什么 |
|---|---|---|
| 启动权（派不派、派几轮） | CTO | 本来就不该被剥夺 |
| **出结论权** | 评审 / QA（**非写者**） | 做的人不给自己出结论 |
| **放行权** | **宿主来源校验（P1）+ 人** | CTO 既不能伪造、也不能跳过 |

收窄后的核心主张：**「写者不给自己出结论；验收的启动权仍在 CTO，但验收的证据来源与放行权在宿主与人」**。

**刷闸门漏洞（漏洞一）**：CTO 可反复派工直到某次 PASS。处置为“标记 + 上限”，不是“直接拒绝”（直接拒绝会误判测试抖动）：

- PASS 时若“本卡最近一次 `CHANGES` 之后无代码变更”→ 标 `suspicious_pass`，写入 `evidence.json`，进每日看板「异常信号」栏，**不阻塞**，但该 PASS **不计入闸门通过率**；
- **重试上限并入 `rounds` 计数器**（补 2）：`rounds ≥ 2 → ask 转人`，`rounds ≥ 3 → deny`。不再单列“派遣上限 3 次”，避免两套数字打架。

### 14.9 三处宿主门槛（M-14）

| 漏洞 | 现约束力 | 补法 |
|---|---|---|
| P1 来源校验可被空壳 preset 绕过 | CTO 可改 patch 造一个假的 `cto-reviewer` | **改 patch / 改 preset 配置本身**设为需人工确认（`pre-execute` 一条规则） |
| `artifactsVersion` 只冻结不锁 | CTO 可在卡进行期改 acceptance | 卡进行期间 `office_artifact.write` 对该卡 kind **直接 deny**；要改就「作废重开」（走 §14.4 复合动作） |
| `exclusive` 释放靠自觉 | 原设计由 CTO 显式调用 | 持有带 **TTL + 活动续租**，宿主计时自动过期（§14.5），不看意愿 |

### 14.10 人力入口只留一个（M-11，与 M-14 分层）

- **日常节奏**：每天一次看板，固定三块 —— 在飞卡 / 昨日 gate 结果 / 异常信号。**不做第二个入口，不加第二次确认。**
- **唯一例外门**：M-14 里“改判定器本身”需要即时确认 —— 它是例外，不是第二个日常入口。
- 一句话记住：**节奏一天一次，例外一次一问。**

### 14.11 机制折损速度（M-7）与参数化

| 机制 | 折损速度 | 处置 |
|---|---|---|
| 越界判定、提交边界、证据来源分级、隔离 | 几乎不贬值（只依赖 git 语义） | **优先投入，一期重心** |
| `SELF-CHECK` 可靠性、`rounds` 阈值、TTL、轮询间隔 | 中速贬值（随模型能力上升） | **写成可调参数，不写成常量** |
| 岗位档位、成本折算 | 快速贬值（模型目录 / 单价 / 额度随时变） | 只做外置配置，**二期最后做** |

> 因此 §14.5 全部阈值、§14.7 双门槛数字、`rounds` 的 2/3 必须进配置，不进代码常量。

### 14.12 本轮 33 项处置一览

| 组 | 编号 | 处置 |
|---|---|---|
| 原始建议 | M-1 ~ M-14 | 全部采纳（M-5 改名为「解锁隔离」；M-13 阶段归属先改） |
| 补丁 | ①~⑥ | ①键改 `intentId`（§14.2）；②三样收益拆分（§7.3）；③三权分离（§14.8）；④节奏 vs 例外门（§14.10）；⑤脚本化 + 用例（§14.6）；⑥双门槛（§14.7） |
| 收紧 | 3 条 | 幂等键（§14.2）、样本门槛（§14.7）、`sampleTag` 隔离（§14.6–14.7） |
| 漏洞 | 2 条 | 刷闸门 → 标记 + `rounds` 上限（§14.8）；`QUEUED` 死锁 → 监督器（§14.5） |
| 补充 | 6 条 | latest-wins（§14.2）、`rounds` 合并（§14.8）、克隆隔离（§14.6）、人工覆盖记账（§14.7）、持久化 fsync 五步（§14.3）、`abandoned` 终止态与释放锁（§14.4） |

---

*本文件是审查与方案，未改动任何插件文件、未安装/启停任何插件、未改变 profile。一期 A 开工需 W0 六项实测结论先出（第 ④ 项属二期开门条件，不影响 A）。*
