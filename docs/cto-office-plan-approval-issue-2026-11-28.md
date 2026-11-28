# Issue: `ask_user_question` 拍板没有 mint `plan` 审批文件，导致 `cto-builder` 实现卡被宿主渲染成 "the user rejected tool \"subagent\""

- **日期**：2026-11-28
- **报告人**：CTO 办公室会话（DSH Web GUI / desktop profile）
- **插件**：`@swiper1881/dsh-cto-office`
- **生效版本**：`0.4.0-alpha.3`
- **生效 profile**：`desktop`
- **问题级别**：P0 / 流程阻塞
- **影响**：用户已在聊天里明确拍板 / 给了完全权限，仍无法派发 `cto-builder` 实现卡；`cto-qa` / `cto-reviewer` 等只读卡不受影响。
- **不是**：DSH 子代理并行槽位耗尽，也不是结束后的子代理生命周期泄漏。

---

## 0. TL;DR

当前 `desktop` profile 的 `@swiper1881/dsh-cto-office@0.4.0-alpha.3` 启用了 R6 拍板关口：

- `office-tools.planApproval.enabled=true`
- `writerPresets=[cto-builder]`
- 对 `subagent` 且 `agent_preset=cto-builder` 的实现卡，守卫要求存在工作区外的 `plan` 审批文件。

但 CTO 章程/SKILL 里的「拍板」动作只用 `ask_user_question` 收集用户选择；它 **不会** 调用 `scripts/approve-phase.mjs`，也 **不会** 生成 `C:\Users\Administrator\.dsh\cto-office-plan-approval.json`。

结果是：

1. 用户聊天里选了「批准派实现卡（推荐）」或「完全权限，该动工动工」；
2. `guards.js` R6 仍然读到 `no-approval`，返回 `{ kind: 'ask', reason: '拍板前不许派实现卡…' }`；
3. DSH 宿主 `ask` 审批策略下，主模型只看到最终 approval outcome；
4. 实际暴露给 CTO 的错误只有：

```text
Error: the user rejected tool "subagent"
```

而不是插件内部的 `拍板前不许派实现卡…请执行 approve-phase.mjs` 原因。

这造成两个问题：

- **功能阻塞**：已拍板后仍派不了 `cto-builder`。
- **可诊断性极差**：用户看起来像「拒绝了自己刚批准的动作」，模型看不到 raw reason，无法自助恢复。

---

## 1. 复现环境

```text
DSH_PROFILE=desktop
DSH_PROFILE_DIR=C:\Users\Administrator\.dsh\profiles\desktop
DSH_HOME=C:\Users\Administrator\.dsh
DSH_SESSION_ID=session-f86e592e-cd99-4066-8a29-b836d189ffc8
DSH_WEB_URL=http://127.0.0.1:12937
```

本机三套 cto-office：

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office  @swiper1881/dsh-cto-office  0.4.0-alpha.3
C:\Users\Administrator\.dsh\profiles\web\node_modules\@swiper1881\dsh-cto-office      @swiper1881/dsh-cto-office  0.2.4
C:\Users\Administrator\.dsh\dsh-cto-office                                            @chy/dsh-cto-office         0.2.2
```

注意：虽然 GUI URL 是 web，但 `DSH_PROFILE=desktop`，本次实际生效的是 desktop alpha 插件。

---

## 2. 复现步骤

### 2.1 真实业务场景复现

1. 打开 desktop profile 的 CTO 办公室会话。
2. 按章程走：澄清 → 开卡 → 冻结 contracts/acceptance → `ask_user_question` 拍板。
3. 用户在聊天里选择「批准派实现卡（推荐）」或说：

```text
那我给你完全权限，你先把本工作区捋顺，该提交提交，该动工动工
```

4. CTO 用正确岗位路由派实现卡：

```text
agent_preset=cto-builder
provider=magpie
model=opencode-go/deepseek-v4.1-flash
reasoning_effort=high
```

5. 如果 `C:\Users\Administrator\.dsh\cto-office-plan-approval.json` 不存在或已过期，`subagent` 调用失败。

### 2.2 期望行为

用户已通过 `ask_user_question` 明确拍板后：

- CTO 应能派 `cto-builder` 实现卡；
- 或宿主应给出明确可诊断原因，例如：

```text
拍板前不许派实现卡：缺少 plan 审批文件。
请执行 node scripts/approve-phase.mjs --kind plan --reason "..."
```

### 2.3 实际行为

实际只得到：

```text
Error: the user rejected tool "subagent"
```

没有 deny reason、policy id、堆栈，也没有提示 `approve-phase.mjs`。

同样会话中，派 `cto-qa` / `cto-reviewer` 探针可以成功：

```text
agent_preset=cto-qa
agent_preset=cto-reviewer
```

这证明不是全局 subagent 不可用，也不是槽位耗尽。

---

## 3. 关键证据

### 3.1 `planApproval` 在 desktop alpha 被启用

文件：

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\cordis.patch.yml
```

行号：`:141-166`

关键配置：

```yaml
office-tools:
  config:
    maxConcurrentWriters: 1
    writerPresets: [cto-builder]
    planApproval:
      enabled: true
      ttlMs: 1800000
```

`tools-plugin.js:29-64` 的默认值 `planApproval.enabled=false` 会被 `resolveConfig` 用 raw config 覆盖；`tools-plugin.js:147` 挂上 pre-execute 守卫：

```js
ctx.on('tools/pre-execute', makePreExecuteGuard({ registry, config: resolved }))
```

### 3.2 R6 只拦 `subagent` + `writerPresets`

文件：

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\lib\guards.js
```

行号：`:137-164`

逻辑摘要：

```js
if (planApproval.enabled === true) {
  const isImplDispatch = exec => {
    if (exec?.name === 'subagent') {
      const preset = targetPreset(...)
      return writerPresets.has(preset)
    }
    ...
  }

  if (isImplDispatch(exec)) {
    const approval = readApproval({ path: planPath, now: Date.now() })
    if (!approval.approved) {
      return {
        kind: 'ask',
        reason: '拍板前不许派实现卡（章程 §八 / 铁律 10）... 请用户确认合成方案与关键取舍；确认后由人在工作区之外生成审批文件（TTL 30 分钟）：node scripts/approve-phase.mjs --kind plan --reason "已拍板"...'
      }
    }
  }
}
```

由于当前 `writerPresets=['cto-builder']`：

- `cto-builder` 触发 R6；
- `cto-qa` / `cto-reviewer` 不触发 R6。

这解释了「QA/reviewer 能新建，builder 一直被拒」的现象。

### 3.3 审批文件路径与缺失状态

文件：

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\lib\patch-approval.js
```

行号：`:49-54`

```js
envKey = name === 'patch'
  ? 'DSH_CTO_OFFICE_PATCH_APPROVAL'
  : `DSH_CTO_OFFICE_${String(name).toUpperCase()}_APPROVAL`

return env[envKey] || join(homedir(), '.dsh', `cto-office-${name}-approval.json`)
```

`name === 'plan'` 时默认路径：

```text
C:\Users\Administrator\.dsh\cto-office-plan-approval.json
```

`patch-approval.js:82-95`：

```js
缺文件 → { approved:false, reason:'no-approval' }
schema 错 → schema 校验失败
now >= expiresAt → approval-expired
```

实测当前文件状态：

```text
EXISTS=False
NO_PLAN_APPROVAL_FILE
TTL_MS=1800000
```

### 3.4 审批文件的正确生成方式

文件：

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\scripts\approve-phase.mjs
```

行号：`:1-50`

脚本注释明确「这是给人用的脚本，不是给 agent 的」；用法：

```bash
node scripts/approve-phase.mjs --kind plan --reason "已拍板，采用方案 A"
node scripts/approve-phase.mjs --kind cd --reason "..."
```

核心逻辑：

```js
const path = approvalPathFor(kind)
mintApproval(...)
```

但 CTO skill / `ask_user_question` 流程没有调用它，也不会写这个工作区外文件。

### 3.5 插件自带测试已覆盖该设计行为

文件：

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\test\cd-phase2.test.mjs
```

行号：`:199-215`

测试名：

```text
R6：未拍板派实现卡 → ask；mint 审批后放行
```

关键断言：

```js
const impl = {
  name: 'subagent',
  arguments: {
    agent_preset: 'cto-builder',
    prompt: '【任务卡 C1】实现'
  }
}

const asked = ...
assert.equal(asked.kind, 'ask')
assert.match(asked.reason, /拍板前不许派实现卡/)

mintApproval({ path, reason: '已拍板' })

const allowed = ...
assert.equal(allowed.kind, 'allow')
```

这说明插件 R6 本身按设计工作；问题是 **CTO 拍板流程与 R6 审批通道没有联通**。

### 3.6 Skill / 章程要求聊天拍板，但没有要求 mint 审批文件

文件：

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\skills\cto-office\SKILL.md
```

关键行：

- `:37`：「用户拍板前不许派实现卡（人工关口，见第八节）」
- `:136-150` 第八节：方案对、逐条对比、合成 contracts
- `:143-145`：「拍板（人工关口）：用 `ask_user_question` 一次给出合成方案与关键取舍；未确认前 `pre-execute` 拒绝「实现卡」的 `office_dispatch` / `subagent`（返回 `ask`，不是 `deny`）」
- `:148-150`：「拍板后 `team_task_create` / `office_dispatch`；实现卡只派 `cto-builder`」

也就是说章程把 `ask_user_question` 当作拍板完成信号，但 R6 实现却要求物理审批文件。两者语义不一致。

### 3.7 DSH 宿主把 `ask` 失败压成一句拒绝

文件：

```text
D:\applications\dsh\resources\app.asar
```

文档行：`:821062` / `:821210`

关键说明：

```text
Under the `ask` approval policy, the model sees only the approval outcome, such as `the user rejected tool "<name>"`, or the approved call's ordinary result.
```

`app.asar:1992444-1992473` 的 `serviceAsk`：

```js
case "rejected":
  return {
    decision: approvalDenial(`the user rejected tool "${exec.name}"`, APPROVAL_REJECTED),
    approvalCancelled: false
  }
```

`app.asar:1993347`：

```js
APPROVAL_REJECTED = "APPROVAL_REJECTED"
```

因此插件 R6 的 `reason` 虽然是：

```text
拍板前不许派实现卡…请执行 approve-phase.mjs…
```

主模型看不到，最终只看到：

```text
Error: the user rejected tool "subagent"
```

---

## 4. 排除项：不是 DSH 子代理槽位泄漏

### 4.1 槽位耗尽错误文本不同

DSH 子代理实现：

```text
node_modules/@deepseek-ai/dsh-subagent/src/index.ts:197
```

```js
maxActiveSubagents: z.number()...default(8).volatile()
```

```text
node_modules/@deepseek-ai/dsh-subagent/src/activation.ts:23-34
```

槽位耗尽会抛：

```text
subagent limit reached (active child limit: 8); wait for an existing child to finish or complete this work with the current agents
```

本次错误是：

```text
the user rejected tool "subagent"
```

文本不一致。

### 4.2 子代理结束会释放槽位

```text
node_modules/@deepseek-ai/dsh-subagent/src/manager.ts:1102-1103
```

```js
this.resident.delete(childId)
activation.releaseSlot()
```

```text
dsh-tool-subagent-control/src/list-agents.ts:22-24
```

```js
statusOf = agents.get(id)?.status === 'running' ? 'running' : 'inactive'
```

`inactive` 只表示没有 turn 执行，不表示占 active slot。

### 4.3 实测反证

同一会话里 `cto-qa` / `cto-reviewer` 生命周期探针仍能新建成功；如果 active child limit 已满，任何新 subagent 都应被 `ACTIVATION_LIMIT_REACHED` 拒绝，而不是只对 `cto-builder` 失败。

---

## 5. 根因判断

### Root cause

`cto-office@0.4.0-alpha.3` 同时存在两套「拍板」语义：

| 层级 | 认为「拍板完成」的条件 |
|---|---|
| Skill / 章程 / CTO 流程 | 用户通过 `ask_user_question` 选择确认方案 |
| `guards.js` R6 实现 | 工作区外存在有效 `plan` 审批文件 `cto-office-plan-approval.json` |

但没有任何代码/工具/流程把前者转换成后者。

### 直接触发条件

同时满足：

1. `DSH_PROFILE=desktop`
2. `@swiper1881/dsh-cto-office@0.4.0-alpha.3`
3. `cordis.patch.yml` 中 `office-tools.planApproval.enabled=true`
4. 实现卡通过 `subagent` 派发且 `agent_preset=cto-builder`
5. 用户只在聊天里拍板，没有在终端执行 `approve-phase.mjs`
6. `C:\Users\Administrator\.dsh\cto-office-plan-approval.json` 缺失或过期

### 为什么看起来「用户拒绝了自己批准的动作」

因为 `guards.js` 返回的是 `kind:'ask'`；DSH ask 审批策略只把最终 outcome 给模型，不把 raw reason 给模型。若用户/审批 UI 没有允许这次调用，宿主就渲染为 `the user rejected tool "subagent"`。

---

## 6. 影响范围

### 受影响

- `subagent` + `agent_preset=cto-builder` 的实现卡
- `office_dispatch role=impl` 如果走 R6 同类 `isImplDispatch` 判断，也受影响
- 任何依赖「聊天拍板后自动派实现卡」的 CTO 流程
- desktop profile 的 0.4.0-alpha.3 会话

### 不受影响

- `cto-qa` / `cto-reviewer` / `cto-architect` / 其他非 `writerPresets` 的只读卡
- 未启用 `planApproval` 的 web 0.2.4 profile
- 已经手动 mint `plan` 审批文件且未过期的会话

### 业务影响

在真实任务「补齐粉笔真题库」中，用户已选择：

```text
全量 765+922
新建隔离库
授权补抓和 del
保留遗留文档不提交
```

并说：

```text
那我给你完全权限，你先把本工作区捋顺，该提交提交，该动工动工
```

但 SC-4a 实现卡两次派 `cto-builder` 都被拒，任务链被卡住。

---

## 7. 临时绕行

在当前版本里，用户必须自己在终端执行：

```powershell
cd C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office
node scripts/approve-phase.mjs --kind plan --reason "用户已拍板全量题库方案：765+922、新建隔离库、授权补抓和 del、保留遗留文档不提交；派 SC-4a 实现卡"
```

成功后生成：

```text
C:\Users\Administrator\.dsh\cto-office-plan-approval.json
```

有效期 30 分钟。之后再派 `cto-builder`，R6 应放行。

这个绕行有明显产品缺陷：

- 用户已经在 GUI 里拍板，还要切到 PowerShell 再拍一次；
- 审批文件 TTL 30 分钟，长任务链中可能过期；
- reason 由人手敲，缺少 contracts/acceptance 版本、taskId、用户选择摘要的结构化绑定；
- agent 沙箱被设计为写不到工作区外文件，所以 CTO 不能自助修复，只能卡住问人。

---

## 8. 建议修复方案

### P0-A：把聊天拍板接到受控审批 mint

推荐给 cto-office 增加一个 host 侧受控工具或 action，例如：

```text
office_plan_approve
```

输入建议：

```json
{
  "taskId": "task-3",
  "contractsVersion": "v1",
  "acceptanceVersion": "v1",
  "decision": "approve",
  "reason": "用户通过 ask_user_question 选择：全量 765+922 / 新建隔离库 / 授权补抓和 del / 保留遗留文档不提交",
  "ttlMs": 1800000
}
```

行为：

1. 校验当前确有已冻结 contracts/acceptance；
2. 校验当前确有用户拍板事件或由 CTO 传入结构化选择摘要；
3. 由 host 侧写 `cto-office-plan-approval.json`，而不是让 agent 直接写工作区外文件；
4. 审批记录里保存 `taskId`、契约版本、用户选择摘要、grantedAt/expiresAt；
5. R6 读审批文件时校验 `taskId` / contracts version，避免一次拍板无限复用。

### P0-B：Skill 明确「拍板后必须先 mint approval」

如果不新增工具，至少在 `skills/cto-office/SKILL.md` 第八节改成：

1. `ask_user_question` 得到用户选择；
2. CTO 输出一条人类终端命令 `approve-phase.mjs`；
3. CTO 用只读方式确认 approval 文件存在且未过期；
4. 才允许 `team_task_create` / `office_dispatch` / `subagent` 派实现卡。

这能修复流程脱节，但体验仍然割裂。

### P1：错误信息可见性

现在 R6 返回 `kind:'ask'`，模型看不到 reason。建议至少做其一：

- 对「缺审批文件」返回 `deny` 并把可读 reason 作为普通错误结果暴露给模型；
- 在 workspace 内写 `.cto-office/last-gate-reason.txt`，CTO skill 遇到 `the user rejected tool "subagent"` 时自动读它；
- 把 reason 作为普通工具输出/结果事件输出，而不是依赖 approval raw reason。

目标：失败时主模型必须能看到：

```text
缺少 plan 审批文件；请执行 approve-phase.mjs 或调用 office_plan_approve。
```

### P2：会话启动时输出配置快照

建议在 CTO 会话开始/加载 skill 时显示：

```text
CTO_OFFICE_PROFILE=desktop
CTO_OFFICE_VERSION=0.4.0-alpha.3
PLAN_APPROVAL=enabled
PLAN_APPROVAL_FILE=C:\Users\Administrator\.dsh\cto-office-plan-approval.json
PLAN_APPROVAL_FILE_EXISTS=false
```

避免 GUI 是 web URL 但 profile 是 desktop 的认知偏差，也方便一眼判断 R6 是否会拦。

### P3：`isImplDispatch` 不应只看 `preset`

当前 R6 用 `writerPresets.has(preset)` 判实现卡。建议改为从 card/task 元数据判断：

```text
role=impl / mode=rw / card.type=implementation
```

`preset` 只用于岗位路由校验。否则未来改 builder preset 或用其他 writer 角色时容易绕开 R6。

### P4：补测试

建议增加以下测试：

1. `ask_user_question` 拍板事件 → 自动 mint approval → `cto-builder` `subagent` 放行；
2. 审批文件过期 → 明确返回「approval-expired」且模型可见；
3. 审批文件绑定 `taskId=A` → 派 `taskId=B` 实现卡应拒绝；
4. `subagent` with `cto-qa` 在 `planApproval.enabled=true` 且无 approval 时仍放行；
5. `subagent` with `cto-builder` 在无 approval 时失败原因对主模型可见；
6. desktop alpha 与 web 稳定版配置差异在 README 中有显式说明。

---

## 9. 验收标准

修复后应满足：

1. 用户在 GUI 用 `ask_user_question` 明确批准方案后，CTO 能直接派 `cto-builder` 实现卡，无需切到终端手动执行 `approve-phase.mjs`。
2. 如果仍缺少审批文件，主模型能看到明确原因，而不是只看到 `Error: the user rejected tool "subagent"`。
3. 审批文件与具体任务/契约版本绑定，不能一次拍板无限复用。
4. `cto-qa` / `cto-reviewer` 等只读卡不因 `planApproval` 缺失被误拦。
5. DSH 子代理槽位耗尽仍保持原错误文本：`subagent limit reached (active child limit: 8)`，不得与审批拒绝混淆。
6. 新增/修改测试能证明「未拍板拦住、已拍板放行、过期拦住、错 taskId 拦住」。

---

## 10. 附：本次排查已核实文件清单

```text
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\package.json
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\tools-plugin.js
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\lib\guards.js
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\lib\role-models.js
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\lib\patch-approval.js
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\scripts\approve-phase.mjs
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\scripts\approve-patch-edit.mjs
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\cordis.patch.yml
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\skills\cto-office\SKILL.md
C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office\test\cd-phase2.test.mjs
C:\Users\Administrator\.dsh\profiles\web\node_modules\@swiper1881\dsh-cto-office\package.json
D:\applications\dsh\resources\app.asar
```

---

## 11. 附：最小复现命令

插件自带测试：

```powershell
cd C:\Users\Administrator\.dsh\profiles\desktop\node_modules\@swiper1881\dsh-cto-office
node --test test\cd-phase2.test.mjs
```

预期应包含 R6 测试：

```text
R6：未拍板派实现卡 → ask；mint 审批后放行
```

真实会话复现：

1. 删除或等待过期：

```text
C:\Users\Administrator\.dsh\cto-office-plan-approval.json
```

2. 在 CTO 会话里走完 `ask_user_question` 拍板，但不执行 `approve-phase.mjs`。
3. 派：

```text
subagent(agent_preset="cto-builder", provider="magpie", model="opencode-go/deepseek-v4.1-flash", reasoning_effort="high")
```

4. 观察错误：

```text
Error: the user rejected tool "subagent"
```

5. 同一会话改派：

```text
subagent(agent_preset="cto-qa", provider="magpie", model="opencode-go/minimax-m3.1-flash", reasoning_effort="low")
```

应能成功创建，证明不是槽位耗尽。

---

## 12. 结论

请把这个问题按 **P0 产品流程缺陷** 处理，不是 DSH subagent 生命周期 bug。

最核心的一句话：

> `ask_user_question` 是 CTO skill 认定的「用户拍板」，但 `guards.js` R6 认定的「已拍板」是工作区外 `plan` 审批文件；两者之间没有桥接，且 DSH ask 审批策略把插件 reason 隐藏了，最终表现为「用户拒绝了自己刚批准的实现卡」。

---

## 13. 修复记录（2026-11-28，`0.4.0-alpha.4`）

### 13.1 根因确认

issue 的判断成立：**两套拍板语义没有桥接**，且 `ask` 把插件原因吞掉了。
补一条 issue 未点明的事实：`ask` 分支即使不吞原因也不该用 —— 它在语义上是
「就这一次工具调用向用户要权限」，而拍板是「就一批实现卡要授权」，两者粒度不同，
必然出现「刚拍板完又被问一次」。

### 13.2 与建议方案的差异（重要）

issue 的 P0-A 建议「给 agent 一个 `office_plan_approve`，由它 mint 凭据」。
**照字面实现会变成后门**：agent 可以自己调它、自己写凭据，R6 就彻底失效。
所以实现改为：

> 工具内部先调 `ctx.userQuestions.ask()`（`intent.kind='plan-review'`）弹一次**真实人工确认**，
> 只有用户点了「批准派实现卡（推荐）」这一项，**Host 侧**才写凭据。
> 拿不到 `userQuestions` 服务时直接报错并给终端兜底命令，**绝不**退化成无确认 mint。

这样既满足「用户不用切终端」，又没有放弃能力层剥夺：agent 仍然写不到那个文件，
它只能「发起一次征询」，不能「自己批准」。

### 13.3 逐条对照

| issue 建议 | 本次做法 | 落点 |
|---|---|---|
| P0-A 新增受控工具 mint 审批 | 新增 `office_plan_approve`：内部弹 plan-review 人工确认，批准后由 Host 写凭据 | `lib/tools.js`、`lib/plan-approval.js` |
| P0-A 第 1 点 校验已冻结 contracts/acceptance | 每张卡必须 `acceptance >= 1`，否则拒绝；版本写进凭据 `scope` | `lib/tools.js`、`lib/plan-approval.js` |
| P0-A 第 5 点 绑定 taskId、防无限复用 | 凭据绑定 `scope.cardIds` + `contractsVersion`/`acceptanceVersion`；R6 校验卡号是否在覆盖范围 | `lib/guards.js`、`lib/plan-approval.js` |
| P0-B 章程明确拍板后要 mint | 章程 §八 改为「拍板走 `office_plan_approve`」，脚本降级为兜底 | `skills/cto-office/SKILL.md` |
| P1 错误可见性 | R6 从 `ask` 改为 **`deny`**，可读原因直接作为工具错误返回给模型 | `lib/guards.js:planDenyReason` |
| P1 备选：写 last-gate-reason 文件 | 未采用：`deny` 已解决可见性，再落文件是重复机制 | — |
| P2 会话启动输出配置快照 | `office_status` 增加一行「拍板关口：enabled/disabled｜凭据状态｜覆盖卡｜文件路径」 | `lib/tools.js` |
| P3 `isImplDispatch` 只看 preset | 改为优先用卡元数据（`card.role` / `authorization.mode`），拿不到卡才退回 preset | `lib/guards.js` |
| P4 补测试 | 新增 `test/plan-approval.test.mjs` 9 个测试；`cd-phase2.test.mjs` 的 R6 断言从 `ask` 改为 `deny` | `test/` |
| 兜底脚本 | `approve-phase.mjs` 支持 `--card A,B` 绑定卡号；不给则退化为通配并警告 | `scripts/approve-phase.mjs` |

### 13.4 验收标准对照

| 验收项 | 状态 |
|---|---|
| 1. GUI 拍板后 CTO 能直接派实现卡，无需终端 | ✅ `office_plan_approve` 弹确认 → 批准 → 凭据立即生效 |
| 2. 缺凭据时模型能看到明确原因 | ✅ R6 返回 `deny`，含缺失原因、工具名、脚本兜底命令、文件路径、卡号 |
| 3. 审批与具体卡/版本绑定，不可无限复用 | ✅ `scope.cardIds` 精确匹配 + TTL；换卡需重新拍板 |
| 4. 只读卡不误拦 | ✅ `cto-qa` / `cto-reviewer` 不查凭据（测试覆盖） |
| 5. 槽位耗尽错误文本不变 | ✅ 未触碰 subagent 运行时 |
| 6. 测试证明四态 | ✅ 未拍板拦住 / 已拍板放行 / 过期拦住 / 错卡号拦住 / 未批准不落凭据 / 无 answerer 不落凭据 |

### 13.5 升级步骤（Windows 那台）

1. 发布 `0.4.0-alpha.4`（或 `link:` 到工作区目录）；
2. `plugin_manager action=install_bundle target=@swiper1881/dsh-cto-office@0.4.0-alpha.4`；
3. **重启 DSH 应用**（Host 侧代码变了：guards/tools/tools-plugin）；
4. 新开会话，跑一次 `office_status` 确认出现「拍板关口：enabled｜凭据不存在」这行；
5. 走一次拍板：`office_plan_approve` → 弹窗点「批准派实现卡（推荐）」→ 再派 `cto-builder`。

> 旧的 `ask` 行为已不存在；如果仍看到 `the user rejected tool`，说明桌面端还在跑 alpha.3，
> 用 `office_status` 的版本行或 `package.json` 核对。
