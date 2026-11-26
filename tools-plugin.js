/**
 * 宿主半的「工具与守卫」入口 —— 挂在 **cto-office 预设自己的 plugins 里**，不是全局。
 *
 * 为什么这么挂（W0 真机反馈 ①）：
 * 最初在全局 host 半用 `ToolRegistrationOptions.when` + `agentPresets.presetForSession`
 * 做收窄。但 cordis 对未 inject 的服务属性裸读会抛错，而 `inject` 没有「可选」语义 ——
 * 拿不到 `agentPresets` 就只能 catch 成 undefined，`when` 随即恒返回 true，
 * 结果**所有 agent（含 standard 会话与 worker 子会话）都拿到了 office_* 工具**。
 *
 * 正解是按设计原本的原则「能力层剥夺」：把工具注册进 CTO 预设的作用域，
 * 隔离由**组装层**负责，而不是运行时判定。这样没有 fail-open 的可能。
 */
import { join } from 'node:path'
import { StoreRegistry } from './lib/registry.js'
import { buildTools } from './lib/tools.js'
import { makePreExecuteGuard } from './lib/guards.js'
import { makePostExecuteReceiptGuard } from './lib/receipt-guard.js'
import { makeReceiptCollector } from './lib/receipt-collector.js'
import { Supervisor } from './lib/supervisor.js'
import { resolveRoleModels } from './lib/role-models.js'

export const name = 'cto-office-tools'

/** 只依赖工具注册表；timer 与 agentPresets 都是可选能力（探测式使用）。 */
export const inject = ['tools']

const DEFAULTS = {
  maxConcurrentWriters: 1,
  writerPresets: ['cto-builder'],
  // 宿主 `subagent` 的默认 preset（patch 里 delegation.agentPreset = cto-builder）。
  // 省略 agent_preset 时按写岗处理，否则一个参数就能绕过两道守卫。
  defaultAgentPreset: 'cto-builder',
  granularity: { maxFiles: 10, maxLines: 400, maxBehaviors: 1 },
  cardsDir: '.cto-office/cards',
  // 三段超时合成一个监督器（方案 §14.5）：阈值全是参数，且支持扁平老写法。
  supervisor: {
    enabled: true,
    pollIntervalMs: 15 * 60 * 1000,
    queuedAlert: { thresholdMs: 60 * 60 * 1000, escalateAfter: 2 },
    exclusiveTtl: { thresholdMs: 45 * 60 * 1000 },
    cardIdleReclaim: { thresholdMs: 120 * 60 * 1000 },
  },
  // M-14 第一处：改判定器本身需人工确认。审批文件在工作区之外（agent 写不到）。
  patchApproval: { path: undefined, ttlMs: 30 * 60 * 1000 },
  // M-7 可落地部分：岗位 → 模型/档位。默认表见 lib/role-models.js；这里只放覆盖项。
  // enforceRoleModels=false 可临时关掉校验（不推荐，等于让岗位表变成建议）。
  roleModels: {},
  enforceRoleModels: true,
}

/**
 * 监督器配置：嵌套写法优先，同时兼容老的扁平键（queuedAlertMs / exclusiveTtlMs / escalateAfter）。
 * 阈值是参数不是常量 —— 这份解析是**唯一**归一化点，看板与监督器都从这里取。
 */
function resolveSupervisor(rawSupervisor, rawRoot = {}) {
  const raw = rawSupervisor && typeof rawSupervisor === 'object' ? rawSupervisor : {}
  const base = DEFAULTS.supervisor
  return {
    enabled: raw.enabled !== false,
    pollIntervalMs: Number.isFinite(raw.pollIntervalMs) ? raw.pollIntervalMs : base.pollIntervalMs,
    queuedAlert: {
      thresholdMs: raw.queuedAlert?.thresholdMs ?? (Number.isFinite(raw.queuedAlertMs) ? raw.queuedAlertMs : base.queuedAlert.thresholdMs),
      escalateAfter: raw.queuedAlert?.escalateAfter ?? (Number.isFinite(raw.escalateAfter) ? raw.escalateAfter : base.queuedAlert.escalateAfter),
    },
    exclusiveTtl: {
      thresholdMs: raw.exclusiveTtl?.thresholdMs
        ?? (Number.isFinite(raw.exclusiveTtlMs) ? raw.exclusiveTtlMs : Number.isFinite(rawRoot.exclusiveTtlMs) ? rawRoot.exclusiveTtlMs : base.exclusiveTtl.thresholdMs),
    },
    cardIdleReclaim: {
      thresholdMs: raw.cardIdleReclaim?.thresholdMs ?? (Number.isFinite(raw.cardIdleReclaimMs) ? raw.cardIdleReclaimMs : base.cardIdleReclaim.thresholdMs),
    },
  }
}

function resolveConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    workspaceRoot: typeof raw.workspaceRoot === 'string' && raw.workspaceRoot ? raw.workspaceRoot : undefined,
    maxConcurrentWriters: Number.isInteger(raw.maxConcurrentWriters) ? raw.maxConcurrentWriters : DEFAULTS.maxConcurrentWriters,
    writerPresets: Array.isArray(raw.writerPresets) && raw.writerPresets.length ? raw.writerPresets : DEFAULTS.writerPresets,
    defaultAgentPreset: typeof raw.defaultAgentPreset === 'string' && raw.defaultAgentPreset ? raw.defaultAgentPreset : DEFAULTS.defaultAgentPreset,
    granularity: { ...DEFAULTS.granularity, ...(raw.granularity ?? {}) },
    cardsDir: typeof raw.cardsDir === 'string' && raw.cardsDir ? raw.cardsDir : DEFAULTS.cardsDir,
    supervisor: resolveSupervisor(raw.supervisor, raw),
    exclusiveTtlMs: Number.isFinite(raw.exclusiveTtlMs) ? raw.exclusiveTtlMs : DEFAULTS.supervisor.exclusiveTtlMs,
    // M-12 双门槛：阈值是参数不是常量（周期长度、样本门槛、连续周期数、各比率阈值都可调）。
    metrics: raw.metrics && typeof raw.metrics === 'object' ? raw.metrics : {},
    patchApproval: { ...DEFAULTS.patchApproval, ...(raw.patchApproval ?? {}) },
    roleModels: raw.roleModels && typeof raw.roleModels === 'object' ? raw.roleModels : {},
    enforceRoleModels: raw.enforceRoleModels !== false,
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  // 岗位表解析一次：坏项打印出来但不阻断启动（宁可少管，不要管错）。
  const roleModelResolution = resolveRoleModels(resolved.roleModels)
  resolved.roleModelTable = roleModelResolution.table
  for (const problem of roleModelResolution.problems) {
    try { ctx.log?.warn?.(`cto-office: 岗位模型表配置有问题，已忽略该项 —— ${problem}`) } catch {}
  }
  const registry = new StoreRegistry({ cardsDir: resolved.cardsDir })

  const supervisors = new Map()
  const supervisorFor = workspace => {
    if (resolved.supervisor.enabled === false) return undefined
    let sup = supervisors.get(workspace)
    if (!sup) {
      sup = new Supervisor(registry.get(workspace), {
        pollIntervalMs: resolved.supervisor.pollIntervalMs,
        queuedAlert: resolved.supervisor.queuedAlert,
        exclusiveTtl: resolved.supervisor.exclusiveTtl,
        cardIdleReclaim: resolved.supervisor.cardIdleReclaim,
      })
      supervisors.set(workspace, sup)
    }
    return sup
  }
  resolved.supervisorInstance = { get: supervisorFor }

  const tools = buildTools(ctx, { registry, config: resolved })
  let dispose = () => {}
  ctx.effect?.(() => {
    const disposers = Object.values(tools).map(tool => ctx.tools.register(tool))
    dispose = () => { for (const d of disposers) { try { d() } catch {} } }
    return () => { try { dispose() } catch {} }
  })

  ctx.on('tools/pre-execute', makePreExecuteGuard({ registry, config: resolved }))
  ctx.on('tools/post-execute', makePostExecuteReceiptGuard({ registry, config: resolved }))
  // 子代理的最终回执随「完成通知」回来，不经过 post-execute —— 只能从会话事件里捡。
  // P1 的来源校验需要「这个会话是哪个 preset」：cordis 对未 inject 的服务属性裸读会抛，
  // 所以照例 try/catch 探测，拿不到就只记事实、不据此打回（判定留在 gate）。
  let agentPresets
  try { agentPresets = ctx.agentPresets } catch { agentPresets = undefined }
  ctx.on('session/event', makeReceiptCollector({ registry, agentPresets }))

  let timer
  try { timer = ctx.timer } catch { timer = undefined }
  if (resolved.supervisor.enabled !== false && timer && typeof timer.interval === 'function') {
    const stop = timer.interval(() => {
      for (const workspace of registry.workspaces()) {
        try {
          for (const alert of supervisorFor(workspace).tick()) {
            try { ctx.log?.warn?.(alert.message) } catch {}
          }
        } catch {}
      }
    }, resolved.supervisor.pollIntervalMs)
    ctx.effect?.(() => stop)
  }
}

export { join as _join }
