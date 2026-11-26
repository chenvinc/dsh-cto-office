#!/usr/bin/env node
/**
 * 人工审批「改判定器本身」（cordis.patch.yml / preset 配置）。
 *
 * 这是**给人用的**脚本，不是给 agent 的：
 * 它写的是工作区之外的审批文件，而 agent 的沙箱是 workspace-write —— 写不到那里。
 * 这正是 M-14 第一处门槛的实现方式：能力边界，而不是又一条运行时规则。
 *
 * 用法：
 *   node scripts/approve-patch-edit.mjs --reason "给 cto-ux 加 read_image"
 *   node scripts/approve-patch-edit.mjs --reason "..." --ttl-minutes 10
 *
 * 审批默认 30 分钟过期，且只应「一次一问」使用（方案 §14.10）。
 */
import { DEFAULT_TTL_MS, defaultApprovalPath, mintApproval, readApproval } from '../lib/patch-approval.js'

const argv = process.argv.slice(2)
const argOf = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const reason = argOf('--reason') ?? ''
const ttlMinutes = Number(argOf('--ttl-minutes') ?? '')
const ttlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes * 60 * 1000 : DEFAULT_TTL_MS
const path = defaultApprovalPath()

if (!reason.trim()) {
  console.error('必须给 --reason：审批要留痕，否则事后无法归因「为什么改判定器」。')
  console.error('例：node scripts/approve-patch-edit.mjs --reason "给 cto-ux 加 read_image 走查能力"')
  process.exit(2)
}

const doc = mintApproval({ path, reason, ttlMs, by: process.env.USER ?? process.env.USERNAME ?? 'human' })
const check = readApproval({ path })

console.log(`✅ 已批准改 cordis.patch.yml（有效期 ${Math.round(ttlMs / 60000)} 分钟）`)
console.log(`   文件：${path}`)
console.log(`   生效：${new Date(doc.grantedAt).toLocaleString()}`)
console.log(`   过期：${new Date(doc.expiresAt).toLocaleString()}`)
console.log(`   原因：${reason}`)
console.log(`   校验：${check.approved ? 'approved' : `NOT approved（${check.reason}）`}`)
if (!check.approved) process.exit(1)
