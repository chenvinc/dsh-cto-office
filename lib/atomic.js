/**
 * 持久化写入（方案 §14.3）。
 *
 * 两条路径：
 *  - writeOnceJson：证据文件主路径。只新建、永不覆盖 → 崩溃最坏是「文件不存在」，
 *    而「不存在」是安全状态（重跑该 intent 即可）；目录 fsync 因此是可选强化。
 *  - replaceJson：单文档兜底路径（card.json 这类必须原地更新的汇总游标）。
 *    temp → fsync(temp) → close → rename → fsync(dir)，顺序不可调换。
 *
 * 读侧一律严格：0 字节 / JSON 坏了 / schema 不全 → CORRUPT，绝不宽容成空对象。
 * 依赖零外部包：@deepseek-ai/dsh-atomic-write 在本机插件目录下会解析到 npx 缓存的
 * rc.1 旧副本（宿主 rc.5），不可信。
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export class CorruptError extends Error {
  constructor(path, detail) {
    super(`CORRUPT: ${path} (${detail})`)
    this.name = 'CorruptError'
    this.code = 'CORRUPT'
  }
}

function tempPath(target) {
  return join(dirname(target), `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`)
}

function writeAll(fd, text) {
  let off = 0
  const buf = Buffer.from(text, 'utf8')
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
}

function fsyncDir(dir) {
  // Windows 不支持对目录 fsync；显式降级并让调用方知道，不静默假装成功。
  let fd
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

/**
 * 只新建、永不覆盖。目标已存在时抛 EEXIST，调用方据此判定幂等命中。
 */
export function writeOnceJson(target, value) {
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) {
    const err = new Error(`EEXIST: ${target}`)
    err.code = 'EEXIST'
    throw err
  }
  const tmp = tempPath(target)
  const fd = openSync(tmp, 'wx')
  try {
    writeAll(fd, JSON.stringify(value, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
  fsyncDir(dirname(target))
  return target
}

/**
 * 覆盖替换（兜底路径）。返回是否成功 fsync 了目录项。
 */
export function replaceJson(target, value) {
  mkdirSync(dirname(target), { recursive: true })
  const tmp = tempPath(target)
  const fd = openSync(tmp, 'wx')
  try {
    writeAll(fd, JSON.stringify(value, null, 2) + '\n')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, target)
  return { dirSynced: fsyncDir(dirname(target)) }
}

/**
 * 严格读。缺失返回 undefined；坏文件抛 CorruptError（不许返回 {}）。
 */
export function readJsonStrict(target) {
  let raw
  try {
    raw = readFileSync(target, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (raw.trim().length === 0) throw new CorruptError(target, '0 bytes')
  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new CorruptError(target, 'invalid json: ' + (error && error.message))
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CorruptError(target, 'not an object')
  }
  return value
}
