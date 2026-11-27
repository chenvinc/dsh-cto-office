/**
 * CD 阶段状态机与持久化测试（设计稿 §6 一期验收）。
 *
 * 守五条：
 *  1. 合法跃迁全覆盖、非法跃迁拒绝、终态无出边、transitionCd 是纯函数；
 *  2. review 最多 2 轮，第 2 轮未过转人，第 3 次 deny；
 *  3. checks 三态（pending / success / failure）各自落到正确阶段；
 *  4. CD record 与卡仓库隔离（不会被 CardStore 当卡读）；
 *  5. 证据只新建、永不覆盖；cto-narrative 可记但不参与判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CardStore } from '../lib/store.js'
import { SOURCES } from '../lib/evidence.js'
import {
  CD_SCHEMA, CD_STATES, CD_TRANSITIONS, MAX_REVIEW_ROUNDS,
  CdStore, IllegalCdTransitionError, CdRoundLimitError,
  assertCdEvidence, canCdTransition, checksStateToState, isCdTerminal,
  makeCdRecord, reviewVerdictToState, transitionCd,
} from '../lib/cd.js'

const SHA = 'a'.repeat(40)

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'cto-cd-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const rec = (over = {}) => makeCdRecord({
  runId: 'CD1', prNumber: 123, headSha: SHA, now: 1000, ...over,
})

// ── 初始形状 ────────────────────────────────────────────────────────

test('makeCdRecord：初始形状与必填校验', () => {
  const r = rec()
  assert.equal(r.schema, CD_SCHEMA)
  assert.equal(r.state, CD_STATES.PR_OPEN)
  assert.equal(r.round, 0)
  assert.equal(r.checksState, 'pending')
  assert.equal(r.autoApproveIrreversible, false)
  assert.equal(r.history.length, 1)
  assert.equal(r.history[0].event, 'begin')
  assert.throws(() => makeCdRecord({ runId: '', prNumber: 1, headSha: SHA }), /runId/)
  assert.throws(() => makeCdRecord({ runId: 'CD1', prNumber: 0, headSha: SHA }), /prNumber/)
  assert.throws(() => makeCdRecord({ runId: 'CD1', prNumber: 1, headSha: 'deadbeef' }), /headSha/)
})

// ── 跃迁 ────────────────────────────────────────────────────────────

test('状态机：跃迁表每条合法边都能走，且 transitionCd 是纯函数', () => {
  for (const [from, tos] of Object.entries(CD_TRANSITIONS)) {
    for (const to of tos) {
      assert.ok(canCdTransition(from, to), `${from} → ${to} 应合法`)
      const before = { ...rec(), state: from }
      const after = transitionCd(before, to, { event: 'test', now: 2000, note: 'x' })
      assert.equal(after.state, to)
      assert.equal(before.state, from, '入参不被修改')
      assert.equal(after.history.length, before.history.length + 1)
      const entry = after.history.at(-1)
      assert.equal(entry.from, from)
      assert.equal(entry.to, to)
      assert.equal(entry.note, 'x')
      assert.equal(after.updatedAt, 2000)
    }
  }
})

test('状态机：非法跃迁与终态出边一律拒绝', () => {
  assert.equal(canCdTransition(CD_STATES.PR_OPEN, CD_STATES.MERGED), false)
  assert.equal(canCdTransition(CD_STATES.CHECKS, CD_STATES.VERIFIED), false)
  assert.throws(
    () => transitionCd(rec(), CD_STATES.MERGED),
    err => err instanceof IllegalCdTransitionError && err.code === 'ILLEGAL_CD_TRANSITION',
  )
  for (const terminal of [CD_STATES.VERIFIED, CD_STATES.ABORTED]) {
    assert.equal(isCdTerminal(terminal), true)
    assert.equal(CD_TRANSITIONS[terminal].length, 0)
    assert.throws(
      () => transitionCd({ ...rec(), state: terminal }, CD_STATES.CHECKS),
      /illegal CD transition/,
    )
  }
  assert.equal(isCdTerminal(CD_STATES.PR_OPEN), false)
  assert.equal(isCdTerminal(CD_STATES.BLOCKED), false)
})

// ── 审查轮次 ────────────────────────────────────────────────────────

test('review：最多 2 轮，第 2 轮未过转人，第 3 次 deny', () => {
  assert.equal(MAX_REVIEW_ROUNDS, 2)
  let r = rec()

  const first = reviewVerdictToState(r, 'CHANGES')
  assert.equal(first.to, CD_STATES.REVIEW)
  assert.equal(first.round, 1)
  r = { ...transitionCd(r, first.to, { event: 'review', round: first.round }), round: first.round }

  const second = reviewVerdictToState(r, 'CHANGES')
  assert.equal(second.to, CD_STATES.BLOCKED)
  assert.equal(second.round, 2)
  assert.equal(second.escalate, true)
  r = { ...transitionCd(r, second.to, { event: 'review', round: second.round }), round: second.round }
  r = transitionCd(r, CD_STATES.REVIEW, { event: 'human-unblock' })

  assert.throws(
    () => reviewVerdictToState(r, 'CHANGES'),
    err => err instanceof CdRoundLimitError && err.code === 'CD_ROUND_LIMIT',
  )
})

test('review：PASS 直接进 CHECKS；非法 verdict / 错阶段 / 终态都拒绝', () => {
  const r = rec()
  assert.equal(reviewVerdictToState(r, 'PASS').to, CD_STATES.CHECKS)
  assert.equal(reviewVerdictToState(r, 'PASS').round, 1)
  assert.throws(() => reviewVerdictToState(r, 'MAYBE'), /unknown review verdict/)
  assert.throws(() => reviewVerdictToState({ ...r, state: CD_STATES.MERGED }, 'PASS'), /只在 PR_OPEN/)
  assert.throws(
    () => reviewVerdictToState({ ...r, state: CD_STATES.VERIFIED }, 'PASS'),
    err => err instanceof IllegalCdTransitionError,
  )
})

// ── checks 三态 ──────────────────────────────────────────────────────

test('checks：pending / success 都停在 CHECKS（success 只标记 mergeReady），failure 进 BLOCKED', () => {
  const atChecks = { ...rec(), state: CD_STATES.CHECKS }
  const pending = checksStateToState(atChecks, 'pending')
  assert.equal(pending.to, CD_STATES.CHECKS)
  assert.equal(pending.mergeReady, false)
  const success = checksStateToState(atChecks, 'success')
  assert.equal(success.to, CD_STATES.CHECKS, 'CHECKS → MERGED 留给 merge action，R9 审批才落得住')
  assert.equal(success.mergeReady, true)
  assert.equal(success.checksState, 'success')
  const failed = checksStateToState(atChecks, 'failure')
  assert.equal(failed.to, CD_STATES.BLOCKED)
  assert.equal(failed.escalate, true)
  assert.throws(() => checksStateToState(atChecks, 'unknown'), /unknown checksState/)
  assert.throws(() => checksStateToState(rec(), 'success'), /只在 CHECKS/)
})

// ── 与卡仓库隔离 ────────────────────────────────────────────────────

test('CD record 与卡仓库隔离：CardStore.list() 读不到 CD', () => {
  const { dir, cleanup } = tmp()
  try {
    const cd = new CdStore(dir)
    cd.save(rec())
    assert.ok(existsSync(cd.cdPath('CD1')))
    assert.equal(cd.read('CD1').runId, 'CD1')
    assert.equal(cd.list().records.length, 1)

    const cards = new CardStore(dir).list()
    assert.equal(cards.cards.length, 0, 'CD record 不许被当成卡')
    assert.equal(cards.corrupt.length, 0)
  } finally { cleanup() }
})

// ── 证据 ────────────────────────────────────────────────────────────

test('证据：只新建、永不覆盖；非权威来源可记但不参与判定', () => {
  const { dir, cleanup } = tmp()
  try {
    const cd = new CdStore(dir)
    const base = { id: 'e1', at: 1000, source: SOURCES.GIT, state: CD_STATES.PR_OPEN, kind: 'pr-create', payload: { pr: 123 } }
    const written = cd.recordEvidence('CD1', base)
    assert.equal(written.id, 'e1')
    assert.equal(written.authoritative, true)
    assert.ok(existsSync(written.path))

    const raw = readFileSync(written.path, 'utf8')
    assert.throws(() => cd.recordEvidence('CD1', { ...base, payload: { pr: 999 } }), /EEXIST/)
    assert.equal(readFileSync(written.path, 'utf8'), raw, '第一次写入的内容不许被覆盖')

    cd.recordEvidence('CD1', { id: 'e2', at: 1001, source: SOURCES.CTO, state: CD_STATES.REVIEW, kind: 'human-note' })
    assert.equal(cd.readEvidence('CD1').length, 2)
    assert.equal(cd.authoritativeEvidence('CD1').length, 1, 'cto-narrative 不参与判定')
    assert.equal(cd.authoritativeEvidence('CD1')[0].source, SOURCES.GIT)

    assert.throws(() => cd.recordEvidence('CD1', { id: 'e3', at: 1, source: 'unknown', state: CD_STATES.PR_OPEN }), /unknown CD evidence source/)
    assert.throws(() => assertCdEvidence({ at: 1, source: SOURCES.HOST_EVENT, state: 'NOPE' }), /must be a CD state/)
    assert.throws(() => assertCdEvidence({ source: SOURCES.HOST_EVENT, state: CD_STATES.PR_OPEN }), /timestamp/)
  } finally { cleanup() }
})

test('证据：无 evidence 目录时返回空数组；坏 schema 的 cd.json 进 corrupt 不炸列表', () => {
  const { dir, cleanup } = tmp()
  try {
    const cd = new CdStore(dir)
    assert.deepEqual(cd.readEvidence('CD1'), [])
    assert.deepEqual(cd.authoritativeEvidence('CD1'), [])
    cd.save({ ...rec(), schema: 'wrong' })
    const listed = cd.list()
    assert.equal(listed.records.length, 0)
    assert.equal(listed.corrupt.length, 1)
  } finally { cleanup() }
})
