/**
 * git plumbing（方案 §4.2a D 层「双读」）。
 *
 * 只读命令：rev-parse / diff / status / numstat。
 * 双读的原因：`diff --name-status` 看不到未跟踪、删除、重命名；
 * `status --porcelain` 看不到已提交的内容。两条合起来才是完整事实。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(cwd, args) {
  try {
    // `-c core.quotePath=false`：git 默认把非 ASCII 路径转义成 "docs/W0-\345\256..." 这种
    // 带引号的八进制字面量，会让 diff/status 的 path 与授权 glob、回执里的真路径对不上。
    // 在这里统一前置，所有命令一起生效，调用方无需关心。
    const quoted = ['-c', 'core.quotePath=false', ...args]
    const { stdout } = await run('git', quoted, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
    return stdout
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr).trim() : ''
    const err = new Error(`git ${args.join(' ')} failed: ${stderr || (error && error.message)}`)
    err.code = 'GIT_FAILED'
    err.stderr = stderr
    throw err
  }
}

/** 当前 HEAD；空仓库返回 null。 */
export async function headSha(cwd) {
  try {
    return (await git(cwd, ['rev-parse', 'HEAD'])).trim()
  } catch (error) {
    if (/ambiguous argument|unknown revision|Needed a single revision/i.test(String(error.stderr))) return null
    throw error
  }
}

/** 工作区是否干净（忽略 `.cto-office/`）。 */
export async function isClean(cwd, ignorePrefixes = ['.cto-office/']) {
  const entries = await statusEntries(cwd, ignorePrefixes)
  return entries.length === 0
}

/**
 * `git diff --name-status <base>..HEAD` → [{path, status}]。
 * status 取 A/M/D/R（R 视为重命名，记新路径）。
 */
export async function diffEntries(cwd, baseSha, ignorePrefixes = []) {
  // `-z`：NUL 分隔，文件名里的制表符/换行/引号都不会让解析错位。
  // 配合 `core.quotePath=false`，非 ASCII 路径也原样返回（真机反馈 P0 误判的修法）。
  const out = await git(cwd, ['diff', '--name-status', '-z', `${baseSha}..HEAD`])
  const tokens = out.split('\0').filter(token => token.length > 0)
  const entries = []
  for (let i = 0; i < tokens.length; i += 1) {
    const status = tokens[i][0]
    if (status === 'R' || status === 'C') {
      const from = tokens[i + 1]
      const path = tokens[i + 2]
      i += 2
      if (isIgnored(path, ignorePrefixes)) continue
      entries.push({ path, from, status: 'R' })
      continue
    }
    const path = tokens[i + 1]
    i += 1
    if (!path || isIgnored(path, ignorePrefixes)) continue
    entries.push({ path, status })
  }
  return entries
}

/** 判定用的路径过滤：`.cto-office/` 本身进 git（可 review），但不算作家改动。 */
function isIgnored(path, ignorePrefixes = []) {
  if (!path) return true
  const normalized = path.replace(/\\/g, '/')
  return ignorePrefixes.some(prefix => {
    const base = prefix.replace(/\/$/, '')
    return normalized === base || normalized.startsWith(base + '/')
  })
}

/** 增删行数。 */
export async function diffLines(cwd, baseSha, ignorePrefixes = []) {
  const out = await git(cwd, ['diff', '--numstat', '-z', `${baseSha}..HEAD`])
  let added = 0
  let removed = 0
  const tokens = out.split('\0').filter(token => token.length > 0)
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    const tab = token.indexOf('\t')
    const tab2 = token.indexOf('\t', tab + 1)
    if (tab < 0 || tab2 < 0) continue
    const a = token.slice(0, tab)
    const r = token.slice(tab + 1, tab2)
    let path = token.slice(tab2 + 1)
    // 重命名：路径为空，后面跟「旧路径」「新路径」两个 token
    if (path === '') { path = tokens[i + 2] ?? ''; i += 2 }
    if (path && isIgnored(path, ignorePrefixes)) continue
    if (a === '-') continue // 二进制
    added += Number(a) || 0
    removed += Number(r) || 0
  }
  return { added, removed }
}

/**
 * `git status --porcelain` → [{path, status}]，过滤掉 `.cto-office/`。
 * 覆盖未跟踪、删除、重命名与工作区修改。
 */
export async function statusEntries(cwd, ignorePrefixes = ['.cto-office/']) {
  const out = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all'])
  const tokens = out.split('\0').filter(token => token.length > 0)
  const entries = []
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (token.length < 4) continue
    const status = token.slice(0, 2).trim() || '??'
    let path = token.slice(3)
    // 重命名/复制在 -z 下是「旧路径\0新路径」两个 token
    if (status[0] === 'R' || status[0] === 'C') {
      path = tokens[i + 1] ?? path
      i += 1
    }
    if (isIgnored(path, ignorePrefixes)) continue
    entries.push({ path, status })
  }
  return entries
}

/** 一次性取齐判定所需事实。 */
export async function collectFacts(cwd, baseSha, ignorePrefixes = ['.cto-office/']) {
  const [changed, untrackedAll, lines] = await Promise.all([
    diffEntries(cwd, baseSha, ignorePrefixes),
    statusEntries(cwd, ignorePrefixes),
    diffLines(cwd, baseSha, ignorePrefixes),
  ])
  const committed = new Set(changed.map(e => e.path))
  return {
    changed,
    untracked: untrackedAll.map(e => e.path),
    workingTree: untrackedAll,
    lines,
    committedPaths: [...committed],
  }
}

/** 是否 git 仓库根。 */
export async function isRepository(cwd) {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch {
    return false
  }
}

export async function repositoryRoot(cwd) {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}
