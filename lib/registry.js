/**
 * 工作区 → 卡仓库 的注册表。
 *
 * 为什么需要它：`apply()` 时宿主还没有「用户工作区」这个信息，而进程 cwd 是
 * DSH 安装目录。若在 apply 时就建 store，`.cto-office/` 会被建到 app 目录里 ——
 * 这个错误比直接报错危险得多。所以仓库改为**按工作区懒建**，且必须先解析出
 * 一个显式工作区（见 resolveWorkspace 的「拒绝猜测」）。
 */
import { CardStore } from './store.js'

export class StoreRegistry {
  constructor(config = {}) {
    this.config = config
    this.byWorkspace = new Map()
  }

  /** 取（或懒建）某工作区的仓库。 */
  get(workspace) {
    if (!workspace) throw new Error('workspace 不能为空')
    let store = this.byWorkspace.get(workspace)
    if (!store) {
      store = new CardStore(workspace, { cardsDir: this.config.cardsDir })
      this.byWorkspace.set(workspace, store)
    }
    return store
  }

  /** 已建立的仓库（供守卫与监督器聚合）。 */
  all() {
    return [...this.byWorkspace.values()]
  }

  workspaces() {
    return [...this.byWorkspace.keys()]
  }
}
