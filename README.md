# CTO 办公室模式

一个 DSH 模式（bundle）：把「一个 CTO 带六个岗位」的分工，做成七个可直接选择的 agent 预设。灵感来自[@suifei/dsh-ai-team（文渊阁）](https://github.com/suifei/dsh-ai-team)的任务团队设计，但去掉了插件形态，直接长在 DSH 原生的 agent preset、子代理、共享任务板之上。

## 它是什么

- **一个根模式**：`CTO 办公室`。你在这里当 CTO——接需求、拆卡、派工、验结果、带证据汇报。
- **六个岗位预设**：架构师、工程师、评审、QA、UI/UX 设计、业务。CTO 用 `subagent` 的 `agent_preset` 参数选人。
- **工具边界是真的**：只读岗的 `tool-fs` 根本没挂 `write`/`edit`，写文件时工具不存在，不是靠提示词求它别写。
- **共享任务板**：bundle 里把 `agent-team` 行的 `defaultEnabled` 设为 `true`，这个 profile 的新会话默认带团队任务板（会话菜单可逐会话关闭）。

## 成员表

| 预设 | 岗位 | 工具 | 拿手活 |
|---|---|---|---|
| `cto-office` | CTO（根） | 全量 + 派工 | 澄清、拆卡、派工、拍板、汇报 |
| `cto-architect` | 架构师 | 只读 fs + bash + 联网 | 方案对比、接口契约、拆卡、风险 |
| `cto-builder` | 工程师 | fs 读写 + bash + jobs | 按契约实现、自测、交证据 |
| `cto-reviewer` | 评审 | 只读 fs + bash 跑测试 | 审 diff、PASS/CHANGES |
| `cto-qa` | QA | 只读 fs + bash 跑验收 | 按验收标准逐条实测 |
| `cto-ux` | UI/UX 设计 | 只读 fs + 看图 + 联网 | 使用路径、摩擦点、交互规格 |
| `cto-product` | 业务 | 只读 fs + bash + 联网 | 需求假设、成功指标、验收标准草案 |

## 和文渊阁的对应

| 文渊阁 | 这里 |
|---|---|
| 墨渊（主理人） | `cto-office`（CTO） |
| 青岚（执行）+ 玄策（编程） | `cto-builder`（工程师）——合并：DSH 里子代理一个会话既领活又干活 |
| 白砚（验收） | `cto-qa` |
| 知微（UX 设计） | `cto-ux` |
| 观澜（业务） | `cto-product` |
| —— | `cto-architect`（新增：并行派工前必须先有契约） |
| —— | `cto-reviewer`（新增：把"写对了"和"做对了"拆成两道闸） |

文渊阁的「做的人不验收」「唯一 owner」「append-only 账本」被保留为章程铁律；「PMO 自动派活」「Web 看板 UI」「成员长期记忆」没有重造——那是插件的活。

## 装与卸

```bash
# 装（在 DSH 会话里用 plugin_manager 工具）
plugin_manager action=install_bundle target=/Users/chy/个人工作台/cto-office

# 卸
plugin_manager action=remove_bundle target=@chy/dsh-cto-office
```

安装后：新建会话 → 模式选「CTO 办公室」。岗位预设不单独开会话用，它们是 CTO 派工的选项。

## 分享到另一台机器

这个 bundle 只有 10 个文件、零 npm 依赖（patch 里引用的 `@deepseek-ai/*` 都由目标机器的 DSH 自己提供），所以换台机器只要让它能读到这个包：

```bash
# 本机：推到自己的仓库
git remote add origin git@github.com:<你的账号>/dsh-cto-office.git
git push -u origin main
```

```text
# 对方机器：在 DSH 会话里装（把 <sha> 换成具体提交，或直接用 main）
plugin_manager action=install_bundle target=github:<你的账号>/dsh-cto-office#<sha>
```

装完按同样三步验收：`list_bundles` 里能看到 `@chy/dsh-cto-office` 且 `overrides` 含 `agent-team`；新建会话的模式列表里有「CTO 办公室」；在 CTO 会话里派一次 `cto-reviewer`，确认它看不到 `write`/`edit`。

对方机器需要满足：

- **DSH ≥ 0.2.2-rc.3**（`package.json` 的 `engines.dsh`）：要用到 agent preset 的 `order` 字段、`tool-subagent` 的 `allowedAgentPresets`、`tool-fs` 的 `write`/`edit` 开关、`agent-team` 的 `defaultEnabled`；更老的版本会在这几行上报 invalid config。
- **Node ≥ 22**（`engines.node`）：patch 里解析技能目录的 `!!js` 用了 `process.getBuiltinModule`。
- 这个包会把该 profile 的 `agent-team` 改成默认开启（见下文「关闭默认任务板」），介意的话装之前先删掉 `cordis.patch.yml` 开头那段覆盖。

没有 git 也行：把整个目录拷过去，`plugin_manager action=install_bundle target=/绝对路径/cto-office`。

## 改

安装用的是 `link:` 协议，profile 的 `node_modules/@chy/dsh-cto-office` 指向本目录，所以**改这里的文件就是改运行时**：

- **改岗位规程**：直接改 `skills/<岗位>/SKILL.md`，下一个会话（或下一次技能读取）就生效。
- **改人格 / 挂哪些工具**：改 `cordis.patch.yml` 里对应预设的 `persona.prefix` 或 `plugins`。**改完必须让 Host 重新组合一次补丁**——实测 `patchReload: live` 不会重读已装 bundle 的 patch，最省事的办法是 `plugin_manager` 对 `@chy/dsh-cto-office` 先 `set_bundle enabled=false` 再 `true`，或者重启 Host；只改 `skills/*/SKILL.md` 不用重载。
- **给某个岗位开口子**：把它的 `tool-fs` 里 `write: false` / `edit: false` 去掉，再按上面重载一次。开完口子就等于放弃了硬隔离，章程里的铁律还会在，但工具不再拦得住。
- **关闭默认任务板**：删掉 `cordis.patch.yml` 开头的 `- id: agent-team` 覆盖行，重装。

## 已知边界

- 成员是子代理会话，不是 24 小时常驻身份；同一会话内可以用 `send_message` 续聊，跨会话没有记忆。
- `bash` 本身能写文件，所以只读岗的边界是「没有 write/edit 工具」+ 章程铁律两层，不是内核级沙盒。
- `write_scopes` 是提示不是锁；冲突靠 `revision` CAS 和 CTO 的分片纪律避免。
- 没有引入 `workflow` 与 `subagent_fork`：前者没有角色槽位，后者会让子代理继承 CTO 的全量工具，都会绕过岗位边界。
