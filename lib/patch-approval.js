/**
 * 「改判定器本身」的人工确认闸门（方案 §14.9 第一处 / M-14）。
 *
 * ── 为什么这道门必须存在 ─────────────────────────────────────────────
 * P1 只挡住了「往文件里写一行 `GATE: PASS`」。但 CTO 可以改 `cordis.patch.yml`，
 * 造一个空壳 `cto-reviewer` preset —— 那时来源校验照样通过，因为来源**确实是一个 preset**。
 * 判定器不能被判定对象改写。
 *
 * ── 为什么不用「再写一条守卫」来保证人工参与 ─────────────────────────
 * 守卫只能看到工具调用，看不到「人有没有点过确认」。若把审批标记也放进工作区，
 * agent 顺手写一个就能绕过 —— 那只是把伪造点从一个文件挪到另一个文件。
 *
 * 所以这里用的是**能力边界**：
 *   审批文件放在工作区之外（默认 `~/.dsh/cto-office-patch-approval.json`），
 *   而 CTO 会话的沙箱是 `workspace-write` —— agent 根本写不到那里。
 *   能写它的只有人（或人在终端里跑的 `scripts/approve-patch-edit.mjs`）。
 *
 * 这正是本项目反复用的原则：**能力层剥夺优于运行时判定**。
 *
 * ── TTL ─────────────────────────────────────────────────────────────
 * 审批默认 30 分钟过期，且**一次一问**（§14.10）：它是「例外门」，不是第二个日常入口。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_TTL_MS = 30 * 60 * 1000
export const APPROVAL_SCHEMA = 'cto-office/patch-approval@1'

/** 受保护的文件：判定器本身（patch 里同时定义 preset 与工具边界）。 */
const PROTECTED = [
  /(^|[\\/])cordis\.patch\.yml$/,
  /(^|[\\/])cordis\.patch\.yaml$/,
]

/** 只读命令白名单：提到受保护文件但这些命令不改写它。 */
const READ_ONLY_COMMANDS = [
  /^\s*(cat|less|more|head|tail|grep|rg|sed\s+-n|awk|wc|diff|md5|shasum|sha256sum)\b/,
  /\bgit\s+(diff|show|log|status|blame)\b/,
  /\bnpm\s+(run\s+check|test)\b/,
  /\bnode\s+scripts\/sync-office-data\.mjs\s+--check\b/,
]

/**
 * 不同关口用不同审批文件，避免「拍板确认」被拿去当「合并授权」用。
 * name: 'patch'（改判定器）/ 'plan'（拍板）/ 'cd'（不可逆动作）。
 * 环境变量形如 DSH_CTO_OFFICE_<NAME>_APPROVAL；'patch' 沿用历史变量名。
 */
export function approvalPathFor(name, env = process.env) {
  const envKey = name === 'patch'
    ? 'DSH_CTO_OFFICE_PATCH_APPROVAL'
    : `DSH_CTO_OFFICE_${String(name).toUpperCase()}_APPROVAL`
  return env[envKey] || join(homedir(), '.dsh', `cto-office-${name}-approval.json`)
}

export function defaultApprovalPath(env = process.env) {
  return approvalPathFor('patch', env)
}

/** 这个工具调用是不是在改判定器本身。 */
export function isJudgementPlaneEdit(toolName, args) {
  if (!toolName || !args || typeof args !== 'object') return false
  const pathLike = args.file_path ?? args.path ?? args.file
  if (typeof pathLike === 'string' && PROTECTED.some(re => re.test(pathLike))) {
    // 读工具不算改
    if (toolName === 'read' || toolName === 'glob' || toolName === 'grep') return false
    return true
  }
  const command = args.command
  // shell 里文件名不一定在行首 / 斜杠后（`cp x cordis.patch.yml`），所以命令分支用宽匹配。
  if (typeof command === 'string' && /cordis\.patch\.ya?ml/.test(command)) {
    const readOnly = READ_ONLY_COMMANDS.some(re => re.test(command))
    return !readOnly
  }
  return false
}

/**
 * 读审批状态。缺失 / 损坏 / 过期一律按**未批准**处理（fail-closed）。
 * @returns {{approved: boolean, reason: string, expiresAt?: number, grantedAt?: number, by?: string}}
 */
export function readApproval({ path = defaultApprovalPath(), now = Date.now() } = {}) {
  if (!existsSync(path)) return { approved: false, reason: 'no-approval' }
  let doc
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { approved: false, reason: 'unreadable-approval' }
  }
  if (!doc || doc.schema !== APPROVAL_SCHEMA) return { approved: false, reason: 'bad-approval-schema' }
  const expiresAt = Number(doc.expiresAt)
  if (!Number.isFinite(expiresAt)) return { approved: false, reason: 'bad-approval-ttl' }
  // `scope` 是 2026-11-28 加的拍板绑定信息（cardIds / 契约版本）。
  // 旧文件没有它 → null，读侧按「通配」处理，保证向后兼容。
  const scope = doc.scope && typeof doc.scope === 'object' && !Array.isArray(doc.scope) ? doc.scope : null
  if (now >= expiresAt) return { approved: false, reason: 'approval-expired', expiresAt, grantedAt: doc.grantedAt, by: doc.by, scope }
  return { approved: true, reason: 'human-approved', expiresAt, grantedAt: doc.grantedAt, by: doc.by, reason_text: doc.reason, scope }
}

/**
 * 生成审批（**只应由人调用**，见 scripts/approve-patch-edit.mjs）。
 * 之所以留在这里而不是内联进脚本：Ttl 语义只有一处实现，脚本和守卫不会漂移。
 */
export function mintApproval({ path = defaultApprovalPath(), reason = '', ttlMs = DEFAULT_TTL_MS, by = 'human', now = Date.now(), scope } = {}) {
  const doc = {
    schema: APPROVAL_SCHEMA,
    grantedAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
    by,
    reason: String(reason ?? ''),
    ...(scope && typeof scope === 'object' && !Array.isArray(scope) ? { scope } : {}),
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n')
  return doc
}

/** 给 deny 用的说明（含人类要执行的那条命令）。 */
export function approvalDenyReason({ path = defaultApprovalPath(), ttlMs = DEFAULT_TTL_MS } = {}) {
  return '改 `cordis.patch.yml` 等于改判定器本身（preset、工具边界、岗位权限都在里面），需要人工确认。'
    + `\n审批文件：${path}（在**工作区之外**，agent 的沙箱写不到它 —— 这是有意的）。`
    + `\n请让用户在自己的终端里执行：\n  node scripts/approve-patch-edit.mjs --reason "为什么要改"\n`
    + `然后在 ${Math.round(ttlMs / 60000)} 分钟内重试这次修改。`
    + '\n不要试图自己创建审批文件：它被设计成你写不到。'
}
