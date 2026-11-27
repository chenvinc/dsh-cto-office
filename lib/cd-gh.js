/**
 * CD 阶段的 `gh` 命令契约与输出解析（三期 / 模式 A）。
 *
 * ── 为什么是「命令模板 + 解析器」，而不是插件自己起 gh 进程 ──────────
 * 已拍板用模式 A：外部命令由 CTO 用现有 `bash` 执行，插件只做状态机与落盘。
 * 但二期的 `evidence` 是任意字符串（等于自述），与铁律 3「证据优先」相冲。
 * 三期把「接通 gh」定义为两件事：
 *   ① 把每个阶段该跑的命令**固化成可复跑的契约**（CTO 不用自己编 gh 参数）；
 *   ② 把 CTO 传回的 stdout **解析成结构化事实**，与声明比对 —— 不一致直接打回。
 * 全程不引入子进程、不绕过 `tools/pre-execute` 的沙箱与破坏性命令拦截。
 *
 * 零外部依赖，纯函数，便于单测与复跑。
 */

/** 每个阶段该跑什么。`repo` 缺省用占位符，CTO 用自己仓库的真实 owner/name 替换。 */
export function cdCommands({ prNumber, headSha, repo, releaseWorkflow, healthUrl } = {}) {
  const r = repo || '{owner}/{repo}'
  const n = prNumber || '<n>'
  const sha = headSha || '<headSha>'
  return {
    begin: `gh pr view ${n} --repo ${r} --json number,headRefOid,state,url`,
    review: '（无 gh 命令）派 cto-reviewer 审 PR，回执末行写 GATE: PASS / GATE: CHANGES',
    checks: `gh pr checks ${n} --repo ${r} --json name,state,conclusion`,
    merge: `gh api -X PUT repos/${r}/pulls/${n}/merge -f merge_method=squash -f sha=${sha}`,
    release: releaseWorkflow
      ? `gh workflow run ${releaseWorkflow} --repo ${r}`
      : '（未配置 cd.releaseWorkflow：请先在 patch 里填发布工作流名，或用现有发布命令并把 stdout 作 evidence）',
    verify: healthUrl
      ? `curl -fsS -o /dev/null -w "%{http_code}" ${healthUrl}`
      : '（未配置 cd.healthUrl：请用 web_fetch / curl 核实线上并把输出作 evidence）',
  }
}

const CD_STAGE_HINT = {
  review: '把 reviewer 回执的 GATE 结论作为 verdict 传给 office_cd action=review。',
  checks: '把上面命令的 stdout 作为 evidence 传给 office_cd action=checks。',
  merge: '先由人执行 approve-phase.mjs --kind cd，再把 stdout 作 evidence 传给 office_cd action=merge。',
  release: '把 workflow run 的 stdout 作 evidence 传给 office_cd action=release。',
  verify: '把健康探测输出作 evidence 传给 office_cd action=verify。',
}

/** 按 CD record 当前状态给出下一步命令（供 office_cd action=status / commands 用）。 */
export function nextCommand(record, config = {}) {
  const cmds = cdCommands({
    prNumber: record?.prNumber,
    headSha: record?.headSha,
    repo: config.repo,
    releaseWorkflow: config.releaseWorkflow,
    healthUrl: config.healthUrl,
  })
  const stageOf = {
    PR_OPEN: 'review', REVIEW: 'review', CHECKS: 'checks',
    MERGED: 'release', RELEASED: 'verify',
  }
  const state = record?.state ?? null
  const stage = stageOf[state] ?? null
  if (!stage) {
    const hint = state === 'BLOCKED'
      ? 'BLOCKED：需人工决策 —— 修复后回到 REVIEW / CHECKS，或 office_cd action=abort。'
      : state === 'VERIFIED' || state === 'ABORTED'
        ? 'CD 已到终态，无下一步命令。'
        : '还没有 CD record，先 office_cd action=begin。'
    return { stage: null, command: null, hint, all: cmds }
  }
  return { stage, command: cmds[stage], hint: CD_STAGE_HINT[stage] ?? '', all: cmds }
}

/**
 * 解析 `gh pr view --json ...` 输出 → { headSha, prNumber, state }。
 * 不是 JSON 时返回 ok:false（调用方跳过校验，保持向后兼容）。
 */
export function parsePrView(text) {
  let doc
  try { doc = JSON.parse(String(text ?? '')) } catch { return { ok: false, reason: 'not-json' } }
  const pr = Array.isArray(doc) ? doc[0] : doc
  if (!pr || typeof pr !== 'object') return { ok: false, reason: 'empty' }
  const headSha = typeof pr.headRefOid === 'string' && pr.headRefOid ? pr.headRefOid : null
  const num = Number(pr.number)
  const prNumber = Number.isInteger(num) && num > 0 ? num : null
  return { ok: true, headSha, prNumber, state: typeof pr.state === 'string' ? pr.state : '' }
}

const FAIL_CONCLUSIONS = new Set([
  'failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale', 'error', 'failure ',
])
const PENDING_STATES = new Set(['pending', 'queued', 'in_progress', 'waiting', 'requested', 'running'])

/**
 * 解析 `gh pr checks --json ...` 输出 → pending / success / failure。
 * 与 forge-github 的口径一致：未完成 / 结论缺失 → pending；失败结论 → failure；
 * cancelled 也算非通过。不是 JSON 时返回 ok:false。
 */
export function parseChecks(text) {
  let doc
  try { doc = JSON.parse(String(text ?? '')) } catch { return { ok: false, reason: 'not-json' } }
  let rows = null
  if (Array.isArray(doc)) rows = doc
  else if (doc && Array.isArray(doc.checks)) rows = doc.checks
  else if (doc && Array.isArray(doc.check_runs)) rows = doc.check_runs
  if (!rows) return { ok: false, reason: 'no-checks-array' }

  let pending = false
  let failed = false
  for (const row of rows) {
    const state = String(row?.state ?? row?.status ?? '').toLowerCase().trim()
    const conclusion = String(row?.conclusion ?? '').toLowerCase().trim()
    if (PENDING_STATES.has(state) || (!state && !conclusion)) { pending = true; continue }
    if (FAIL_CONCLUSIONS.has(conclusion)) { failed = true; continue }
    // completed + success / neutral / skipped → 通过
  }
  return { ok: true, checksState: failed ? 'failure' : pending ? 'pending' : 'success', count: rows.length }
}

/** 把 gh 的 stderr 归类，供 CTO 判断「为什么这条命令没跑成」。 */
export function classifyGhFailure(text) {
  const s = String(text ?? '').toLowerCase()
  if (/not logged|authentication|401|bad credentials|gh auth login|unauthenticated/.test(s)) return 'unauthenticated'
  if (/could not resolve to a pull|not found|404|no pull requests/.test(s)) return 'not-found'
  if (/rate limit|403|api rate limit exceeded/.test(s)) return 'rate-limited'
  if (/sha|head ref|stale|did not match|expected|conflict/.test(s)) return 'stale'
  if (/network|timeout|timedout|etimedout|econn|could not connect|dns|unavailable/.test(s)) return 'unavailable'
  return 'unknown'
}
