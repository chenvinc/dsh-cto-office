# 章程与 CD 阶段改造 · 设计稿

> 状态：**设计稿，三个决策已拍板（2026-11-27），未实施**。本轮不改动任何运行时文件。
> 已定：CD = 六步之外的独立阶段；不可逆动作用策略 A（人工确认）；一期外部命令用模式 A（CTO 用 `bash` 跑 `gh`）。详见 §8。
> 目标：把流程图里「说出需求 → 双方案 → 拍板 → 设计稿/审交互 → 定接口验收 → 派活单 →
> 实现/回执 → 开 MR → 审查（最多 2 轮）→ 自动检查 → 合并 → 发布 → 核实线上」
> 落进现有 `cto-office`：全程 DSH 内、只用 OpenCode Go 上游、不新增第 8 个 preset。
> 配套文档：`docs/模型映射-OpenCode-Go-本机可用路由.md`（2026-11-27 的路由口径）。

---

## 0. 设计决策速览

| # | 决策 | 理由 |
|---|---|---|
| D1 | **六步保持 6 个，CD 不是第七步**，而是「结算」之后的独立阶段，由 `office_cd` + CD record 管理 | `parseSteps` 硬断言「恰好六步」；`STEP_IDS` 是面板稳定键；`client.js` 的 StepBar 是 `repeat(6,...)`；`office-data@2` 生成物链。加第七步要同时改 sync 脚本、面板 CSS、HTML 生成区间、schema 版本，成本远高于收益 |
| D2 | **不引入 `workflow` 工具 / `subagent_fork`** | 保持 `README` 第 136 行的既有决策：workflow 没有角色槽位、脚本由模型现场写且不可保存；CD 的「自动」用 **Host 定时器 + 状态机** 实现 |
| D3 | **不新增工件类型**，方案合成结论写进现有 `contracts` 工件 | `ARTIFACT_KINDS` 只有 `contracts`/`acceptance`；加第三种会改变 `versions()`/`artifactsVersion` 形状，牵动 `office_gate` 的 intent 事务、回执校验与多个单测 |
| D4 | **CD 状态不进卡状态机**，另建 `.cto-office/cd/<runId>/cd.json` | `STATES`/`TRANSITIONS`/`isTerminal` 被 `office_release`、`ArtifactStore`、`Supervisor` 与「状态机：合法与非法跃迁」测试共享；往里塞 `CD_*` 会连锁改动 |
| D5 | **CD record 复用现有持久化与证据分级**：`replaceJson` 写游标、`writeOnceJson` 写证据、`SOURCES` 三类权威来源 | 不另造一套账本；`cto-narrative` 仍不参与机器判定 |
| D6 | **不新增 preset、不改 7 个 preset 的工具挂载**，CD 配置只加在 `office-tools` 行的 `config` | `EXPECTED` 断言的是 patch 里的工具挂载矩阵，不是自定义工具个数；但改 config 会改 patch sha，必须 `npm run sync` 后 `npm run check` |
| D7 | **不可逆动作（合并/发布）默认仍需一次人工确认**；完全自动是显式开关 | 与铁律 6「不可逆动作要问人」、DSH 默认 approval fail-closed 对齐；避免为了「一路自动」把安全边界整体拆掉 |
| D8 | 面板 StepBar 仍是 6 格；CD 状态用**新增 chip** 呈现，消息里用 `CD:` 行做机器可读协议 | 复用现有「面板只认 `GATE:` 这一行」的模式（章程 §二.5 / `client.js:348`） |

---

## 1. 现状与硬约束（取证）

| 约束 | 出处 |
|---|---|
| `parseSteps` 从 `## 二、开工六步` 起扫到下一个 `## `，只认 `^\d+\.\s+\*\*(.+?)\*\*`，且**必须恰好 6 个**、label 必须在 `STEP_IDS`（澄清/开卡/派工/跟进/闸门/结算） | `scripts/sync-office-data.mjs:317-334`、`:30-37` |
| `assertFixture`：恰好 7 个 preset、order 唯一、工具矩阵逐项等于 `EXPECTED`、`allowedAgentPresets` 恰好 6 个、根 preset 唯一 | `scripts/sync-office-data.mjs:283-315`、`:83-100` |
| `office.json` 记 patch 的 sha256；`npm run sync` 重生成 `docs/office.json`、`docs/architecture.html` 生成区间、`client.js` 的 `OFFICE_FACTS` 注入区 | `scripts/sync-office-data.mjs:435-463` |
| 禁用词扫描只覆盖 HTML（`:682-684`），章程/README 不被扫；但仍避免旧口径字样 | `scripts/sync-office-data.mjs:41` |
| 工具参数用「紧凑声明」经 `wrap()` 转标准 JSON Schema；**输出** schema 的 `required` 必须在对象上，可空值用 `oneOf` | `lib/tools.js:51-88`、`:615-630` |
| 工具与守卫挂在 `cto-office` 预设作用域（`tools-plugin.js`），`index.js` 只是空壳；已有 `pre-execute` / `post-execute` / `session/event` / `timer.interval` 四类挂载点 | `tools-plugin.js:94-151`、`index.js` |
| 卡状态机 `QUEUED→DISPATCHED→CHANGES→SETTLED/ABANDONED`；`office_gate` 已有 `rounds` 计数与「2 轮转人 / 3 轮 deny」文案 | `lib/card.js:12-34`、`lib/tools.js:414-417` |
| 证据四类来源，权威白名单 = `host-event` / `git-plumbing` / `subagent-session`，`cto-narrative` 排除 | `lib/evidence.js:12-24` |
| 回执协议 `RECEIPT:` / `SELF-CHECK:` + `GATE: PASS/CHANGES/FAIL` 末行 | `lib/receipt.js:1-22`、`skills/cto-office/SKILL.md:33` |
| 人工确认先例：审批文件放在**工作区之外**（agent 沙箱写不到），带 TTL | `lib/patch-approval.js` / `tools-plugin.js:43-44` |
| 本机 `gh` 2.102.0 已装；`@deepseek-ai/dsh-experimental-forge-github` 已随 DSH 出厂但**当前 profile 未启用** | 本机实测；`packages.md` |
| 面板只读会话事件流，`inferStep` 目前**永不返回 `open-card`**（已知缺陷 D1） | `client.js:989-1016`、`docs/多Agent协作框架-审查与落地方案.md` N4/D1 |

---

## 2. 流程图 → 六步 / CD 阶段 映射

| 图中节点 | 落到哪 | 机制 |
|---|---|---|
| 我 · 说出需求 | 第 1 步 澄清 | 用户回合 |
| 主控：理解需求、查代码/查数据/查线上 | 第 1–2 步 | CTO 自己用 `read`/`grep`/`bash`/`web_fetch`（必要时 browser-use / MCP），事实写进卡「输入」段 |
| 出一份方案 + 独立出一份方案（并行） | 第 2–3 步 | CTO 自己一份（root 路由 `opencode-go/hy4` @ high）+ 派 `cto-architect` 一张 `ro` 方案卡（`auto/gemini-4-argon` @ high）；**两条 `subagent` 同消息发出** |
| 逐条对比、合成一份（标注采纳谁/为什么） | 第 2 步 | 写进 `contracts` 工件，冻结版本；`office_artifact action=write kind=contracts` |
| 我 · 拍板 | 第 2→3 步之间的人工关口 | `ask_user_question` + `pre-execute` 返回 `ask`；未确认前拒绝实现卡派工 |
| 出设计稿 → 审交互和文案 → 取舍改稿 | 第 3–4 步 | `cto-ux`（Argon，可看图）+ `send_message` 续聊；CTO 取舍 |
| 定接口和验收标准 | 第 2 步 | `office_artifact` 写 `contracts` / `acceptance`，编号验收条目 |
| 派活单 | 第 3 步 | `team_task_create` 或 `office_dispatch`；实现卡只派 `cto-builder` |
| 写成块的后端 / 回执 | 第 3–4 步 | `subagent` + `RECEIPT`/`SELF-CHECK` 回执协议 |
| 读改动、自己跑测试、前端自己写 | 第 4–5 步 | CTO 用 bash/fs；铁律 5 需先说明理由并获同意 |
| 闸门 / 结算 | 第 5–6 步 | `office_gate` → `office_release action=settle` |
| **开合并请求 → 审查（≤2 轮）→ 自动检查 → 合并 → 发布 → 核实线上** | **CD 阶段（结算之后，非第七步）** | `office_cd` 状态机 + Host timer；见 §4 |

---

## 3. 章程改造设计（`skills/cto-office/SKILL.md`）

### 3.1 写法约束（否则 `npm run check` 会红）

1. **`## 二、开工六步` 的 6 行 `N. **label**` 一个字都不改**（label 必须是 `澄清/开卡/派工/跟进/闸门/结算`）。
2. 章节二内**不得出现**任何 `^\d+\.\s+\*\*` 形式的行 —— 补充说明一律用 `-` 项目符号或表格。
   `parseSteps` 会把它算成第七步并 `E_STEPS` 退出。
3. 新增章节放在 `## 七、向上汇报的格式` **之后**（`## 八`、`## 九`），parseSteps 在下一个 `##` 就停，不受影响。
4. 不改 `cordis.patch.yml` 的 `plugins` 列表、不加 preset、不改工具边界 → `EXPECTED` 断言不变。
5. 章程改完必须 `npm run sync`（重生成 office.json / architecture.html 生成区间 / client.js 注入区），再 `npm run check`。
   **不要手改这三个生成物**，会被 sync 覆盖。

### 3.2 第二节 · 各步补充文案（可直接粘贴，均为 `-` 子项）

> 第 1 步「澄清」后追加：
```
   - 接需求后先由 CTO 自己查代码、查数据、查线上（`read` / `grep` / `bash` / `web_fetch`），把事实写进卡的「输入」段；有歧义或不可逆动作（删数据、发布、改线上配置、花钱）一次 `ask_user_question` 问全，别边做边猜。
```
> 第 2 步「开卡」后追加：
```
   - 需要「两份独立方案」时，开一张 `ro` 方案卡派 `cto-architect`；CTO 自己那份不落卡。合成结论写进 `contracts` 工件，逐条写明「采纳了谁 / 没采纳的为什么」，见第八节。
   - 定接口与逐条编号的验收标准：`office_artifact action=write kind=contracts|acceptance`；进行期禁改工件，要改就作废重开。
   - 用户拍板前不许派实现卡（人工关口，见第八节）。
```
> 第 3 步「派工」后追加：
```
   - 方案卡可并行（都是只读、写入范围写「只读」）；实现卡串行（`maxConcurrentWriters=1`）。两条独立方案的派工路由必须不同，由岗位表保证。
```
> 第 5 步「闸门」后追加：
```
   - CD 阶段的「审查最多 2 轮」不是本步闸门：它是第九节 CD record 的 `REVIEW` 阶段，由 `office_cd` 的 `rounds` 计数器把关。
```
> 第 6 步「结算」后追加：
```
   - 全部卡 `SETTLED`、工作区干净、最近一次权威闸门结论为 `PASS` 后，才允许 `office_cd action=begin`。
   - 四行汇报后追加一行「CD 阶段：未开始 / runId / 当前阶段」。
```

### 3.3 新增第八节 · 方案对与拍板（草案）

```
## 八、方案对与拍板

- **两份方案**＝CTO 自己一份（主控路由 `opencode-go/hy4` @ `high`）+ 一张 `ro` 方案卡派
  `cto-architect`（岗位表固定 `auto/gemini-4-argon` @ `high`）。两条 `subagent` 同一条消息发出，
  互不阻塞。不许 CTO 自己再写一份冒充第二方案，也不许把两张方案卡都派同一个 preset。
- **逐条对比、合成一份**：写进 `contracts` 工件（复用现有类型，不新增工件种类），冻结版本；
  每条写「采纳了谁 / 没采纳的为什么」。这份工件同时是后面接口契约与验收标准的对照物。
- **拍板（人工关口）**：用 `ask_user_question` 一次给出合成方案与关键取舍；未确认前
  `pre-execute` 拒绝「实现卡」的 `office_dispatch` / `subagent`（返回 `ask`，不是 `deny`）。
  这一步对应图里的「我 · 拍板」，**不自动化**。
- **出设计稿 → 审交互和文案 → 取舍改稿**：拍板后派 `cto-ux`（Argon，可用 `read_image` 看设计稿），
  审回执用 `send_message` 让同一子代理续聊改稿；CTO 取舍后定稿接口与验收标准。
- **派活单**：`team_task_create`（`blocked_by` / `write_scopes`）或 `office_dispatch`；
  实现卡只派 `cto-builder`（`opencode-go/deepseek-v4.1-flash` @ `high`）。
  回执走现有 `RECEIPT` / `SELF-CHECK`；子代理看不到你的对话，卡的内容必须写进 prompt。
```

### 3.4 新增第九节 · 上线子流程（草案）

```
## 九、上线子流程（CD 阶段）

CD 不是第七步，是「结算」之后的独立阶段，由 `office_cd` 与 `.cto-office/cd/<runId>/cd.json` 管理。
六步条不变，面板仍是 6 格；CD 状态用右栏新增的 chip 呈现。

- 顺序固定：`开合并请求 → 审查（≤2 轮）→ 自动检查 → 合并 → 发布 → 核实线上`。
  每一步对应 `office_cd` 的一个 action，前置条件不满足由 `pre-execute` 拒绝，不许跳步。
- 「自动」＝ Host 定时器按 CD record 推进阶段（复用现有 `timer.interval` 监督器模式），
  不是让模型每次手写 workflow 脚本。**不引入 `workflow` 工具**（它没有角色槽位、脚本不可保存），
  也不引入 `subagent_fork`（会继承 CTO 全量工具，绕过岗位边界）。
- 审查岗位是 `cto-reviewer`（`opencode-go/glm-5.3-flash` @ `low`），与 builder 不同家族；
  `rounds` 达 2 仍未过 → 转人，第 3 次 → 直接 deny 且不再派回（与章程 §二.5 同一口径）。
- 不可逆动作（合并 / 发布）默认仍需一次人工确认（铁律 6）；完全自动是显式开关，见设计稿 §4.6。
- 全程在 DSH 内：外部只有 `gh` CLI / GitHub Actions / 线上健康端点，不接任何外部 agent 软件。
- 每个阶段的结果以 `CD: <state> run=<runId> round=<n>` 行写进 `office_cd` 的响应；
  右栏面板只认这一行（与 `GATE:` 行同一套机器可读协议）。
```

### 3.5 铁律增补（第三节末尾）

```
8. **两份方案必须来自不同路由**。岗位表已把 `cto-architect` 固定到 Argon、主控固定在 Hy4；
   发现两张方案卡同路由，视为无效方案对，重派。
9. **CD 不许跳步**。`office_cd` 的 action 只能按第九节顺序推进；跳过 checks 直接 merge、
   review 第 3 轮再派回，一律 deny。
10. **拍板前不派实现卡，合并/发布前先问人**。除非用户显式开启完全自动（设计稿 §4.6 策略 B）。
```

---

## 4. CD 阶段设计

### 4.1 状态机（独立于卡状态机）

```
PR_OPEN ──review(PASS)──► CHECKS ──checks(success)──► MERGED ──release──► RELEASED ──verify──► VERIFIED
   │                        │  ▲                         │                    │                    │
   │                        │  └──pending(轮询)──────────┘                    │                    │
   └─review(CHANGES,round<2)─┘                                               │                    │
        └─(round≥2)─► BLOCKED ──人确认/修复后──► REVIEW                      │                    │
                                                                           ▼                    ▼
   任意非终态 ──abort──► ABORTED                                        BLOCKED ◄──failure── CHECKS/MERGE/RELEASE/VERIFY
```

| 状态 | 进入条件 | 退出条件（可机检） |
|---|---|---|
| `PR_OPEN` | `begin`：全部卡 SETTLED、工作区干净、最近权威闸门 PASS、已拿到 `prNumber` + `headSha` | 有一次 `review` 回执 |
| `REVIEW` | `review` 收到 CHANGES 且 `rounds<2` | PASS → `CHECKS`；rounds≥2 → `BLOCKED` |
| `CHECKS` | review PASS | `gh pr checks` 全 success → `MERGED`；pending → 保持；failure → `BLOCKED` |
| `MERGED` | 合并成功且 `headSha` 未漂（带 SHA 前置条件） | 触发发布 |
| `RELEASED` | 发布指令已发出（workflow_dispatch / tag） | 健康核实通过 |
| `VERIFIED` | 线上核实证据落盘 | 终态 |
| `BLOCKED` | 任一阶段失败 / 达 2 轮 / 审批缺失 | 人确认后回 `REVIEW` 或 `CHECKS`，或 `ABORTED` |
| `ABORTED` | `abort` | 终态 |

`cd.json` 字段草案：
```json
{
  "schema": "cto-office/cd@1",
  "runId": "CD1", "state": "PR_OPEN", "round": 0,
  "prNumber": 123, "headSha": "<40/64 hex>", "checksState": "pending",
  "planApproval": false, "autoApproveIrreversible": false,
  "evidence": ["<evidenceId>"], "history": [{ "at": 0, "event": "begin", "from": null, "to": "PR_OPEN" }],
  "updatedAt": 0
}
```
落盘：`<workspace>/.cto-office/cd/<runId>/cd.json`（`replaceJson`），
证据 `<workspace>/.cto-office/cd/<runId>/evidence/<id>.json`（`writeOnceJson`，只新建永不覆盖）。
**不进 `CardStore`**，避免 `list()` / `finalize()` / `Supervisor` 把 CD 当卡读。

### 4.2 工具：`office_cd`（单工具多 action，挂进 `buildTools` 的 `raw`）

沿用 `office_artifact` 的 `action` 模式，减少 schema 面。参数用紧凑声明经 `wrap()` 转标准 JSON Schema；
输出 schema 用 `jsonSchemaOf`，可空字段用 `oneOf`（`lib/tools.js:615-630` 的真机教训）。

| action | 关键参数 | 前置校验（不满足 → 抛错 / `pre-execute` deny） | 结果 |
|---|---|---|---|
| `status` | — | 无 | 只读快照，不改状态 |
| `begin` | `prNumber`,`headSha` | 全部卡 `SETTLED`、`isClean()`、`latestJudgement` 为 PASS、无在飞 CD | → `PR_OPEN` |
| `review` | `verdict`,`evidence` | 当前 `PR_OPEN`/`REVIEW`；`headSha` 未漂；`round<3` | PASS→`CHECKS`；CHANGES 且 round<2→`REVIEW`(round+1)；round≥2→`BLOCKED` |
| `checks` | `checksState`,`evidence` | 当前 `CHECKS`；`checksState` ∈ pending/success/failure | success→`MERGED`；pending→不变；failure→`BLOCKED` |
| `merge` | `evidence` | checks=success、review PASS、`headSha` 未漂、**审批满足策略**（§4.6） | → `MERGED` |
| `release` | `evidence` | 当前 `MERGED`、审批满足策略 | → `RELEASED` |
| `verify` | `evidence`,`healthUrl` | 当前 `RELEASED`，健康证据来自 `host-event`/`git-plumbing` | → `VERIFIED` |
| `abort` | `reason` | 非终态 | → `ABORTED` |

响应消息固定带一行 `CD: <state> run=<runId> round=<n>`，供右栏解析（D8）。

**执行模式（分期）**：
- **一期 · 模式 A（推荐）**：`office_cd` **只做状态机 + 落盘 + 前置校验**，不自己执行外部命令。
  `gh pr create` / `gh pr checks` / `gh pr merge` / `workflow_dispatch` / 健康探测由 CTO 用现有 `bash` 工具执行，
  stdout 作为 `evidence` 传回（`source=git-plumbing` 或 `host-event`）。
  好处：不绕过 `pre-execute` 的破坏性 git 拦截（`lib/guards.js:22-29`），不复制 `tool-bash` 的沙箱逻辑。
- **二期 · 模式 B（完全自动）**：`office_cd` 内部按 `dsh-experimental-forge-github` 的先例跑**受限 `gh` 子进程**
  （命令白名单、环境擦除 `DSH_*` 与含 KEY/SECRET/TOKEN 的变量、输出字节上限），
  由 Host timer 直接推进到 `VERIFIED`。代价：插件自己起进程、要单独审计，且必须显式开启。
  → **本次不采用**（已拍板模式 A）；保留为后续可选升级路径，实施前需单独做安全评审。

### 4.3 守卫扩展（`lib/guards.js` 的 `makePreExecuteGuard`）

在现有 4 条规则（判定器改动审批、岗位路由、写者名额、破坏性 git）之后追加，**保持「守卫失败即放行」的 catch 语义**：

| 规则 | 触发 | 决策 |
|---|---|---|
| R5 方案卡形态 | `office_dispatch` 且 `args.role === 'plan'`（新增可选参数） | 必须 `mode==='ro'` 且 `preset==='cto-architect'`，否则 `deny`；这从机制上保证两张方案不同路由 |
| R6 拍板关口 | `office_dispatch`/`subagent` 派实现卡，且无 `planApproval` | 返回 `ask`（不是 `deny`），理由指向工作区外的审批文件；复用 `lib/patch-approval.js` 的 TTL/路径机制 |
| R7 CD 跃迁 | `office_cd` 的 action 与 `cd.json` 当前 state 不匹配 | `deny`，理由写「当前在 X 阶段，Y 需要先完成 Z」 |
| R8 CD 轮次 | `office_cd action=review` 且 `round>=3` | `deny`，「最多 2 轮，第 3 次不再派回，转人」 |
| R9 不可逆动作 | `office_cd action=merge|release` 且策略 A、审批文件缺失 | `deny` + `approvalDenyReason` |

> R5 的 `role` 是 `office_dispatch` 的新可选参数：需要在 `lib/tools.js:101-114` 加一行、在 `test/tool-schema.test.mjs` 里不新增违规断言。
> 若不想改工具 schema，可退化为「用 prompt 里的 `【方案卡】` 标记 + `cardIdFromPrompt` 同款解析」——设计上更轻，但少一层机检。

### 4.4 自动化驱动

- 复用 `tools-plugin.js:138-151` 的 `ctx.timer.interval`：新增一个 CD 轮询，
  间隔 `cd.checksPollIntervalMs`（默认 60s），只做**只读探测 + 推进 pending 阶段**，不判定、不写外部状态。
- 跨轮持续性用 `goal`（同会话持久目标）+ `schedule`（Host 级定时唤醒），长链不会因一次 turn 结束而断。
- **不用 `workflow` 工具**（D2）；也不新增 `workflow` 挂载，保持 patch 里 delegation 组上方的「不挂 workflow」注释取证（sync 脚本 `:396-404` 会扫这段注释）。

### 4.5 外部接通（全程仍在 DSH 内）

| 图中框 | DSH 内做法 | 前置 |
|---|---|---|
| 开合并请求 | `bash` 跑 `gh pr create`（本机 `gh` 2.102.0 已装）→ `office_cd action=begin` 记录 | `gh auth status` 通过 |
| Codex 审查（≤2 轮） | `subagent agent_preset=cto-reviewer`（GLM Flash @ low），回执 `GATE:` 行 → `office_cd action=review` | 岗位表已固定路由 |
| 自动检查 | `gh pr checks <n> --watch` 或 `gh api` 读 check runs；可选启用 `dsh-experimental-forge-github`（已出厂、当前 profile 未启用） | `gh` 已登录；forge 需 enable |
| 合并 | `gh api -X PUT repos/.../pulls/<n>/merge`，带期望 `headSha`（新提交到达会被 GitHub 拒绝，报 `stale`）→ `office_cd action=merge` | checks 全绿 + 审批 |
| 发布 | `gh workflow run <deploy.yml>` / 打 tag，触发外部 CI；**DSH 只发指令，不做部署** | 仓库有发布工作流 |
| 核实线上 | `web_fetch` / browser-use 打健康端点，结果作为证据 → `office_cd action=verify` | 端点可达 |

> 「发布」与「核实线上」本质上是外部 CI/线上系统，DSH 不是 CD 平台；设计只承诺**驱动与取证**，不承诺替代 CI。

### 4.6 权限分段（D7）

| 策略 | 拍板前 | 拍板后 | 不可逆动作 |
|---|---|---|---|
| **A（默认，推荐）** | `ask_user_question` + `pre-execute: ask`（人工关口） | checks/轮询全自动 | `merge`/`release` 前仍需一次人工确认（工作区外审批文件 + TTL，复用 `patch-approval.js`） |
| **B（完全自动，显式开启）** | 同上（拍板永远不自动化） | 全自动 | `cd.autoApproveIrreversible=true` 且审批文件在 TTL 内；仅当 CD record 所有前置闸门通过才触发 |

> **本次采用策略 A**；策略 B 本次不实施，`cd.autoApproveIrreversible` 保持 `false`。
> 配置里保留该字段只为将来显式开启，不写进本期验收。

配置草案（加在 `cordis.patch.yml` 的 `office-tools` 行 `config`，**不新增 preset / 不改 plugins 列表**）：
```yaml
- id: office-tools
  name: '@swiper1881/dsh-cto-office/tools'
  config:
    maxConcurrentWriters: 1
    writerPresets: [cto-builder]
    granularity: { maxFiles: 10, maxLines: 400, maxBehaviors: 1 }
    cd:
      enabled: false                    # 默认关闭，显式开启
      maxReviewRounds: 2
      checksPollIntervalMs: 60000
      autoApproveIrreversible: false    # 策略 A 默认
      ghCommand: gh
      releaseWorkflow: deploy.yml
      healthUrl: ''                     # 为空时 verify 只能靠人工证据
```
> 改 config → patch sha 变 → **必须 `npm run sync` 再 `npm run check`**。
> `tools-plugin.js` 的 `DEFAULTS` 与 `resolveConfig` 同步加 `cd` 段；`resolveSupervisor` 的归一化方式可作为阈值参数化的样板（阈值是参数不是常量）。

### 4.7 证据与回执

- 每个 CD action 落一条证据：`{ at, source, kind, runId, state, payload }`，
  `source` 只取 `SOURCES.HOST_EVENT` / `SOURCES.GIT` / `SOURCES.SUBAGENT`；
  `cto-narrative` 可记但**不参与判定**（`lib/evidence.js` 既有规则）。
- reviewer 回执沿用 `GATE: PASS/CHANGES` 末行；`office_cd` 的响应带 `CD:` 行。
- `CD:` 与 `GATE:` 都是「面板只认这一行」的机器可读协议，`client.js` 的 `eventGate` 解析器可并列扩展。

### 4.8 面板（可选，不阻塞一期）

- `OFFICE_FACTS.steps` 仍 6 条，StepBar CSS `repeat(6,...)` 不动（D1）。
- 右栏新增一个 **CD chip**：读会话事件里 `office_cd` 的 `CD:` 行，显示 `state / round / prNumber / headSha 短值`。
- 顺手修 D1：`inferStep` 增加 `open-card` 分支（检测到 `office_dispatch`/`team_task_create` 返回 `open-card`）——
  这属于 `client.js` 改动，与章程/状态机解耦，可单独一轮。

---

## 5. 改动面清单（含「是否触发 check」）

| 文件 | 改动 | 触发 `npm run check` |
|---|---|---|
| `skills/cto-office/SKILL.md` | §二各步补 `-` 子项、新增 §八/§九、铁律 8–10 | **是**（六步解析 + 生成物） |
| `lib/cd.js` | 新增：CD 状态机、`CD_STATES`/`canCdTransition`、cd.json 读写（复用 `atomic.js`） | 否（但要单测） |
| `lib/tools.js` | `office_cd` 工具（单工具多 action）；`office_dispatch` 可选加 `role` 参数 | 否（`test/tool-schema.test.mjs` 会验 schema） |
| `tools-plugin.js` | `DEFAULTS.cd` / `resolveConfig` 加 cd 段；注册 CD timer | 否 |
| `lib/guards.js` | R5–R9 五条规则 | 否（但要单测） |
| `cordis.patch.yml` | `office-tools` 行 `config` 加 `cd` 段 | **是**（patch sha → 需 sync） |
| `scripts/sync-office-data.mjs` | **不改** | — |
| `docs/office.json` / `docs/architecture.html` / `client.js` 注入区 | 由 `npm run sync` 重生成，**不手改** | — |
| `client.js`（CD chip / D1 修复） | 可选，单独一轮 | 否（但 `npm run check` 会校验注入区） |
| `test/cd.test.mjs`、`test/role-models.test.mjs` 等 | 新增 CD 状态机/守卫/工具 schema 单测 | 否（`npm test` 要全绿） |
| `README.md` | 「已知边界」补 CD 阶段说明 | 否 |
| `docs/W10-实现记录.md` / `docs/交接-下一会话.md` | **不改**（历史记录） | — |

**明确不动**：7 个 preset 的工具边界、只读/可写划分、`allowedAgentPresets` 六项、`STEP_IDS`、六步 label、`office-data@2` schema。

---

## 6. 分期与验收（每条都要机检）

### 一期 · 章程 + CD 状态机骨架（不涉及外部命令）
1. 按 §3.2–3.5 改 SKILL.md，`npm run sync` → `npm run check` 双绿，且 `parseSteps` 仍解析到 6 步。
2. 新增 `lib/cd.js` + `test/cd.test.mjs`：合法/非法跃迁、rounds 封顶、终态、证据只读。
3. 验收：`npm test` 98+ 全绿；`npm run check` 绿；`office.json` 的 `steps` 仍 6 条、`provenance.sha256` 与新 patch 一致。

### 二期 · 工具 + 守卫
4. `office_cd`（模式 A，只做状态机/落盘）+ `office_dispatch` 的 `role` 参数；R5–R9 守卫。
5. 验收（单测）：跳过 checks 直接 merge → deny；review 第 3 轮 → deny；方案卡用 rw 或错 preset → deny；
   未拍板派实现卡 → `ask`；`CD:` 行格式可被解析；工具输出 schema 通过 `test/tool-schema.test.mjs`。
6. 验收（真机，新会话）：跑一次完整六步 + `office_cd begin→review(PASS)→checks(success)→status`，
   确认 `.cto-office/cd/CD1/cd.json` 与 evidence 落盘、右栏能读到 `CD:` 行。

### 三期 · 外部接通与自动化
7. 配 `cd` 段并 `npm run sync`/`check`；接通 `gh`、checks 轮询、merge、release、verify。
8. 验收：`gh` 未登录 / checks failure / headSha 漂移 / 审批缺失 → 各自 `BLOCKED` 或 deny 且理由可读；
   策略 A 下 merge 前没有审批文件 → deny。（策略 B 本次不实施，不列入验收。）
9. 验收（面板）：CD chip 显示 state/round；StepBar 仍 6 格；D1 修复后 `open-card` 会亮。

---

## 7. 风险与明确不做的事

| 风险 | 应对 |
|---|---|
| 章程里误写 `N. **…**` → `E_STEPS` 卡死 | §3.1 写成规则；改完先跑 `npm run check`，不要先改生成物 |
| 同时手改 `architecture.html` / `client.js` 注入区，被 sync 覆盖 | 顺序固定：改 patch + SKILL → `npm run sync` → 再改非生成区 → `npm run check` |
| CD 插件自己起 `gh` 进程，绕过 `pre-execute` 的破坏性 git 拦截与沙箱 | 一期用模式 A（CTO 用 `bash` 跑）；模式 B 必须显式开启 + 命令白名单 + 环境擦除 + 输出上限 |
| 完全自动与铁律 6「不可逆动作要问人」冲突 | 策略 A 默认；策略 B 需用户显式开启且审批文件在工作区外带 TTL |
| DSH 不是 CI/CD，发布/核实线上依赖外部系统 | 设计只承诺驱动与取证；`healthUrl` 为空时 verify 只认人工证据并标注 |
| 并发写冲突 | 仍 `maxConcurrentWriters=1`；worktree 是另一轮（审查方案 §4.2b），本期不碰 |
| `office_cd` 输出 schema 写成 `properties.x.required: true` 导致 preset 激活失败 | 遵守 `lib/tools.js:51-64` 的方言：输出 `required` 在对象上，可空用 `oneOf` |
| 面板读不到文件系统与任务板（N4） | CD 状态只经会话事件里的 `CD:` 行传递，不让面板读 `.cto-office/` |

**不做**：新增第 7 步 / 第 8 个 preset / `workflow` 挂载 / `subagent_fork` / 新工件类型 / 改卡状态机 /
改 `office-data@2` schema / 手改生成物 / 回改历史验收文档。

---

## 8. 已拍板的三个决策（2026-11-27）

| # | 决策 | 未采用的选项 |
|---|---|---|
| 1 | **CD = 六步之外的独立阶段**（D1）：`office_cd` + CD record 管理，六步与 StepBar 保持 6 格 | ~~显式第 7 步~~：需同步改 `STEP_IDS`、`parseSteps`、`office-data` schema、StepBar CSS、HTML 生成区间，工作量约翻倍，本次不做 |
| 2 | **策略 A**：拍板前人工、之后自动，但 `merge` / `release` 前仍需一次人工确认（铁律 6、DSH 默认 fail-closed） | ~~策略 B 完全自动~~：本次不实施，`cd.autoApproveIrreversible` 保持 `false` |
| 3 | **模式 A**：外部命令（`gh` / checks / merge / 发布 / 健康探测）由 CTO 用现有 `bash` 执行，stdout 作为 `evidence` 传回；`office_cd` 只做状态机、落盘、前置校验 | ~~模式 B 插件内起受限 `gh` 子进程~~：本次不实施；保留为后续升级路径，实施前单独做安全评审 |

由此确定本期的边界：

- 不引入 `workflow` / `subagent_fork`、不新增 preset、不新增工件类型、不改卡状态机、不改 `office-data@2` schema。
- 不实现「一路全自动到上线」：自动的是**检查轮询与阶段推进**，不可逆动作仍有人确认。
- 三期验收只覆盖策略 A；模式 B / 策略 B 的验收项不写进本期。

**下一步**：按 §6 一期开工（章程 SKILL.md + `lib/cd.js` + `test/cd.test.mjs`，`npm run sync` → `npm run check` → `npm test` 三绿）。
二期再做 `office_cd` 工具与 R5–R9 守卫，三期接 `gh`。

---

## 9. 实施备注（与设计稿的三处偏差）

一期、二期已按本设计落地。以下三处是实施时发现的**有意修正**，记录在此避免文档与代码漂移：

1. **`checks(success)` 不直接进 `MERGED`**。§4.2 表里 `checks(success) → MERGED` 与 `merge → MERGED`
   重复，会让「合并前人工确认（R9）」无处落脚。实现改为：`checks(success)` 只把 `checksState`
   记为 success、`mergeReady=true`，仍停在 `CHECKS`；`CHECKS → MERGED` 只由 `merge` action 承担。
   `lib/cd.js:checksStateToState` 与 `test/cd.test.mjs` 已同步。
2. **不设 `cd.enabled` 开关**。设计稿 §4.6 的配置草案里 `enabled: false` 是「默认关闭」，
   但二期已把工具交付，且每个 action 都有前置条件 + 守卫闸门，再叠一个开关只会变成死配置。
   实现为：`office_cd` 常驻注册；`planApproval.enabled` 单独作为拍板关口的开关（默认 false，
   由 profile patch 显式设为 true —— 否则会截走既有守卫单测）。
3. **CD 定时器推迟到三期**。模式 A 下插件不自己执行 `gh`，没有可轮询的 checks 状态，
   定时器只会空转。因此 §4.4 的 `timer.interval` CD 巡检与 `checksPollIntervalMs` 配置一并留到
   三期（接通 `gh` 之后）。`cd` 配置只保留实际生效的 `maxReviewRounds` / `releaseWorkflow` / `healthUrl`。

另外，`office_cd` 的 `merge` 前置在工具内做了一次 defense-in-depth 校验（`checksState=success`
与 `headSha` 未漂），审批只在 R9 守卫读一次，不重复读审批文件。

4. **三期的「接通 gh」不等于插件起进程**。模式 A 已拍板，所以三期把「接通」实现为
   `lib/cd-gh.js`：① 每个阶段该跑的 `gh` 命令固化为可复跑契约（`office_cd action=status|commands`
   返回）；② CTO 传回的 stdout 被解析成结构化事实（`parsePrView` / `parseChecks`），
   与 `headSha` / `checksState` 声明不一致时按铁律 3 直接打回；`gh` 报错由
   `classifyGhFailure` 归类成可读理由。二期的 `evidence` 是任意字符串，三期起变成可判定事实。
5. **CD 定时器只做只读告警**。`lib/cd-watch.js` + `tools-plugin.js` 的第二个 `timer.interval`
   扫描 `cd.json`，对停在 `CHECKS/pending`、`BLOCKED` 或任意非终态超过 `staleAfterMs` 的 run
   发一条日志（同一状态去重）。它**不推进状态、不跑 gh** —— 否则会用自己写的 cd.json 覆盖
   CTO 刚写的状态。这与备注 3 一致，也是 §4.4「不判定、不写外部状态」的字面落地。
6. **面板**：`client.js` 新增 CD chip（解析 `CD:` 行，与 `lib/cd.js:parseCdLine` 同一正则，
   单测里做字面一致性护栏），并修了 D1（`inferStep` 现在会返回 `open-card`）。StepBar 仍 6 格。

**如实说明的边界**：按模式 A + 策略 A，这不是「开 MR 后无人值守一路到上线」——
`gh` 命令由 CTO 用 `bash` 执行，`merge`/`release` 前仍需人跑一次 `approve-phase.mjs`；
定时器只负责卡住时发日志告警。要做到原图那种全自动，需要改决策 2/3（策略 B + 模式 B），
那是一次独立的安全评审，不在本次范围。

7. **拍板关口从 `ask` 改为「工具内人工确认 + `deny` 机检」**（2026-11-28，`0.4.0-alpha.4`）。
   §4.3 原设计让 R6 返回 `ask`，理由写进 `reason`；但 DSH 在 ask 策略下只把 outcome 交给模型
   （`the user rejected tool "<name>"`），插件原因被吞，且「聊天里已拍板」与「工作区外审批文件」
   两套语义没有桥接，真实项目里表现为 P0 阻塞。现在：
   - 人工确认搬进新工具 `office_plan_approve`（内部 `userQuestions.ask` + `intent:'plan-review'`）；
   - 批准后由 Host 写凭据，绑定 `cardIds` 与契约/验收版本，TTL 内有效；
   - R6 只做机检，失败返回 **`deny`**，把「缺凭据 / 已过期 / 卡不在覆盖范围」原样告诉模型。
   这条改动的完整来龙去脉与验收对照见 `docs/cto-office-plan-approval-issue-2026-11-28.md` 与 §13。
   实现层面 `ask` 决策在 cto-office 里**已不再使用**（保留 `ask` 语义给真正的单次权限场景）。
