/**
 * 工件层（方案 §4.3 2a）：契约与验收基线。
 *
 * 契约三条：
 *  1. 只有主检出有工件目录，且只有 CTO 经本模块写（worker 只读）。
 *  2. 工件版本冻结进卡（`artifactsVersion`），回执必须写「我读的是哪一版」。
 *  3. **卡进行期禁止改工件**（M-14）：要改就「作废重开」，否则 worker 按 v1 做、
 *     你按 v2 验，返工责任无法归因。
 *
 * 布局：<workspace>/.cto-office/cards/<id>/artifacts/<kind>.json
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readJsonStrict, replaceJson } from './atomic.js'
import { STATES, isTerminal } from './card.js'

export const ARTIFACT_KINDS = Object.freeze(['contracts', 'acceptance'])

export class ArtifactError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ArtifactError'
    this.code = code
  }
}

export class ArtifactStore {
  constructor(store) {
    this.store = store
  }

  dir(cardId) {
    return join(this.store.cardDir(cardId), 'artifacts')
  }

  path(cardId, kind) {
    if (!ARTIFACT_KINDS.includes(kind)) throw new ArtifactError('BAD_KIND', `未知工件类型 ${kind}（只支持 ${ARTIFACT_KINDS.join(' / ')}）`)
    return join(this.dir(cardId), `${kind}.json`)
  }

  read(cardId, kind) {
    const value = readJsonStrict(this.path(cardId, kind))
    return value
  }

  /** 当前版本号；不存在为 0。 */
  version(cardId, kind) {
    const doc = this.read(cardId, kind)
    return doc && Number.isInteger(doc.version) ? doc.version : 0
  }

  /** 版本三元组（方案里的 `artifactsVersion`）。 */
  versions(cardId) {
    const out = {}
    for (const kind of ARTIFACT_KINDS) out[kind] = this.version(cardId, kind)
    return out
  }

  /**
   * 写工件。进行期（DISPATCHED / CHANGES）直接拒绝 —— 见 M-14。
   * @returns {{kind, version, previous}}
   */
  write(cardId, kind, content, now = Date.now()) {
    const card = this.store.read(cardId)
    if (card && !isTerminal(card.state)) {
      throw new ArtifactError(
        'CARD_IN_PROGRESS',
        `卡 ${cardId} 正在执行（${card.state}），禁止改 ${kind}。要改就 office_release action=abandon 作废重开 —— 否则 worker 按旧版做、你按新版验，责任无法归因。`,
      )
    }
    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new ArtifactError('EMPTY_CONTENT', `${kind} 内容不能为空`)
    }
    const previous = this.version(cardId, kind)
    const doc = { schema: 'cto-office/artifact@1', kind, version: previous + 1, content, updatedAt: now }
    replaceJson(this.path(cardId, kind), doc)
    return { kind, version: doc.version, previous }
  }

  /**
   * 校验工件完备性。
   * acceptance 必填（判定对照物）；contracts 可选 —— 小卡没有契约也合理，
   * 但一旦冻结过（版本 > 0），就必须与卡内版本一致。
   */
  verify(card) {
    const problems = []
    const versions = this.versions(card.cardId)
    if (versions.acceptance === 0) problems.push('acceptance 工件不存在（没有对照物，闸门无从判起）')
    const frozen = card.artifactsVersion ?? {}
    for (const [kind, expected] of Object.entries(frozen)) {
      if (versions[kind] !== expected) {
        problems.push(`${kind} 版本 ${versions[kind]} ≠ 卡内冻结的 ${expected}`)
      }
    }
    const acceptance = this.read(card.cardId, 'acceptance')
    if (acceptance) {
      const ids = String(acceptance.content)
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => {
          const m = /^(?:[-*]\s*)?([A-Za-z]+\d+)/.exec(line)
          return m ? m[1] : null
        })
        .filter(Boolean)
      if (ids.length === 0) problems.push('acceptance 里没有可解析的编号条目（应形如 A1 / A2）')
      else if (card.acceptance?.length && ids.length !== card.acceptance.length) {
        problems.push(`acceptance 工件有 ${ids.length} 条，卡里记了 ${card.acceptance.length} 条`)
      }
    }
    return { ok: problems.length === 0, problems, versions }
  }
}

export { existsSync, dirname }
