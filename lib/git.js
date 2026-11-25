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
    const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, windowsHide: true })
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
  const out = await git(cwd, ['diff', '--name-status', `${baseSha}..HEAD`])
  const entries = []
  for (const line of out.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('\t')
    const status = parts[0][0]
    const path = status === 'R' || status === 'C' ? (parts[2] ?? parts[1]) : parts[1]
    if (isIgnored(path, ignorePrefixes)) continue
    entries.push(status === 'R' || status === 'C' ? { path, from: parts[1], status: 'R' } : { path, status })
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
  const out = await git(cwd, ['diff', '--numstat', `${baseSha}..HEAD`])
  let added = 0
  let removed = 0
  for (const line of out.split('\n')) {
    const cols = line.trim().split('\t')
    if (cols.length < 3) continue
    if (isIgnored(cols[2], ignorePrefixes)) continue
    if (cols[0] === '-') continue // 二进制
    added += Number(cols[0]) || 0
    removed += Number(cols[1]) || 0
  }
  return { added, removed }
}

/**
 * `git status --porcelain` → [{path, status}]，过滤掉 `.cto-office/`。
 * 覆盖未跟踪、删除、重命名与工作区修改。
 */
export async function statusEntries(cwd, ignorePrefixes = ['.cto-office/']) {
  const out = await git(cwd, ['status', '--porcelain', '--untracked-files=all'])
  const entries = []
  for (const line of out.split('\n')) {
    if (line.length < 4) continue
    const status = line.slice(0, 2)
    let path = line.slice(3).trim()
    if (path.includes(' -> ')) path = path.split(' -> ').pop()
    path = path.replace(/^"|"$/g, '')
    if (ignorePrefixes.some(prefix => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) continue
    entries.push({ path, status: status.trim() || '??' })
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
