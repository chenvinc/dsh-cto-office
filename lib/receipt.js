/**
 * 回执协议解析与校验（方案 §14.1 / §4.3 2c）。
 *
 * 回执是**判定的输入**：缺字段就打回（fail-closed）。这与「判定器自身不 fail-closed」不矛盾。
 *
 * 约定格式（见 skills/cto-builder 与 §4.3）：
 *
 *   RECEIPT:
 *   - card: C1
 *   - artifactsVersion: contracts=3, acceptance=2
 *   - changed: api/import.ts, app/import/page.tsx
 *   - acceptance:
 *     - A1 PASS
 *     - A2 PASS 证据：pnpm test → 12 passed
 *     - A3 FAIL 原因：大文件未测
 *   - selfRisk: ...
 *   SELF-CHECK:
 *   - build: pnpm build → 0
 *   - tests: pnpm test → 12 passed
 *   - scope: api/import.ts
 *   - gaps: 大文件未压测
 */
import { isAuthorized } from './glob.js'

const REQUIRED_RECEIPT = ['card', 'artifactsVersion', 'changed', 'acceptance']
const REQUIRED_SELF_CHECK = ['build', 'tests', 'scope', 'gaps']

/** 取出某个块（`NAME:` 到下一个顶层 `NAME:` 或文本结束）的正文。 */
function block(text, name) {
  const re = new RegExp(`^${name}:\\s*$`, 'm')
  const m = re.exec(text)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = text.slice(start)
  const nextBlock = /^[A-Z][A-Z-]*:\s*$/m.exec(rest)
  return nextBlock ? rest.slice(0, nextBlock.index) : rest
}

/** 解析 `- key: value` 与 `- key: <换行缩进子项>` 形式。 */
function fields(body) {
  const out = {}
  const lines = body.split('\n')
  let current = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const sub = /^\s+-\s+(.+)$/.exec(line)
    if (sub && current) {
      out[current].push(sub[1].trim())
      continue
    }
    const top = /^-\s+([a-zA-Z][\w-]*):\s*(.*)$/.exec(line)
    if (top) {
      current = top[1]
      out[current] = []
      if (top[2].trim()) out[current].push(top[2].trim())
      else out[current] = []
      continue
    }
    current = null
  }
  return out
}

/** 解析 `A1 PASS` / `A2 PASS 证据：…` / `A3 FAIL 原因：…`。 */
export function parseAcceptanceLines(lines = []) {
  return lines.map(line => {
    const m = /^([A-Za-z]+\d+)\s+(PASS|FAIL|BLOCKED)\b\s*(.*)$/.exec(line.trim())
    if (!m) return { id: line.trim(), outcome: null, note: '' }
    return { id: m[1], outcome: m[2], note: m[3] }
  })
}

/** 解析 `contracts=3, acceptance=2`。 */
export function parseArtifactsVersion(text) {
  const out = {}
  for (const part of String(text ?? '').split(',')) {
    const m = /([a-zA-Z]+)\s*=\s*(\d+)/.exec(part)
    if (m) out[m[1]] = Number(m[2])
  }
  return out
}

/** 从一段文本里抽出回执；没有 RECEIPT 块则返回 null。 */
export function parseReceipt(text) {
  if (typeof text !== 'string' || !/^RECEIPT:\s*$/m.test(text)) return null
  const rBody = block(text, 'RECEIPT')
  const sBody = block(text, 'SELF-CHECK')
  const r = fields(rBody ?? '')
  const s = sBody ? fields(sBody) : {}
  return {
    receipt: r,
    selfCheck: s,
    acceptance: parseAcceptanceLines(r.acceptance ?? []),
    artifactsVersion: parseArtifactsVersion((r.artifactsVersion ?? [])[0]),
    changed: (r.changed ?? []).flatMap(v => v.split(',').map(s => s.trim()).filter(Boolean)),
    scope: (s.scope ?? []).flatMap(v => v.split(',').map(s => s.trim()).filter(Boolean)),
  }
}

/**
 * 校验回执。纯函数，便于单测与复跑。
 *
 * @param text 子代理交回的文本
 * @param card 卡（含 authorization、artifactsVersion、acceptance）
 * @returns { ok, missing, problems, parsed }
 */
export function validateReceipt(text, card) {
  const missing = []
  const problems = []
  const parsed = parseReceipt(text)

  if (!parsed) {
    return { ok: false, missing: ['RECEIPT'], problems: ['回执里找不到 RECEIPT 块'], parsed: null }
  }

  for (const key of REQUIRED_RECEIPT) {
    if (!(key in parsed.receipt)) missing.push(`RECEIPT.${key}`)
  }
  for (const key of REQUIRED_SELF_CHECK) {
    if (!(key in parsed.selfCheck)) missing.push(`SELF-CHECK.${key}`)
  }

  if (parsed.receipt.card && parsed.receipt.card[0] !== card.cardId) {
    problems.push(`receipt.card=${parsed.receipt.card[0]}，与卡 ${card.cardId} 不一致`)
  }

  const expected = card.artifactsVersion ?? {}
  for (const [kind, version] of Object.entries(expected)) {
    const got = parsed.artifactsVersion[kind]
    if (got === undefined) problems.push(`回执未写 artifactsVersion.${kind}（应为 ${version}）`)
    else if (got !== version) problems.push(`回执读的是 ${kind}=${got}，卡已定稿 ${kind}=${version}（返工责任无法归因）`)
  }

  const auth = card.authorization
  for (const path of [...parsed.changed, ...parsed.scope]) {
    if (!isAuthorized(auth, path)) problems.push(`回执声明的改动 ${path} 不在授权清单内`)
  }

  const expectedIds = new Set((card.acceptance ?? []).map((line, i) => {
    const m = /^([A-Za-z]+\d+)/.exec(String(line).trim())
    return m ? m[1] : `A${i + 1}`
  }))
  for (const id of expectedIds) {
    const hit = parsed.acceptance.find(a => a.id === id)
    if (!hit) problems.push(`acceptance 缺少 ${id} 的判定`)
    else if (hit.outcome === null) problems.push(`acceptance ${id} 没有 PASS/FAIL/BLOCKED 结论`)
  }

  return { ok: missing.length === 0 && problems.length === 0, missing, problems, parsed }
}

/** 从派工 prompt 里取卡号（章程模板是 `【任务卡 C1】…`）。 */
export function cardIdFromPrompt(prompt) {
  if (typeof prompt !== 'string') return null
  const m = /【\s*任务卡\s*([A-Za-z0-9_-]+)\s*】/.exec(prompt)
  return m ? m[1] : null
}
