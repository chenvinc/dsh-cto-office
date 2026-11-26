#!/usr/bin/env node
/**
 * M-8 故障注入（方案 §14.6）：9 个用例 + 报告视图。
 *
 * 分工（补 3 修正）：
 *  - 用例 1–7 在 **scratch 工作区**跑（每个用例一个一次性 git 仓库，跑完即删）。
 *  - 用例 8–9 在**一次性克隆的真实项目**里跑（`git clone` 本仓库到临时目录），
 *    为了拿到端到端保真（真实仓库结构、真实沙箱），同时零污染。
 *
 * 样本隔离：所有卡都带 `sampleTag: 'injected'`，且这个标签挂在**卡**上而不是证据上
 * （§14.6）—— 聚合只能经 card join，一张卡内部不可能混样。M-12 的闸门通过率/回退率
 * 统计只取 real，注入样本另建验收视图，两者永不合并。
 *
 * 用法：
 *   node scripts/fault-injection.mjs            # 跑 9 例，打印报告
 *   node scripts/fault-injection.mjs --out x.json
 *   node scripts/fault-injection.mjs --no-write # 不落盘
 *
 * 退出码：全部通过为 0，任一失败为 1。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CardStore } from '../lib/store.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { buildTools } from '../lib/tools.js'
import { StoreRegistry } from '../lib/registry.js'
import { STATES, canTransition, makeCard } from '../lib/card.js'
import { isDestructiveGit, makePreExecuteGuard } from '../lib/guards.js'
import { replaceJson } from '../lib/atomic.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = name => argv.includes(name)
const argOf = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

const RESULTS = []
function record(id, name, expected, ok, detail, sampleTag = 'injected') {
  RESULTS.push({ id, name, expected, verdict: ok ? 'PASS' : 'FAIL', detail, sampleTag })
  const mark = ok ? 'PASS ' : 'FAIL '
  console.log(`${mark} ${id}. ${name} — ${detail}`)
}

// ── 工具 ────────────────────────────────────────────────────────────

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 一次性 scratch 仓库。 */
function makeRepo(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'cto-fi-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'fi@t')
  git(dir, 'config', 'user.name', 'fi')
  writeFileSync(join(dir, '.gitignore'), '.cto-office/\n')
  for (const [name, content] of entries) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

function commitAll(dir, message = 'work') {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', message)
}

/** 一次性克隆的真实项目（用例 8–9 用）。 */
function cloneOnce() {
  const base = mkdtempSync(join(tmpdir(), 'cto-fi-clone-'))
  const dir = join(base, 'clone')
  execFileSync('git', ['clone', '--quiet', '--depth', '1', ROOT, dir], { stdio: 'pipe' })
  git(dir, 'config', 'user.email', 'fi@t')
  git(dir, 'config', 'user.name', 'fi')
  return dir
}

function rigFor(dir, overrides = {}) {
  const config = {
    cardsDir: '.cto-office/cards',
    maxConcurrentWriters: 1,
    writerPresets: ['cto-builder'],
    defaultAgentPreset: 'cto-builder',
    granularity: {},
    supervisor: { enabled: false },
    ...overrides,
  }
  const store = new CardStore(dir)
  return {
    store,
    artifacts: new ArtifactStore(store),
    tools: buildTools({}, { registry: new StoreRegistry({ cardsDir: config.cardsDir }), config }),
    config,
  }
}

/** 建工件 → 派工（冻结 baseSha）→ 返回卡。 */
async function dispatchCard(rig, dir, cardId, extra = {}) {
  rig.artifacts.write(cardId, 'acceptance', 'A1 可跑')
  const res = await rig.tools.dispatch.execute({
    workspace: dir,
    cardId,
    subject: `注入用例 ${cardId}`,
    mode: 'rw',
    include: ['**'],
    sampleTag: 'injected',
    ...extra,
  })
  return { res, card: rig.store.read(cardId) }
}

/** 把回执直接写进卡（注入用例要隔离「回执对齐」这个变量）。 */
function setReceipt(store, cardId, changed, artifactsVersion = {}) {
  const card = store.read(cardId)
  card.lastReceipt = { at: Date.now(), changed, scope: [], acceptance: [], artifactsVersion }
  store.save(card)
  return card
}

// ── 用例 1–7：scratch ───────────────────────────────────────────────

async function case1() {
  const dir = makeRepo([['a.ts', '1\n'], ['b.ts', '1\n']])
  try {
    const rig = rigFor(dir)
    await dispatchCard(rig, dir, 'C1', { include: ['a.ts'] })
    appendFileSync(join(dir, 'a.ts'), '2\n')
    appendFileSync(join(dir, 'b.ts'), '2\n')
    commitAll(dir)
    setReceipt(rig.store, 'C1', ['a.ts', 'b.ts'])

    const res = await rig.tools.gate.execute({ workspace: dir, cardId: 'C1' })
    const outOfScope = res.violations.filter(v => v.kind === 'out-of-scope').map(v => v.path)
    record(1, '人为改授权外文件', 'gate 打回并列出文件名',
      res.verdict === 'CHANGES' && outOfScope.includes('b.ts'),
      `${res.verdict}；out-of-scope=${JSON.stringify(outOfScope)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function case2() {
  const dir = makeRepo([['a.ts', '1\n']])
  try {
    const rig = rigFor(dir)
    // (a) 非法跃迁：QUEUED 不能直接 SETTLED
    const card = makeCard({ cardId: 'CX', authorization: { mode: 'rw', include: ['**'] }, baseSha: 'a' })
    rig.store.save(card)
    let illegal = null
    try { rig.store.transition(card, STATES.SETTLED) } catch (error) { illegal = error.code }
    const transitionBlocked = !canTransition(STATES.QUEUED, STATES.SETTLED) && illegal === 'ILLEGAL_TRANSITION'

    // (b) 跳过「写验收基线」直接派工
    let baselineError = ''
    try {
      await rig.tools.dispatch.execute({ workspace: dir, cardId: 'CY', subject: '跳过工件', mode: 'rw', include: ['**'], acceptance: ['A1 可跑'] })
    } catch (error) { baselineError = error.message }

    record(2, '跳过开卡直接派工', '非法跃迁 / 缺验收基线被拒',
      transitionBlocked && /验收基线/.test(baselineError),
      `跃迁=${illegal}；派工报错=${baselineError ? '有' : '无'}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function case3() {
  const dir = makeRepo([['a.ts', '1\n']])
  try {
    const rig = rigFor(dir)
    await dispatchCard(rig, dir, 'C1', { include: ['a.ts'] })

    // 伪造现场：工作区（gitignored 目录内）写一段 GATE: PASS，再记一条自述
    mkdirSync(join(dir, '.cto-office', 'fake'), { recursive: true })
    writeFileSync(join(dir, '.cto-office', 'fake', 'gate.txt'), 'GATE: PASS\n')
    rig.store.recordNote('C1', 'GATE: PASS — 我自己宣布通过')

    const res = await rig.tools.gate.execute({ workspace: dir, cardId: 'C1' })
    const latest = rig.store.latestJudgement('C1')
    const summary = rig.store.evidenceSummary('C1')
    // 已知缺口：采集器不校验回执来自哪个 preset（见实现记录）。这里如实计入 detail。
    record(3, '伪造 GATE: PASS（错误来源）', '伪造文本不能变成结论',
      res.verdict !== 'PASS' && latest?.source === 'git-plumbing',
      `${res.verdict}；判定来源=${latest?.source}；被排除的非权威证据=${summary.excluded}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function case4() {
  const dir = makeRepo([['a.ts', '1\n']])
  try {
    const rig = rigFor(dir)
    await dispatchCard(rig, dir, 'C1', { include: ['a.ts'] })

    const guard = makePreExecuteGuard({
      registry: { all: () => [rig.store] },
      store: rig.store,
      config: { ...rig.config, patchApproval: { path: join(dir, 'unused-approval.json') } },
    })
    const allow = async () => ({ kind: 'allow' })
    const resetHard = await guard({ name: 'bash', arguments: { command: 'git reset --hard HEAD~1' } }, allow)
    const amend = await guard({ name: 'bash', arguments: { command: 'git commit --amend -m x' } }, allow)

    record(4, '提交后 reset 洗越界', 'pre-execute 拦截',
      resetHard.kind === 'deny' && amend.kind === 'deny' && isDestructiveGit('git checkout -- a.ts'),
      `reset=${resetHard.kind}；amend=${amend.kind}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function case5() {
  const files = Array.from({ length: 11 }, (_, i) => `f${i}.ts`)
  const dir = makeRepo(files.map(name => [name, '1\n']))
  try {
    const rig = rigFor(dir)
    await dispatchCard(rig, dir, 'C1', { include: ['**'] })
    for (const name of files) appendFileSync(join(dir, name), '2\n')
    commitAll(dir)
    setReceipt(rig.store, 'C1', files)

    const res = await rig.tools.gate.execute({ workspace: dir, cardId: 'C1' })
    const hit = res.violations.find(v => v.kind === 'granularity-files')
    record(5, '超粒度巨型卡', 'gate 硬拦',
      res.verdict === 'CHANGES' && Boolean(hit) && hit.count === 11,
      `${res.verdict}；files=${hit?.count ?? '?'} > limit ${hit?.limit ?? '?'}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function case6() {
  const dir = makeRepo([['a.ts', '1\n']])
  try {
    const rig = rigFor(dir)
    await dispatchCard(rig, dir, 'C1', { include: ['a.ts'] })
    // 制造版本漂移：卡里冻结的是 v2，磁盘上的工件仍是 v1（模拟越权改冻结值）
    const card = rig.store.read('C1')
    card.artifactsVersion = { ...card.artifactsVersion, acceptance: 2 }
    replaceJson(rig.store.cardPath('C1'), card)

    let message = ''
    try { await rig.tools.gate.execute({ workspace: dir, cardId: 'C1' }) } catch (error) { message = error.message }
    record(6, 'artifactsVersion 不一致', 'gate 打回并说明读了哪版',
      /1 ≠ 卡内冻结的 2/.test(message),
      message ? message.slice(0, 120) : '（没有报错 —— 这是缺陷）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

async function case7() {
  const dir = makeRepo([['a.ts', '1\n']])
  try {
    const rig = rigFor(dir)
    const { card } = await dispatchCard(rig, dir, 'C1', { include: ['a.ts'] })

    // 崩溃现场：intent 已登记、结论已落盘，但卡上还没记账。
    // 注意 artifactsVersion 必须用**全量** versions（gate 签名时用的就是它）：
    // 卡里的 `artifactsVersion` 是过滤过 0 的冻结子集，拿它冒充会触发 stale-context。
    const intent = rig.store.beginIntent('C1', { action: 'judge', baseSha: card.baseSha, artifactsVersion: rig.artifacts.versions('C1') })
    rig.store.writeJudgement('C1', intent, {
      baseSha: card.baseSha, verdict: 'PASS', violations: [], stats: { files: 0, lines: 0, dirtyPaths: [] }, at: 1,
    })

    const resumed = await rig.tools.gate.execute({ workspace: dir, cardId: 'C1' })
    const after = rig.store.read('C1')
    record(7, '崩溃恢复：intent 有、result 无', '重跑判定，不产生第二结论',
      /崩溃恢复/.test(resumed.message) && rig.store.countEvidence('C1') === 1 && after.rounds === 1,
      `证据=${rig.store.countEvidence('C1')} 件；rounds=${after.rounds}；复用 intent #${intent.intentSeq}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// ── 用例 8–9：一次性克隆的真实项目 ──────────────────────────────────

async function case8(dir) {
  const rig = rigFor(dir, { maxConcurrentWriters: 3 })
  await dispatchCard(rig, dir, 'C8', { include: ['**'] })
  let code = ''
  try { rig.artifacts.write('C8', 'acceptance', 'A1 可跑\nA2 追加') } catch (error) { code = error.code }
  record(8, '进行期改 artifactsVersion（真实克隆）', 'office_artifact.write 直接 deny',
    code === 'CARD_IN_PROGRESS',
    `error.code=${code || '(无)'}`)
}

async function case9(dir) {
  const rig = rigFor(dir, { maxConcurrentWriters: 3 })
  const glob = 'package.json'
  const a = await rig.tools.dispatch.execute({
    workspace: dir, cardId: 'C9a', subject: '持互斥占用', mode: 'rw', include: ['**'], exclusive: [glob], sampleTag: 'injected',
  })
  const b = await rig.tools.dispatch.execute({
    workspace: dir, cardId: 'C9b', subject: '撞互斥组', mode: 'rw', include: ['**'], exclusive: [glob], sampleTag: 'injected',
  })
  // 样本隔离：标签必须落在**卡**上（聚合只能经 card join，卡内不可能混样）
  const tagA = rig.store.read('C9a')?.sampleTag
  const tagB = rig.store.read('C9b')?.sampleTag
  record(9, '两张卡声明同一 exclusive glob（真实克隆）', '第二张进 QUEUED，且 sampleTag 落在卡上',
    a.state === STATES.DISPATCHED && b.state === STATES.QUEUED && b.blockedBy?.reason === 'exclusive-held'
      && tagA === 'injected' && tagB === 'injected',
    `${a.state} / ${b.state}(${b.blockedBy?.reason ?? '-'})；sampleTag=${tagA}/${tagB}`)
}

// ── 报告 ────────────────────────────────────────────────────────────

function buildReport() {
  const pass = RESULTS.filter(r => r.verdict === 'PASS').length
  const fail = RESULTS.length - pass
  const json = {
    schema: 'cto-office/fault-injection@1',
    generatedAt: new Date().toISOString(),
    repo: ROOT,
    summary: { total: RESULTS.length, pass, fail, bySampleTag: { injected: RESULTS.length } },
    cases: RESULTS,
    isolation: '闸门通过率/回退率统计只取 sampleTag=real；本报告全部为 injected，永不进入聚合。',
  }
  const rows = RESULTS.map(r => `| ${r.id} | ${r.name} | ${r.expected} | ${r.verdict} | ${r.detail.replace(/\|/g, '\\|')} |`)
  const markdown = [
    '# M-8 故障注入报告（sampleTag: injected）',
    '',
    `生成时间：${json.generatedAt}`,
    `通过 **${pass}/${RESULTS.length}**${fail ? `，失败 ${fail}` : ''}`,
    '',
    '| # | 用例 | 期望 | 结果 | 证据 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    '> 样本隔离：全部为 `injected`。M-12 的闸门通过率 / 回退率只取 `sampleTag: real`，本报告不参与聚合。',
  ].join('\n')
  return { json, markdown }
}

// ── 主流程 ──────────────────────────────────────────────────────────

const CASES = [
  ['1', case1], ['2', case2], ['3', case3], ['4', case4],
  ['5', case5], ['6', case6], ['7', case7],
]

const scratch = new Map()
for (const [id, fn] of CASES) {
  try {
    await fn()
  } catch (error) {
    record(Number(id), `用例 ${id} 执行异常`, '应跑完', false, `异常：${error?.message ?? error}`)
  }
  scratch.set(id, true)
}

// 8–9 共用一次克隆（真实结构，跑完即删）
let cloneDir = null
try {
  cloneDir = cloneOnce()
  await case8(cloneDir)
  await case9(cloneDir)
} catch (error) {
  record(8, '克隆用例执行异常', '应跑完', false, `异常：${error?.message ?? error}`)
} finally {
  if (cloneDir) rmSync(dirname(cloneDir), { recursive: true, force: true })
}

const report = buildReport()
console.log('\n' + report.markdown)

if (!flag('--no-write')) {
  const out = argOf('--out') ?? join(ROOT, '.cto-office', 'acceptance', 'fault-injection-latest.json')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(report.json, null, 2) + '\n')
  console.log(`\n报告已落盘：${out}`)
}

process.exitCode = report.json.summary.fail === 0 ? 0 : 1
