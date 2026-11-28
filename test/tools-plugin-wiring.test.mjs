/**
 * alpha.5 回归：用真实 apply() 装配，证明 office_plan_approve 能拿到 userQuestions。
 *
 * 这个测试刻意复刻 cordis 4 的语义：未 inject 的服务属性裸读直接抛
 * `cannot get property ... without inject`，只有 ctx.get(name) 可读。
 * alpha.4 的实现正是在这里把服务读成 undefined，导致拍板弹不出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../tools-plugin.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { StoreRegistry } from '../lib/registry.js'
import { readPlanApproval } from '../lib/plan-approval.js'

const APPROVE = '批准派实现卡（推荐）'
const SUMMARY = '采用方案 A：补隔离库后全量回填，保留遗留文档不提交'

function makeCtx({ userQuestions, registered }) {
  const target = {
    get: name => {
      if (name === 'userQuestions') return userQuestions
      if (name === 'timer') return { interval: () => () => {} }
      return undefined
    },
    tools: {
      register: tool => {
        registered.set(tool.name, tool)
        return () => {}
      },
    },
    effect: fn => {
      const stop = fn()
      return () => { try { stop?.() } catch {} }
    },
    on: () => {},
    logger: { warn: () => {}, info: () => {} },
  }
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
}

function workspaceWithAcceptance(cardId) {
  const dir = mkdtempSync(join(tmpdir(), 'cto-wiring-'))
  const registry = new StoreRegistry({ cardsDir: '.cto-office/cards' })
  new ArtifactStore(registry.get(dir)).write(cardId, 'acceptance', `${cardId} 验收：A1 成立`)
  return dir
}

function baseConfig(dir, approvalPath) {
  return {
    planApproval: { enabled: true, path: approvalPath, ttlMs: 60_000 },
    patchApproval: { path: join(dir, 'approvals', 'patch.json') },
    cdApproval: { path: join(dir, 'approvals', 'cd.json') },
    enforceRoleModels: false,
    roleModels: {},
  }
}

test('apply()：userQuestions 未 inject 时经 ctx.get 拿到，office_plan_approve 能落凭据', async () => {
  const dir = workspaceWithAcceptance('W1')
  const approvalPath = join(dir, 'approvals', 'plan.json')
  const calls = []
  const userQuestions = {
    ask: async request => {
      calls.push(request)
      return { answers: [{ id: 'plan-approve', selected: [APPROVE] }] }
    },
  }
  const registered = new Map()
  const ctx = makeCtx({ userQuestions, registered })
  try {
    apply(ctx, baseConfig(dir, approvalPath))
    const tool = registered.get('office_plan_approve')
    assert.ok(tool, 'office_plan_approve 应已注册')

    const agent = { id: 'root-agent' }
    const result = await tool.execute({
      workspace: dir,
      cardIds: ['W1'],
      summary: SUMMARY,
    }, { agent })

    assert.equal(result.approved, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].questions[0].intent.kind, 'plan-review')
    assert.equal(calls[0].agent, agent)
    assert.equal(readPlanApproval({ path: approvalPath }).approved, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply()：真拿不到 userQuestions 时 fail-closed，不写凭据', async () => {
  const dir = workspaceWithAcceptance('W2')
  const approvalPath = join(dir, 'approvals', 'plan.json')
  const registered = new Map()
  const ctx = makeCtx({ userQuestions: undefined, registered })
  try {
    apply(ctx, baseConfig(dir, approvalPath))
    const tool = registered.get('office_plan_approve')
    await assert.rejects(
      tool.execute({ workspace: dir, cardIds: ['W2'], summary: SUMMARY }, {}),
      /这不是 profile 没挂 seam[\s\S]*approve-phase\.mjs/,
    )
    assert.equal(readPlanApproval({ path: approvalPath }).approved, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})