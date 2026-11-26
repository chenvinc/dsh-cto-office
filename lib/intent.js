/**
 * 判定事务（方案 §14.2）+ 证据读侧严格化（§14.3）。
 *
 * ── 为什么幂等键是 `intentId`，不是内容三元组 ─────────────────────────
 * 上一版想用 `(cardId, baseSha, artifactsVersion)` 当幂等键。错的：
 * 「判定 → CHANGES → 改码 → 再判」这三者**全都不变**，于是重跑会被判成同一次，
 * 卡被永久钉在 CHANGES。幂等键必须是「一次判定动作」本身，即每次新建的 UUID。
 *
 * ── 三条不变量 ───────────────────────────────────────────────────────
 * 1. **intent 先于判定落盘**：崩溃点只可能是「intent 有、result 无」，
 *    而这是安全状态 —— 复用同一 `intentId` 重跑，天然幂等。
 * 2. **结果只新建、永不覆盖**：重跑不会毁掉一份已有结论；最坏是「新文件不存在」。
 * 3. **latest-wins**：只有 `intentSeq == max` 的孤儿 intent 才重跑；
 *    更旧的孤儿一律标 `abandoned` 且**不重跑** —— 否则会用旧证据产出陈旧结论覆盖新结论。
 *
 * 内容三元组退一步只做**证据有效性断言**：判定时若 `baseSha` / `artifactsVersion`
 * 与 intent 登记的不一致，该 intent 作废（标 abandoned）并开新 intent，不复用。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readJsonStrict, replaceJson, writeOnceJson, CorruptError } from './atomic.js'

export const INTENT_SCHEMA = 'cto-office/intent@1'

export const INTENT_STATE = Object.freeze({
  /** 已登记、结果未落盘。崩溃后要复用这一条重跑。 */
  PENDING: 'pending',
  /** 结果已落盘、卡上记账也已完成。此后再判 = 新 intent。 */
  RESULT_WRITTEN: 'result-written',
  /** 陈旧孤儿（不是最新 seq）或上下文已变 —— 作废，绝不重跑。 */
  ABANDONED: 'abandoned',
})

const FILE_RE = /^(\d{6})-([0-9a-fA-F-]{36})\.json$/

function fileName(intentSeq, intentId) {
  return `${String(intentSeq).padStart(6, '0')}-${intentId}.json`
}

/**
 * 读 intents 目录。坏文件**不跳过** —— 收集进 corrupt 由调用方 fail-closed。
 * 跳过坏 intent 的后果是「以为没有在飞事务」，比报错危险。
 */
export function listIntents(intentsDir) {
  if (!existsSync(intentsDir)) return { intents: [], corrupt: [] }
  const intents = []
  const corrupt = []
  for (const name of readdirSync(intentsDir)) {
    if (!name.endsWith('.json')) continue
    const parsed = FILE_RE.exec(name)
    if (!parsed) {
      corrupt.push({ file: name, reason: 'unrecognized intent filename' })
      continue
    }
    try {
      const intent = readJsonStrict(join(intentsDir, name))
      if (!intent) continue
      if (intent.schema !== INTENT_SCHEMA) {
        corrupt.push({ file: name, reason: `schema ${intent.schema}` })
        continue
      }
      intent.intentSeq = Number(parsed[1])
      intent.intentId = intent.intentId ?? parsed[2]
      intents.push(intent)
    } catch (error) {
      corrupt.push({ file: name, reason: error instanceof CorruptError ? error.message : String(error) })
    }
  }
  intents.sort((a, b) => a.intentSeq - b.intentSeq)
  for (let i = 1; i < intents.length; i++) {
    if (intents[i].intentSeq === intents[i - 1].intentSeq) {
      corrupt.push({ file: fileName(intents[i].intentSeq, intents[i].intentId), reason: `duplicate intentSeq ${intents[i].intentSeq}` })
    }
  }
  return { intents, corrupt }
}

/**
 * 启动扫描。返回：
 *  - `resumable`：最新 seq 的未完成 intent（结果可能有、也可能没有），调用方复用
 *  - `abandoned`：本轮被判作废的陈旧孤儿
 *  - `corrupt`：坏 intent（调用方必须 fail-closed）
 *
 * 注意 `resumable` 不区分「result 已写但卡上记账没做完」—— 那种情况也要把它跑完，
 * 否则卡上的 `rounds` / 状态会永远停在崩溃前。
 */
export function recoverIntents({ intentsDir, resultPathFor, now = Date.now() }) {
  const { intents, corrupt } = listIntents(intentsDir)
  const abandoned = []
  let resumable = null

  const maxSeq = intents.length > 0 ? intents[intents.length - 1].intentSeq : 0
  for (const intent of intents) {
    const hasResult = existsSync(resultPathFor(intent.intentId))

    // 已经完整收尾：只补记账（result 落了、卡上可能没写完）
    if (intent.state === INTENT_STATE.RESULT_WRITTEN) {
      if (!hasResult) corrupt.push({ file: fileName(intent.intentSeq, intent.intentId), reason: 'result-written but result file missing' })
      continue
    }
    if (intent.state === INTENT_STATE.ABANDONED) continue

    // state 仍是 pending / 或字段缺失（上一版写的 intent）
    if (intent.intentSeq !== maxSeq) {
      markIntentState(intentsDir, intent, INTENT_STATE.ABANDONED, { reason: 'stale-intent', note: '不是最新 seq，按 latest-wins 不重跑' }, now)
      abandoned.push({ intentId: intent.intentId, intentSeq: intent.intentSeq, reason: 'stale-intent' })
      continue
    }
    resumable = intent
  }
  return { resumable, abandoned, corrupt }
}

/** 登记一条 intent（只新建）。seq 由现有最大 seq + 1 推出，不依赖 card.json 里的计数器 —— 目录才是权威。 */
export function beginIntent(intentsDir, meta, now = Date.now()) {
  const { intents } = listIntents(intentsDir)
  const intentSeq = intents.length > 0 ? intents[intents.length - 1].intentSeq + 1 : 1
  const intentId = randomUUID()
  const intent = {
    schema: INTENT_SCHEMA,
    intentId,
    intentSeq,
    cardId: meta.cardId,
    action: meta.action ?? 'judge',
    baseSha: meta.baseSha,
    artifactsVersion: meta.artifactsVersion ?? {},
    state: INTENT_STATE.PENDING,
    createdAt: now,
  }
  writeOnceJson(join(intentsDir, fileName(intentSeq, intentId)), intent)
  return intent
}

/** intent 状态只在原地推进（单文档兜底路径）。 */
export function markIntentState(intentsDir, intent, state, detail = {}, now = Date.now()) {
  const next = { ...intent, state, updatedAt: now, ...detail }
  delete next.intentSeq
  replaceJson(join(intentsDir, fileName(intent.intentSeq, intent.intentId)), next)
  return { ...next, intentSeq: intent.intentSeq }
}

/**
 * 写结果。目标名保证此前不存在，所以「重跑」永远不会覆盖已有结论；
 * EEXIST 视为幂等命中，读回既有结果。
 */
export function writeResult(resultPath, payload, now = Date.now()) {
  try {
    writeOnceJson(resultPath, { ...payload, writtenAt: now })
    return { created: true }
  } catch (error) {
    if (error && error.code === 'EEXIST') return { created: false }
    throw error
  }
}
