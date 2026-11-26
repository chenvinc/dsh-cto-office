/**
 * 授权清单的 glob 匹配 —— 薄适配层，优先用宿主自带的 picomatch。
 *
 * 不造轮子：DSH 安装目录里有 picomatch@4（fs 搜索链路上的同一份实现）。
 * 本文件内置的最小匹配器只是**兜底**，不是主路径。
 *
 * ── 为什么这里要试多个锚点（真机反馈，2026-11-26）────────────────────
 * 最初只用 `process.env.DSH_INSTALL_DIR`。但该变量只存在于 **bash 工具的环境**，
 * 桌面版 Host 进程里并没有 → `createRequire` 抛 MODULE_NOT_FOUND → 一直跑兜底。
 * `office_status` 报 `glob 后端 = fallback` 就是这条的现场证据。
 *
 * 现在按顺序试多个锚点，并在 `matchBackend()` 里汇报**具体命中的锚点**，
 * 便于真机核对「设计上的主路径是否真的生效」。
 */
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'

let picomatch = null
let backend = 'fallback'
let anchorUsed = null

/** 候选锚点：能作为 createRequire 起点、且向上能走到 DSH 的 node_modules。 */
function candidateAnchors() {
  const out = []
  const push = value => { if (typeof value === 'string' && value) out.push(value) }

  push(process.env.DSH_CTO_OFFICE_PICOMATCH)
  push(process.env.DSH_INSTALL_DIR ? join(process.env.DSH_INSTALL_DIR, 'package.json') : null)

  // 桌面版（Electron）：Resources/app.asar/dsh 与 Resources/dsh 两种布局都试
  if (typeof process.resourcesPath === 'string') {
    push(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
    push(join(process.resourcesPath, 'dsh', 'package.json'))
    push(join(process.resourcesPath, 'app', 'package.json'))
  }
  // 从可执行文件反推 Resources
  if (typeof process.execPath === 'string') {
    const resources = join(dirname(process.execPath), '..', 'Resources')
    push(join(resources, 'app.asar', 'dsh', 'package.json'))
    push(join(resources, 'dsh', 'package.json'))
  }
  // 本包自身位置（若 picomatch 作为依赖被装上）
  try { push(new URL('./package.json', import.meta.url).pathname) } catch {}
  return out
}

for (const anchor of candidateAnchors()) {
  try {
    const req = createRequire(anchor)
    const mod = req('picomatch')
    const fn = typeof mod === 'function' ? mod : mod?.default
    if (typeof fn === 'function' && fn('db/**')('db/a.ts') === true) {
      picomatch = fn
      backend = 'picomatch'
      anchorUsed = anchor
      break
    }
  } catch {
    // 换下一个锚点
  }
}

/**
 * 当前生效的匹配后端。
 * `picomatch` 表示走了设计上的主路径；`fallback` 表示在跑内置兜底（非预期状态）。
 */
export function matchBackend() {
  return backend
}

/** 主路径用的锚点（兜底时为 null）。 */
export function matchBackendAnchor() {
  return anchorUsed
}

const CACHE = new Map()

function fallbackMatcher(pattern) {
  const cached = CACHE.get(pattern)
  if (cached) return cached
  let src = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') { src += '(?:[^/]+/)*'; i += 2 } else { src += '.*'; i += 1 }
      } else {
        src += '[^/]*'
      }
      continue
    }
    if (ch === '?') { src += '[^/]'; continue }
    if (ch === '{') {
      const end = pattern.indexOf('}', i)
      if (end > i) {
        src += '(?:' + pattern.slice(i + 1, end).split(',').map(escapeRe).join('|') + ')'
        i = end
        continue
      }
    }
    src += escapeRe(ch)
  }
  const re = new RegExp('^' + src + '$')
  CACHE.set(pattern, re)
  return re
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 归一化仓库相对路径：去前导 `./`、折叠重复斜杠、去尾斜杠。 */
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

/** 路径是否命中单个 glob。结尾 `/` 表示整个目录。 */
export function matchGlob(pattern, target) {
  const raw = String(pattern)
  const isDir = /\/$/.test(raw)
  const p = normalizePath(raw) + (isDir ? '/**' : '')
  const t = normalizePath(target)
  if (p === '**' || p === '**/*') return true
  if (picomatch) return Boolean(picomatch(p, { dot: true })(t))
  return fallbackMatcher(p).test(t)
}

export function matchAny(patterns, target) {
  return (patterns || []).some(pattern => matchGlob(pattern, target))
}

export function isAuthorized(authorization, target) {
  if (!authorization) return false
  if (authorization.mode === 'ro') return false
  if (matchAny(authorization.deny, target)) return false
  const includes = authorization.include
  if (!includes || includes.length === 0) return false
  return matchAny(includes, target)
}
