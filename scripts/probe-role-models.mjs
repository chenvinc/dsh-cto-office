#!/usr/bin/env node
/**
 * 岗位路由「出词」探针（2026-11-27 加，防 T2 复发）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * `list_subagent_models()` 与 `/v1/models` 只反映「会话策略 + 目录」，
 * 不保证上游订阅真的包含该模型。实测踩过两次：
 *   - `opencode-go/minimax-m3.1-flash-free` 在目录与白名单里都有，真发请求 400
 *     （"isn't included in OpenCode Go"）→ 子代理能创建但一执行就崩；
 *   - `opencode-go/longcat-2.5-free` 410 ModelDeprecated。
 * DSH 的 route preflight 查不到这一层，所以只能自己发一次最小请求。
 *
 * 用法：
 *   node scripts/probe-role-models.mjs
 *   MAGPIE_GATEWAY_KEY=... node scripts/probe-role-models.mjs   # 或自动读 ~/.dsh/.env
 *   DSH_MAGPIE_GATEWAY_URL=... DSH_PROBE_TIMEOUT_MS=30000 node scripts/probe-role-models.mjs
 *
 * 每条路由发 1 个 `max_tokens:1` 请求，会占用极少量额度 / 窗口计数；
 * 只打印状态与耗时，**不打印凭据**。任一条非 200 → 退出码 1。
 * 手动运行的诊断脚本，不进 npm test、不进插件运行时。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEFAULT_ROLE_MODELS } from '../lib/role-models.js'

const URL = process.env.DSH_MAGPIE_GATEWAY_URL || 'http://127.0.0.1:3425/v1/chat/completions'
const TIMEOUT_MS = Number(process.env.DSH_PROBE_TIMEOUT_MS) || 25000

function gatewayKey() {
  if (process.env.MAGPIE_GATEWAY_KEY) return process.env.MAGPIE_GATEWAY_KEY.trim()
  try {
    const env = readFileSync(join(homedir(), '.dsh', '.env'), 'utf8')
    const m = env.match(/^\s*MAGPIE_GATEWAY_KEY\s*=\s*(.+?)\s*$/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : ''
  } catch {
    return ''
  }
}

const key = gatewayKey()
if (!key) {
  console.error('拿不到 MAGPIE_GATEWAY_KEY：请设置环境变量，或确认 ~/.dsh/.env 里有这一项。')
  process.exit(2)
}

// 同一路由被多个岗位共用时只探一次（architect / ux 都是 auto/gemini-4-argon）。
const routes = [...new Map(
  Object.values(DEFAULT_ROLE_MODELS).map(r => [`${r.provider}/${r.model}`, r]),
).values()]

console.log(`探针：${routes.length} 条岗位路由 → ${URL}（每条 1 token，超时 ${TIMEOUT_MS}ms）\n`)

let failed = 0
for (const route of routes) {
  const label = `${route.provider}/${route.model}`
  if (route.provider !== 'magpie') {
    console.log(`SKIP  ${label}  （非 openai-completions 通道，请用对应端点单独验）`)
    continue
  }
  const started = Date.now()
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: route.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await res.text()
    let detail = 'OK'
    try {
      const body = JSON.parse(text)
      if (body.error) detail = `ERR ${String(body.error.message || JSON.stringify(body.error)).slice(0, 160)}`
      else detail = `OK choices=${body.choices?.length ?? 0}`
    } catch {
      detail = text.slice(0, 160)
    }
    const ok = res.status === 200
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} ${String(res.status).padEnd(4)} ${String(Date.now() - started).padStart(6)}ms  ${detail}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${label.padEnd(46)} ---- ${String(Date.now() - started).padStart(6)}ms  ${error.name}: ${error.message}`)
  }
}

console.log(`\n结果：${routes.length - failed}/${routes.length} 可用。`)
if (failed) {
  console.log('有不可用路由：先修 DEFAULT_ROLE_MODELS 与 docs/模型映射-OpenCode-Go-本机可用路由.md，')
  console.log('再改 allowedModels → 重载 bundle → 新开会话。别只放行白名单。')
  process.exit(1)
}
