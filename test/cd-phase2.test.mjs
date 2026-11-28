/**
 * 二期验收：`office_cd` 工具 + R5–R9 守卫（设计稿 §6 二期）。
 *
 * 守六条：
 *  1. 模式 A 全流程 begin→review→checks→merge→release→verify→status 能跑通，
 *     每步都带可解析的 `CD:` 行，cd.json 与证据都落盘；
 *  2. begin 前置（无 SETTLED 卡 / 在飞卡 / 缺 evidence）拒绝；
 *  3. 跳过 checks 直接 merge → 工具拒绝；
 *  4. R5 方案卡形态、R6 拍板关口（ask）、R7 跳步 deny、R8 轮次 deny、R9 审批 deny；
 *  5. 两份审批 mint 之后对应动作放行；
 *  6. checks(success) 停在 CHECKS，CHECKS→MERGED 只由 merge 承担。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeCard, STATES } from '../lib/card.js'
import { CdStore, CD_ACTIONS, CD_STATES } from '../lib/cd.js'
import { mintApproval } from '../lib/patch-approval.js'
import { StoreRegistry } from '../lib/registry.js'
import { buildTools } from '../lib/tools.js'
import { makePreExecuteGuard } from '../lib/guards.js'

const SHA = 'b'.repeat(40)
const EVIDENCE = 'gh: ok'

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-cd2-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function setup() {
  const { dir, cleanup } = tmp()
  const registry = new StoreRegistry({ cardsDir: '.cto-office/cards' })
  const store = registry.get(dir)
  const card = makeCard({
    cardId: 'C1', subject: '已完成的卡', preset: 'cto-builder',
    authorization: { mode: 'rw', include: ['a.ts'] }, baseSha: SHA,
    acceptance: ['A1 通过'], now: 1000,
  })
  card.state = STATES.SETTLED
  store.save(card)

  const approvalsDir = join(dir, 'approvals')
  const config = {
    cd: { maxReviewRounds: 2, releaseWorkflow: 'deploy.yml', healthUrl: '' },
    planApproval: { enabled: false, path: join(approvalsDir, 'plan.json') },
    cdApproval: { path: join(approvalsDir, 'cd.json') },
    patchApproval: { path: join(approvalsDir, 'patch.json') },
    enforceRoleModels: false,
    writerPresets: ['cto-builder'],
    defaultAgentPreset: 'cto-builder',
    maxConcurrentWriters: 1,
  }
  const tools = buildTools({}, { registry, config })
  return { dir, cleanup, registry, store, config, tools }
}

const call = (tools, dir, extra) => tools.cd.execute({ workspace: dir, runId: 'CD1', ...extra })

const guardFor = ({ dir, store, config }) => makePreExecuteGuard({
  registry: { all: () => [store] }, store, config,
})
const ALLOW = async () => ({ kind: 'allow' })
const CD_LINE = /^CD: [A-Z_]+ run=CD1 round=\d+$/

// ── 工具形状 ────────────────────────────────────────────────────────

test('office_cd：工具存在，8 个 action，输出 schema 带 cdLine', () => {
  const { tools, cleanup } = setup()
  try {
    assert.ok(tools.cd, 'office_cd 已注册')
    assert.deepEqual(tools.cd.parameters.properties.action.enum, [...CD_ACTIONS])
    assert.ok(tools.cd.output.schema.required.includes('cdLine'))
    assert.ok(tools.cd.output.schema.required.includes('state'))
  } finally { cleanup() }
})

// ── 模式 A 全流程 ───────────────────────────────────────────────────

test('office_cd：begin → review(PASS) → checks(success) → merge → release → verify → status', async () => {
  const s = setup()
  try {
    const begin = await call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: EVIDENCE })
    assert.equal(begin.state, CD_STATES.PR_OPEN)
    assert.match(begin.cdLine, CD_LINE)
    assert.match(begin.message, /^CD: PR_OPEN/)

    const review = await call(s.tools, s.dir, { action: 'review', verdict: 'PASS', evidence: 'GATE: PASS' })
    assert.equal(review.state, CD_STATES.CHECKS)
    assert.equal(review.round, 1)

    const checks = await call(s.tools, s.dir, { action: 'checks', checksState: 'success', evidence: EVIDENCE })
    assert.equal(checks.state, CD_STATES.CHECKS, 'success 只标记 mergeReady，不直接进 MERGED')
    assert.match(checks.message, /checks 全绿/)

    const merge = await call(s.tools, s.dir, { action: 'merge', headSha: SHA, evidence: EVIDENCE })
    assert.equal(merge.state, CD_STATES.MERGED)

    const release = await call(s.tools, s.dir, { action: 'release', evidence: EVIDENCE })
    assert.equal(release.state, CD_STATES.RELEASED)

    const verify = await call(s.tools, s.dir, { action: 'verify', evidence: '200 OK', healthUrl: 'https://example.com/health' })
    assert.equal(verify.state, CD_STATES.VERIFIED)
    assert.match(verify.cdLine, CD_LINE)

    const status = await call(s.tools, s.dir, { action: 'status' })
    assert.equal(status.state, CD_STATES.VERIFIED)
    assert.match(status.message, /evidence=/)

    const cdStore = new CdStore(s.dir)
    const record = cdStore.read('CD1')
    assert.equal(record.state, CD_STATES.VERIFIED)
    assert.equal(record.headSha, SHA)
    assert.equal(record.healthUrl, 'https://example.com/health')
    assert.ok(record.history.length >= 6, 'begin 1 条 + review/checks/merge/release/verify 各 1 条')
    assert.ok(cdStore.readEvidence('CD1').length >= 6, '每个 action 都留下证据')
    assert.ok(cdStore.authoritativeEvidence('CD1').length >= 6)
    assert.ok(existsSync(cdStore.cdPath('CD1')))
  } finally { s.cleanup() }
})

test('office_cd：begin 前置 —— 缺 evidence / 无 SETTLED 卡 / 在飞卡都拒绝', async () => {
  const s = setup()
  try {
    await assert.rejects(
      call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA }),
      /需要 evidence/,
    )
    // 移除 SETTLED 卡
    s.store.save({ ...s.store.read('C1'), state: STATES.ABANDONED })
    await assert.rejects(
      call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: EVIDENCE }),
      /没有 SETTLED 卡/,
    )
    // 在飞卡
    s.store.save({ ...s.store.read('C1'), state: STATES.DISPATCHED })
    await assert.rejects(
      call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: EVIDENCE }),
      /在飞卡/,
    )
  } finally { s.cleanup() }
})

test('office_cd：跳过 checks 直接 merge → 工具拒绝（checksState 未 success / headSha stale）', async () => {
  const s = setup()
  try {
    await call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: EVIDENCE })
    await call(s.tools, s.dir, { action: 'review', verdict: 'PASS', evidence: 'GATE: PASS' })
    await assert.rejects(
      call(s.tools, s.dir, { action: 'merge', headSha: SHA, evidence: EVIDENCE }),
      /checksState 必须为 success/,
    )
    await call(s.tools, s.dir, { action: 'checks', checksState: 'success', evidence: EVIDENCE })
    await assert.rejects(
      call(s.tools, s.dir, { action: 'merge', headSha: 'c'.repeat(40), evidence: EVIDENCE }),
      /stale/,
    )
  } finally { s.cleanup() }
})

test('office_cd：review CHANGES 两轮 → BLOCKED 转人；第 3 次抛 CdRoundLimitError', async () => {
  const s = setup()
  try {
    await call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: EVIDENCE })
    const first = await call(s.tools, s.dir, { action: 'review', verdict: 'CHANGES', evidence: 'GATE: CHANGES' })
    assert.equal(first.state, CD_STATES.REVIEW)
    assert.equal(first.round, 1)
    const second = await call(s.tools, s.dir, { action: 'review', verdict: 'CHANGES', evidence: 'GATE: CHANGES' })
    assert.equal(second.state, CD_STATES.BLOCKED)
    assert.equal(second.round, 2)
    assert.match(second.message, /转人决策/)
    await assert.rejects(
      call(s.tools, s.dir, { action: 'review', verdict: 'CHANGES', evidence: 'GATE: CHANGES' }),
      /CD review round limit/,
    )
  } finally { s.cleanup() }
})

// ── 守卫 R5–R9 ─────────────────────────────────────────────────────

test('R5：方案卡必须 ro + cto-architect', async () => {
  const s = setup()
  try {
    const guard = guardFor(s)
    const args = { workspace: s.dir, cardId: 'P1', subject: '方案', role: 'plan' }
    const wrongMode = await guard({ name: 'office_dispatch', arguments: { ...args, mode: 'rw', preset: 'cto-architect' } }, ALLOW)
    assert.equal(wrongMode.kind, 'deny')
    assert.match(wrongMode.reason, /mode=ro/)
    const wrongPreset = await guard({ name: 'office_dispatch', arguments: { ...args, mode: 'ro', preset: 'cto-builder' } }, ALLOW)
    assert.equal(wrongPreset.kind, 'deny')
    const ok = await guard({ name: 'office_dispatch', arguments: { ...args, mode: 'ro', preset: 'cto-architect' } }, ALLOW)
    assert.equal(ok.kind, 'allow')
  } finally { s.cleanup() }
})

test('R6：未拍板派实现卡 → deny 且原因可执行；mint 审批后放行', async () => {
  const s = setup()
  try {
    const guard = guardFor({ ...s, config: { ...s.config, planApproval: { enabled: true, path: s.config.planApproval.path } } })
    const impl = { name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '【任务卡 C1】实现' } }
    const denied = await guard(impl, ALLOW)
    assert.equal(denied.kind, 'deny')
    assert.match(denied.reason, /拍板未通过/)
    assert.match(denied.reason, /office_plan_approve/)

    mintApproval({ path: s.config.planApproval.path, reason: '已拍板' })
    const allowed = await guard(impl, ALLOW)
    assert.equal(allowed.kind, 'allow')

    // 方案卡不受 R6 影响
    const plan = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-architect', prompt: '方案' } }, ALLOW)
    assert.equal(plan.kind, 'allow')
  } finally { s.cleanup() }
})

test('R7：CD 跳步 deny；R8：第 3 轮 review deny；R9：merge 无审批 deny、mint 后放行', async () => {
  const s = setup()
  try {
    await call(s.tools, s.dir, { action: 'begin', prNumber: 123, headSha: SHA, evidence: EVIDENCE })
    const guard = guardFor(s)
    const cdArgs = action => ({ name: 'office_cd', arguments: { workspace: s.dir, runId: 'CD1', action } })

    // R7：PR_OPEN 直接 merge
    const skip = await guard(cdArgs('merge'), ALLOW)
    assert.equal(skip.kind, 'deny')
    assert.match(skip.reason, /不许跳步/)

    // R8：round 到 2 后再 review
    const cdStore = new CdStore(s.dir)
    const record = cdStore.read('CD1')
    cdStore.save({ ...record, state: CD_STATES.REVIEW, round: 2 })
    const third = await guard(cdArgs('review'), ALLOW)
    assert.equal(third.kind, 'deny')
    assert.match(third.reason, /最多 2 轮/)

    // R9：合法 merge 但无审批
    cdStore.save({ ...cdStore.read('CD1'), state: CD_STATES.CHECKS, checksState: 'success', round: 1 })
    const noApproval = await guard(cdArgs('merge'), ALLOW)
    assert.equal(noApproval.kind, 'deny')
    assert.match(noApproval.reason, /不可逆动作/)

    mintApproval({ path: s.config.cdApproval.path, reason: '允许合并' })
    const ok = await guard(cdArgs('merge'), ALLOW)
    assert.equal(ok.kind, 'allow')
  } finally { s.cleanup() }
})
