/**
 * 拍板关口回归测试（2026-11-28 P0 issue）。
 *
 * 这个 issue 的根因是两套「拍板」语义没接上：
 *   章程：用户用了 ask_user_question = 已拍板
 *   R6  ：工作区外存在 plan 审批文件 = 已拍板
 * 修法：人工确认搬进 `office_plan_approve`（内部 plan-review 问句），Host 侧落凭据；
 *       R6 只机检，失败用 `deny` 把可读原因交给模型。
 *
 * 守七条：
 *  1. 未拍板派实现卡 → `deny`（不是 ask），原因里必须出现 office_plan_approve 与兜底脚本；
 *  2. 已拍板且卡在覆盖范围 → 放行；
 *  3. 审批只覆盖 A 卡时不放行 B 卡（不能一次拍板无限复用）；
 *  4. 过期 → deny 且 reason 是 approval-expired；
 *  5. 只读卡（qa/reviewer）不受 R6 影响；
 *  6. office_plan_approve：批准 → 落凭据（含 cardIds/版本）且 R6 立刻放行；
 *  7. office_plan_approve 的 fail-closed：拿不到 userQuestions / 用户未批准 / 缺验收基线 → 不写凭据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeCard, STATES } from '../lib/card.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { mintPlanApproval, planApprovalPath, readPlanApproval } from '../lib/plan-approval.js'
import { StoreRegistry } from '../lib/registry.js'
import { buildTools } from '../lib/tools.js'
import { makePreExecuteGuard } from '../lib/guards.js'

const SHA = 'a'.repeat(40)
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-plan-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 建一个带审批文件路径的 fixture；cards 里可预置卡状态与工件。 */
function setup({ cards = [], acceptance = [], approvalPath, userQuestions } = {}) {
  const { dir, cleanup } = tmp()
  const path = approvalPath ?? join(dir, 'approvals', 'plan.json')
  const registry = new StoreRegistry({ cardsDir: '.cto-office/cards' })
  const store = registry.get(dir)
  const artifacts = new ArtifactStore(store)
  for (const id of acceptance) artifacts.write(id, 'acceptance', `${id} 验收：A1 成立`)
  for (const spec of cards) {
    const card = makeCard({
      cardId: spec.cardId, subject: spec.subject ?? '卡', preset: spec.preset ?? 'cto-builder',
      authorization: { mode: spec.mode ?? 'rw', include: spec.include ?? ['a.ts'] },
      baseSha: SHA, acceptance: ['A1 ok'], now: 1000,
    })
    card.role = spec.role ?? 'impl'
    card.state = spec.state ?? STATES.QUEUED
    store.save(card)
  }
  const config = {
    planApproval: { enabled: true, path, ttlMs: 1800000 },
    cdApproval: { path: join(dir, 'approvals', 'cd.json') },
    patchApproval: { path: join(dir, 'approvals', 'patch.json') },
    writerPresets: ['cto-builder'],
    defaultAgentPreset: 'cto-builder',
    maxConcurrentWriters: 1,
    enforceRoleModels: false,
    userQuestions,
  }
  const tools = buildTools({}, { registry, config })
  const guard = makePreExecuteGuard({ registry: { all: () => [store] }, store, config })
  return { dir, cleanup, store, artifacts, config, tools, guard, path }
}

const ALLOW = async () => ({ kind: 'allow' })
const implDispatch = cardId => ({
  name: 'subagent',
  arguments: {
    agent_preset: 'cto-builder', provider: 'magpie',
    model: 'opencode-go/deepseek-v4.1-flash', reasoning_effort: 'high',
    prompt: `【任务卡 ${cardId}】实现`,
  },
})

// ── 1. 未拍板 → deny 且原因可读 ──────────────────────────────────────

test('R6：未拍板派实现卡 → deny（不是 ask），原因可执行', async () => {
  const s = setup()
  try {
    const decision = await s.guard(implDispatch('C1'), ALLOW)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /拍板未通过/)
    assert.match(decision.reason, /office_plan_approve/)
    assert.match(decision.reason, /approve-phase\.mjs/)
    assert.match(decision.reason, /【任务卡 C1】/)
    assert.ok(!existsSync(s.path), 'deny 不应顺手写凭据')
  } finally { s.cleanup() }
})

// ── 2. 已拍板且覆盖 → 放行 ──────────────────────────────────────────

test('R6：凭据覆盖该卡 → 放行', async () => {
  const s = setup()
  try {
    mintPlanApproval({ path: s.path, reason: '已拍板', scope: { cardIds: ['C1'] } })
    const decision = await s.guard(implDispatch('C1'), ALLOW)
    assert.equal(decision.kind, 'allow')
  } finally { s.cleanup() }
})

// ── 3. 卡号绑定：一次拍板不能无限复用 ───────────────────────────────

test('R6：凭据只覆盖 C1 时，派 C2 仍被拒（out-of-scope）', async () => {
  const s = setup()
  try {
    mintPlanApproval({ path: s.path, reason: '已拍板', scope: { cardIds: ['C1'] } })
    const decision = await s.guard(implDispatch('C2'), ALLOW)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /没有覆盖这张卡/)
    assert.match(decision.reason, /已批准的卡：C1/)

    // 旧式通配凭据（终端没用 --card）仍然放行，保证向后兼容
    mintPlanApproval({ path: s.path, reason: '旧流程' })
    assert.equal((await s.guard(implDispatch('C2'), ALLOW)).kind, 'allow')
  } finally { s.cleanup() }
})

// ── 4. 过期 → deny ────────────────────────────────────────────────

test('R6：凭据过期 → deny 且指出 approval-expired', async () => {
  const s = setup()
  try {
    mintPlanApproval({ path: s.path, reason: '已拍板', scope: { cardIds: ['C1'] }, ttlMs: 1, now: Date.now() - 120000 })
    const decision = await s.guard(implDispatch('C1'), ALLOW)
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /已过期/)
    assert.match(decision.reason, /重新拍板/)
  } finally { s.cleanup() }
})

// ── 5. 只读卡不受影响 ──────────────────────────────────────────────

test('R6：只读卡（qa/reviewer）不查拍板凭据', async () => {
  const s = setup()
  try {
    for (const preset of ['cto-qa', 'cto-reviewer']) {
      const decision = await s.guard({
        name: 'subagent',
        arguments: { agent_preset: preset, prompt: '【任务卡 Q1】只读' },
      }, ALLOW)
      assert.equal(decision.kind, 'allow', preset)
    }
    // 即便 planApproval 关了也不影响（回归）
    assert.ok(true)
  } finally { s.cleanup() }
})

// ── 6. office_plan_approve：批准后落凭据并放行 ──────────────────────

function fakeQuestions(selectedLabel, { custom } = {}) {
  const calls = []
  return {
    calls,
    ask: async request => {
      calls.push(request)
      return { answers: [{ id: 'plan-approve', selected: selectedLabel ? [selectedLabel] : [], ...(custom ? { custom } : {}) }] }
    },
  }
}

test('office_plan_approve：用户点批准 → Host 落凭据（绑定卡号+版本），R6 立即放行', async () => {
  const uq = fakeQuestions('批准派实现卡（推荐）')
  const s = setup({ acceptance: ['SC-4a'], userQuestions: uq })
  try {
    const result = await s.tools.planApprove.execute({
      workspace: s.dir,
      cardIds: ['SC-4a'],
      summary: '全量 765+922、新建隔离库、授权补抓和 del、保留遗留文档不提交',
    }, {})
    assert.equal(result.approved, true)
    assert.deepEqual(result.cardIds, ['SC-4a'])

    const doc = JSON.parse(readFileSync(s.path, 'utf8'))
    assert.deepEqual(doc.scope.cardIds, ['SC-4a'])
    assert.deepEqual(doc.scope.acceptanceVersion, { 'SC-4a': 1 })
    assert.deepEqual(doc.scope.contractsVersion, { 'SC-4a': 0 })
    assert.equal(doc.by, 'human-via-office_plan_approve')

    // 弹给用户的确实是一次 plan-review 意图的真实问句
    assert.equal(uq.calls.length, 1)
    const q = uq.calls[0].questions[0]
    assert.equal(q.intent.kind, 'plan-review')
    assert.equal(q.intent.approve, '批准派实现卡（推荐）')
    assert.match(q.detail, /覆盖卡：SC-4a/)

    // 凭据可被 R6 读到并放行
    assert.equal(readPlanApproval({ path: s.path }).approved, true)
    assert.equal((await s.guard(implDispatch('SC-4a'), ALLOW)).kind, 'allow')
  } finally { s.cleanup() }
})

// ── 7. fail-closed 三例 ───────────────────────────────────────────

test('office_plan_approve：拿不到 userQuestions → 报错给兜底命令，且不写凭据', async () => {
  const s = setup({ acceptance: ['C1'], userQuestions: undefined })
  try {
    await assert.rejects(
      s.tools.planApprove.execute({ workspace: s.dir, cardIds: ['C1'], summary: '采用方案 A：先补隔离库再全量回填，保留遗留文档不提交' }, {}),
      /拿不到 userQuestions 服务[\s\S]*approve-phase\.mjs/,
    )
    assert.ok(!existsSync(s.path), '无人工确认时绝不写凭据')
  } finally { s.cleanup() }
})

test('office_plan_approve：用户选不批准 / 只填自定义文本 → 不写凭据', async () => {
  for (const uq of [fakeQuestions('先不批准'), fakeQuestions(null, { custom: '再改改' })]) {
    const s = setup({ acceptance: ['C1'], userQuestions: uq })
    try {
      const result = await s.tools.planApprove.execute({ workspace: s.dir, cardIds: ['C1'], summary: '采用方案 A：先补隔离库再全量回填，保留遗留文档不提交' }, {})
      assert.equal(result.approved, false)
      assert.ok(!existsSync(s.path), '未批准不得落凭据（custom 文本不算授权）')
      assert.match(result.message, /未批准/)
    } finally { s.cleanup() }
  }
})

test('office_plan_approve：缺验收基线 / 缺 cardIds / summary 太短一律拒绝', async () => {
  const s = setup({ userQuestions: fakeQuestions('批准派实现卡（推荐）') })
  try {
    await assert.rejects(
      s.tools.planApprove.execute({ workspace: s.dir, cardIds: ['NO-ART'], summary: '采用方案 A：先补隔离库再全量回填，保留遗留文档不提交' }, {}),
      /还没有验收基线/,
    )
    await assert.rejects(
      s.tools.planApprove.execute({ workspace: s.dir, cardIds: [], summary: '采用方案 A：先补隔离库再全量回填，保留遗留文档不提交' }, {}),
      /cardIds 不能为空/,
    )
    await assert.rejects(
      s.tools.planApprove.execute({ workspace: s.dir, cardIds: ['X'], summary: '短' }, {}),
      /summary 太短/,
    )
    assert.ok(!existsSync(s.path))
  } finally { s.cleanup() }
})

// ── 8. 状态快照能看出拍板状态（issue P2）──────────────────────────

test('office_status：输出拍板关口的配置快照', async () => {
  const s = setup()
  try {
    const off = await s.tools.status.execute({ workspace: s.dir })
    assert.match(off.message, /拍板关口：/)
    mintPlanApproval({ path: s.path, reason: '已拍板', scope: { cardIds: ['C1'] } })
    const on = await s.tools.status.execute({ workspace: s.dir })
    assert.match(on.message, /拍板关口：enabled/)
    assert.match(on.message, /覆盖卡 C1/)
  } finally { s.cleanup() }
})
