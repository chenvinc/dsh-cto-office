/**
 * CD 阶段状态机与持久化（设计稿 §4.1 / D4）。
 *
 * 与卡状态机**完全分离**：cd.json 存在 <workspace>/.cto-office/cd/<runId>/ 下，
 * 不进 CardStore.list() / finalize() / Supervisor，因此 CD 永远不会被当成卡读。
 *
 * 持久化复用 lib/atomic.js：
 *   - 游标 cd.json 用 replaceJson（必须原地更新）；
 *   - 证据用 writeOnceJson（只新建、永不覆盖 —— 崩溃最坏是「文件不存在」，可安全重跑）。
 *
 * 证据来源沿用 lib/evidence.js 的四类；cto-narrative 可记但**不参与判定**
 * （isAuthoritative 会把它标成 false）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readJsonStrict, replaceJson, writeOnceJson } from './atomic.js'
import { SOURCES, isAuthoritative } from './evidence.js'

export const CD_SCHEMA = 'cto-office/cd@1'

export const CD_STATES = Object.freeze({
  PR_OPEN: 'PR_OPEN',
  REVIEW: 'REVIEW',
  CHECKS: 'CHECKS',
  MERGED: 'MERGED',
  RELEASED: 'RELEASED',
  VERIFIED: 'VERIFIED',
  BLOCKED: 'BLOCKED',
  ABORTED: 'ABORTED',
})

const TERMINAL = new Set([CD_STATES.VERIFIED, CD_STATES.ABORTED])

/** 审查最多 2 轮；第 3 次尝试直接 deny（设计稿 §4.1 / 章程 §九）。 */
export const MAX_REVIEW_ROUNDS = 2

/**
 * 允许跃迁表（设计稿 §4.1 跃迁图）。
 * `CHECKS → CHECKS` 是 pending 轮询：阶段不变，但会留一条 history。
 * 任意非终态都可以 `BLOCKED`（审批缺失 / 失败 / 达 2 轮）与 `ABORTED`（abort）。
 */
export const CD_TRANSITIONS = Object.freeze({
  [CD_STATES.PR_OPEN]: [CD_STATES.REVIEW, CD_STATES.CHECKS, CD_STATES.BLOCKED, CD_STATES.ABORTED],
  [CD_STATES.REVIEW]: [CD_STATES.REVIEW, CD_STATES.CHECKS, CD_STATES.BLOCKED, CD_STATES.ABORTED],
  [CD_STATES.CHECKS]: [CD_STATES.CHECKS, CD_STATES.MERGED, CD_STATES.BLOCKED, CD_STATES.ABORTED],
  [CD_STATES.MERGED]: [CD_STATES.RELEASED, CD_STATES.BLOCKED, CD_STATES.ABORTED],
  [CD_STATES.RELEASED]: [CD_STATES.VERIFIED, CD_STATES.BLOCKED, CD_STATES.ABORTED],
  [CD_STATES.BLOCKED]: [CD_STATES.REVIEW, CD_STATES.CHECKS, CD_STATES.ABORTED],
  [CD_STATES.VERIFIED]: [],
  [CD_STATES.ABORTED]: [],
})

export class IllegalCdTransitionError extends Error {
  constructor(runId, from, to) {
    super(`illegal CD transition for ${runId}: ${from} → ${to}`)
    this.name = 'IllegalCdTransitionError'
    this.code = 'ILLEGAL_CD_TRANSITION'
  }
}

export class CdRoundLimitError extends Error {
  constructor(runId, attempt, maxRounds = MAX_REVIEW_ROUNDS) {
    super(`CD review round limit reached for ${runId}: 第 ${attempt} 次审查被拒（最多 ${maxRounds} 轮，第 ${maxRounds + 1} 次不再派回，转人决策）。`)
    this.name = 'CdRoundLimitError'
    this.code = 'CD_ROUND_LIMIT'
  }
}

export function isCdTerminal(state) {
  return TERMINAL.has(state)
}

export function canCdTransition(from, to) {
  const allowed = CD_TRANSITIONS[from]
  return Array.isArray(allowed) ? allowed.includes(to) : false
}

/** `office_cd` 的 action 列表（设计稿 §4.2）。 */
export const CD_ACTIONS = Object.freeze([
  'status', 'begin', 'review', 'checks', 'merge', 'release', 'verify', 'abort', 'commands',
])

/**
 * action → 允许的当前状态（pre-execute R7 的唯一判据）。
 * `null` 表示「还没有 CD record」，`any` 表示任何状态，`any-non-terminal` 表示任意非终态。
 */
const ACTION_FROM = Object.freeze({
  begin: [null],
  review: [CD_STATES.PR_OPEN, CD_STATES.REVIEW, CD_STATES.BLOCKED],
  checks: [CD_STATES.CHECKS],
  merge: [CD_STATES.CHECKS],
  release: [CD_STATES.MERGED],
  verify: [CD_STATES.RELEASED],
  abort: 'any-non-terminal',
  status: 'any',
  commands: 'any',
})

export function cdActionAllowed(action, state) {
  const from = ACTION_FROM[action]
  if (from === 'any') return true
  if (from === 'any-non-terminal') return !isCdTerminal(state)
  if (!Array.isArray(from)) return false
  return from.some(allowed => (allowed === null ? state == null : allowed === state))
}

/** 面板机器可读协议（章程 §九）：一行 `CD: <state> run=<runId> round=<n>`。 */
export function cdLine(record) {
  return `CD: ${record.state} run=${record.runId} round=${record.round ?? 0}`
}

/**
 * 解析 `CD:` 行（client.js 的面板解析与此同一协议；改这里要同步改面板正则）。
 * 倒序取最后一条，便于一段文本里既有历史又有最新状态。
 */
export function parseCdLine(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^CD:\s+([A-Z_]+)\s+run=(\S+)\s+round=(\d+)/.exec(lines[i])
    if (m) return { state: m[1], runId: m[2], round: Number(m[3]) }
  }
  return null
}

/**
 * 建 CD record（未落盘）。headSha 必须是完整 40/64 位十六进制，
 * 与 forge-github 的 merge 前置条件同口径（新提交到达会被 GitHub 拒绝，报 stale）。
 */
export function makeCdRecord({ runId, prNumber, headSha, now = Date.now() }) {
  if (!runId) throw new Error('runId required')
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error('prNumber must be a positive integer')
  if (typeof headSha !== 'string' || !/^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$/.test(headSha)) {
    throw new Error('headSha must be a full 40- or 64-digit hex sha')
  }
  return {
    schema: CD_SCHEMA,
    runId,
    state: CD_STATES.PR_OPEN,
    round: 0,
    prNumber,
    headSha,
    checksState: 'pending',
    planApproval: false,
    autoApproveIrreversible: false,
    evidence: [],
    history: [{ at: now, event: 'begin', from: null, to: CD_STATES.PR_OPEN }],
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 纯函数跃迁：不修改入参，返回新 record。
 * 非法跃迁抛 IllegalCdTransitionError（终态无出边也会命中）。
 */
export function transitionCd(record, to, { event = 'transition', note, now = Date.now(), ...rest } = {}) {
  if (!record || record.schema !== CD_SCHEMA) throw new Error('invalid CD record')
  if (!canCdTransition(record.state, to)) throw new IllegalCdTransitionError(record.runId, record.state, to)
  const entry = { at: now, event, from: record.state, to, ...(note ? { note } : {}), ...rest }
  return {
    ...record,
    state: to,
    history: [...(record.history ?? []), entry],
    updatedAt: now,
  }
}

/**
 * review 回执 → 下一阶段（纯函数，不落盘）。
 *
 * 口径与章程 §二.5 一致：最多 2 轮；第 2 轮仍未过 → BLOCKED 转人；第 3 次尝试 → deny。
 * round 记的是「已受理的审查轮次」，PASS 也算一轮。
 */
export function reviewVerdictToState(record, verdict, maxRounds = MAX_REVIEW_ROUNDS) {
  if (verdict !== 'PASS' && verdict !== 'CHANGES') throw new Error(`unknown review verdict: ${verdict}`)
  if (isCdTerminal(record.state)) throw new IllegalCdTransitionError(record.runId, record.state, CD_STATES.REVIEW)
  const allowedFrom = [CD_STATES.PR_OPEN, CD_STATES.REVIEW, CD_STATES.BLOCKED]
  if (!allowedFrom.includes(record.state)) {
    throw new Error(`review 只在 PR_OPEN / REVIEW / BLOCKED 阶段受理，当前 ${record.state}`)
  }
  const round = (record.round ?? 0) + 1
  // 第 1..maxRounds 轮受理；第 maxRounds+1 次尝试直接 deny，不再派回。
  if (round > maxRounds) throw new CdRoundLimitError(record.runId, round, maxRounds)
  if (verdict === 'PASS') return { to: CD_STATES.CHECKS, round, reason: 'review-pass' }
  if (round >= maxRounds) {
    return { to: CD_STATES.BLOCKED, round, reason: 'review-round-limit', escalate: true }
  }
  return { to: CD_STATES.REVIEW, round, reason: 'review-changes' }
}

/**
 * checks 三态 → 下一阶段（纯函数）。
 *
 * 设计稿 §4.2 表里 `checks(success) → MERGED` 与 `merge → MERGED` 重复，
 * 会让「合并前的人工确认」无处落脚。实施时修正为：
 *   - `success` 只把 `checksState` 记成 success、`mergeReady=true`，**仍停在 CHECKS**；
 *   - 真正的 `CHECKS → MERGED` 由 `merge` action 承担（R9 审批就在这一步）。
 * `failure` → BLOCKED；`pending` → 保持 CHECKS（轮询）。
 */
export function checksStateToState(record, checksState) {
  if (!['pending', 'success', 'failure'].includes(checksState)) {
    throw new Error(`unknown checksState: ${checksState}`)
  }
  if (record.state !== CD_STATES.CHECKS) {
    throw new Error(`checks 只在 CHECKS 阶段受理，当前 ${record.state}`)
  }
  if (checksState === 'failure') {
    return { to: CD_STATES.BLOCKED, checksState, reason: 'checks-failure', escalate: true }
  }
  return {
    to: CD_STATES.CHECKS,
    checksState,
    reason: checksState === 'success' ? 'checks-success' : 'checks-pending',
    mergeReady: checksState === 'success',
  }
}

/** 证据字段校验：来源必须是四类之一，state 必须是合法 CD 状态。 */
export function assertCdEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('CD evidence must be an object')
  }
  if (!Object.values(SOURCES).includes(evidence.source)) {
    throw new Error(`unknown CD evidence source: ${evidence.source}`)
  }
  if (!evidence.state || !Object.values(CD_STATES).includes(evidence.state)) {
    throw new Error(`CD evidence.state must be a CD state, got ${evidence.state}`)
  }
  if (!Number.isFinite(evidence.at)) throw new Error('CD evidence.at must be a timestamp')
  return {
    at: evidence.at,
    source: evidence.source,
    kind: evidence.kind ?? 'cd-action',
    state: evidence.state,
    payload: evidence.payload ?? null,
  }
}

/**
 * CD record 仓库。与 CardStore 同构但目录独立：
 * <workspace>/.cto-office/cd/<runId>/{cd.json, evidence/<id>.json}
 */
export class CdStore {
  constructor(root) {
    this.root = root
    this.dir = join(root, '.cto-office', 'cd')
  }

  runDir(runId) {
    return join(this.dir, runId)
  }

  cdPath(runId) {
    return join(this.runDir(runId), 'cd.json')
  }

  evidenceDir(runId) {
    return join(this.runDir(runId), 'evidence')
  }

  /** 读 cd.json；损坏抛 CorruptError，缺失返回 undefined。 */
  read(runId) {
    return readJsonStrict(this.cdPath(runId))
  }

  /** 覆盖替换游标（原地更新），并推进 updatedAt。 */
  save(record) {
    record.updatedAt = Date.now()
    replaceJson(this.cdPath(record.runId), record)
    return record
  }

  /** 列出全部 CD record（坏文件单独归 corrupt，不炸列表）。 */
  list() {
    if (!existsSync(this.dir)) return { records: [], corrupt: [] }
    const records = []
    const corrupt = []
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const record = this.read(entry.name)
        if (record) {
          if (record.schema !== CD_SCHEMA) corrupt.push({ runId: entry.name, reason: `schema ${record.schema}` })
          else records.push(record)
        }
      } catch (error) {
        corrupt.push({ runId: entry.name, reason: String(error && error.message ? error.message : error) })
      }
    }
    return { records, corrupt }
  }

  /** 写一条证据：只新建、永不覆盖。重复 id 会抛 EEXIST，调用方据此判幂等命中。 */
  recordEvidence(runId, evidence) {
    const checked = assertCdEvidence(evidence)
    const id = evidence.id ?? `${Date.now()}-${randomBytes(4).toString('hex')}`
    const path = join(this.evidenceDir(runId), `${id}.json`)
    writeOnceJson(path, { ...checked, id, runId })
    return { id, path, authoritative: isAuthoritative(checked.source) }
  }

  /** 读全部证据（只读，不修改文件）；每条附上 authoritative 标记。 */
  readEvidence(runId) {
    const dir = this.evidenceDir(runId)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        const doc = readJsonStrict(join(dir, name))
        return { ...doc, authoritative: isAuthoritative(doc.source) }
      })
  }

  /** 参与判定的证据（cto-narrative 在此被排除）。 */
  authoritativeEvidence(runId) {
    return this.readEvidence(runId).filter(item => item.authoritative)
  }
}
