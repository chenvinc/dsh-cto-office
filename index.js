/**
 * CTO 办公室 bundle 的 Host 半。
 *
 * v2.0 一期 A / W1 起，本包不再只是「预设 + 技能 + 面板」的壳：
 * 它注册三个判定工具与两条 pre-execute 守卫，把「单写者、越界必现」从章程搬进宿主。
 *
 * 设计约束（见 docs/dependency-manifest.md）：
 *  - 零 `@deepseek-ai/*` import。这些包在本机插件目录下会解析到 npx 缓存的旧 rc，
 *    与运行宿主版本不一致；所有能力通过 `ctx` 拿，工具定义用原生字面量。
 *  - 守卫自身出错必须放行，判定层不能把会话卡死。
 */
import { join } from 'node:path'
import { CardStore } from './lib/store.js'
import { buildTools } from './lib/tools.js'
import { makePreExecuteGuard } from './lib/guards.js'
import { Supervisor } from './lib/supervisor.js'

export const name = '@swiper1881/dsh-cto-office'

/**
 * tools 是必需的；timer 用来挂超时监督器（宿主已有服务，不自建定时器）。
 * timer 缺失不应让插件加载失败，所以它不在 inject 里，而是运行时探测。
 */
export const inject = ['tools']

const DEFAULTS = {
  maxConcurrentWriters: 1,
  writerPresets: ['cto-builder'],
  granularity: { maxFiles: 10, maxLines: 400, maxBehaviors: 1 },
  cardsDir: '.cto-office/cards',
  supervisor: { enabled: true, pollIntervalMs: 15 * 60 * 1000, queuedAlertMs: 60 * 60 * 1000 },
}

function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const workspaceRoot = typeof raw.workspaceRoot === 'string' && raw.workspaceRoot
    ? raw.workspaceRoot
    : (typeof process.cwd === 'function' ? process.cwd() : '.')
  return {
    workspaceRoot,
    maxConcurrentWriters: Number.isInteger(raw.maxConcurrentWriters) ? raw.maxConcurrentWriters : DEFAULTS.maxConcurrentWriters,
    writerPresets: Array.isArray(raw.writerPresets) && raw.writerPresets.length ? raw.writerPresets : DEFAULTS.writerPresets,
    granularity: { ...DEFAULTS.granularity, ...(raw.granularity ?? {}) },
    cardsDir: typeof raw.cardsDir === 'string' && raw.cardsDir ? raw.cardsDir : DEFAULTS.cardsDir,
    supervisor: { ...DEFAULTS.supervisor, ...(raw.supervisor ?? {}) },
  }
}

/**
 * 该 step 是否属于 CTO（root 预设）。
 *
 * 用 `ToolRegistrationOptions.when` 把三个工具收窄到 CTO 一个岗位 —— 否则办公室里的
 * 每个角色都会看到 office_dispatch，等于把派工权扩散出去（与「只有根能派工」冲突）。
 *
 * 取不到预设信息时**放行**：判定层宁可少收窄，也不能让工具凭空消失（§6.1 失败即放行）。
 */
function makeWhenCto(ap) {
  return (activation) => {
    if (!ap?.presetForSession) return true
    try {
      const preset = ap.presetForSession(activation.agent.session)
      if (typeof preset !== 'string' || preset.length === 0) return true
      return preset === 'cto-office'
    } catch {
      return true
    }
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const store = new CardStore(resolved.workspaceRoot, { cardsDir: resolved.cardsDir })

  // 超时监督器：一期 A 只做「QUEUED 持有者 idle」这一条最小报警。
  let supervisor
  if (resolved.supervisor.enabled !== false) {
    supervisor = new Supervisor(store, {
      pollIntervalMs: resolved.supervisor.pollIntervalMs,
      queuedAlertMs: resolved.supervisor.queuedAlertMs,
    })
    resolved.supervisorInstance = supervisor
  }

  const tools = buildTools(ctx, { store, config: resolved })

  // agentPresets 是可选依赖：拿不到就不收窄（放行），不因此让整个插件加载失败。
  const ap = (() => { try { return ctx.agentPresets } catch { return undefined } })()
  const when = makeWhenCto(ap)

  let dispose = () => {}
  ctx.effect?.(() => {
    for (const tool of [tools.dispatch, tools.gate, tools.release, tools.status]) {
      dispose = ctx.tools.register(tool, { when })
    }
    return () => { try { dispose() } catch {} }
  })

  ctx.on('tools/pre-execute', makePreExecuteGuard({ store, config: resolved }))

  // 挂到宿主 timer 服务；没有就明确跳过（不偷偷改成 setInterval）。
  if (supervisor) {
    const stopTimer = supervisor.attach(ctx)
    ctx.effect?.(() => stopTimer)
  }

  // 供后续阶段（evidence 白名单、超时监督器）复用的内部句柄。
  try { ctx.set?.('ctoOffice', { store, config: resolved }) } catch { /* 可选 */ }
}
