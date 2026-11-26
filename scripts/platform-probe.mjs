#!/usr/bin/env node
/**
 * platform-probe —— 把 docs/dependency-manifest.md 里「靠非公开 API 与行号事实」的假设
 * 写成可执行断言（M-6）。
 *
 * 升级 DSH 之后跑一次，就知道哪几条依赖破了，而不是等面板空白或闸门失灵才发现。
 *
 * 两种运行方式：
 *   node scripts/platform-probe.mjs                       # 普通 Node：只跑本机可检的项
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     scripts/platform-probe.mjs                          # 进 asar：额外检查宿主源码面
 *
 * 约定（照清单 §三）：
 *  - **只读**，不改任何状态；
 *  - 输出人可读表格 + 退出码（有 FAIL 则非 0）；
 *  - 读不到的项标 N-A 并说明原因，**不许猜成 PASS**。
 *
 * 状态含义：
 *   PASS  假设成立
 *   FAIL  假设已破，需要按「兜底方案」降级
 *   N-A   当前环境检不了（例如普通 Node 读不到 asar）
 *   INFO  成立，但值得知道（例如上游能力有变化的机会）
 */
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const outPath = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : null })()

const results = []
const add = (id, name, status, detail) => results.push({ id, name, status, detail })

// ── 环境 ────────────────────────────────────────────────────────────

const RESOURCES = typeof process.resourcesPath === 'string' ? process.resourcesPath : null
const ASAR_DSH = RESOURCES ? join(RESOURCES, 'app.asar', 'dsh') : null
const canReadHost = Boolean(ASAR_DSH && existsSync(join(ASAR_DSH, 'package.json')))
const hostPkgDir = name => join(ASAR_DSH, 'node_modules', '@deepseek-ai', name)
const readHostFile = rel => readFileSync(join(ASAR_DSH, rel), 'utf8')

const HOST_HINT = '需要 Electron 运行时：ELECTRON_RUN_AS_NODE=1 用 App 的二进制再跑一次'

/** 宿主源码面断言：普通 Node 下只能 N-A。 */
function hostSource(id, name, relPaths, pattern, hint = HOST_HINT) {
  if (!canReadHost) return add(id, name, 'N-A', hint)
  const files = Array.isArray(relPaths) ? relPaths : [relPaths]
  const existing = files.filter(rel => existsSync(join(ASAR_DSH, rel)))
  if (existing.length === 0) return add(id, name, 'FAIL', `宿主包文件都不存在：${files.join(', ')}`)
  // 多文件回退：宿主可能只发编译产物、也可能只发 src。任一处命中即算成立，
  // 但**命中不了就判 FAIL** —— 这条是「假设已破」，不能因为「文件在」就放行。
  for (const rel of existing) {
    const text = readFileSync(join(ASAR_DSH, rel), 'utf8')
    const hit = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
    if (hit) return add(id, name, 'PASS', `源码面命中（${rel}）`)
  }
  return add(id, name, 'FAIL', `源码面未命中（已查 ${existing.join(', ')}）`)
}

function hostPackage(id, name, packageName, note) {
  if (!canReadHost) return add(id, name, 'N-A', HOST_HINT)
  const ok = existsSync(hostPkgDir(packageName))
  add(id, name, ok ? 'PASS' : 'FAIL', ok ? `@deepseek-ai/${packageName} 存在${note ? `（${note}）` : ''}` : `缺 @deepseek-ai/${packageName}`)
}

// ── patch 静态断言（D4 / D14）────────────────────────────────────────

const patchText = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
const RO_PRESETS = ['cto-architect', 'cto-reviewer', 'cto-qa', 'cto-ux', 'cto-product']
const WRITABLE_PRESETS = ['cto-office', 'cto-builder']

/** 取某个 preset 区块的文本（到下一个同级 - id: 为止）。 */
function presetBlock(presetId) {
  const lines = patchText.split('\n')
  const start = lines.findIndex(line => new RegExp(`^ {4}- id: preset-${presetId}$`).test(line))
  if (start < 0) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {4}- id: /.test(lines[i])) { end = i; break }
    if (/^ {2}[a-zA-Z]/.test(lines[i])) { end = i; break }
  }
  return lines.slice(start, end).join('\n')
}

function checkPatchToolBoundary() {
  const problems = []
  for (const id of RO_PRESETS) {
    const block = presetBlock(id)
    if (!block) { problems.push(`${id} 区块找不到`); continue }
    // 注意缩进：tool-fs 的 config 在 patch 里是 14 空格（别写死成 12，否则永远判 FAIL）
    if (!/^ +write: false$/m.test(block)) problems.push(`${id} 缺 write: false`)
    if (!/^ +edit: false$/m.test(block)) problems.push(`${id} 缺 edit: false`)
  }
  add('D4-1', '只读岗 write/edit 在 patch 里被关掉', problems.length ? 'FAIL' : 'PASS',
    problems.length ? problems.join('；') : `${RO_PRESETS.length} 个只读岗都有 write:false + edit:false`)

  const writableProblems = []
  for (const id of WRITABLE_PRESETS) {
    const block = presetBlock(id)
    if (!block) { writableProblems.push(`${id} 区块找不到`); continue }
    if (/^ +(write|edit): false$/m.test(block)) writableProblems.push(`${id} 被误关成只读`)
  }
  add('D4-2', '可写岗（cto-office / cto-builder）未被误关', writableProblems.length ? 'FAIL' : 'PASS',
    writableProblems.length ? writableProblems.join('；') : '两个可写岗都保留 write/edit')

  const applyPatchFalse = (patchText.match(/^ +applyPatch: false$/gm) ?? []).length
  add('D4-3', 'applyPatch 对所有岗位关闭', applyPatchFalse >= 7 ? 'PASS' : 'FAIL',
    `applyPatch: false 共 ${applyPatchFalse} 处（期望 ≥ 7；新增岗位请同步更新本断言）`)

  add('D14-1', 'subagent 暴露 modelSelection（岗位档位前提）',
    /^ {18}modelSelection: true$/m.test(patchText) ? 'PASS' : 'FAIL',
    /^ {18}modelSelection: true$/m.test(patchText) ? 'delegation 里 modelSelection: true' : 'delegation 里没有 modelSelection: true')
}

// ── 装载形态 ────────────────────────────────────────────────────────

function checkInstall() {
  const profileDir = join(homedir(), '.dsh', 'profiles', 'desktop')
  const linked = join(profileDir, 'node_modules', PKG.name)
  if (!existsSync(linked)) return add('ENV-1', '插件在 desktop profile 里可解析', 'N-A', `未找到 ${linked}（可能换 profile 了）`)
  let isLink = false
  try { isLink = lstatSync(linked).isSymbolicLink() } catch {}
  add('ENV-1', '装载形态是 link:（改代码不必重装）', isLink ? 'PASS' : 'INFO',
    isLink ? '符号链接：改代码后只需重启应用，不必重装' : '不是符号链接：副本安装，改代码后需要重装')

  const profilePkgPath = join(profileDir, 'package.json')
  if (!existsSync(profilePkgPath)) return add('ENV-2', 'profile 声明了本 bundle', 'N-A', 'profile package.json 不存在')
  const profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  const bundles = profilePkg?.dsh?.profile?.bundles ?? []
  add('ENV-2', 'profile 的 bundles 列表含本 bundle', bundles.includes(PKG.name) ? 'PASS' : 'FAIL',
    bundles.includes(PKG.name) ? `${PKG.name} 已在 bundles` : 'bundles 里没有本包 → 重启后不会加载')

  const engines = PKG.engines?.dsh ?? '(未声明)'
  add('ENV-3', 'engines.dsh 已声明', PKG.engines?.dsh ? 'PASS' : 'INFO', `engines.dsh = ${engines}`)
}

// ── 本插件自身契约（回归护栏）─────────────────────────────────────────

async function checkSelf() {
  const { matchBackend, matchBackendAnchor } = await import('../lib/glob.js')
  const backend = matchBackend()
  // 普通 Node 里必然兜底：picomatch 在 asar 内，只有宿主 Electron 的 fs 能解析。
  // 所以这里不能判 FAIL，否则每次「本地跑探针」都会误报 —— 这本身就是 W0 追加五记下的教训。
  if (!canReadHost) {
    add('D19', 'glob 主路径用宿主自带 picomatch', 'N-A',
      `普通 Node 下 backend=${backend} 属预期（picomatch 在 asar 内）；宿主内验证见 W0 第 1 步`)
  } else {
    add('D19', 'glob 主路径用宿主自带 picomatch', backend === 'picomatch' ? 'PASS' : 'FAIL',
      backend === 'picomatch' ? `backend=picomatch，锚点 ${matchBackendAnchor()}` : `backend=${backend}（内置兜底，非设计主路径）`)
  }

  const { DEFAULT_METRICS, resolveMetricsConfig } = await import('../lib/metrics.js')
  add('SELF-1', 'M-12 双门槛默认值仍在（样本门槛不可被写死为 0）',
    DEFAULT_METRICS.minCards === 15 && DEFAULT_METRICS.minCycles === 3 ? 'PASS' : 'FAIL',
    `minCards=${DEFAULT_METRICS.minCards}, minCycles=${DEFAULT_METRICS.minCycles}, consecutiveBreaches=${DEFAULT_METRICS.consecutiveBreaches}`)

  const { INTENT_SCHEMA } = await import('../lib/intent.js')
  add('SELF-2', 'M-2 事务 schema 存在（判定可恢复的前提）', INTENT_SCHEMA ? 'PASS' : 'FAIL', INTENT_SCHEMA)

  // SELF-4：用**宿主自己的校验器**验我们的工具 schema。
  // 写错一处不是「面板少个按钮」，而是「整个 preset 起不来」——真机已经踩过一次
  // （type: ['number','null'] → JsonSchemaError → CTO 在模式选择里消失）。
  if (!canReadHost) {
    add('SELF-4', '工具 schema 通过宿主真校验器', 'N-A', HOST_HINT)
  } else {
    const hostSchema = await import(join(ASAR_DSH, 'node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'))
    const { buildTools } = await import('../lib/tools.js')
    const tools = buildTools({}, { registry: { get: () => ({}) }, config: {} })
    const rejected = []
    for (const [name, tool] of Object.entries(tools)) {
      for (const [kind, schema] of [['parameters', tool.parameters], ['output', tool.output?.schema]]) {
        if (!schema) continue
        try { hostSchema.assertSupportedJsonSchema(schema) } catch (error) {
          rejected.push(`${name}.${kind}: ${String(error.message).slice(0, 100)}`)
        }
      }
    }
    add('SELF-4', '工具 schema 通过宿主真校验器', rejected.length ? 'FAIL' : 'PASS',
      rejected.length ? rejected.join('；') : `${Object.keys(tools).length} 个工具 × 2 类 schema 全部通过`)
  }

  // SELF-5：预检 apply() —— 按宿主加载本插件的方式跑一遍：
  //   - 未 inject 的服务属性裸读会抛（用 Proxy 模拟 cordis）
  //   - tools.register 按宿主的 schema 校验规则检查
  // 这一条能直接拦住「改完、重启、才发现 preset 起不来」的事故（真机已发生过一次）。
  try {
    const plugin = await import('../tools-plugin.js')
    const hostSchema = canReadHost
      ? await import(join(ASAR_DSH, 'node_modules/@deepseek-ai/dsh-tools/lib/types/json-schema.js'))
      : null
    const registered = []
    const fake = new Proxy({
      tools: {
        register(tool) {
          if (!tool?.name) throw new Error('tool without name')
          if (!tool.parameters) throw new Error(`${tool.name}: missing parameters`)
          if (hostSchema) {
            hostSchema.assertSupportedJsonSchema(tool.parameters)
            if (tool.output?.schema) hostSchema.assertObjectJsonSchema(tool.output.schema)
          }
          registered.push(tool.name)
          return () => {}
        },
      },
      on() { return () => {} },
      effect(fn) { const dispose = fn(); return () => { try { dispose?.() } catch {} } },
      log: { warn() {}, info() {}, error() {} },
    }, {
      get(target, key) {
        if (key in target) return target[key]
        // cordis 语义：未 inject 的服务属性裸读直接抛 —— 预检必须模拟这一点
        throw new Error(`cannot get property "${String(key)}" without inject`)
      },
    })
    plugin.apply(fake, { maxConcurrentWriters: 1, writerPresets: ['cto-builder'], defaultAgentPreset: 'cto-builder' })
    add('SELF-5', '预检 apply()：插件能注册全部工具', 'PASS',
      `${registered.length} 个工具${hostSchema ? '（schema 已过宿主校验）' : ''}：${registered.join(', ')}`)
  } catch (error) {
    add('SELF-5', '预检 apply()：插件能注册全部工具', 'FAIL', `apply 抛错：${error.message}`)
  }

  const { defaultApprovalPath } = await import('../lib/patch-approval.js')
  const approval = defaultApprovalPath()
  add('SELF-3', 'M-14 审批文件在工作区之外', approval.startsWith(ROOT) ? 'FAIL' : 'PASS', approval)
}

// ── 清单完整性 ──────────────────────────────────────────────────────

function checkManifest() {
  const path = join(ROOT, 'docs', 'dependency-manifest.md')
  if (!existsSync(path)) return add('DOC-1', '依赖清单存在', 'FAIL', 'docs/dependency-manifest.md 不存在')
  const text = readFileSync(path, 'utf8')
  const ids = new Set([...text.matchAll(/^\| (D\d+) \|/gm)].map(m => m[1]))
  const missing = []
  for (let i = 1; i <= 20; i++) if (!ids.has(`D${i}`)) missing.push(`D${i}`)
  add('DOC-1', '依赖清单 D1–D20 无缺项', missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? `共 ${ids.size} 条依赖点` : `缺：${missing.join(', ')}`)
}

// ── 跑 ──────────────────────────────────────────────────────────────

checkPatchToolBoundary()
checkInstall()
await checkSelf()
checkManifest()

// ---- 宿主源码面（需要 asar）----
hostSource('D5', 'agentPresets.presetForSession 存在', 'node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js', 'presetForSession')
hostSource('D6', 'pre-execute 决策含 deny（可拦截）',
  ['node_modules/@deepseek-ai/dsh-tools/src/contracts.ts', 'node_modules/@deepseek-ai/dsh-tools/lib/types/pipeline.js'],
  /export type PreToolDecision[\s\S]{0,600}kind: 'deny'/)
hostSource('D7', 'tools.guard 单调否决（ToolGuard）', 'node_modules/@deepseek-ai/dsh-tools/lib/index.js', /ToolGuard|checkGuards/)
hostSource('D8', 'post-execute 决策含 block（可打回）',
  ['node_modules/@deepseek-ai/dsh-tools/src/contracts.ts', 'node_modules/@deepseek-ai/dsh-tools/lib/types/pipeline.js'],
  /export type PostToolDecision[\s\S]{0,900}kind: 'block'/)
hostSource('D15', 'pre-execute 不能改写工具参数',
  ['node_modules/@deepseek-ai/dsh-tools/src/contracts.ts', 'node_modules/@deepseek-ai/dsh-tools/lib/types/pipeline.js'],
  /Input rewriting is excluded/)
hostSource('D16', '沙箱 workspaceRoot 是宿主级（回落 cwd）', 'node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js', /workspaceRoot[\s\S]{0,200}process\.cwd\(\)/)
hostSource('D12', 'dsh-atomic-write 仍不提供 fsync', 'node_modules/@deepseek-ai/dsh-atomic-write/lib/index.js', /out of scope|settings-atomic-durability/,
  '需要 Electron 运行时；这条若变成 FAIL 说明上游补了 fsync，可删自实现约 40 行')

hostPackage('D10', 'storageDomain 服务包存在', 'dsh-storage-domain')
hostPackage('D11', 'session-checkpoint-policy 包存在', 'dsh-session-checkpoint-policy')
hostPackage('D13', 'tokenMeter 服务包存在', 'dsh-token-meter')
hostPackage('D20', 'timer 服务包存在', 'cordis-plugin-timer')

if (canReadHost) {
  const worktree = existsSync(hostPkgDir('dsh-experimental-worktree'))
  add('D9', 'worktree 可选包是否已安装', worktree ? 'INFO' : 'PASS',
    worktree ? '已安装：二期可以提前试' : '未安装（二期才需要，一期不受影响）')
} else {
  add('D9', 'worktree 可选包是否已安装', 'N-A', HOST_HINT)
}

// 客户端面（D1–D3）只能静态看源码，属于弱断言：如实标注。
const clientText = readFileSync(join(ROOT, 'client.js'), 'utf8')
add('D1', '面板 retain 数据源 `cto-office/liveboard` 仍在 client.js', clientText.includes('cto-office/liveboard') ? 'PASS' : 'FAIL',
  '静态源码断言（弱）：确认注册面没被误删，不等于运行时 retain 生效')
add('D2', '客户端注入面（slots / sessions 等）仍在', /slots/.test(clientText) && /sessions/.test(clientText) ? 'PASS' : 'FAIL',
  '静态源码断言（弱）')
add('D3', 'client.js 有 SessionReferenceSourceMap 未登记说明', /SessionReferenceSourceMap/.test(clientText) ? 'INFO' : 'INFO',
  '宿主当前不校验；一旦开始校验会抛错，届时需在宿主补登记')

// ── 报告 ────────────────────────────────────────────────────────────

const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc }, {})
const width = Math.max(...results.map(r => r.id.length))
const lines = [
  `platform-probe · DSH 依赖面检查（${PKG.name}@${PKG.version}）`,
  `运行时：${canReadHost ? 'Electron（可读 asar）' : '普通 Node（宿主源码面 N-A）'}`,
  '',
  ...results.map(r => `${r.status.padEnd(5)} ${r.id.padEnd(width)}  ${r.name}  —  ${r.detail}`),
  '',
  `合计：PASS ${counts.PASS ?? 0} · FAIL ${counts.FAIL ?? 0} · N-A ${counts['N-A'] ?? 0} · INFO ${counts.INFO ?? 0}`,
]

if (!asJson) console.log(lines.join('\n'))

const report = { schema: 'cto-office/platform-probe@1', generatedAt: new Date().toISOString(), runtime: canReadHost ? 'electron' : 'node', results, counts }
if (outPath) {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  if (!asJson) console.log(`\n报告已落盘：${outPath}`)
}
if (asJson) console.log(JSON.stringify(report, null, 2))

process.exitCode = (counts.FAIL ?? 0) === 0 ? 0 : 1
