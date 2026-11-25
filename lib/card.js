/**
 * 卡模型与判定（方案 §4.2a / §4.4 / §14.4）。
 *
 * 状态机：QUEUED → DISPATCHED → CHANGES → … → SETTLED / ABANDONED
 * 终止态（SETTLED / ABANDONED）必须释放 exclusive 持有并把阻塞它的卡重新评估。
 */
import { isAuthorized, matchAny } from './glob.js'

export const CARD_SCHEMA = 'cto-office/card@1'

/** 卡状态。clarify / open-card 是会话级阶段，不落在卡上。 */
export const STATES = Object.freeze({
  QUEUED: 'QUEUED',
  DISPATCHED: 'DISPATCHED',
  CHANGES: 'CHANGES',
  SETTLED: 'SETTLED',
  ABANDONED: 'ABANDONED',
})

const TERMINAL = new Set([STATES.SETTLED, STATES.ABANDONED])

/** 阻塞原因只有两种（方案 §14.4）。 */
export const BLOCK_REASONS = Object.freeze({
  SERIAL_LIMIT: 'serial-limit',
  EXCLUSIVE_HELD: 'exclusive-held',
})

const TRANSITIONS = {
  [STATES.QUEUED]: [STATES.DISPATCHED, STATES.ABANDONED],
  [STATES.DISPATCHED]: [STATES.CHANGES, STATES.SETTLED, STATES.ABANDONED],
  [STATES.CHANGES]: [STATES.DISPATCHED, STATES.SETTLED, STATES.ABANDONED],
  [STATES.SETTLED]: [],
  [STATES.ABANDONED]: [],
}

export function isTerminal(state) {
  return TERMINAL.has(state)
}

export function canTransition(from, to) {
  const allowed = TRANSITIONS[from]
  return Array.isArray(allowed) ? allowed.includes(to) : false
}

export class IllegalTransitionError extends Error {
  constructor(cardId, from, to) {
    super(`illegal transition for ${cardId}: ${from} → ${to}`)
    this.name = 'IllegalTransitionError'
    this.code = 'ILLEGAL_TRANSITION'
  }
}

/** 建卡（未落盘）。baseSha 由调用方传入，冻结在卡里。 */
export function makeCard({ cardId, subject, preset, authorization, baseSha = null, acceptance = [], declared = {}, now = Date.now() }) {
  if (!cardId) throw new Error('cardId required')
  if (!authorization || !authorization.mode) throw new Error('authorization.mode required')
  return {
    schema: CARD_SCHEMA,
    cardId,
    subject: subject ?? '',
    preset: preset ?? null,
    authorization: {
      mode: authorization.mode,
      include: authorization.include ?? [],
      deny: authorization.deny ?? [],
      exclusive: authorization.exclusive ?? [],
    },
    baseSha,
    acceptance,
    declared: {
      files: declared.files ?? null,
      lines: declared.lines ?? null,
      behaviors: declared.behaviors ?? declared.behaviorCount ?? null,
    },
    state: STATES.QUEUED,
    blockedBy: null,
    rounds: 0,
    createdAt: now,
    updatedAt: now,
    // baseSha 冻结时机 = 卡真正拿到写者名额的那一刻，不是建卡那一刻。
    // 否则卡在队列里等的时候 main 前进了，baseSha..HEAD 会把别人的改动算进本卡（批注 A3）。
    history: [{ at: now, event: 'created', baseSha }],
  }
}

/** 卡粒度上限（方案 §4.4 / 4.3 卡粒度硬上限）。 */
export const GRANULARITY = Object.freeze({ maxFiles: 10, maxLines: 400, maxBehaviors: 1 })

/**
 * 判定：把 diff 与 status 两类事实对授权清单与粒度上限做检查。
 * 纯函数，不碰文件系统 —— 便于单测与复跑。
 *
 * @param card 卡
 * @param facts { changed: [{path, status}], untracked: [path], lines: {added, removed}, acceptanceCount }
 * @param limits 可覆盖的粒度上限
 */
export function judge(card, facts, limits = GRANULARITY) {
  const violations = []
  const auth = card.authorization

  const paths = new Set()
  for (const entry of facts.changed ?? []) paths.add(entry.path)
  for (const path of facts.untracked ?? []) paths.add(path)

  if (auth.mode === 'ro') {
    for (const path of paths) {
      violations.push({ kind: 'read-only-write', path, detail: '只读卡不得改动任何文件' })
    }
  } else {
    for (const path of paths) {
      if (!isAuthorized(auth, path)) {
        violations.push({ kind: 'out-of-scope', path, detail: `不在授权清单内（include=${JSON.stringify(auth.include)}）` })
      }
    }
  }

  const fileCount = paths.size
  if (fileCount > limits.maxFiles) {
    violations.push({ kind: 'granularity-files', count: fileCount, limit: limits.maxFiles, detail: `变更文件 ${fileCount} > ${limits.maxFiles}，请拆卡` })
  }
  const lineCount = (facts.lines?.added ?? 0) + (facts.lines?.removed ?? 0)
  if (lineCount > limits.maxLines) {
    violations.push({ kind: 'granularity-lines', count: lineCount, limit: limits.maxLines, detail: `净变更 ${lineCount} 行 > ${limits.maxLines}，请拆卡` })
  }
  const behaviors = facts.acceptanceCount ?? (card.acceptance ? card.acceptance.length : 0)
  if (behaviors > limits.maxBehaviors) {
    violations.push({ kind: 'granularity-behaviors', count: behaviors, limit: limits.maxBehaviors, detail: `可观测行为变化 ${behaviors} 条 > ${limits.maxBehaviors}，请拆卡` })
  }

  const verdict = violations.length === 0 ? 'PASS' : 'CHANGES'
  return { verdict, violations, stats: { files: fileCount, lines: lineCount, behaviors } }
}

/**
 * 回执与 git 事实的交叉核对（W2 收口）。
 *
 * 为什么必须做：gate 只看 diff、回执校验只看清单，两边各看各的 ——
 * 「回执说改了 A，diff 说改了 A+B」这种情况两处都能过。
 * 交叉核对把「声明」与「事实」对齐，才谈得上「越界必现」。
 *
 * @param card 卡（含 lastReceipt）
 * @param facts { changed:[{path}], untracked:[path] }
 * @returns violations（kind 以 receipt- 开头）
 */
export function crossCheckReceipt(card, facts) {
  const violations = []
  const receipt = card.lastReceipt
  if (!receipt) {
    if (card.authorization?.mode === 'rw') {
      violations.push({ kind: 'receipt-missing', detail: '写卡没有回执记录：先让子代理交 RECEIPT，再判闸门' })
    }
    return violations
  }

  const actual = new Set([
    ...(facts.changed ?? []).map(e => e.path),
    ...(facts.untracked ?? []).map(p => p ?? p),
  ])
  const declared = new Set([...(receipt.changed ?? []), ...(receipt.scope ?? [])])

  for (const path of declared) {
    if (!actual.has(path)) {
      violations.push({ kind: 'receipt-overclaim', path, detail: '回执声称改了这个文件，但 git 里没有它的改动' })
    }
  }
  for (const path of actual) {
    if (!declared.has(path)) {
      violations.push({ kind: 'receipt-underclaim', path, detail: 'git 显示这个文件被改了，但回执没有声明' })
    }
  }
  return violations
}

/** 该卡的 exclusive glob 与另一张卡是否冲突。 */
export function exclusivesConflict(card, other) {
  const a = card.authorization?.exclusive ?? []
  const b = other.authorization?.exclusive ?? []
  for (const globA of a) {
    for (const globB of b) {
      // 两个 glob 冲突：任一方能匹配到对方声明的字面前缀，或完全相同。
      if (globA === globB) return { globA, globB }
      const prefix = s => String(s).replace(/[*?{].*$/, '')
      const pa = prefix(globA)
      const pb = prefix(globB)
      if (pa && (matchAny([globB], pa) || pb.startsWith(pa))) return { globA, globB }
      if (pb && pb.startsWith(pa || '\u0000')) return { globA, globB }
    }
  }
  return null
}
