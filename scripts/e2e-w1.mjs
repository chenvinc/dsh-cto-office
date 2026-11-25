#!/usr/bin/env node
/**
 * W1 端到端验收（可复跑）。
 *
 * 在一个一次性临时仓库里跑完整链路：派工 → 串行阻塞 → 越界判定 → 结算拦截 →
 * 终止态释放锁。这是方案 §14.6 故障注入的骨架（后续用例在此扩展）。
 *
 * 用法：node scripts/e2e-w1.mjs
 * 退出码：0 全部通过；1 有用例失败。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CardStore } from '../lib/store.js'
import { buildTools } from '../lib/tools.js'
import { STATES } from '../lib/card.js'
import { makePostExecuteReceiptGuard } from '../lib/receipt-guard.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cto-e2e-'))
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'e2e@local')
  git('config', 'user.name', 'e2e')
  mkdirSync(join(dir, 'db'), { recursive: true })
  mkdirSync(join(dir, 'app'), { recursive: true })
  mkdirSync(join(dir, 'shared'), { recursive: true })
  writeFileSync(join(dir, 'db', 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'app', 'p.tsx'), 'export const P = 1\n')
  writeFileSync(join(dir, 'shared', 'types.ts'), 'export type T = 0\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { dir, git }
}

async function main() {
  const { dir, git } = makeRepo()
  const store = new CardStore(dir, {})
  const tools = buildTools({}, { store, config: { maxConcurrentWriters: 1 } })
  const W = dir

  // 0) 工件先于卡：没有验收基线不许派工
  let refusedNoArtifact = false
  try {
    await tools.dispatch.execute({ workspace: W, cardId: 'C0', subject: 'x', mode: 'rw', include: ['db/**'], acceptance: ['A1 x'] })
  } catch { refusedNoArtifact = true }
  check('无验收基线 → 拒绝派工', refusedNoArtifact)

  await tools.artifact.execute({ workspace: W, cardId: 'C1', action: 'write', kind: 'acceptance', content: 'A1 导入可跑' })
  await tools.artifact.execute({ workspace: W, cardId: 'C1', action: 'write', kind: 'contracts', content: 'api: POST /import' })

  // 1) 派工 C1（授权 db/**）
  const d1 = await tools.dispatch.execute({ workspace: W, cardId: 'C1', subject: '数据层', preset: 'cto-builder', mode: 'rw', include: ['db/**'], acceptance: ['A1 可跑'] })
  check('派工 C1 → DISPATCHED', d1.state === STATES.DISPATCHED, 'baseSha=' + d1.baseSha.slice(0, 7))

  // 2) 串行名额：C2 必须 QUEUED
  await tools.artifact.execute({ workspace: W, cardId: 'C2', action: 'write', kind: 'acceptance', content: 'A1 空态有引导' })
  const d2 = await tools.dispatch.execute({ workspace: W, cardId: 'C2', subject: '导入页', preset: 'cto-builder', mode: 'rw', include: ['app/**'], acceptance: ['A1 空态'] })
  check('第二个写卡 → QUEUED（serial-limit）', d2.state === STATES.QUEUED && d2.blockedBy?.reason === 'serial-limit', JSON.stringify(d2.blockedBy))

  // 3) 越界：改授权外文件 → CHANGES，且同时抓到 diff 与 status 两类
  appendFileSync(join(dir, 'shared', 'types.ts'), 'export type T2 = 1\n')
  writeFileSync(join(dir, 'stray.log'), 'x\n')
  const g1 = await tools.gate.execute({ workspace: W, cardId: 'C1' })
  const paths = (g1.violations || []).map(v => v.path)
  check('越界判定 → CHANGES', g1.verdict === 'CHANGES', paths.join(', '))
  check('双读：diff 抓到已跟踪文件', paths.includes('shared/types.ts'))
  check('双读：status 抓到未跟踪文件', paths.includes('stray.log'))

  // 4) 越界未修复 → 不许结算
  let refused = false
  try { await tools.release.execute({ workspace: W, cardId: 'C1', action: 'settle' }) } catch { refused = true }
  check('闸门未过时拒绝结算', refused)

  // 5) 提交越界改动后工作区干净，但闸门结论仍是 CHANGES → 仍不许结算
  git('add', '-A'); git('commit', '-qm', 'out of scope')
  let refused2 = false
  try { await tools.release.execute({ workspace: W, cardId: 'C1', action: 'settle' }) } catch { refused2 = true }
  check('工作区干净但闸门非 PASS → 仍拒绝结算', refused2)

  // 6) 作废 C1 → 释放并解阻 C2
  const ab = await tools.release.execute({ workspace: W, cardId: 'C1', action: 'abandon', reason: '越界需重开' })
  check('作废 C1 → ABANDONED', ab.state === STATES.ABANDONED)
  const c2 = store.read('C2')
  check('终止态释放锁 → C2 解阻', c2.blockedBy === null, JSON.stringify(c2.blockedBy))

  // 6b) 进行期禁改工件（M-14）
  let artifactLocked = false
  try {
    await tools.artifact.execute({ workspace: W, cardId: 'C2', action: 'write', kind: 'acceptance', content: 'A1 改口径' })
  } catch (error) {
    artifactLocked = /禁止|in progress|执行/.test(error.message)
  }
  check('卡执行中 → 禁止改验收基线', artifactLocked)

  // 7) 启动 C2（此刻才冻 baseSha，不含 C1 的改动）→ 授权内提交 → PASS → 结算
  const startC2 = await tools.dispatch.execute({ workspace: W, cardId: 'C2' })
  check('C2 启动时才冻结 baseSha（A3）', startC2.state === STATES.DISPATCHED && !!startC2.baseSha, 'baseSha=' + String(startC2.baseSha).slice(0, 7))
  const c2After = store.read('C2')
  check('C2 的 baseSha = C1 提交后的 HEAD（不含他人改动）', c2After.baseSha === execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim())

  appendFileSync(join(dir, 'app', 'p.tsx'), 'export const Q = 2\n')
  git('add', '-A'); git('commit', '-qm', 'in scope')
  const receiptGuard2 = makePostExecuteReceiptGuard({ store, config: { writerPresets: ['cto-builder'] } })
  const c2Receipt = [
    'RECEIPT:',
    '- card: C2',
    '- artifactsVersion: acceptance=1',
    '- changed: app/p.tsx',
    '- acceptance:',
    '  - A1 PASS 证据：pnpm test → 3 passed',
    'SELF-CHECK:',
    '- build: pnpm build → 0',
    '- tests: pnpm test → 3 passed',
    '- scope: app/p.tsx',
    '- gaps: 无',
  ].join('\n')
  const receiptDecision = await receiptGuard2(
    { name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '【任务卡 C2】x' } },
    { content: [{ type: 'text', text: c2Receipt }] },
    async () => ({ kind: 'accept' }),
  )
  check('合规回执被接受并记账', receiptDecision.kind === 'accept' && !!store.read('C2').lastReceipt)

  const g2 = await tools.gate.execute({ workspace: W, cardId: 'C2' })
  check('授权内改动 + 回执对齐 → PASS', g2.verdict === 'PASS', JSON.stringify(g2.stats))

  // 回执与事实不一致 → 不许过闸
  store.recordReceipt('C2', { changed: ['app/p.tsx', 'app/ghost.tsx'], scope: [], acceptance: [], artifactsVersion: { acceptance: 1 } })
  const g3 = await tools.gate.execute({ workspace: W, cardId: 'C2' })
  check('回执虚报 → CHANGES', g3.verdict === 'CHANGES' && g3.violations.some(v => v.kind === 'receipt-overclaim'))
  store.recordReceipt('C2', { changed: [], scope: [], acceptance: [], artifactsVersion: { acceptance: 1 } })
  const g4 = await tools.gate.execute({ workspace: W, cardId: 'C2' })
  check('回执漏报 → CHANGES', g4.verdict === 'CHANGES' && g4.violations.some(v => v.kind === 'receipt-underclaim'))
  store.recordReceipt('C2', { changed: ['app/p.tsx'], scope: [], acceptance: [], artifactsVersion: { acceptance: 1 } })
  const evBefore = store.countEvidence('C2')
  await tools.gate.execute({ workspace: W, cardId: 'C2' })
  check('重复判定 → 新增一件而非覆盖', store.countEvidence('C2') === evBefore + 1, `${evBefore} → ${store.countEvidence('C2')}`)

  const st = await tools.release.execute({ workspace: W, cardId: 'C2', action: 'settle' })
  check('PASS 后可以结算', st.state === STATES.SETTLED)

  // 8) 证据：每次判定一件一文件（不覆盖、不合并）
  const evC1 = store.countEvidence('C1')
  check('C1 判定一次 → 一份证据', evC1 === 1, 'count=' + evC1)

  // 9) 回执闸门：缺 RECEIPT 的写岗交付被 block
  const receiptGuard = makePostExecuteReceiptGuard({ store, config: { writerPresets: ['cto-builder'] } })
  const next = async () => ({ kind: 'accept' })
  const blocked = await receiptGuard(
    { name: 'subagent', arguments: { agent_preset: 'cto-builder', prompt: '【任务卡 C2】x' } },
    { content: [{ type: 'text', text: '做完了' }] },
    next,
  )
  check('写岗缺回执 → block', blocked.kind === 'block')
  const readOnly = await receiptGuard(
    { name: 'subagent', arguments: { agent_preset: 'cto-qa', prompt: '【任务卡 C2】x' } },
    { content: [{ type: 'text', text: '无回执' }] },
    next,
  )
  check('只读岗不要求回执', readOnly.kind === 'accept')

  rmSync(dir, { recursive: true, force: true })

  const failed = results.filter(r => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch(error => { console.error(error); process.exit(1) })
