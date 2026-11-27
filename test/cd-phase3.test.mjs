/**
 * 三期验收：`gh` 命令契约 / 输出解析 / CD 巡检 / 面板协议（设计稿 §6 三期）。
 *
 * 守六条：
 *  1. 每个 CD 阶段都有固化的 gh 命令，且 repo / headSha / workflow / healthUrl 都填对；
 *  2. gh stdout 能被解析成结构化事实，三态聚合正确，失败可归类；
 *  3. `CD:` 行往返解析（lib 侧与 client.js 的正则字面一致）；
 *  4. CdWatcher 只读告警：pending / BLOCKED 超时报、终态不报、去重、不写状态；
 *  5. office_cd 用 evidence 校验声明（铁律 3）：headSha / checksState 冲突打回；
 *  6. 面板静态护栏：D1 的 open-card 分支、CD chip、CD: 正则与 lib 一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeCard, STATES } from '../lib/card.js'
import { CD_ACTIONS, CD_STATES, cdLine, parseCdLine } from '../lib/cd.js'
import { cdCommands, classifyGhFailure, nextCommand, parseChecks, parsePrView } from '../lib/cd-gh.js'
import { CdWatcher } from '../lib/cd-watch.js'
import { StoreRegistry } from '../lib/registry.js'
import { buildTools } from '../lib/tools.js'

const SHA = 'c'.repeat(40)

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cto-cd3-'))
  const registry = new StoreRegistry({ cardsDir: '.cto-office/cards' })
  const store = registry.get(dir)
  const card = makeCard({
    cardId: 'C1', subject: '卡', preset: 'cto-builder',
    authorization: { mode: 'rw', include: ['a.ts'] }, baseSha: SHA,
    acceptance: ['A1 ok'], now: 1000,
  })
  card.state = STATES.SETTLED
  store.save(card)
  const config = {
    cd: {
      maxReviewRounds: 2, releaseWorkflow: 'deploy.yml', healthUrl: 'https://example.com/health',
      checksPollIntervalMs: 60000, staleAfterMs: 300000,
    },
    planApproval: { enabled: false },
    cdApproval: {},
    patchApproval: {},
    enforceRoleModels: false,
  }
  const tools = buildTools({}, { registry, config })
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }), tools }
}

const call = (tools, dir, extra) => tools.cd.execute({ workspace: dir, runId: 'CD1', ...extra })

// ── 命令契约 ────────────────────────────────────────────────────────

test('cdCommands / nextCommand：每阶段有命令，参数与配置都填对', () => {
  const cmds = cdCommands({ prNumber: 123, headSha: SHA, repo: 'acme/app', releaseWorkflow: 'deploy.yml', healthUrl: 'https://h/health' })
  assert.match(cmds.begin, /gh pr view 123 --repo acme\/app/)
  assert.match(cmds.checks, /gh pr checks 123/)
  assert.match(cmds.merge, new RegExp(`sha=${SHA}`))
  assert.match(cmds.release, /gh workflow run deploy\.yml --repo acme\/app/)
  assert.match(cmds.verify, /curl .*https:\/\/h\/health/)

  const cfg = { repo: 'acme/app', releaseWorkflow: 'deploy.yml', healthUrl: 'https://h/health' }
  const rec = (state, checksState = 'pending') => ({ state, prNumber: 123, headSha: SHA, checksState })
  assert.equal(nextCommand(rec(CD_STATES.PR_OPEN), cfg).stage, 'review')
  assert.equal(nextCommand(rec(CD_STATES.CHECKS), cfg).stage, 'checks')
  assert.match(nextCommand(rec(CD_STATES.MERGED), cfg).command, /gh workflow run/)
  assert.match(nextCommand(rec(CD_STATES.RELEASED), cfg).command, /curl/)
  assert.equal(nextCommand(rec(CD_STATES.VERIFIED), cfg).stage, null)
  assert.match(nextCommand(rec(CD_STATES.BLOCKED), cfg).hint, /人工决策/)
  assert.ok(CD_ACTIONS.includes('commands'))
})

// ── gh 输出解析 ─────────────────────────────────────────────────────

test('parsePrView：对象 / 数组 / 非 JSON / 缺字段', () => {
  assert.deepEqual(parsePrView(JSON.stringify({ number: 123, headRefOid: SHA, state: 'OPEN' })), {
    ok: true, headSha: SHA, prNumber: 123, state: 'OPEN',
  })
  assert.equal(parsePrView(JSON.stringify([{ number: 7, headRefOid: SHA }])).prNumber, 7)
  assert.equal(parsePrView('gh: not json').ok, false)
  assert.equal(parsePrView('{}').headSha, null)
})

test('parseChecks：success / pending / failure，失败优先于 pending', () => {
  const ok = JSON.stringify([
    { name: 'build', state: 'completed', conclusion: 'success' },
    { name: 'lint', state: 'completed', conclusion: 'neutral' },
  ])
  assert.deepEqual(parseChecks(ok), { ok: true, checksState: 'success', count: 2 })
  const pending = JSON.stringify([
    { name: 'build', state: 'completed', conclusion: 'success' },
    { name: 'e2e', state: 'in_progress', conclusion: '' },
  ])
  assert.equal(parseChecks(pending).checksState, 'pending')
  const failed = JSON.stringify([
    { name: 'build', state: 'completed', conclusion: 'failure' },
    { name: 'e2e', state: 'in_progress', conclusion: '' },
  ])
  assert.equal(parseChecks(failed).checksState, 'failure', '失败优先')
  assert.equal(parseChecks(JSON.stringify({ check_runs: [{ state: 'completed', conclusion: 'cancelled' }] })).checksState, 'failure')
  assert.equal(parseChecks('gh: ok').ok, false)
  assert.equal(parseChecks('{}').ok, false)
})

test('classifyGhFailure：六类错误各归其位', () => {
  assert.equal(classifyGhFailure('gh: Not logged in. Run gh auth login'), 'unauthenticated')
  assert.equal(classifyGhFailure('401 Bad credentials'), 'unauthenticated')
  assert.equal(classifyGhFailure("Could not resolve to a PullRequest with the number of 999"), 'not-found')
  assert.equal(classifyGhFailure('API rate limit exceeded for user'), 'rate-limited')
  assert.equal(classifyGhFailure('head sha did not match expected'), 'stale')
  assert.equal(classifyGhFailure('connect ETIMEDOUT'), 'unavailable')
  assert.equal(classifyGhFailure('everything is fine'), 'unknown')
})

// ── CD: 行协议 ──────────────────────────────────────────────────────

test('cdLine / parseCdLine：往返、倒序取最后一条、无匹配返回 null', () => {
  const rec = { state: CD_STATES.CHECKS, runId: 'CD7', round: 2 }
  assert.equal(cdLine(rec), 'CD: CHECKS run=CD7 round=2')
  assert.deepEqual(parseCdLine(cdLine(rec)), { state: 'CHECKS', runId: 'CD7', round: 2 })
  assert.deepEqual(
    parseCdLine('CD: PR_OPEN run=CD7 round=0\n正文\nCD: MERGED run=CD7 round=2'),
    { state: 'MERGED', runId: 'CD7', round: 2 },
  )
  assert.equal(parseCdLine('没有 CD 行'), null)
})

// ── CD 巡检器 ───────────────────────────────────────────────────────

test('CdWatcher：pending / BLOCKED 超时告警，终态不报，同一状态只报一次', () => {
  const now = 1_000_000
  const watcher = new CdWatcher({ staleAfterMs: 300000, now: () => now })
  const rec = (state, checksState, updatedAt) => ({ runId: 'CD1', state, checksState, updatedAt })
  const stalled = rec(CD_STATES.CHECKS, 'pending', now - 400000)

  const first = watcher.tick([stalled])
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'checks-pending')
  assert.match(first[0].message, /office_cd action=status/)
  assert.deepEqual(watcher.tick([stalled]), [], '同一 (state,updatedAt,kind) 不重复报')

  const blocked = rec(CD_STATES.BLOCKED, 'pending', now - 400000)
  const b = watcher.tick([blocked])
  assert.equal(b[0].kind, 'blocked')
  assert.match(b[0].message, /人工决策/)

  assert.deepEqual(watcher.tick([rec(CD_STATES.VERIFIED, 'success', now - 400000)]), [], '终态不报')
  assert.deepEqual(watcher.tick([rec(CD_STATES.CHECKS, 'pending', now - 1000)]), [], '未超时不报')
  // 活动推进（updatedAt 变了）后允许重报
  assert.equal(watcher.tick([{ ...stalled, updatedAt: now - 350000 }]).length, 1)
})

// ── office_cd：commands / status / evidence 校验 ────────────────────

test('office_cd：commands 列出全量命令，status 带下一步命令', async () => {
  const s = setup()
  try {
    await call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: JSON.stringify({ number: 123, headRefOid: SHA }) })
    const commands = await call(s.tools, s.dir, { action: 'commands', repo: 'acme/app' })
    assert.match(commands.message, /全量命令契约/)
    assert.match(commands.message, /gh pr view 123 --repo acme\/app/)
    assert.match(commands.message, /stage=review/)
    const status = await call(s.tools, s.dir, { action: 'status' })
    assert.match(status.message, /下一步：stage=review/)
    assert.match(status.message, /evidence=/)
  } finally { s.cleanup() }
})

test('office_cd：铁律 3 —— evidence 与声明冲突一律打回', async () => {
  const s = setup()
  try {
    // begin：evidence 里的 headRefOid 与参数不一致
    await assert.rejects(
      call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: JSON.stringify({ number: 123, headRefOid: 'd'.repeat(40) }) }),
      /证据优先/,
    )
    // gh 未登录的 stderr 也要有可读理由
    await assert.rejects(
      call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: 'gh: Not logged in. Run gh auth login' }),
      /unauthenticated/,
    )
    await call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: JSON.stringify({ number: 123, headRefOid: SHA }) })
    await call(s.tools, s.dir, { action: 'review', verdict: 'PASS', evidence: 'GATE: PASS' })

    // checks：evidence 解析出 success，却声明 pending
    const successJson = JSON.stringify([{ name: 'build', state: 'completed', conclusion: 'success' }])
    await assert.rejects(
      call(s.tools, s.dir, { action: 'checks', checksState: 'pending', evidence: successJson }),
      /证据优先/,
    )
    // 一致则放行
    const ok = await call(s.tools, s.dir, { action: 'checks', checksState: 'success', evidence: successJson })
    assert.equal(ok.state, CD_STATES.CHECKS)
    assert.match(ok.message, /checks 全绿/)
  } finally { s.cleanup() }
})

// ── 面板静态护栏（浏览器半跑不了单测，用文本一致性防漂移）──────────

test('client.js：D1 的 open-card 分支、CD chip、CD: 正则与 lib 一致', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const client = readFileSync(join(root, 'client.js'), 'utf8')
  const lib = readFileSync(join(root, 'lib', 'cd.js'), 'utf8')
  assert.match(client, /if \(openCard\) return 'open-card'/, 'D1 修复：open-card 会亮')
  assert.match(client, /className: 'co-cd'/, 'CD chip 已渲染')
  assert.match(client, /'data-cd-state': cdSnap\.state/)
  assert.match(client, /function cdStatusOf\(events\)/)
  const reLiteral = '^CD:\\s+([A-Z_]+)\\s+run=(\\S+)\\s+round=(\\d+)'
  assert.ok(client.includes(reLiteral), 'client.js 的 CD: 正则与 lib/cd.js:parseCdLine 字面一致')
  assert.ok(lib.includes(reLiteral))
  assert.match(client, /grid-template-columns:repeat\(6,/, 'StepBar 仍 6 格')
})
