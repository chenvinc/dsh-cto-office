/**
 * 授权清单的 glob 匹配 —— 薄适配层，优先用宿主自带的 picomatch。
 *
 * 不造轮子：DSH 安装目录里有 picomatch@4（fs 搜索链路上的同一份实现）。
 * 通过安装锚点解析（DSH_INSTALL_DIR/package.json），避免从插件目录解析时
 * 落到 npx 缓存的旧副本（依赖清单 D12 记录的那类问题）。
 *
 * 解析失败才退回本文件内的最小匹配器 —— 它是**兜底**，不是主路径；
 * 当前生效的是哪一条，`matchBackend()` 会如实返回，供 probe 与文档核对。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'

let picomatch = null
let backend = 'fallback'

try {
  const install = process.env.DSH_INSTALL_DIR
  if (install) {
    const req = createRequire(join(install, 'package.json'))
    picomatch = req('picomatch')
    backend = 'picomatch'
  }
} catch {
  picomatch = null
  backend = 'fallback'
}

/** 当前生效的匹配后端：'picomatch' | 'fallback'。 */
export function matchBackend() {
  return backend
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

/** 路径是否命中任一 glob。 */
export function matchAny(patterns, target) {
  return (patterns || []).some(pattern => matchGlob(pattern, target))
}

/** 是否落在允许写入集合内：命中 include 且不命中 deny；ro 一律否。 */
export function isAuthorized(authorization, target) {
  if (!authorization) return false
  if (authorization.mode === 'ro') return false
  if (matchAny(authorization.deny, target)) return false
  const includes = authorization.include
  if (!includes || includes.length === 0) return false
  return matchAny(includes, target)
}
