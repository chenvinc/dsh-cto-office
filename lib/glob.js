/**
 * 极简 glob（无依赖，够授权清单用）。
 *
 * 支持：`**` 任意层、`*` 段内任意、`?` 单字符、`{a,b}` 选择、结尾 `/` 视为目录前缀。
 * 不支持转义与字符类——授权清单不需要，且少一种语法少一类歧义。
 */

const CACHE = new Map()

function toRegex(pattern) {
  const cached = CACHE.get(pattern)
  if (cached) return cached

  let src = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]
    if (ch === '*') {
      const isDouble = pattern[i + 1] === '*'
      if (isDouble) {
        // `**/` 吃掉零到多层目录；裸 `**` 吃掉任意字符
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

/** 归一化仓库相对路径：去前导 `./`、折叠重复斜杠。 */
export function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '')
}

/** 路径是否命中单个 glob。 */
export function matchGlob(pattern, target) {
  const raw = String(pattern)
  // 结尾 `/` 表示「该目录下的全部内容」；必须在归一化前判断，否则斜杠会被吃掉。
  const isDir = /\/$/.test(raw)
  const p = normalizePath(raw) + (isDir ? '/**' : '')
  const t = normalizePath(target)
  if (p === '**' || p === '**/*') return true
  return toRegex(p).test(t)
}

/** 路径是否命中任一 glob。 */
export function matchAny(patterns, target) {
  return (patterns || []).some(pattern => matchGlob(pattern, target))
}

/** 是否落在清单的允许写入集合内：命中 include 且不命中 deny。 */
export function isAuthorized(authorization, target) {
  if (!authorization) return false
  if (authorization.mode === 'ro') return false
  const denied = matchAny(authorization.deny, target)
  if (denied) return false
  const includes = authorization.include
  if (!includes || includes.length === 0) return false
  return matchAny(includes, target)
}
