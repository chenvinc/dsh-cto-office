/**
 * 岗位 → 模型/档位（M-7 的可落地部分）测试。
 *
 * 守的四条：
 *  1. 默认表全部落在 opencode-go 上游，且按模型家族分工
 *     （主控 Hy4 / 第二方案 Gemini Argon / 实现 DeepSeek Flash / 审查 GLM）；
 *  2. 漏传或传错路由 → 守卫拒绝，并把**该传的三个参数**原样写进拒绝理由；
 *  3. 未配置的岗位不参与校验（不能因为表里没有就把派工卡死）；
 *  4. 表的解析不静默吞坏配置：坏项剔除并报告。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CardStore } from '../lib/store.js'
import { STATES, makeCard } from '../lib/card.js'
import { makePreExecuteGuard } from '../lib/guards.js'
import { buildTools } from '../lib/tools.js'
import { StoreRegistry } from '../lib/registry.js'
import {
  DEFAULT_ROLE_MODELS,
  checkDispatchRoute,
  describeRoute,
  resolveRoleModels,
  routeForPreset,
} from '../lib/role-models.js'

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-role-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const ROLES = resolveRoleModels({}).table
const ALLOW = async () => ({ kind: 'allow' })

function guardFor(config = {}, dir = tmpdir()) {
  const store = new CardStore(dir)
  return makePreExecuteGuard({
    registry: { all: () => [store] },
    store,
    config: { maxConcurrentWriters: 1, writerPresets: ['cto-builder'], defaultAgentPreset: 'cto-builder', ...config },
  })
}

const routeArgs = preset => {
  const route = routeForPreset(ROLES, preset)
  return { provider: route.provider, model: route.model, reasoning_effort: route.reasoning_effort }
}

// ── 默认表 ──────────────────────────────────────────────────────────

test('默认表：全部落在 opencode-go 上游，按模型家族分工', () => {
  assert.deepEqual(routeForPreset(ROLES, 'cto-architect'), {
    preset: 'cto-architect', provider: 'magpie', model: 'auto/gemini-4-argon', reasoning_effort: 'high', tier: 'thinking',
  })
  assert.equal(routeForPreset(ROLES, 'cto-reviewer').model, 'opencode-go/glm-5.3-flash')
  assert.equal(routeForPreset(ROLES, 'cto-builder').model, 'opencode-go/deepseek-v4.1-flash')
  assert.equal(routeForPreset(ROLES, 'cto-builder').reasoning_effort, 'high', '写代码要强档')
  assert.equal(routeForPreset(ROLES, 'cto-qa').model, 'opencode-go/minimax-m3.1-flash')
  assert.equal(routeForPreset(ROLES, 'cto-ux').model, 'auto/gemini-4-argon')
  assert.equal(routeForPreset(ROLES, 'cto-product').model, 'opencode-go/kimi-k3.1-pro')
  for (const preset of ['cto-reviewer', 'cto-qa', 'cto-product']) {
    assert.equal(routeForPreset(ROLES, preset).reasoning_effort, 'low', `${preset} 走低档`)
  }
  assert.equal(Object.keys(DEFAULT_ROLE_MODELS).length, 6, '六个岗位各一条')
  assert.equal(routeForPreset(ROLES, 'standard'), null, '非本办公室岗位不参与')
  for (const [preset, route] of Object.entries(DEFAULT_ROLE_MODELS)) {
    assert.equal(route.provider, 'magpie', `${preset} 统一走 magpie 通道`)
    assert.ok(
      /^opencode-go\//.test(route.model) || route.model === 'auto/gemini-4-argon',
      `${preset} 的 ${route.model} 必须是 opencode-go 上游（auto/gemini-4-argon 的 owned_by 也是 opencode-go）`,
    )
  }
})

test('表解析：配置可覆盖、可用 null 摘除、坏配置被剔除且报告', () => {
  const { table, problems } = resolveRoleModels({
    'cto-builder': { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash', reasoning_effort: 'max' },
    'cto-qa': null,
    'cto-ux': { provider: '', model: 'x' },
    'cto-product': { provider: 'magpie', model: 'm', reasoning_effort: 'ultra' },
  })
  assert.equal(routeForPreset(table, 'cto-builder').provider, 'dsh-opencode-go', '覆盖生效')
  assert.equal(routeForPreset(table, 'cto-builder').reasoning_effort, 'max')
  assert.equal(routeForPreset(table, 'cto-qa'), null, 'null = 不校验该岗位')
  assert.equal(routeForPreset(table, 'cto-ux'), null, '坏项剔除，不留在表里')
  assert.equal(problems.length, 2, '两个坏项都要报告')
  assert.ok(problems.some(p => /cto-ux/.test(p)))
  assert.ok(problems.some(p => /ultra/.test(p)))
})

// ── 校验 ────────────────────────────────────────────────────────────

test('校验：漏传 / 传错都会说明「应传什么」，未配置岗位直接放行', () => {
  const ok = checkDispatchRoute(ROLES, 'cto-architect', routeArgs('cto-architect'))
  assert.equal(ok.ok, true)

  const missing = checkDispatchRoute(ROLES, 'cto-architect', { prompt: 'x' })
  assert.equal(missing.ok, false)
  assert.ok(missing.problems.some(p => /缺 provider/.test(p)))
  assert.ok(missing.problems.some(p => /缺 model/.test(p)))
  assert.ok(missing.problems.some(p => /缺 reasoning_effort/.test(p)))

  const wrongModel = checkDispatchRoute(ROLES, 'cto-builder', { ...routeArgs('cto-builder'), model: 'opencode-go/hy4' })
  assert.equal(wrongModel.ok, false)
  assert.match(wrongModel.problems.join('；'), /opencode-go\/deepseek-v4\.1-flash/)

  assert.equal(checkDispatchRoute(ROLES, 'cto-unknown', { prompt: 'x' }).ok, true, '未配置岗位不校验')
})

test('描述：给 CTO 看的路由串', () => {
  assert.equal(describeRoute(routeForPreset(ROLES, 'cto-architect')), 'magpie/auto/gemini-4-argon @ high')
  assert.equal(describeRoute(null), '（继承父 Agent 的路由）')
})

// ── 守卫 ────────────────────────────────────────────────────────────

test('守卫：漏传路由拒绝，且拒绝理由里给出该传的三个参数', async () => {
  const guard = guardFor()
  const denied = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-architect', prompt: '看看架构' } }, ALLOW)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /必须带上这个岗位的路由/)
  assert.match(denied.reason, /provider="magpie"/)
  assert.match(denied.reason, /model="auto\/gemini-4-argon"/)
  assert.match(denied.reason, /reasoning_effort="high"/)
  assert.match(denied.reason, /岗位表：/, '把整张表给出来，避免 CTO 反复试错')
})

test('守卫：按表传放行；传错档位拒绝', async () => {
  const guard = guardFor()
  const allowed = await guard({
    name: 'subagent',
    arguments: { agent_preset: 'cto-architect', ...routeArgs('cto-architect'), prompt: '看看架构' },
  }, ALLOW)
  assert.equal(allowed.kind, 'allow')

  const wrongEffort = await guard({
    name: 'subagent',
    arguments: { agent_preset: 'cto-architect', ...routeArgs('cto-architect'), reasoning_effort: 'low', prompt: 'x' },
  }, ALLOW)
  assert.equal(wrongEffort.kind, 'deny')
  assert.match(wrongEffort.reason, /reasoning_effort=low，应为 high/)
})

test('守卫：省略 agent_preset 按写岗处理 —— 路由也要按写岗校验', async () => {
  const guard = guardFor()
  const denied = await guard({ name: 'subagent', arguments: { prompt: '随便派' } }, ALLOW)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /cto-builder/, '默认写岗 = cto-builder，路由按它校验')
})

test('守卫：enforceRoleModels=false 时退回继承父路由（可临时关闭）', async () => {
  const guard = guardFor({ enforceRoleModels: false })
  const allowed = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-architect', prompt: 'x' } }, ALLOW)
  assert.equal(allowed.kind, 'allow')
})

test('守卫：只读岗同样受路由校验（模型跟岗位走，不跟读写走）', async () => {
  const guard = guardFor()
  const denied = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-qa', prompt: '审一下' } }, ALLOW)
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /opencode-go\/minimax-m3\.1-flash/)
  assert.match(denied.reason, /reasoning_effort="low"/)
})

// ── 派工响应 ────────────────────────────────────────────────────────

test('office_dispatch 的响应里带该岗位应传的路由', async () => {
  const { dir, cleanup } = tmp()
  try {
    const { execFileSync } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    writeFileSync(join(dir, '.gitignore'), '.cto-office/\n')
    writeFileSync(join(dir, 'a.ts'), 'x\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })

    const config = { cardsDir: '.cto-office/cards', granularity: {}, supervisor: { enabled: false }, maxConcurrentWriters: 1 }
    const tools = buildTools({}, { registry: new StoreRegistry({ cardsDir: config.cardsDir }), config })
    const res = await tools.dispatch.execute({
      workspace: dir, cardId: 'C1', subject: '加个字段', mode: 'rw', include: ['a.ts'], preset: 'cto-architect',
    })
    assert.match(res.message, /派工路由（按岗位表，pre-execute 会校验）：cto-architect → magpie\/auto\/gemini-4-argon @ high/)
  } finally { cleanup() }
})
