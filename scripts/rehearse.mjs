#!/usr/bin/env node
/**
 * 停点 1 演练与核对（手工可读报告）。
 *
 * 在一个一次性仓库里完整走一遍「工件 → 开卡 → 派工 → 回执 → 闸门 → 结算」，
 * 并把磁盘上真正留下的东西列出来核对 —— 不是只看打印的 PASS，而是核对产物。
 *
 * 用法：node scripts/rehearse.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { CardStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { ArtifactStore } from '../lib/artifacts.js'
import { makePostExecuteReceiptGuard } from '../lib/receipt-guard.js'
import { Supervisor } from '../lib/supervisor.js'
import { STATES } from '../lib/card.js'

const log = (...a) => console.log(...a)
const h = t => `\n${'─'.repeat(64)}\n${t}\n${'─'.repeat(64)}`

function buildRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cto-rehearse-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q'); git('config', 'user.email', 'r@local'); git('config', 'user.name', 'rehearse')
  for (const d of ['db', 'api', 'app', 'shared']) mkdirSync(join(dir, d), { recursive: true })
  writeFileSync(join(dir, 'db', 'schema.ts'), 'export const schema = 1\n')
  writeFileSync(join(dir, 'api', 'import.ts'), 'export const importer = 1\n')
  writeFileSync(join(dir, 'app', 'page.tsx'), 'export const Page = 1\n')
  writeFileSync(join(dir, 'shared', 'types.ts'), 'export type T = 0\n')
  writeFileSync(join(dir, '.gitignore'), '.cto-office/\n')
  git('add', '-A'); git('commit', '-qm', 'init')
  return { dir, git }
}

const RECEIPT = (cardId, versions, files) => [
  'RECEIPT:',
  `- card: ${cardId}`,
  `- artifactsVersion: ${Object.entries(versions).map(([k, v]) => `${k}=${v}`).join(', ')}`,
  `- changed: ${files.join(', ')}`,
  '- acceptance:',
  '  - A1 PASS 证据：pnpm test → 7 passed',
  'SELF-CHECK:',
  '- build: pnpm build → 0',
  '- tests: pnpm test → 7 passed',
  `- scope: ${files.join(', ')}`,
  '- gaps: 大文件未压测',
].join('\n')

async function main() {
  const { dir, git } = buildRepo()
  const store = new CardStore(dir, {})
  const art = new ArtifactStore(store)
  const tools = buildTools({}, { store, config: { maxConcurrentWriters: 1 } })
  const guard = makePostExecuteReceiptGuard({ store, config: { writerPresets: ['cto-builder'] } })
  const accept = async () => ({ kind: 'accept' })
  const W = dir

  h('① 工件先行：没有验收基线不许派工')
  try { await tools.dispatch.execute({ workspace: W, cardId: 'C1', subject: 'x', mode: 'rw', include: ['api/**'], acceptance: ['A1'] }); log('❌ 竟然通过了') }
  catch (e) { log('✅ 被拒：', e.message.slice(0, 60)) }

  await tools.artifact.execute({ workspace: W, cardId: 'C1', action: 'write', kind: 'acceptance', content: 'A1 导入可跑' })
  await tools.artifact.execute({ workspace: W, cardId: 'C1', action: 'write', kind: 'contracts', content: 'POST /api/import → {imported:n}' })
  const v = art.versions('C1')
  log('✅ 工件落盘：', JSON.stringify(v))

  h('② 开卡与派工（串行名额 = 1）')
  const d1 = await tools.dispatch.execute({ workspace: W, cardId: 'C1', subject: '导入 API', preset: 'cto-builder', mode: 'rw', include: ['api/**'], acceptance: ['A1 导入可跑'] })
  log('✅ C1', d1.state, 'baseSha=', d1.baseSha.slice(0, 7))
  await tools.artifact.execute({ workspace: W, cardId: 'C2', action: 'write', kind: 'acceptance', content: 'A1 导入页有引导' })
  const d2 = await tools.dispatch.execute({ workspace: W, cardId: 'C2', subject: '导入页', preset: 'cto-builder', mode: 'rw', include: ['app/**'], acceptance: ['A1 导入页有引导'] })
  log('✅ C2', d2.state, '| blockedBy =', JSON.stringify(d2.blockedBy))

  h('③ 越界：改授权外文件 → 双读抓到、回执交叉核对也抓到')
  appendFileSync(join(dir, 'shared', 'types.ts'), 'export type T2 = 1\n')
  appendFileSync(join(dir, 'api', 'import.ts'), 'export const v2 = 2\n')
  git('add', '-A'); git('commit', '-qm', 'feat: import api + out of scope')
  const c1Decision = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '【任务卡 C1】导入 API' } }, { content: [{ type: 'text', text: RECEIPT('C1', { contracts: 1, acceptance: 1 }, ['api/import.ts']) }] }, accept)
  log('回执闸门：', c1Decision.kind, '（只报了 api/import.ts，实际还改了 shared/types.ts）')
  const g1 = await tools.gate.execute({ workspace: W, cardId: 'C1' })
  log('判定：', g1.verdict)
  for (const vi of g1.violations) log(`  - [${vi.kind}] ${vi.path ?? ''} ${vi.detail}`)

  h('④ 结算被拦：闸门非 PASS')
  try { await tools.release.execute({ workspace: W, cardId: 'C1', action: 'settle' }); log('❌ 竟然结算了') }
  catch (e) { log('✅ 被拒：', e.message.slice(0, 70)) }

  h('⑤ 作废 C1 → 释放锁 → C2 解阻 → 启动（此刻才冻 baseSha）')
  const ab = await tools.release.execute({ workspace: W, cardId: 'C1', action: 'abandon', reason: '越界，重开' })
  log('✅ C1', ab.state, '| unblocked =', ab.unblocked.join(',') || '(无)')
  const start = await tools.dispatch.execute({ workspace: W, cardId: 'C2' })
  log('✅ C2', start.state, 'baseSha =', start.baseSha.slice(0, 7), '（= C1 提交后的 HEAD）')

  h('⑥ 合规路径：回执与事实一致 → PASS → 结算')
  appendFileSync(join(dir, 'app', 'page.tsx'), 'export const Q = 2\n')
  git('add', '-A'); git('commit', '-qm', 'feat: import page')
  const dec = await guard({ name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '【任务卡 C2】导入页' } }, { content: [{ type: 'text', text: RECEIPT('C2', { acceptance: 1 }, ['app/page.tsx']) }] }, accept)
  log('回执闸门：', dec.kind)
  const g2 = await tools.gate.execute({ workspace: W, cardId: 'C2' })
  log('判定：', g2.verdict, JSON.stringify(g2.stats))
  const st = await tools.release.execute({ workspace: W, cardId: 'C2', action: 'settle' })
  log('✅ 结算：', st.cardId, '→', st.state)

  h('⑦ 超时监督器（把时钟推到 90 分钟后）')
  const stale = Date.now() - 90 * 60_000
  const holder = store.read('C1'); holder.updatedAt = stale; store.save(holder, stale)
  const card = store.read('C2')
  card.state = 'QUEUED'; card.blockedBy = { cardId: 'C1', reason: 'serial-limit' }
  store.save(card, stale)
  const sup = new Supervisor(store, { queuedAlertMs: 60 * 60_000 })
  const alerts = sup.tick()
  log('✅ 报警：', alerts.map(a => a.message).join(' | ') || '(无)')

  h('⑧ 磁盘核对：真正留下的东西')
  const walk = (d, depth = 0) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const rel = relative(dir, p)
      if (rel.split('/').includes('.git')) continue
      const s = statSync(p)
      if (s.isDirectory()) { log('  '.repeat(depth) + name + '/'); walk(p, depth + 1) }
      else log('  '.repeat(depth) + `${name}  (${s.size}B)`)
    }
  }
  walk(dir)

  h('⑨ 关键产物内容抽查')
  const latest = store.latestEvidence('C1')
  log('C1 最新证据 source =', latest?.source, '| verdict =', latest?.verdict)
  log('C1 证据条数 =', store.countEvidence('C1'), '| C2 证据条数 =', store.countEvidence('C2'))
  log('C2 回执记录 =', JSON.stringify(store.read('C2').lastReceipt?.changed ?? null))
  log('alerts.jsonl 存在 =', readdirSync(join(dir, '.cto-office')).includes('alerts.jsonl'))
  log('git status（应只忽略 .cto-office）:', JSON.stringify(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' })))

  rmSync(dir, { recursive: true, force: true })
  log('\n演练结束。')
}

main().catch(e => { console.error(e); process.exit(1) })
