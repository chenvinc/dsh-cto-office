#!/usr/bin/env node
/**
 * 人工审批「拍板」与「CD 不可逆动作」两道关口（二期）。
 *
 * 给人用的脚本，不是给 agent 的：审批文件在工作区之外（`~/.dsh/`），
 * agent 的 workspace-write 沙箱写不到 —— 这是能力层剥夺，不是又一条运行时规则。
 * 两道门用**不同文件**，避免「拍板确认」被拿去当「合并授权」用。
 *
 * 用法：
 *   node scripts/approve-phase.mjs --kind plan --reason "已拍板，采用方案 A"
 *   node scripts/approve-phase.mjs --kind cd   --reason "允许合并 PR #123"
 *   node scripts/approve-phase.mjs --kind cd --reason "..." --ttl-minutes 10
 *
 * 默认 30 分钟过期，一次一问（设计稿 §4.6 策略 A）。
 */
import { DEFAULT_TTL_MS, approvalPathFor, mintApproval, readApproval } from '../lib/patch-approval.js'
import { normalizePlanScope } from '../lib/plan-approval.js'

const argv = process.argv.slice(2)
const argOf = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const kind = argOf('--kind') ?? ''
const reason = argOf('--reason') ?? ''
const cardArg = argOf('--card') ?? ''
const ttlMinutes = Number(argOf('--ttl-minutes') ?? '')
const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : DEFAULT_TTL_MS

if (!['plan', 'cd'].includes(kind)) {
  console.error('必须给 --kind plan|cd：两道关口用不同的审批文件。')
  console.error('例：node scripts/approve-phase.mjs --kind plan --card SC-4a --reason "已拍板"')
  process.exit(2)
}
if (!reason.trim()) {
  console.error('必须给 --reason：审批要留痕，否则事后无法归因「为什么放行」。')
  process.exit(2)
}

// 拍板凭据绑定卡号（2026-11-28 修复）：不给 --card 就退化成「通配」，
// 一次批准可复用到任意实现卡 —— 只建议在调试时用。
const scope = kind === 'plan'
  ? normalizePlanScope({ cardIds: cardArg.split(',').map(s => s.trim()).filter(Boolean) })
  : undefined
if (kind === 'plan' && scope && scope.cardIds.length === 0) {
  console.warn('⚠ 未给 --card：这次拍板是通配授权，可覆盖任意实现卡。生产环境请用 --card <卡号,...> 收窄范围。')
}

const path = approvalPathFor(kind)
const label = kind === 'plan' ? '拍板（派实现卡）' : 'CD 不可逆动作（merge / release）'
const doc = mintApproval({ path, reason, ttlMs, by: process.env.USER ?? process.env.USERNAME ?? 'human', scope })
const check = readApproval({ path })

console.log(`✅ 已批准 ${label}（有效期 ${Math.round(ttlMs / 60000)} 分钟）`)
console.log(`   文件：${path}`)
console.log(`   生效：${new Date(doc.grantedAt).toLocaleString()}`)
console.log(`   过期：${new Date(doc.expiresAt).toLocaleString()}`)
console.log(`   原因：${reason}`)
if (kind === 'plan') {
  console.log(`   覆盖卡：${scope.cardIds.length ? scope.cardIds.join(', ') : '（通配，未绑定）'}`)
}
console.log(`   校验：${check.approved ? 'approved' : `NOT approved（${check.reason}）`}`)
if (!check.approved) process.exit(1)
