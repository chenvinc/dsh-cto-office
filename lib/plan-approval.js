/**
 * 拍板审批（plan approval）—— 把「用户拍板」变成可机检的凭据。
 *
 * ── 为什么需要这一层（2026-11-28 P0 issue）──────────────────────────
 * 二期加 R6 时，设计是「人在地工作区外生成审批文件」（能力层剥夺，agent 写不到）。
 * 但真实流程里用户是在 GUI 聊天里拍板的，没人会去终端敲 `approve-phase.mjs`，
 * 于是出现「用户批准了自己的动作、却被告知 the user rejected tool」。
 *
 * 三期修复把人工确认搬进 `office_plan_approve` 工具：工具内部通过
 * `ctx.userQuestions.ask()`（intent=plan-review）弹一次真实的人工确认，
 * 用户点「批准」后由 **Host 侧**写审批文件。agent 仍然不能自己造文件，
 * 但它现在有一条合规、可自助的路径拿到授权。
 *
 * ── 凭据形状 ────────────────────────────────────────────────────────
 * 复用 patch-approval.js 的 schema（向后兼容旧文件），额外带 `scope`：
 *   { cardIds: ['SC-4a', 'SC-4b'], contractsVersion: {...}, acceptanceVersion: {...} }
 * `scope` 缺失 = 旧的「人工在终端直接 mint」的粗粒度授权（通配，兼容旧流程）。
 */
import { existsSync } from 'node:fs'
import { approvalPathFor, mintApproval, readApproval } from './patch-approval.js'

export const PLAN_APPROVAL_KIND = 'plan'

/** 审批默认有效期：与 scripts/approve-phase.mjs 的 30 分钟一致。 */
export const DEFAULT_PLAN_TTL_MS = 30 * 60 * 1000

/** 审批文件路径（默认 ~/.dsh/cto-office-plan-approval.json，可用环境变量覆盖）。 */
export function planApprovalPath(env = process.env) {
  return approvalPathFor(PLAN_APPROVAL_KIND, env)
}

/**
 * 读拍板审批。缺失 / 损坏 / 过期一律按未批准处理（fail-closed），
 * 并把 reason 原样带出去 —— R6 要靠它给出可诊断的拒绝原因。
 *
 * @returns {{approved: boolean, reason: string, expiresAt?: number, grantedAt?: number,
 *   by?: string, note?: string, scope: object|null}}
 */
export function readPlanApproval({ path = planApprovalPath(), now = Date.now() } = {}) {
  const approval = readApproval({ path, now })
  return {
    ...approval,
    note: approval.reason_text ?? '',
    scope: approval.scope ?? null,
  }
}

/** 规范化 scope：只保留 cardIds 与两个版本映射，避免把任意字段写进凭据。 */
export function normalizePlanScope({ cardIds, contractsVersion, acceptanceVersion } = {}) {
  const ids = Array.isArray(cardIds)
    ? [...new Set(cardIds.map(id => String(id ?? '').trim()).filter(Boolean))]
    : []
  const versionMap = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const out = {}
    for (const [key, raw] of Object.entries(value)) {
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 0) out[key] = n
    }
    return Object.keys(out).length ? out : null
  }
  return {
    cardIds: ids,
    contractsVersion: versionMap(contractsVersion),
    acceptanceVersion: versionMap(acceptanceVersion),
  }
}

/**
 * 这份审批是否覆盖某张卡。
 *
 * - `scope` 缺失 / `cardIds` 为空 → 通配（旧的终端 mint 流程，人工显式授权）。
 * - 有 `cardIds` → 必须精确命中，否则视为越权复用。
 */
export function planApprovalCovers(approval, cardId) {
  if (!approval || approval.approved !== true) return { covers: false, reason: approval?.reason ?? 'no-approval' }
  const ids = approval.scope?.cardIds ?? []
  if (!ids.length) return { covers: true, reason: 'wildcard' }
  if (!cardId) return { covers: false, reason: 'card-unknown' }
  if (ids.includes(cardId)) return { covers: true, reason: 'scoped' }
  return { covers: false, reason: 'out-of-scope', approvedCards: ids }
}

/** 写拍板审批（**只应由 Host 在拿到真实人工批准后调用**）。 */
export function mintPlanApproval({
  path = planApprovalPath(),
  reason = '',
  ttlMs = DEFAULT_PLAN_TTL_MS,
  by = 'human',
  scope,
  now = Date.now(),
} = {}) {
  return mintApproval({
    path,
    reason,
    ttlMs,
    by,
    now,
    scope: normalizePlanScope(scope),
  })
}

/** 供状态快照用：文件在不在、什么时候过期（不读内容里的敏感字段）。 */
export function planApprovalSnapshot({ path = planApprovalPath(), now = Date.now() } = {}) {
  const approval = readPlanApproval({ path, now })
  return {
    path,
    exists: existsSync(path),
    approved: approval.approved,
    reason: approval.reason,
    expiresAt: approval.expiresAt ?? null,
    grantedAt: approval.grantedAt ?? null,
    scope: approval.scope ?? null,
  }
}
