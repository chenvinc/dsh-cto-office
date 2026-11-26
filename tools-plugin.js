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
  supervisor: { enabled: true, pollIntervalMs: 15 * 60 * 1000, queuedAlertMs: 60 * 60 * 1000, exclusiveTtlMs: 45 * 60 * 1000 },
  // M-14 第一处：改判定器本身需人工确认。审批文件在工作区之外（agent 写不到）。
  patchApproval: { path: undefined, ttlMs: 30 * 60 * 1000 },
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
    supervisor: { ...DEFAULTS.supervisor, ...(raw.supervisor ?? {}) },
    exclusiveTtlMs: Number.isFinite(raw.exclusiveTtlMs) ? raw.exclusiveTtlMs : DEFAULTS.supervisor.exclusiveTtlMs,
    patchApproval: { ...DEFAULTS.patchApproval, ...(raw.patchApproval ?? {}) },
  }
}

export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const registry = new StoreRegistry({ cardsDir: resolved.cardsDir })

  const supervisors = new Map()
  const supervisorFor = workspace => {
    if (resolved.supervisor.enabled === false) return undefined
    let sup = supervisors.get(workspace)
    if (!sup) {
      sup = new Supervisor(registry.get(workspace), {
        pollIntervalMs: resolved.supervisor.pollIntervalMs,
        queuedAlertMs: resolved.supervisor.queuedAlertMs,
        exclusiveTtlMs: resolved.exclusiveTtlMs,
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
  ctx.on('session/event', makeReceiptCollector({ registry }))

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
