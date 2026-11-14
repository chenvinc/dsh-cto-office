/* CTO 办公室 · 办公室信息流（浏览器半）
 *
 * 这是 package.json `dsh.client` 声明的 classic script：不能出现 import/export，
 * 只能 require() 宿主白名单里的模块。右栏面板读的是已有的 session 事件通道
 * （ctx.sessions.retain → binding.eventSource）与 subagentCatalog 投影，
 * 不新建 HTTP / SSE / Host 路由。
 *
 * retain 的 source 名登记为 `cto-office/liveboard`。它不在
 * `SessionReferenceSourceMap`（packages/api/session-controller/src/client/index.ts 的声明合并）
 * 里，宿主运行期不校验，只用于诊断与归属；宿主开始校验时，需在那个声明合并里补上
 * 这一条（`interface SessionReferenceSourceMap { 'cto-office/liveboard': true }`）。
 *
 * `OFFICE_FACTS` 由 scripts/sync-office-data.mjs 注入，禁止手写。
 */
/* office-facts:start */
var OFFICE_FACTS = {
  "schema": "cto-office/office-data@2",
  "theme": {
    "accent": "#5ac8fa",
    "ok": "#7fe0a8",
    "warn": "#f2c66d",
    "bad": "#ff8f8f"
  },
  "steps": [
    {
      "id": "clarify",
      "label": "澄清"
    },
    {
      "id": "open-card",
      "label": "开卡"
    },
    {
      "id": "dispatch",
      "label": "派工"
    },
    {
      "id": "follow",
      "label": "跟进"
    },
    {
      "id": "gate",
      "label": "闸门"
    },
    {
      "id": "settle",
      "label": "结算"
    }
  ],
  "rootPreset": "cto-office",
  "gateRoles": [
    "cto-reviewer",
    "cto-qa"
  ],
  "presets": [
    {
      "id": "cto-office",
      "name": "CTO 办公室",
      "role": "CTO",
      "order": 20,
      "isRoot": true,
      "canDispatch": true,
      "tools": {
        "read": true,
        "write": true,
        "edit": true,
        "applyPatch": false,
        "bash": true,
        "pwsh": true,
        "search": true,
        "jobs": true,
        "todo": true,
        "web": true,
        "askUser": true,
        "present": true,
        "goal": true,
        "office": true,
        "subagent": true,
        "skill": true,
        "fsSearch": true
      }
    },
    {
      "id": "cto-architect",
      "name": "CTO 办公室 · 架构师",
      "role": "架构师",
      "order": 21,
      "tools": {
        "read": true,
        "write": false,
        "edit": false,
        "applyPatch": false,
        "bash": true,
        "pwsh": true,
        "search": true,
        "jobs": false,
        "todo": true,
        "web": true,
        "askUser": false,
        "present": false,
        "goal": false,
        "office": false,
        "subagent": false,
        "skill": true,
        "fsSearch": true
      }
    },
    {
      "id": "cto-builder",
      "name": "CTO 办公室 · 工程师",
      "role": "工程师",
      "order": 22,
      "tools": {
        "read": true,
        "write": true,
        "edit": true,
        "applyPatch": false,
        "bash": true,
        "pwsh": true,
        "search": true,
        "jobs": true,
        "todo": true,
        "web": false,
        "askUser": false,
        "present": false,
        "goal": false,
        "office": false,
        "subagent": false,
        "skill": true,
        "fsSearch": true
      }
    },
    {
      "id": "cto-reviewer",
      "name": "CTO 办公室 · 评审",
      "role": "评审",
      "order": 23,
      "tools": {
        "read": true,
        "write": false,
        "edit": false,
        "applyPatch": false,
        "bash": true,
        "pwsh": true,
        "search": true,
        "jobs": false,
        "todo": true,
        "web": false,
        "askUser": false,
        "present": false,
        "goal": false,
        "office": false,
        "subagent": false,
        "skill": true,
        "fsSearch": true
      }
    },
    {
      "id": "cto-qa",
      "name": "CTO 办公室 · QA",
      "role": "QA",
      "order": 24,
      "tools": {
        "read": true,
        "write": false,
        "edit": false,
        "applyPatch": false,
        "bash": true,
        "pwsh": true,
        "search": true,
        "jobs": false,
        "todo": true,
        "web": false,
        "askUser": false,
        "present": false,
        "goal": false,
        "office": false,
        "subagent": false,
        "skill": true,
        "fsSearch": true
      }
    },
    {
      "id": "cto-ux",
      "name": "CTO 办公室 · UI/UX 设计",
      "role": "UI/UX 设计",
      "order": 25,
      "tools": {
        "read": true,
        "write": false,
        "edit": false,
        "applyPatch": false,
        "bash": true,
        "pwsh": true,
        "search": true,
        "jobs": false,
        "todo": true,
        "web": true,
        "askUser": false,
        "present": false,
        "goal": false,
        "office": false,
        "subagent": false,
        "skill": true,
        "fsSearch": true
      }
    },
    {
      "id": "cto-product",
      "name": "CTO 办公室 · 业务",
      "role": "业务",
      "order": 26,
      "tools": {
        "read": true,
        "write": false,
        "edit": false,
        "applyPatch": false,
        "bash": true,
        "pwsh": true,
        "search": true,
        "jobs": false,
        "todo": true,
        "web": true,
        "askUser": false,
        "present": false,
        "goal": false,
        "office": false,
        "subagent": false,
        "skill": true,
        "fsSearch": true
      }
    }
  ]
};
/* office-facts:end */

;(function () {
  'use strict'

  var KIND = 'cto-office.role-feed'
  var TAB_ID = '@chy/dsh-cto-office:role-feed'
  var DISMISS_KEY = 'cto-office.role-feed.dismissed'
  var NOOP = function () {}
  var EMPTY_SNAP = { entries: [], hasMore: false, revision: 0 }

  /* 提示条的关闭状态：按 session 存 sessionStorage。storage 不可用（隐私模式/配额满）
   * 就只活在本次渲染——不抛错、不把面板打到兜底卡。 */
  var DISMISS_STORE = 'cto-office/feed-dismiss@1:'
  var EMPTY_DISMISS = { confirm: '', window: false, faults: {}, presets: {} }

  function readDismiss(sessionId) {
    try {
      var raw = window.sessionStorage.getItem(DISMISS_STORE + (sessionId || ''))
      if (!raw) return { confirm: '', window: false, faults: {}, presets: {} }
      var parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return { confirm: '', window: false, faults: {}, presets: {} }
      return {
        confirm: typeof parsed.confirm === 'string' ? parsed.confirm : '',
        window: parsed.window === true,
        faults: parsed.faults && typeof parsed.faults === 'object' ? parsed.faults : {},
        presets: parsed.presets && typeof parsed.presets === 'object' ? parsed.presets : {}
      }
    } catch (error) { return { confirm: '', window: false, faults: {}, presets: {} } }
  }

  function writeDismiss(sessionId, state) {
    try { window.sessionStorage.setItem(DISMISS_STORE + (sessionId || ''), JSON.stringify(state)) } catch (error) { /* 只活在本次渲染 */ }
  }

  function str(v) {
    return typeof v === 'string' ? v : ''
  }

  /* 凭据先替换再截断：截断会把密钥切掉一半但仍留在 DOM 里，所以顺序不能反。 */
  var SECRET_RULES = [
    /sk-[A-Za-z0-9_-]{8,}/g,
    /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    /ghp_[A-Za-z0-9]{20,}/g,
    /github_pat_[A-Za-z0-9_]{20,}/g,
    /AKIA[0-9A-Z]{16}/g,
    /(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi
  ]

  function sanitize(text) {
    var s = String(text == null ? '' : text)
    for (var i = 0; i < SECRET_RULES.length; i += 1) s = s.replace(SECRET_RULES[i], '‹已隐藏›')
    return s
  }

  function clip(text, max) {
    var s = sanitize(text).replace(/\s+/g, ' ').trim()
    return s.length > max ? s.slice(0, max - 1) + '…' : s
  }

  /* 原始事件（E 层）要读全文：只脱敏、不压行，单条上限 2000 字符；
   * 超了在末尾显式写明截断与原文长度，别把正文悄悄吃掉。 */
  var FULL_MAX = 2000

  function fullOf(text) {
    var s = sanitize(String(text == null ? '' : text)).replace(/[ \t]+/g, ' ').trim()
    if (s.length <= FULL_MAX) return s
    return s.slice(0, FULL_MAX) + '…（已截断，共 ' + s.length + ' 字符）'
  }

  function formatDuration(ms) {
    /* NaN / Infinity 都是「算不出来」，不是「0 秒」：返回空串，由渲染处落 — */
    if (!ms || !isFinite(ms)) return ''
    var s = Math.round(ms / 1000)
    if (s < 60) return s + 's'
    var m = Math.floor(s / 60)
    return m + 'm' + String(s % 60).padStart(2, '0') + 's'
  }

  function textOf(value) {
    var out = []
    var seen = 0
    function walk(v, depth) {
      if (v == null || seen > 2400) return
      if (typeof v === 'string') { out.push(v); seen += v.length; return }
      if (typeof v !== 'object' || depth > 5) return
      if (Array.isArray(v)) { for (var i = 0; i < v.length; i += 1) walk(v[i], depth + 1); return }
      if (typeof v.text === 'string') { out.push(v.text); seen += v.text.length }
      if (typeof v.content === 'string') { out.push(v.content); seen += v.content.length }
      else if (v.content) walk(v.content, depth + 1)
      if (v.message) walk(v.message, depth + 1)
    }
    walk(value, 0)
    return out.join(' ')
  }

  function argHint(raw, full) {
    if (typeof raw !== 'string' || raw === '') return ''
    var parsed = null
    try { parsed = JSON.parse(raw) } catch (error) { return full ? fullOf(raw) : clip(raw, 80) }
    if (parsed == null || typeof parsed !== 'object') return full ? fullOf(String(parsed)) : clip(String(parsed), 80)
    var keys = ['description', 'prompt', 'command', 'cmd', 'path', 'pattern', 'query', 'title']
    for (var i = 0; i < keys.length; i += 1) {
      if (typeof parsed[keys[i]] === 'string' && parsed[keys[i]] !== '') return full ? fullOf(parsed[keys[i]]) : clip(parsed[keys[i]], 80)
    }
    return ''
  }

  function gateOfText(text) {
    var lines = String(text || '').split(/\r?\n/).map(function (line) { return line.trim() }).filter(Boolean)
    if (!lines.length) return ''
    var m = /^GATE:\s*(PASS|CHANGES|FAIL)\b/.exec(lines[lines.length - 1])
    return m ? m[1] : ''
  }

  function eventGate(event) {
    if (event.type !== 'assistant/message' && event.type !== 'tool/result') return ''
    return gateOfText(textOf(event.data))
  }

  function catalogOf(value) {
    if (Array.isArray(value)) return value
    if (value && Array.isArray(value.entries)) return value.entries
    return []
  }

  function readPresetFromList(ctx, id) {
    try {
      var snap = ctx.sessions.list.getSnapshot()
      var row = snap.byId[id]
      var values = row && row.projectionValues
      var preset = values && values.agentPreset
      return typeof preset === 'string' && preset !== '' ? preset : ''
    } catch (error) { return '' }
  }

  var presetCache = new Map()
  var retainActive = 0
  var retainWaiting = []
  var RETAIN_LIMIT = 8

  function pumpRetain() {
    while (retainActive < RETAIN_LIMIT && retainWaiting.length) {
      var job = retainWaiting.shift()
      retainActive += 1
      Promise.resolve().then(job.task).then(function (value) {
        retainActive -= 1
        job.resolve(value)
        pumpRetain()
      }, function (error) {
        retainActive -= 1
        job.reject(error)
        pumpRetain()
      })
    }
  }

  function scheduleRetain(task) {
    return new Promise(function (resolve, reject) {
      retainWaiting.push({ task: task, resolve: resolve, reject: reject })
      pumpRetain()
    })
  }

  /* 解析成功resolve({preset,reason:''})；失败 resolve({preset:'',reason})，由面板把
   * 这个子会话挂到「未识别」一行，而不是从信息流里静默删掉。 */
  function resolvePreset(ctx, child) {
    var cached = presetCache.get(child.id)
    if (cached) return Promise.resolve({ preset: cached, reason: '' })
    var listed = readPresetFromList(ctx, child.id)
    if (listed) { presetCache.set(child.id, listed); return Promise.resolve({ preset: listed, reason: '' }) }
    return scheduleRetain(function () {
      var target = childTarget(child, child.parentSessionId)
      var ref = null
      var reason = ''
      try { ref = ctx.sessions.retain(target, { source: 'cto-office/liveboard' }) }
      catch (error) { return { preset: '', reason: clip(error && error.message ? error.message : String(error), 80) } }
      return Promise.resolve(ref.ready).then(function () {
        var face = ref.binding.session.projections.faceOf('agentPreset')
        var value = face.getSnapshot()
        var preset = typeof value === 'string' ? value : ''
        if (preset) presetCache.set(child.id, preset)
        else reason = '会话没有 agentPreset 投影'
        return { preset: preset, reason: preset ? '' : reason }
      }).catch(function (error) {
        return { preset: '', reason: clip(error && error.message ? error.message : String(error), 80) || '读取 agentPreset 失败' }
      }).then(function (result) {
        try { ref.release() } catch (error) { /* already gone */ }
        return result
      })
    })
  }

  function childTarget(child, parentSessionId) {
    return child.mode === 'one-shot' || child.mode === 'continuable' || child.mode === 'unknown'
      ? { parentSessionId: parentSessionId, childSessionId: child.id, mode: child.mode }
      : child.id
  }

  function statusOfRole(role, children, feeds, rootRunning, rootEvents, needsConfirm) {
    if (role.isRoot) {
      if (needsConfirm) return 'blocked'
      if (rootRunning) return 'running'
      return rootEvents.length ? 'returned' : 'idle'
    }
    if (!children.length) return 'idle'
    var anyFail = false
    var anyGate = false
    for (var i = 0; i < feeds.length; i += 1) {
      var g = feeds[i] && feeds[i].gate
      if (g === 'FAIL') anyFail = true
      else if (g) anyGate = true
    }
    if (anyFail) return 'blocked'
    if (anyGate) return 'returned'
    if (rootRunning) return 'running'
    return 'returned'
  }

  function roleGateOf(feeds) {
    var best = ''
    var rank = { FAIL: 3, CHANGES: 2, PASS: 1 }
    for (var i = 0; i < feeds.length; i += 1) {
      var g = feeds[i] && feeds[i].gate
      if (g && (rank[g] || 0) > (rank[best] || 0)) best = g
    }
    return best
  }

  function turnElapsed(events) {
    var ui = -1
    for (var i = 0; i < events.length; i += 1) if (events[i].type === 'user/message') ui = i
    if (ui < 0) return ''
    for (var j = events.length - 1; j > ui; j -= 1) {
      if (events[j].type === 'assistant/message') {
        var start = events[ui].time || 0
        var end = events[j].time || start
        return formatDuration(Math.max(0, end - start))
      }
    }
    return ''
  }

  function gateChip(status) {
    if (status === 'PASS') return { text: 'PASS', symbol: '✓', cls: 'ok' }
    if (status === 'CHANGES') return { text: 'CHANGES', symbol: '!', cls: 'warn' }
    if (status === 'FAIL') return { text: 'FAIL', symbol: '✕', cls: 'bad' }
    return { text: '待判定', symbol: '·', cls: 'idle' }
  }

  var CSS = [
    '.co-panel{container-type:inline-size;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--co-bg,#0a0d11);color:var(--co-text,#e8eef4);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;--co-bg:#0a0d11;--co-panel:#11171e;--co-panel-2:#0c1218;--co-line:#232c37;--co-line-2:#33404e;--co-text:#e8eef4;--co-muted:#94a3b2;--co-dim:#6f8090;--co-accent:#5ac8fa;--co-ok:#7fe0a8;--co-warn:#f2c66d;--co-bad:#ff8f8f;--co-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono","Courier New",monospace}',
    '.co-panel *{box-sizing:border-box;min-width:0}',
    '.co-shell{display:flex;flex-direction:column;min-height:0;height:100%;overflow:hidden}',
    '.co-head{flex:none;padding:10px 12px 8px;border-bottom:1px solid var(--co-line);background:linear-gradient(180deg,#121a22,#0c1218)}',
    '.co-title{display:flex;align-items:center;gap:8px;justify-content:space-between}',
    '.co-title h2{margin:0;font-size:13.5px;letter-spacing:.01em}',
    '.co-title .co-badge{font:10.5px var(--co-mono);color:var(--co-muted);border:1px solid var(--co-line-2);border-radius:999px;padding:1px 7px;white-space:nowrap}',
    '.co-sum{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 6px;margin-top:6px;font-size:11px;color:var(--co-muted)}',
    '.co-sep{color:var(--co-muted);font-weight:700;opacity:1;margin:0 -1px}',
    '.co-pending{color:var(--co-muted)}',
    '.co-sum b{color:var(--co-text);font-weight:600;font-family:var(--co-mono);font-size:11px}',
    '.co-steps{flex:none;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px;padding:8px 12px;border-bottom:1px solid var(--co-line)}',
    '.co-step{appearance:none;border:1px solid var(--co-line);background:var(--co-panel-2);color:var(--co-muted);border-radius:6px;padding:5px 3px;font:11px/1.2 inherit;cursor:pointer;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.co-step[aria-current="step"]{border-color:var(--co-accent);color:var(--co-text);background:color-mix(in srgb,var(--co-accent) 10%,transparent)}',
    '.co-step .co-infer{display:block;font:9px var(--co-mono);color:var(--co-dim);margin-top:2px}',
    /* 默认 block、显示态 flex：关闭态是条件渲染，data-show 只在显示态出现 */
    '.co-strip{flex:none;display:block;margin:8px 12px 0;padding:7px 9px;border:1px solid var(--co-line-2);border-radius:6px;font-size:11.5px;color:var(--co-muted);background:var(--co-panel-2)}',
    '.co-strip[data-show="true"]{display:flex;align-items:flex-start;gap:8px}',
    '.co-strip-t{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}',
    '.co-strip-x{flex:none;appearance:none;width:20px;height:20px;padding:0;display:flex;align-items:center;justify-content:center;border:1px solid transparent;border-radius:4px;background:transparent;color:inherit;font:14px/1 inherit;cursor:pointer;opacity:.65}',
    '.co-strip-x:hover{opacity:1;border-color:currentColor}',
    '.co-strip-x:focus-visible{outline:2px solid currentColor;outline-offset:1px}',
    '.co-strip-action[data-show="true"]{display:block}',
    '.co-strip[data-tone="warn"]{border-color:color-mix(in srgb,var(--co-warn) 45%,transparent);color:var(--co-warn)}',
    '.co-strip[data-tone="bad"]{border-color:color-mix(in srgb,var(--co-bad) 45%,transparent);color:var(--co-bad)}',
    '.co-strip-action{appearance:none;width:calc(100% - 24px);text-align:left;font:11.5px/1.5 inherit;cursor:pointer}',
    '.co-strip-action:hover{border-color:var(--co-bad);text-decoration:underline}',
    '.co-strip-action:focus-visible{outline:2px solid var(--co-bad);outline-offset:1px}',
    '.co-list{flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px 10px;display:flex;flex-direction:column;gap:7px;scrollbar-gutter:stable}',
    '.co-card{flex:0 0 auto;border:1px solid var(--co-line);border-radius:8px;background:var(--co-panel);overflow:hidden}',
    '.co-card[data-status="running"]{border-color:var(--co-line-2)}',
    '.co-card[data-status="blocked"]{border-color:color-mix(in srgb,var(--co-bad) 45%,transparent)}',
    '.co-card[data-status="returned"]{border-color:color-mix(in srgb,var(--co-ok) 30%,transparent)}',
    '.co-card-head{display:flex;align-items:center;gap:7px;width:100%;padding:7px 9px;background:transparent;border:0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
    '.co-dot{width:7px;height:7px;border-radius:50%;background:var(--co-dim);flex:none}',
    '.co-card[data-status="running"] .co-dot{background:var(--co-accent)}',
    '.co-card[data-status="returned"] .co-dot{background:var(--co-ok)}',
    '.co-card[data-status="blocked"] .co-dot{background:var(--co-bad)}',
    '.co-card[data-status="idle"] .co-dot{background:var(--co-dim)}',
    '.co-role{font-weight:600;font-size:12.5px;white-space:nowrap}',
    '.co-preset{font:10px var(--co-mono);color:var(--co-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.co-card-head .co-spacer{flex:1 1 auto}',
    '.co-gate{display:inline-flex;align-items:center;gap:3px;font:10px var(--co-mono);border:1px solid var(--co-line-2);border-radius:999px;padding:1px 6px;color:var(--co-muted);white-space:nowrap}',
    '.co-gate[data-gate="PASS"]{color:var(--co-ok);border-color:color-mix(in srgb,var(--co-ok) 50%,transparent)}',
    '.co-gate[data-gate="CHANGES"]{color:var(--co-warn);border-color:rgba(242,198,109,.5)}',
    '.co-gate[data-gate="FAIL"]{color:var(--co-bad);border-color:color-mix(in srgb,var(--co-bad) 50%,transparent)}',
    '.co-gate .co-sym{font-weight:700}',
    '.co-last{padding:0 9px 7px 24px;font-size:11px;color:var(--co-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.co-body{border-top:1px solid var(--co-line);padding:6px 9px 8px;background:var(--co-panel-2)}',
    '.co-run + .co-run{border-top:1px dashed var(--co-line-2);margin-top:6px;padding-top:6px}',
    '.co-run-h{font:10.5px var(--co-mono);color:var(--co-muted);margin:0 0 4px}',
    '.co-ev{list-style:none;display:flex;gap:6px;padding:3px 0;font-size:11px;color:var(--co-muted);align-items:baseline}',
    '.co-ev code{font:10px var(--co-mono);color:var(--co-dim);flex:none}',
    '.co-ev[data-kind="tool-call"] .co-ev-t{color:var(--co-accent)}',
    '.co-ev[data-kind="tool-result"] .co-ev-t{color:var(--co-text)}',
    '.co-ev[data-kind="user"] .co-ev-t{color:var(--co-text)}',
    /* 证据正文要读全文：不 nowrap、不 ellipsis，长串（路径/命令）按字符折行 */
    '.co-ev-t{flex:1 1 auto;min-width:0;white-space:pre-wrap;overflow-wrap:anywhere}',
    /* 单条默认只显示 3 行（原始事件动辄几百字，全文一撑卡片就几屏）；
     * data-full 由「展开全文」按钮/B 层「看原始回执」切换，展开后不裁剪。 */
    '.co-ev-b{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}',
    '.co-ev-b[data-full="true"]{display:block;overflow:visible;-webkit-line-clamp:none}',
    '.co-ev-btn{flex:none;font-size:10.5px;padding:0 2px}',
    '.co-new{width:5px;height:5px;border-radius:50%;background:var(--co-accent);flex:none}',
    /* 原始事件列表不设上限（原先 max-height:240 让卡里多一层滚动）：外层 .co-list 是唯一滚动容器 */
    '.co-ops{list-style:none;margin:0;padding:0}',
    '.co-empty{padding:18px 8px;text-align:center;color:var(--co-dim);font-size:12px}',
    '.co-foot{flex:none;border-top:1px solid var(--co-line);padding:6px 10px;display:flex;align-items:center;gap:10px;justify-content:center;background:var(--co-panel-2)}',
    '.co-return{margin-left:auto;display:none;appearance:none;border:1px solid var(--co-accent);background:color-mix(in srgb,var(--co-accent) 12%,transparent);color:var(--co-accent);border-radius:999px;padding:4px 12px;font:11.5px inherit;cursor:pointer}',
    '.co-return[data-show="true"]{display:inline-flex;gap:5px;align-items:center}',
    '.co-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
    '.co-card[data-expanded="true"] .co-card-head{background:#131c25}',
    '.co-more{margin:4px 0;padding:2px 0;color:var(--co-muted);font-size:10.5px}',
    '.co-more-btn{appearance:none;margin:4px 0;padding:4px 8px;border:1px solid var(--co-line-2);border-radius:6px;background:transparent;color:var(--co-accent);font:10.5px inherit;cursor:pointer}',
    '.co-more-btn:hover{border-color:var(--co-accent)}',
    '.co-more-btn:focus-visible{outline:2px solid var(--co-accent);outline-offset:1px}',
    '.co-rounds{list-style:none;margin:2px 0 0;padding:0}',
    '.co-round-btn{appearance:none;width:100%;text-align:left;background:transparent;border:0;border-top:1px dashed var(--co-line-2);color:var(--co-muted);font:10.5px inherit;padding:4px 0;cursor:pointer;overflow-wrap:anywhere}',
    '.co-round-btn:hover{color:var(--co-text)}',
    '.co-round-btn:focus-visible{outline:2px solid var(--co-accent);outline-offset:1px}',
    '.co-sec{margin:6px 0 0}',
    '.co-sec-h{font:10.5px var(--co-mono);color:var(--co-muted);margin:0 0 3px}',
    '.co-concl-row{display:flex;gap:8px;justify-content:space-between;align-items:baseline;flex-wrap:wrap}',
    '.co-concl{font-size:11.5px;color:var(--co-text);overflow-wrap:anywhere}',
    '.co-when{font:10.5px var(--co-mono);color:var(--co-muted);white-space:nowrap}',
    '.co-verdict{margin-top:2px;font-size:11.5px;color:var(--co-muted);overflow-wrap:anywhere}',
    '.co-verdict[data-verdict="PASS"]{color:var(--co-ok)}',
    '.co-verdict[data-verdict="CHANGES"]{color:var(--co-warn)}',
    '.co-verdict[data-verdict="FAIL"]{color:var(--co-bad)}',
    '.co-opinions,.co-acts{list-style:none;margin:0;padding:0}',
    '.co-opinion{padding:3px 0;font-size:11px;color:var(--co-muted);overflow-wrap:anywhere}',
    '.co-opinion .co-lv{font:10px var(--co-mono);color:var(--co-warn);margin-right:4px}',
    '.co-opinion code{font:10px var(--co-mono);color:var(--co-text)}',
    '.co-advice{margin:1px 0 0 16px;font-size:10.5px;color:var(--co-muted);overflow-wrap:anywhere}',
    '.co-act{padding:2px 0;font-size:11px;color:var(--co-muted);overflow-wrap:anywhere}',
    '.co-link{appearance:none;background:transparent;border:0;padding:2px 0;color:var(--co-accent);font:11px inherit;cursor:pointer;text-align:left}',
    '.co-link:hover{text-decoration:underline}',
    '.co-link:focus-visible{outline:2px solid var(--co-accent);outline-offset:2px}',
    '.co-raw{margin-top:4px}',
    '.co-foot-note{font-size:10.5px;color:var(--co-muted)}',
    '.co-legend{flex:none;border-top:1px solid var(--co-line);padding:6px 12px;background:var(--co-panel-2);font-size:10.5px;color:var(--co-muted)}',
    '.co-legend div{padding:1px 0}',
    '.co-legend-btn{appearance:none;background:transparent;border:0;padding:2px 0;color:var(--co-muted);font:10.5px inherit;cursor:pointer}',
    '.co-legend-btn:hover{color:var(--co-text)}',
    '.co-legend-btn:focus-visible{outline:2px solid var(--co-accent);outline-offset:1px}',
    '.co-card-headrow{display:flex;align-items:center;gap:2px;padding-right:7px}',
    '.co-card-headrow .co-card-head{flex:1 1 auto;padding-right:0}',
    '.co-gate-btn{appearance:none;background:transparent;font:10px var(--co-mono);cursor:pointer;flex:none}',
    '.co-gate-btn:hover{border-color:var(--co-accent);color:var(--co-text)}',
    '.co-gate-btn:focus-visible{outline:2px solid var(--co-accent);outline-offset:2px}',
    '.co-g-num{display:none}',
    '.co-fallback{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:10px;justify-content:flex-start;padding:16px 14px}',
    '.co-fallback-msg{margin:0;font:11.5px/1.5 var(--co-mono);color:var(--co-muted);overflow-wrap:anywhere;max-height:7.5em;overflow:auto}',
    '.co-retry{align-self:flex-start;appearance:none;border:1px solid var(--co-accent);background:color-mix(in srgb,var(--co-accent) 12%,transparent);color:var(--co-accent);border-radius:999px;padding:4px 14px;font:11.5px inherit;cursor:pointer}',
    '.co-retry:focus-visible{outline:2px solid var(--co-accent);outline-offset:2px}',
    '@media (prefers-reduced-motion:no-preference){.co-dot{transition:background-color .18s ease}.co-card[data-status="running"] .co-dot{animation:co-breathe 2.4s ease-in-out infinite}.co-card[data-status="blocked"]{animation:co-blocked .8s ease-out 1}@keyframes co-breathe{0%,100%{opacity:1}50%{opacity:.45}}@keyframes co-blocked{0%{box-shadow:0 0 0 3px color-mix(in srgb,var(--co-bad) 35%,transparent)}100%{box-shadow:none}}}',
    '@media (prefers-reduced-motion:reduce){.co-panel *{animation:none!important;transition:none!important}}',
    '@container (max-width:359px){.co-head{padding:8px}.co-steps{gap:2px;padding:6px 8px}.co-step{font-size:10px;padding:4px 1px}.co-role{font-size:12px}.co-preset{display:none}.co-last{padding-left:10px}}',
    '@container (min-width:560px){.co-head{padding:12px 14px 9px}.co-list{padding:10px 12px}.co-title h2{font-size:14px}.co-role{font-size:13px}}',
    '@container (min-width:560px){.co-g-code{display:inline}}',
    /* 窄档：判定 chip 收成「! 3」「✕ 2」；「待判定」不能只剩一个点（读者不知道那是什么），
     * 所以它反过来——丢点是保字，靠下面这条把 data-gate="none" 的符号藏掉。 */
    '@container (max-width:359px){.co-g-txt,.co-g-code{display:none}.co-g-num{display:inline}.co-gate[data-gate="none"] .co-sym{display:none}}',
    /* 窄档裸符号的第二种情况：CHANGES 但没有逐条意见（count 0），`!` 一个字符说不清，换成「要改」。 */
    '@container (max-width:359px){.co-gate[data-gate="CHANGES"][data-bare="true"] .co-sym{display:none}.co-gate[data-gate="CHANGES"][data-bare="true"] .co-g-txt{display:inline}}',
    '@media (max-width:359px){.co-preset{display:none}}'
  ].join('\n')

  window.__ModuleLoader__.load({
    id: '@chy/dsh-cto-office',
    meta: function () {
      return { stylesheets: { 'cto-office-feed.css': { text: function () { return CSS } } } }
    },
    factory: function (require) {
      var React = require('react')
      var h = React.createElement

      function useSnap(store, empty) {
        return React.useSyncExternalStore(
          store ? function (cb) { return store.subscribe(cb) } : NOOP,
          store ? function () { return store.getSnapshot() } : function () { return empty },
          function () { return store ? store.getSnapshot() : empty }
        )
      }

      /* 渲染期降级：只用于「算不出来就退回兜底值」的辅助计算（闸门、推断步、单行文案），
       * 失败不抛出、记录首条原因给面板显示。真正的程序错误不在这里吞掉——那要留给下面的
       * ErrorBoundary，否则会变成「静默空白」（上一次 P0 就是这样被藏起来的）。 */
      var safeFault = ''

      function safe(fn, fallback) {
        try { return fn() } catch (error) {
          if (!safeFault) safeFault = clip(error && error.message ? error.message : String(error), 120)
          return fallback
        }
      }

      /* 面板主体的最后一道防线：任何漏网的渲染期异常都换成一张兜底卡，而不是让宿主
       * 卸载整棵右栏（P0 现象：右栏全白）。重试只重置边界自身，不重建 ctx / session。 */
      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null, stack: '' }
          this.reset = this.reset.bind(this)
        }

        static getDerivedStateFromError(error) {
          return { error: error || new Error('render error') }
        }

        /* 只把组件栈接到兜底卡上（data-has-stack），不再打一条 console.error：
         * React 已经为这次异常打了一条，多打一条会让「一次异常 = 一条日志」的排查口径失效。 */
        componentDidCatch(error, info) {
          this.setState({ stack: (info && info.componentStack) || '' })
        }

        reset() {
          this.setState({ error: null, stack: '' })
        }

        render() {
          var error = this.state.error
          if (!error) return this.props.children
          var message = clip(error && error.message ? error.message : String(error), 160) || '（无错误消息）'
          var sessionId = this.props.sessionId || ''
          return h('div', {
            className: 'co-panel',
            'data-state': 'error',
            'data-session': sessionId,
            'data-has-stack': this.state.stack ? 'true' : 'false',
            role: 'alert'
          },
            h('div', { className: 'co-shell' },
              h('div', { className: 'co-head' },
                h('div', { className: 'co-title' },
                  h('h2', null, '信息流加载失败'),
                  h('span', { className: 'co-badge' }, 'error')
                )
              ),
              h('div', { className: 'co-fallback', 'data-role': 'fallback' },
                h('p', { className: 'co-fallback-msg' }, message),
                h('button', { type: 'button', className: 'co-retry', onClick: this.reset }, '重试')
              )
            )
          )
        }
      }

      function roleList() {
        var presets = (OFFICE_FACTS && OFFICE_FACTS.presets) || []
        return presets.slice().sort(function (a, b) { return (a.order || 0) - (b.order || 0) })
      }

      function rootPreset() {
        var list = roleList()
        for (var i = 0; i < list.length; i += 1) if (list[i].isRoot) return list[i]
        return list[0]
      }

      /* 业务事实（谁是根预设、哪两个角色出闸门）由 sync 写进 facts，
       * 渲染层只查表，不写死 preset id。 */
      function rootPresetId() {
        var root = rootPreset()
        return (root && root.id) || ''
      }

      function isGateRole(id) {
        var list = (OFFICE_FACTS && OFFICE_FACTS.gateRoles) || []
        return list.indexOf(id) >= 0
      }

      function FeedEvent(props) {
        var e = props.event
        var out = safe(function () { return describe(e, props.role) }, null)
        if (!out) return null
        return h('li', { className: 'co-ev', 'data-kind': out.kind, 'data-new': props.isNew ? 'true' : 'false' },
          h('code', null, out.time),
          h('span', { className: 'co-ev-t' }, out.head ? h('span', { className: 'co-ev-h' }, out.head) : null, h('span', { className: 'co-ev-b' }, out.body)),
          props.isNew ? h('span', { className: 'co-new', 'aria-label': '新事件' }) : null
        )
      }

      var BODY_MAX = 72
      var LINE_MAX = 100

      /* 一行事件 = 前缀(head) + 正文(body)：正文 ≤72 字，整行 ≤100 字。
       * 前缀不计入正文预算（它本身是标签），但整行超了要硬截并带省略号。
       * 折叠卡摘要走这里；E 层原始事件走 lineOfFull（全文，只受 FULL_MAX 约束）。 */
      function lineOf(head, text) {
        var body = clip(text, BODY_MAX)
        if (head.length + body.length > LINE_MAX) {
          body = head.length >= LINE_MAX - 1 ? '' : body.slice(0, LINE_MAX - 1 - head.length) + '…'
        }
        return { head: head, body: body, text: head + body }
      }

      function lineOfFull(head, text) {
        var body = fullOf(text)
        return { head: head, body: body, text: head + body }
      }

      var FULL_OPTS = { full: true }

      /* 根卡折叠摘要：第一眼要是「人被做了什么」，不是日志词。
       * 从最近一条事件往回找能说成人话的那条；turn/…、tool/result、心跳一律跳过，
       * 一条都映射不出来就返回 null（那一行不渲染）——宁可不写，也不写那句日志占位词。 */
      function rootLastText(events, roleName) {
        for (var i = events.length - 1; i >= 0; i -= 1) {
          var e = events[i]
          if (!e || !e.type) continue
          if (e.type === 'assistant/message') {
            var lines = textOf(e.data).split(/\r?\n/)
            for (var j = 0; j < lines.length; j += 1) {
              var t = lines[j].trim()
              if (!t || /^GATE[:：]/.test(t)) continue
              return lineOf('', clip(t, 60))
            }
            continue
          }
          if (e.type !== 'tool/call') continue
          var name = str(e.data && e.data.name)
          var args = argsOf(e.data && e.data.arguments)
          var file = str(args.file_path) || str(args.path) || str(args.file)
          if (READ_TOOLS[name] && file) return lineOf('', '读了 ' + baseName(file))
          if (WRITE_TOOLS[name] && file) return lineOf('', '改了 ' + baseName(file))
          if (RUN_TOOLS[name]) return lineOf('', '跑了 ' + clip(str(args.command) || str(args.cmd) || name, 60))
          if (name === 'subagent' || name === 'subagent_fork') {
            return lineOf('', '派工给 ' + clip(str(args.agent) || str(args.preset) || str(args.name) || '子代理', 40))
          }
        }
        return null
      }

      /* 折叠卡摘要取最近一轮；多轮时把轮次插进前缀第二段（`评审 · 第 4 轮 · …`），
       * 单轮不带轮次号，免得每张卡都是「第 1 轮」的噪音。 */
      function withRound(line, roundLabel) {
        if (!line || !roundLabel || line.head.indexOf(roundLabel) >= 0) return line
        var cut = line.head.indexOf(' · ')
        var head = cut >= 0 ? line.head.slice(0, cut + 3) + roundLabel + ' · ' : roundLabel + ' · '
        return lineOf(head, line.body)
      }

      /* 事件 → 一行可读文本。默认走摘要预算（正文 72 / 整行 100）；
       * opts.full 时正文给全文（E 层原始事件：回执、证据都要能读完整）。 */
      function describe(e, roleName, opts) {
        if (!e || !e.type) return null
        var full = !!(opts && opts.full)
        var stamp = full ? lineOfFull : lineOf
        var time = formatTime(e.time)
        var line = null
        if (e.type === 'tool/call') {
          var name = clip(str(e.data && e.data.name) || 'tool', 24)
          var hint = argHint(e.data && e.data.arguments, full)
          line = stamp('工具 · ' + name + (hint ? ' · ' : ''), hint)
        } else if (e.type === 'tool/result') {
          line = stamp('结果 · ', textOf(e.data) || '（无文本）')
        } else if (e.type === 'user/message') {
          var src = e.data && e.data.source
          if (src && src.kind && src.kind !== 'user') return null
          line = stamp('用户 · ', textOf(e.data) || '（消息）')
        } else if (e.type === 'assistant/message') {
          line = stamp((roleName || 'CTO') + ' · ', textOf(e.data) || '（消息）')
        } else if (e.type === 'subagent/catalog') {
          var d = e.data || {}
          line = stamp('派工 · ', str(d.label) || str(d.name) || str(d.childSessionId) || '子会话')
        } else if (e.type === 'turn/end') {
          line = stamp('', '这一轮结束')
        } else if (e.type === 'turn/start') {
          line = stamp('', '这一轮开始')
        }
        if (!line) return null
        return { kind: e.type, time: time, head: line.head, body: line.body, text: line.text }
      }

      function formatTime(t) {
        if (!t) return ''
        var date = new Date(t)
        if (isNaN(date.getTime())) return ''
        var hh = String(date.getHours()).padStart(2, '0')
        var mm = String(date.getMinutes()).padStart(2, '0')
        var ss = String(date.getSeconds()).padStart(2, '0')
        return hh + ':' + mm + ':' + ss
      }

      /* 单行结构。按钮不是按字数猜的，是量出来的：正文挂在 ref 上，
       * 每次布局后比 scrollHeight / clientHeight（3 行 clamp 之下 clientHeight 是裁后的高度），
       * ResizeObserver 盯着它——面板宽度变了要重算，窄档 55 字的单行也才不会被静默裁掉。 */
      function EventRow(props) {
        var out = props.out
        var body = props.body
        var full = props.full
        var bodyRef = React.useRef(null)
        /* 初值只用来避免首帧闪一下：字数短的先不给按钮，量完再定。 */
        var [overflow, setOverflow] = React.useState(function () { return body.length > 60 || body.indexOf('\n') >= 0 })
        React.useLayoutEffect(function () {
          var el = bodyRef.current
          if (!el) return undefined
          function measure() {
            var node = bodyRef.current
            if (!node) return
            /* 全文态没有裁剪，不参与判定（按钮仍留着，用来收起）。 */
            if (node.getAttribute('data-full') === 'true') return
            var need = node.scrollHeight > node.clientHeight + 1
            setOverflow(function (prev) { return prev === need ? prev : need })
          }
          measure()
          var ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
          if (ro) ro.observe(el)
          else window.addEventListener('resize', measure)
          return function () {
            if (ro) ro.disconnect()
            else window.removeEventListener('resize', measure)
          }
        }, [body, full])
        var showBtn = full || overflow
        return h('li', { className: 'co-ev', 'data-kind': out.kind, 'data-seq': String(props.seq), tabIndex: -1, 'data-new': props.isNew ? 'true' : 'false' },
          h('code', null, props.time),
          h('span', { className: 'co-ev-t' },
            out.head ? h('span', { className: 'co-ev-h' }, out.head) : null,
            h('span', { ref: bodyRef, className: 'co-ev-b', 'data-full': full ? 'true' : 'false' }, body)
          ),
          showBtn ? h('button', {
            type: 'button',
            className: 'co-link co-ev-btn',
            'aria-expanded': full ? 'true' : 'false',
            'aria-label': (full ? '收起这条事件' : '展开这条事件的全文') + '：' + clip(out.head || body, 30),
            onClick: props.onToggle
          }, full ? '收起' : '展开全文') : null
        )
      }

      function EventList(props) {
        /* 单条展开态：父级给 isFull/onToggle 就用父级的（B 层「看原始回执」要能远程把某条打开），
         * 没给就自己管（F 层「更早轮次」里的事件列表）。 */
        var [ownFull, setOwnFull] = React.useState({})
        var isFull = props.isFull || function (seq) { return !!ownFull[seq] }
        function toggleRow(seq) {
          if (props.onToggle) { props.onToggle(seq); return }
          setOwnFull(function (prev) {
            var next = Object.assign({}, prev)
            if (prev[seq]) delete next[seq]
            else next[seq] = true
            return next
          })
        }
        /* 每行一个闭包（var 在循环里是同一个绑定，直接写 onClick 会让所有按钮都切到最后一行的 seq） */
        function rowToggle(seqValue) {
          return function () { toggleRow(seqValue) }
        }
        var rows = []
        for (var i = 0; i < props.events.length; i += 1) {
          var e = props.events[i]
          var time = formatTime(e.time)
          var out = safe(function () { return describe(e, props.roleName, FULL_OPTS) }, null)
          if (!out) continue
          var seq = e.seq
          var full = !!isFull(seq)
          var body = String(out.body == null ? '' : out.body)
          rows.push(h(EventRow, {
            key: String(seq) + '-' + i,
            seq: seq,
            time: time,
            out: out,
            body: body,
            full: full,
            isNew: !!(props.newAfter && seq > props.newAfter),
            onToggle: rowToggle(seq)
          }))
        }
        if (!rows.length) return h('div', { className: 'co-empty' }, '还没有可见事件。')
        return h('ul', { className: 'co-ops' }, rows)
      }

      function gateStatusOf(events) {
        var gate = ''
        for (var i = 0; i < events.length; i += 1) {
          var g = eventGate(events[i])
          if (g) gate = g
        }
        return gate
      }

      function inferStep(events, gate) {
        var dispatch = false
        var follow = false
        var settled = false
        var sawUser = false
        var sawAssistantAfterGate = false
        for (var i = 0; i < events.length; i += 1) {
          var e = events[i]
          if (e.type === 'user/message') sawUser = true
          if (e.type === 'tool/call') {
            var n = str(e.data && e.data.name)
            if (n === 'subagent' || n === 'subagent_fork') dispatch = true
            if (n === 'wait_agent' || n === 'list_agents' || n === 'send_message' || n === 'job_output') follow = true
          }
          if (e.type === 'tool/result' && /\b(wait_agent|list_agents|send_message|job_output)\b/.test(textOf(e.data))) follow = true
          if (eventGate(e)) gate = gate || eventGate(e)
          if (gate && e.type === 'assistant/message') sawAssistantAfterGate = true
          if (e.type === 'turn/end' && gate) settled = sawAssistantAfterGate
        }
        if (gate) {
          if (settled) return 'settle'
          return 'gate'
        }
        if (follow) return 'follow'
        if (dispatch) return 'dispatch'
        if (sawUser) return 'clarify'
        return ''
      }

      function StepBar(props) {
        var steps = (OFFICE_FACTS && OFFICE_FACTS.steps) || []
        var current = props.current
        var currentIdx = -1
        for (var j = 0; j < steps.length; j += 1) if (steps[j].id === current) currentIdx = j

        function focusStep(id) {
          setTimeout(function () {
            var el = document.querySelector('[data-step-id="' + id + '"]')
            if (el && el.focus) el.focus()
          }, 0)
        }

        function move(from, delta) {
          var next = from + delta
          if (next < 0 || next >= steps.length) return
          props.onPick(steps[next].id)
          focusStep(steps[next].id)
        }

        return h('div', {
          className: 'co-steps',
          role: 'tablist',
          'aria-label': '开工六步（当前步为推断）',
          onKeyDown: function (ev) {
            if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
            ev.preventDefault()
            var target = ev.target
            var id = target && target.getAttribute ? target.getAttribute('data-step-id') : null
            var from = currentIdx < 0 ? 0 : currentIdx
            for (var q = 0; q < steps.length; q += 1) if (steps[q].id === id) from = q
            move(from, ev.key === 'ArrowRight' ? 1 : -1)
          }
        }, steps.map(function (step, idx) {
          var active = step.id === current
          return h('button', {
            key: step.id,
            type: 'button',
            role: 'tab',
            className: 'co-step',
            'data-step-id': step.id,
            'aria-current': active ? 'step' : undefined,
            'aria-selected': active ? 'true' : 'false',
            tabIndex: active || (currentIdx < 0 && idx === 0) ? 0 : -1,
            title: step.label + (active ? '（当前步为推断）' : ''),
            onClick: function () { props.onPick(step.id); focusStep(step.id) }
          }, step.label, active ? h('span', { className: 'co-infer', title: '按工具调用推断，可能滞后' }, '推断') : null)
        }))
      }

      function RoleProbe(props) {
        var ctx = props.ctx
        var child = props.child
        var [binding, setBinding] = React.useState(null)
        var [error, setError] = React.useState('')
        React.useEffect(function () {
          var current = null
          var alive = true
          setBinding(null)
          setError('')
          try {
            current = ctx.sessions.retain(childTarget(child, props.parentSessionId), { source: 'cto-office/liveboard' })
          } catch (err) {
            setError(err && err.message ? err.message : String(err))
            return NOOP
          }
          /* 真源的 binding getter 在 release 后抛错，所以只在 ready 兑现后取一次并留在 state 里，
           * 不在渲染期读 ref.binding。ready 被拒（会话起不来/已释放）时落到 error，不吞。 */
          Promise.resolve(current.ready).then(function (ready) {
            if (alive) setBinding(ready)
          }, function (err) {
            if (alive) setError(clip(err && err.message ? err.message : String(err), 120))
          })
          return function () {
            alive = false
            if (current) { try { current.release() } catch (err) { /* already gone */ } }
          }
        }, [child.id, child.mode])
        var win = useSnap(binding && binding.eventSource ? binding.eventSource : null, EMPTY_SNAP)
        var events = React.useMemo(function () {
          var out = []
          var entries = win.entries || []
          for (var i = 0; i < entries.length; i += 1) if (entries[i].type === 'event') out.push(entries[i].event)
          return out
        }, [win])
        var gate = gateStatusOf(events)
        React.useEffect(function () {
          props.onFeed(child.id, { child: child, events: events, gate: gate, hasMore: !!win.hasMore, error: error })
        }, [child.id, gate, win, error])
        return null
      }

      /* ── 事件解析：callId 配对 / 回执拆条 / 一轮的六层视图 ── */

      /* 真实事件的 callId 藏在 data.message.source.callId（tool/result），
       * 工具调用在 data.callId，PTC 派发在 data.subCallId；三个都要试。 */
      function callIdOf(e) {
        var d = e && e.data
        if (!d || typeof d !== 'object') return ''
        if (d.message && d.message.source && d.message.source.callId != null) return String(d.message.source.callId)
        if (d.callId != null) return String(d.callId)
        if (d.subCallId != null) return String(d.subCallId)
        if (d.source && d.source.callId != null) return String(d.source.callId)
        return ''
      }

      function toolResultInfo(e) {
        var d = (e && e.data) || {}
        var message = d.message && typeof d.message === 'object' ? d.message : d
        var text = ''
        var content = message.content
        if (Array.isArray(content)) {
          for (var i = 0; i < content.length; i += 1) {
            if (content[i] && content[i].type === 'text' && typeof content[i].text === 'string') { text = content[i].text; break }
          }
        }
        var payload = null
        if (text) { try { payload = JSON.parse(text) } catch (error) { payload = null } }
        /* DSH 真源要求复述结果恰好是一段 text（question-reply.ts resultReply）：
         * 形状不对的 result 不是「答完了」，是这个答复坏了。 */
        var contentList = Array.isArray(content) ? content : []
        var contentOk = contentList.length === 1 && !!contentList[0] && contentList[0].type === 'text' && typeof contentList[0].text === 'string'
        return {
          callId: message.source && message.source.callId != null ? String(message.source.callId) : callIdOf(e),
          payload: payload,
          text: text,
          time: typeof e.time === 'number' ? e.time : 0,
          isError: message.isError === true,
          contentOk: contentOk
        }
      }

      /* 照 DSH 真源（packages/client/ui-user-questions/src/client/question-reply.ts:170-190）判「答完了」：
       * isError 不算答；content 必须恰好一段 text；answers 必须是数组且条数与问题数一致。
       * 失败/畸形的 result 保持 pending —— 横幅宁可多亮一次，也不能把没答的问题静默吞掉。 */
      function answerOk(info, questionCount) {
        if (!info || info.isError === true) return false
        if (!info.contentOk) return false
        var payload = info.payload
        if (!payload || payload.pending === true) return false
        if (!Array.isArray(payload.answers)) return false
        if (questionCount && payload.answers.length !== questionCount) return false
        return true
      }

      /* 待确认横幅：配对键依次试 message.source.callId / callId / subCallId；
       * result 里 pending:true 表示「还没答」，迟到答复走 user/message 的
       * source={kind:'user-question-reply', callId, outcome:'answered'}（真源 question-reply.ts:124-133）。 */
      function confirmStateOf(events) {
        var pending = false
        var pendingId = ''
        for (var i = 0; i < events.length; i += 1) {
          var e = events[i]
          if (e.type !== 'tool/call' || !/ask_user/i.test(str(e.data && e.data.name))) continue
          var cid = callIdOf(e)
          var id = cid || ('seq:' + e.seq)
          var askArgs = argsOf(e.data && e.data.arguments)
          var askQuestions = Array.isArray(askArgs.questions) ? askArgs.questions : []
          var answered = false
          for (var j = i + 1; j < events.length; j += 1) {
            var next = events[j]
            if (next.type === 'tool/result') {
              var info = toolResultInfo(next)
              if (!cid || info.callId !== cid) continue
              if (answerOk(info, askQuestions.length)) answered = true
            } else if (next.type === 'user/message') {
              var src = next.data && next.data.source
              if (src && src.kind === 'user-question-reply' && String(src.callId) === cid && src.outcome === 'answered') answered = true
            }
          }
          if (!answered) { pending = true; pendingId = id }
        }
        return { pending: pending, id: pendingId }
      }

      function argsOf(raw) {
        if (!raw) return {}
        if (typeof raw === 'string') {
          try { var parsed = JSON.parse(raw); return parsed && typeof parsed === 'object' ? parsed : {} } catch (error) { return {} }
        }
        return typeof raw === 'object' ? raw : {}
      }

      function baseName(path) {
        var s = str(path)
        var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
        return i >= 0 ? s.slice(i + 1) : s
      }

      function receiptTextOf(events) {
        for (var i = events.length - 1; i >= 0; i -= 1) {
          if (events[i].type === 'assistant/message') return textOf(events[i].data)
        }
        return ''
      }

      /* 回执那条事件的 seq：B 层「看原始回执」点下去要直接把它展开成全文。 */
      function receiptSeqOf(events) {
        for (var i = events.length - 1; i >= 0; i -= 1) {
          if (events[i].type === 'assistant/message') return events[i].seq
        }
        return 0
      }

      /* 回执意见：`[P1] path:42 — 一句话`（前面可能带 `1. `），下一行 `建议：…`。
       * 拆不出来就是「没有逐条意见」——上层要走兜底文案，不能因为回执太短就崩。 */
      function parseReceipt(text) {
        var lines = String(text || '').split(/\r?\n/)
        var opinions = []
        var evidence = []
        var current = null
        for (var i = 0; i < lines.length; i += 1) {
          var line = lines[i].trim()
          if (!line) continue
          var ev = /^(?:证据|实测)[:：]\s*(.+)$/.exec(line)
          if (ev) { evidence.push(fullOf(ev[1])); current = null; continue }
          var m = /^(?:\d+[.)]\s*)?\[?(P[0-3])\]?\s+(.+)$/.exec(line)
          if (m && !/^GATE[:：]/.test(line)) {
            var rest = m[2]
            var loc = /^([^\s—–]+?:\d+)\s*[—–-]\s*(.+)$/.exec(rest)
            current = { level: m[1], where: loc ? clip(loc[1], 40) : '', what: clip(loc ? loc[2] : rest, 90), advice: '' }
            opinions.push(current)
            continue
          }
          var adv = /^(?:建议改法|建议|怎么改)[:：]\s*(.+)$/.exec(line)
          if (adv && current) { current.advice = clip(adv[1], 90); continue }
          current = null
        }
        return { opinions: opinions, evidence: evidence }
      }

      function whenText(ms) {
        if (!ms || !isFinite(ms)) return ''
        var diff = Date.now() - ms
        if (diff < 0) return ''
        if (diff < 60000) return '刚刚'
        if (diff < 3600000) return Math.round(diff / 60000) + ' 分钟前'
        if (diff < 86400000) return Math.round(diff / 3600000) + ' 小时前'
        return new Date(ms).toLocaleDateString('zh-CN')
      }

      function gateLabel(code) {
        if (code === 'PASS') return '通过'
        if (code === 'CHANGES') return '要改'
        if (code === 'FAIL') return '未过'
        return '待判定'
      }

      /* 轮次头的一句话：意见条数 → 回执首行 → 判定句 → 兜底。
       * 原来这里在「有回执但没解析出逐条意见」时写的是日志占位词（回合 + 结束），
       * 用户读到的是日志而不是结论，这条优先级链就是来堵它的。 */
      function roundHeadText(events, gate) {
        var count = 0
        safe(function () { count = parseReceipt(receiptTextOf(events)).opinions.length }, 0)
        if (count) return '提了 ' + count + ' 条意见'
        var lines = String(receiptTextOf(events) || '').split(/\r?\n/)
        for (var i = 0; i < lines.length; i += 1) {
          var t = lines[i].trim()
          if (!t || /^GATE[:：]/.test(t)) continue
          return clip(t, 40)
        }
        if (gate) return gateLabel(gate)
        return '这一轮没有结论'
      }

      var READ_TOOLS = { read: true }
      var WRITE_TOOLS = { edit: true, write: true, apply_patch: true, create_file: true, str_replace_editor: true }
      var RUN_TOOLS = { bash: true, shell: true }
      var NOISE_TOOLS = { todo_write: true, list_agents: true, wait_agent: true, job_output: true, send_message: true }

      /* 一轮的六层视图（A 结论 / B 意见 / C 动作 / D 证据 / E 原始事件 / F 更早轮次）。
       * 全部在一个函数里算完，渲染只摆位置，方便逐层断言。 */
      function roundView(events, gate) {
        var receipt = parseReceipt(receiptTextOf(events))
        var results = {}
        for (var i = 0; i < events.length; i += 1) {
          if (events[i].type !== 'tool/result') continue
          var info = toolResultInfo(events[i])
          if (info.callId) results[info.callId] = info
        }
        var reads = []
        var readSeen = {}
        var writes = []
        var acts = []
        var runCount = 0
        var hidden = 0
        var lastTime = 0
        for (var j = 0; j < events.length; j += 1) {
          var e = events[j]
          var t = typeof e.time === 'number' && isFinite(e.time) ? e.time : 0
          if (t > lastTime) lastTime = t
          if (e.type === 'turn/start' || e.type === 'turn/end') { hidden += 1; continue }
          if (e.type === 'tool/result') { hidden += 1; continue }
          if (e.type !== 'tool/call') continue
          var name = str(e.data && e.data.name)
          var args = argsOf(e.data && e.data.arguments)
          var cid = callIdOf(e)
          var res = cid ? results[cid] : null
          if (NOISE_TOOLS[name]) { hidden += 1; continue }
          if (READ_TOOLS[name]) {
            var rp = str(args.file_path) || str(args.path) || str(args.file)
            if (rp) { if (!readSeen[rp]) { readSeen[rp] = true; reads.push(rp) } } else hidden += 1
            continue
          }
          if (WRITE_TOOLS[name]) {
            var wp = str(args.file_path) || str(args.path) || str(args.file)
            if (wp) writes.push(wp); else hidden += 1
            continue
          }
          if (RUN_TOOLS[name]) {
            var cmd = clip(str(args.command) || str(args.cmd) || name, 40)
            var ok = res ? res.isError !== true : null
            var ms = res && res.time && t ? res.time - t : 0
            runCount += 1
            acts.push({
              time: t,
              text: (formatTime(t).slice(0, 5) + ' 跑 ' + cmd) + (ok === true ? ' · 通过' : ok === false ? ' · 失败' : '') + (ms > 0 ? ' · ' + formatDuration(ms) : '')
            })
            continue
          }
          if (name === 'subagent' || name === 'subagent_fork') {
            var to = clip(str(args.agent) || str(args.preset) || str(args.name) || '子代理', 24)
            var what = clip(str(args.prompt) || str(args.task) || str(args.description) || '', 40)
            acts.push({ time: t, text: formatTime(t).slice(0, 5) + ' 派工给 ' + to + (what ? '：' + what : '') })
            continue
          }
          hidden += 1
        }
        if (reads.length) acts.push({ time: 0, text: '读 ' + reads.length + ' 个文件（' + baseName(reads[0]) + (reads.length > 1 ? ' 等' : '') + '）' })
        for (var w = 0; w < writes.length; w += 1) acts.push({ time: 0, text: '改 ' + baseName(writes[w]) })
        acts.sort(function (a, b) { return (a.time || 0) - (b.time || 0) })
        var counts = []
        if (writes.length) counts.push('改了 ' + writes.length + ' 个文件')
        if (runCount) counts.push('跑了 ' + runCount + ' 条命令')
        if (reads.length) counts.push('读了 ' + reads.length + ' 个文件')
        var code = gate || ''
        var top = ''
        for (var o = 0; o < receipt.opinions.length; o += 1) {
          var lv = receipt.opinions[o].level
          if (!top || lv < top) top = lv
        }
        var verdictText = '还没有判定'
        if (code === 'PASS') verdictText = '通过'
        else if (code === 'CHANGES') verdictText = receipt.opinions.length ? '要改 ' + receipt.opinions.length + ' 处' + (top ? '，最高 ' + top : '') : '要改（回执没写几条）'
        else if (code === 'FAIL') verdictText = receipt.opinions.length ? '没过：' + receipt.opinions.length + ' 条不达标' : '没过'
        return {
          countsText: counts.length ? counts.join(' · ') : '这一步没动文件、也没跑命令',
          when: whenText(lastTime),
          verdictText: verdictText,
          verdictCode: code || 'none',
          opinions: receipt.opinions,
          evidence: receipt.evidence,
          actions: acts,
          hidden: hidden,
          total: events.length,
          gate: code,
          receiptSeq: receiptSeqOf(events)
        }
      }

      function CardBody(props) {
        if (props.failure) {
          return h('div', { className: 'co-body-inner', id: props.bodyId },
            h('div', { className: 'co-sec', 'data-layer': 'a' },
              h('div', { className: 'co-concl-row' },
                h('span', { className: 'co-concl' }, '不明岗位'),
                h('span', { className: 'co-when' }, props.roundLabel || '未识别')
              ),
              h('div', { className: 'co-verdict', 'data-verdict': 'none' }, '子会话读取失败：' + props.failure)
            )
          )
        }
        var view = props.view
        if (!view) return h('div', { className: 'co-empty' }, '这一步的记录读不出来。')
        var out = []
        out.push(h('div', { key: 'a', className: 'co-sec', 'data-layer': 'a' },
          h('div', { className: 'co-concl-row' },
            h('span', { className: 'co-concl' }, view.countsText),
            h('span', { className: 'co-when' }, [props.roundLabel, view.when].filter(Boolean).join(' · '))
          ),
          h('div', { className: 'co-verdict', 'data-verdict': view.verdictCode }, view.verdictText)
        ))
        if (props.showOpinions) {
          out.push(h('div', { key: 'b', className: 'co-sec', 'data-layer': 'b', tabIndex: -1 },
            h('div', { className: 'co-sec-h' }, view.opinions.length ? '意见 · 共 ' + view.opinions.length + ' 条' : '意见 · 回执里没有逐条意见，只有判定。'),
            view.opinions.length
              ? h('ul', { className: 'co-opinions' }, view.opinions.map(function (op, idx) {
                return h('li', { key: idx, className: 'co-opinion', 'data-level': op.level },
                  h('span', { className: 'co-lv' }, '[' + op.level + ']'),
                  op.where ? h('code', null, op.where) : null,
                  op.where ? h('span', { className: 'co-dash' }, ' — ') : null,
                  h('span', { className: 'co-what' }, op.what),
                  op.advice ? h('div', { className: 'co-advice' }, '建议：' + op.advice) : null
                )
              }))
              : h('button', { type: 'button', className: 'co-link co-receipt-btn', onClick: function () { if (props.onOpenReceipt) props.onOpenReceipt(view.receiptSeq); else props.onToggleRaw() } }, '看原始回执')
          ))
        }
        if (view.actions.length) {
          out.push(h('div', { key: 'c', className: 'co-sec', 'data-layer': 'c' },
            h('div', { className: 'co-sec-h' }, '做了什么'),
            h('ul', { className: 'co-acts' }, view.actions.map(function (a, idx) { return h('li', { key: idx, className: 'co-act' }, a.text) }))
          ))
        }
        if (view.evidence.length) {
          out.push(h('div', { key: 'd', className: 'co-sec', 'data-layer': 'd' },
            h('div', { className: 'co-sec-h' }, '证据'),
            h('ul', { className: 'co-acts' }, view.evidence.map(function (line, idx) { return h('li', { key: idx, className: 'co-act' }, line) }))
          ))
        }
        out.push(h('div', { key: 'e', className: 'co-sec', 'data-layer': 'e' },
          h('button', {
            type: 'button',
            className: 'co-link co-raw-btn',
            'aria-expanded': props.rawOpen ? 'true' : 'false',
            onClick: props.onToggleRaw
          }, props.rawOpen ? '收起原始事件' : '原始事件 ' + view.total + ' 条 · 展开'),
          props.rawOpen
            ? h('div', { className: 'co-raw' },
              view.hidden ? h('div', { className: 'co-sec-h' }, '其中 ' + view.hidden + ' 条是心跳/重复已折叠') : null,
              h(EventList, {
                events: props.events,
                roleName: props.roleName,
                isFull: function (seq) { return !!(props.fullRows && props.fullRows[props.rowKey + ':' + seq]) },
                onToggle: function (seq) { if (props.onToggleRow) props.onToggleRow(props.rowKey + ':' + seq) }
              }))
            : null
        ))
        return h('div', { className: 'co-body-inner', id: props.bodyId }, out)
      }

      function roleLabel(role) {
        return role.role || role.name || role.id
      }

      /* 闸门 chip：只表示最近一轮；历史最差挂在 title 里，免得跟卡面文字打架。
       * 卡头必须把 toggle 与 chip 拆成兄弟节点——button 套 button 会被浏览器拆 DOM。 */
      function GateChip(props) {
        var code = props.code || ''
        if (!code) {
          return h('span', { className: 'co-gate', 'data-gate': 'none', title: '还没有判定：回执末行出现 GATE: … 之后才算' },
            h('span', { className: 'co-sym', 'aria-hidden': 'true' }, '· '),
            /* 窄容器（≤359）里其它 chip 只剩符号，这一枚反过来：符号藏掉、文字留着。 */
            h('span', { className: 'co-g-txt-word' }, '待判定')
          )
        }
        var meta = code === 'PASS'
          ? { sym: '✓', label: '通过', human: '这一轮通过' }
          : code === 'CHANGES'
            ? { sym: '!', label: props.count ? '要改 ' + props.count : '要改', human: '这一轮要改，不是失败，改完再审一次' }
            : { sym: '✕', label: props.count ? '未过 ' + props.count : '未过', human: '这一轮没过' }
        var title = '最近一轮：' + meta.human + (props.history ? '（前几轮曾：' + gateLabel(props.history) + '）' : '')
        return h('button', {
          type: 'button',
          className: 'co-gate co-gate-btn',
          'data-gate': code,
          /* 没有逐条意见时窄档只剩一个裸符号，读者不知道什么意思；标出来让 CSS 换成文字。 */
          'data-bare': props.count ? 'false' : 'true',
          title: title,
          'aria-label': title,
          /* chip 本身就是展开控件：补上状态与目标，读屏才知道它开的是哪块。 */
          'aria-expanded': props.expanded ? 'true' : 'false',
          'aria-controls': props.controls || null,
          onClick: props.onOpen
        },
          h('span', { className: 'co-sym', 'aria-hidden': 'true' }, meta.sym + ' '),
          h('span', { className: 'co-g-num' }, props.count ? ' ' + props.count : ''),
          h('span', { className: 'co-g-txt' }, meta.label),
          h('span', { className: 'co-g-code' }, ' · ' + code)
        )
      }

      function Legend(props) {
        var rows = [
          '✓ 通过 — 回执末行 GATE: PASS',
          '! 要改 — GATE: CHANGES，不是失败，改完再审一次',
          '✕ 未过 — GATE: FAIL，这一轮不达标',
          '· 待判定 — 还没有回执，或者回执没写 GATE 行',
          '判定来自子会话回执的最后一行 GATE: …，不看中间过程'
        ]
        return h('div', { className: 'co-legend', 'data-legend': 'open', role: 'note' }, rows.map(function (line, idx) {
          return h('div', { key: idx }, line)
        }))
      }

      function Panel(props) {
        /* 每次渲染开头清掉上一帧的降级原因，否则一次错误会永久挂在 strip 上，
         * 后来不同的错误也看不见。safeFault 只记录本帧第一条。 */
        safeFault = ''
        var ctx = props.ctx
        var sessionId = props.sessionId
        var useProjection = props.useProjection
        var [ref, setRef] = React.useState(null)
        var [binding, setBinding] = React.useState(null)
        var [rootFault, setRootFault] = React.useState('')
        var [retainNonce, setRetainNonce] = React.useState(0)
        var [expanded, setExpanded] = React.useState(null)
        var [feeds, setFeeds] = React.useState({})
        var [pinned, setPinned] = React.useState(true)
        var [seenSeq, setSeenSeq] = React.useState(0)
        var [announce, setAnnounce] = React.useState('')
        var [pickedStep, setPickedStep] = React.useState('')
        /* 收起的提示按 session 存 sessionStorage；首帧懒读，避免先闪一下横幅再消失。 */
        var [dismiss, setDismiss] = React.useState(function () { return readDismiss(sessionId) })
        var [showAll, setShowAll] = React.useState({})
        var [openRound, setOpenRound] = React.useState('')
        var [rawOpen, setRawOpen] = React.useState('')
        /* 原始事件里被单独展开成全文的条目，key = `<卡片 key>:<seq>` */
        var [fullRows, setFullRows] = React.useState({})
        var [legendOpen, setLegendOpen] = React.useState(false)
        var listSnap = useSnap(ctx.sessions.list, { ids: [], byId: {} })
        var win = useSnap(binding && binding.eventSource ? binding.eventSource : null, EMPTY_SNAP)
        var catalogRaw = useProjection ? useProjection('subagentCatalog') : undefined
        var catalog = React.useMemo(function () { return catalogOf(catalogRaw) }, [catalogRaw])
        var [presets, setPresets] = React.useState({})
        var [presetFaults, setPresetFaults] = React.useState({})
        var scrollRef = React.useRef(null)
        var panelRef = React.useRef(null)
        var row = listSnap.byId && listSnap.byId[sessionId]
        var running = !!(row && row.running)
        var events = React.useMemo(function () {
          var out = []
          var entries = win.entries || []
          for (var i = 0; i < entries.length; i += 1) if (entries[i].type === 'event') out.push(entries[i].event)
          return out
        }, [win])

        React.useEffect(function () {
          var current = null
          var failed = ''
          var alive = true
          setBinding(null)
          try { current = ctx.sessions.retain(sessionId, { source: 'cto-office/liveboard' }) }
          catch (error) { failed = clip(error && error.message ? error.message : String(error), 120) }
          /* ref 只表示「拿到了引用」（可能还没 ready）；订阅走 ready 兑现后的 binding。 */
          setRef(current)
          setRootFault(failed)
          if (current && !failed) {
            Promise.resolve(current.ready).then(function (ready) {
              if (alive) setBinding(ready)
            }, function (error) {
              if (alive) setRootFault(clip(error && error.message ? error.message : String(error), 120))
            })
          }
          return function () {
            alive = false
            if (current) { try { current.release() } catch (error) { /* already gone */ } }
          }
        }, [sessionId, retainNonce])

        React.useEffect(function () {
          var alive = true
          ;(catalog).forEach(function (child) {
            if (presets[child.id]) return
            var pending = null
            try { pending = resolvePreset(ctx, Object.assign({ parentSessionId: sessionId }, child)) } catch (error) { pending = null }
            if (!pending || typeof pending.then !== 'function') return
            pending.then(function (result) {
              if (!alive) return
              var preset = result && result.preset
              if (preset) {
                setPresets(function (prev) { return prev[child.id] ? prev : Object.assign({}, prev, { [child.id]: preset }) })
                return
              }
              var reason = (result && result.reason) || '未知原因'
              setPresetFaults(function (prev) {
                if (prev[child.id] === reason) return prev
                return Object.assign({}, prev, { [child.id]: reason })
              })
            }).catch(NOOP)
          })
          return function () { alive = false }
        }, [catalog.map(function (c) { return c.id }).join('|'), presets])

        React.useEffect(function () {
          if (pinned) setSeenSeq(latestSeq(events))
        }, [pinned, events])

        var childrenByRole = {}
        var unknownChildren = []
        var roles = roleList()
        var unknownReasonById = {}
        var knownRoleIds = {}
        for (var ri = 0; ri < roles.length; ri += 1) knownRoleIds[roles[ri].id] = true
        /* 当前 catalog 的 id：留在 presetFaults 里但子会话已经离开的，不再计入 strip */
        var catalogIds = {}
        for (var ci = 0; ci < catalog.length; ci += 1) catalogIds[catalog[ci].id] = true
        var offbookFault = ''
        var offbookCount = 0
        for (var i = 0; i < catalog.length; i += 1) {
          var child = catalog[i]
          var preset = presets[child.id]
          if (!preset) {
            /* 解析失败的子会话不丢：归到「未识别」一行，仍然可展开看事件；
             * 还在解析中的（既无 preset 也无 fault）先不渲染，避免闪一张空卡。 */
            if (presetFaults[child.id]) unknownChildren.push({ child: child, reason: presetFaults[child.id] })
            continue
          }
          if (!knownRoleIds[preset]) {
            /* 解析出了 preset，但它不在角色册里（改名 / 外部造的孩子）：
             * 同样不许静默丢卡，挂「未识别」并写清未知角色名。 */
            unknownChildren.push({ child: child, reason: '未知角色 ' + preset })
            offbookCount += 1
            if (!offbookFault) offbookFault = '未知角色 ' + preset
            continue
          }
          if (!childrenByRole[preset]) childrenByRole[preset] = []
          childrenByRole[preset].push(child)
        }
        var unknownFault = ''
        var unknownFaultCount = 0
        Object.keys(presetFaults).forEach(function (id) {
          if (!catalogIds[id]) return
          unknownFaultCount += 1
          if (!unknownFault) unknownFault = presetFaults[id]
        })
        if (offbookCount) {
          unknownFaultCount += offbookCount
          if (!unknownFault) unknownFault = offbookFault
        }
        if (unknownChildren.length) {
          roles = roles.concat([{ id: 'unknown', role: '未识别', name: '未识别子会话', order: 9999 }])
          childrenByRole.unknown = unknownChildren.map(function (entry) {
            unknownReasonById[entry.child.id] = entry.reason
            return entry.child
          })
        }
        var root = rootPreset()
        var gateTok = safe(function () { return gateStatusOf(events) }, '')
        var confirmState = safe(function () { return confirmStateOf(events) }, { pending: false, id: '' })
        var needsConfirm = confirmState.pending
        var state = rootFault ? 'degraded' : (!ref ? 'empty' : (events.length && !running ? 'ended' : 'live'))
        var gateCount = 0
        var gatePending = 0
        var rolesStatus = roles.map(function (role) {
          var children = childrenByRole[role.id] || []
          var childFeeds = children.map(function (child) { return feeds[child.id] }).filter(Boolean)
          var status = statusOfRole(role, children, childFeeds, running, events, needsConfirm)
          var roleGate = role.isRoot ? gateTok : safe(function () { return roleGateOf(childFeeds) }, '')
          /* 根卡上的 gate 是子代理结论的回声，同一判定不能数两次：只数闸门角色。 */
          if (isGateRole(role.id)) {
            if (roleGate) gateCount += 1
            else gatePending += 1
          }
          return { role: role, children: children, feeds: childFeeds, status: status, gate: roleGate }
        })
        var newCount = pinned ? 0 : events.filter(function (ev) { return ev.seq > seenSeq }).length
        var inferredStep = safe(function () { return inferStep(events, gateTok) }, '')
        var step = pickedStep || inferredStep
        /* 坏时间戳只该让耗时变成 —，不该把整块面板打到兜底卡（兜底卡留给渲染逻辑本身坏了）。 */
        var elapsed = safe(function () { return turnElapsed(events) }, '')

        /* ── 提示条：可关；关闭状态落 sessionStorage（不可用就只活在本次渲染） ── */
        function persist(next) {
          writeDismiss(sessionId, next)
          return next
        }

        function dismissConfirm() {
          setDismiss(function (prev) { return persist(Object.assign({}, prev, { confirm: confirmState.id })) })
        }

        function dismissText(bucket, text) {
          var key = clip(text, 160)
          setDismiss(function (prev) {
            var map = Object.assign({}, prev[bucket])
            map[key] = Date.now()
            var patch = {}
            patch[bucket] = map
            return persist(Object.assign({}, prev, patch))
          })
        }

        function dismissWindow() {
          setDismiss(function (prev) { return persist(Object.assign({}, prev, { window: true })) })
        }

        var faultText = safeFault ? '部分内容未算出：' + safeFault : ''
        var presetText = unknownFault
          ? '有子会话未能识别角色：' + unknownFault + (unknownFaultCount > 1 ? '（共 ' + unknownFaultCount + ' 个）' : '')
          : ''
        var confirmHidden = !!(needsConfirm && dismiss.confirm && dismiss.confirm === confirmState.id)
        var faultHidden = !!(faultText && dismiss.faults[clip(faultText, 160)])
        var presetHidden = !!(presetText && dismiss.presets[clip(presetText, 160)])
        var windowShown = !rootFault && !!win.hasMore
        var windowHidden = !!(windowShown && dismiss.window)

        /* 窗口重置（hasMore true → false）时清掉关闭标记：真换了窗口才允许重新弹。 */
        var hasMoreRef = React.useRef(null)
        React.useEffect(function () {
          var hasMore = !!win.hasMore
          var prev = hasMoreRef.current
          hasMoreRef.current = hasMore
          if (prev === true && hasMore === false && dismiss.window) {
            setDismiss(function (state0) { return persist(Object.assign({}, state0, { window: false })) })
          }
        }, [win])

        /* 读屏只播报「显示中的提示集合」变化，不每帧刷。 */
        var stripSig = [
          needsConfirm && !confirmHidden ? 'confirm' : '',
          windowShown && !windowHidden ? 'window' : '',
          faultText && !faultHidden ? 'fault' : '',
          presetText && !presetHidden ? 'preset' : ''
        ].join('|')
        var stripRef = React.useRef(stripSig)
        React.useEffect(function () {
          if (stripRef.current === stripSig) return
          stripRef.current = stripSig
          var names = []
          if (needsConfirm && !confirmHidden) names.push('有一项待你确认')
          if (windowShown && !windowHidden) names.push('数据不完整')
          if (faultText && !faultHidden) names.push('部分内容未算出')
          if (presetText && !presetHidden) names.push('有子会话未能识别角色')
          setAnnounce(names.length ? '提示：' + names.join('、') : '提示已关闭')
        }, [stripSig])

        /* 图例首次自动展开一次（localStorage 记住已看过）。 */
        React.useEffect(function () {
          if (legendOpen || !gateCount) return
          var seen = false
          try { seen = window.localStorage.getItem('cto-office/legend-seen@1') === '1' } catch (error) { seen = true }
          if (seen) return
          setLegendOpen(true)
          try { window.localStorage.setItem('cto-office/legend-seen@1', '1') } catch (error) { /* ignore */ }
        }, [gateCount, legendOpen])

        function onScroll(ev) {
          var el = ev.currentTarget
          var near = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          setPinned(near)
          if (near) setSeenSeq(latestSeq(events))
        }

        function jumpLatest() {
          var el = scrollRef.current
          if (el) el.scrollTop = el.scrollHeight
          setPinned(true)
          setSeenSeq(latestSeq(events))
          setAnnounce('已回到最新')
        }

        function toggle(role, hasChild) {
          if (!hasChild && !role.isRoot) return
          var next = expanded === role.id ? null : role.id
          setExpanded(next)
          setOpenRound('')
          setRawOpen('')
          if (next) setAnnounce('展开 ' + roleLabel(role))
        }

        /* chip 点击 = 展开这张卡并把焦点送到 B 层（意见），不是「重新判定」。 */
        function openOpinions(role) {
          setExpanded(role.id)
          setOpenRound('')
          setRawOpen('')
          setAnnounce('展开 ' + roleLabel(role) + ' 的意见')
          setTimeout(function () {
            var el = panelRef.current && panelRef.current.querySelector('[data-role="' + role.id + '"] [data-layer="b"]')
            if (el && el.focus) el.focus()
          }, 0)
        }

        function markFull(key, on) {
          setFullRows(function (prev) {
            if (!!prev[key] === !!on) return prev
            var next = Object.assign({}, prev)
            if (on) next[key] = true
            else delete next[key]
            return next
          })
        }

        /* B 层「看原始回执」= 一步读完：展开 E 层 + 把回执那条单独展开成全文 + 焦点进条目。
         * 用户点它就是想读全文，不该让他再点第二次。 */
        function openReceipt(cardKey, bodyId, seq) {
          setRawOpen(cardKey)
          if (seq) {
            markFull(cardKey + ':' + seq, true)
            setTimeout(function () {
              var box = document.getElementById(bodyId)
              var node = box && box.querySelector('.co-ev[data-seq="' + seq + '"]')
              if (node && node.focus) node.focus()
            }, 0)
          }
          setAnnounce('展开原始回执全文')
        }

        function onKeyDown(ev) {
          if (ev.key !== 'Escape') return
          if (expanded) {
            ev.stopPropagation()
            setExpanded(null)
            setOpenRound('')
            setRawOpen('')
            var btn = panelRef.current && panelRef.current.querySelector('[data-role="' + expanded + '"] .co-card-head')
            if (btn) btn.focus()
            setAnnounce('已收起 ' + expanded)
          }
        }

        var newAfter = pinned ? 0 : seenSeq
        var theme = (OFFICE_FACTS && OFFICE_FACTS.theme) || {}
        var themeStyle = {
          '--co-accent': theme.accent || '#5ac8fa',
          '--co-ok': theme.ok || '#7fe0a8',
          '--co-warn': theme.warn || '#f2c66d',
          '--co-bad': theme.bad || '#ff8f8f'
        }

        var strips = []
        if (rootFault) {
          /* 订阅失败那条不加 ×：它是 <button>，塞按钮就是按钮嵌套；而且关掉等于全程瞎，必须留着重试。 */
          strips.push(h('button', {
            key: 'retain-fault',
            type: 'button',
            className: 'co-strip co-strip-action',
            'data-show': 'true',
            'data-tone': 'bad',
            'data-strip': 'retain-fault',
            onClick: function () { setRetainNonce(function (n) { return n + 1 }) }
          }, '会话事件订阅失败：' + rootFault + ' · 重试'))
        }
        if (needsConfirm && !confirmHidden) {
          strips.push(h('div', { key: 'confirm', className: 'co-strip', 'data-show': 'true', 'data-tone': 'warn', 'data-strip': 'confirm', role: 'note' },
            h('span', { className: 'co-strip-t' }, '有一项待你确认 · CTO 正在等你回复'),
            h('button', { type: 'button', className: 'co-strip-x', 'aria-label': '关闭提示：有一项待你确认 · CTO 正在等你回复', onClick: dismissConfirm }, '×')
          ))
        }
        if (windowShown && !windowHidden) {
          strips.push(h('div', { key: 'window', className: 'co-strip', 'data-show': 'true', 'data-tone': 'info', 'data-strip': 'window', role: 'note' },
            h('span', { className: 'co-strip-t' }, '数据不完整：只拿到了尾部窗口，更早事件未加载'),
            h('button', { type: 'button', className: 'co-strip-x', 'aria-label': '关闭提示：数据不完整', onClick: dismissWindow }, '×')
          ))
        }
        if (faultText && !faultHidden) {
          strips.push(h('div', { key: 'fault', className: 'co-strip', 'data-show': 'true', 'data-tone': 'warn', 'data-strip': 'fault', role: 'note' },
            h('span', { className: 'co-strip-t' }, faultText),
            h('button', { type: 'button', className: 'co-strip-x', 'aria-label': '关闭提示：' + faultText, onClick: function () { dismissText('faults', faultText) } }, '×')
          ))
        }
        if (presetText && !presetHidden) {
          strips.push(h('div', { key: 'preset-fault', className: 'co-strip', 'data-show': 'true', 'data-tone': 'warn', 'data-strip': 'preset-fault', role: 'note' },
            h('span', { className: 'co-strip-t' }, presetText),
            h('button', { type: 'button', className: 'co-strip-x', 'aria-label': '关闭提示：' + presetText, onClick: function () { dismissText('presets', presetText) } }, '×')
          ))
        }

        return h('div', { className: 'co-panel', 'data-state': state, 'data-session': sessionId || '', ref: panelRef, style: themeStyle, onKeyDown: onKeyDown },
          h('div', { className: 'co-shell' },
            h('div', { className: 'co-head' },
              h('div', { className: 'co-title' },
                h('h2', null, '办公室信息流'),
                h('span', { className: 'co-badge' }, OFFICE_FACTS.schema || 'office-data')
              ),
              h('div', { className: 'co-sum' },
                h('span', null, h('b', null, rolesStatus.filter(function (x) { return x.status === 'running' }).length), ' 人在跑'),
                h('span', { className: 'co-sep', 'aria-hidden': 'true' }, '·'),
                h('span', null, h('b', null, rolesStatus.length), ' 张卡'),
                h('span', { className: 'co-sep', 'aria-hidden': 'true' }, '·'),
                h('span', null, h('b', null, gateCount), ' 道闸'),
                gatePending ? h('span', { className: 'co-sep', 'aria-hidden': 'true' }, '·') : null,
                gatePending ? h('span', { className: 'co-pending', 'data-pending-gates': String(gatePending) }, gatePending + ' 待判定') : null,
                h('span', { className: 'co-sep', 'aria-hidden': 'true' }, '·'),
                h('span', { title: '最近一轮：最后一条用户消息 → 其后最后一条助手消息；未配对显示 —', 'data-elapsed': elapsed || '—' }, h('b', null, elapsed || '—'))
              )
            ),
            h(StepBar, { current: step, onPick: function (id) { setPickedStep(id === inferredStep ? '' : id) } }),
            strips,
            h('div', { className: 'co-list', ref: scrollRef, onScroll: onScroll, role: 'log', 'aria-label': '七角色信息流' },
              rolesStatus.map(function (item) {
                var role = item.role
                var children = item.children
                var hasChild = children.length > 0
                var isOpen = expanded === role.id
                var feed = item.feeds.length ? item.feeds[item.feeds.length - 1] : null
                var feedLast = feed && feed.events.length ? feed.events[feed.events.length - 1] : null
                /* 轮次按子会话清单里的序号算，不能用 feeds.length：折叠态只挂了最近 3 张，
                 * feeds 里没有更早的，长度会从 4 掉到 3，写成「第 3 轮」。 */
                var feedIndex = -1
                for (var ci2 = 0; ci2 < children.length; ci2 += 1) {
                  if (feed && feed.child && children[ci2].id === feed.child.id) { feedIndex = ci2; break }
                }
                /* 契约为准：一律带「第 N 轮」，不给单轮开特例（少一处分支，少一次读错）。 */
                var roundLabel = feedIndex >= 0 ? '第 ' + (feedIndex + 1) + ' 轮' : ''
                /* 「未识别」不是岗位名：前缀要把原因写进去（未知角色 x / 投影不可用），
                 * 否则卡面读成「未识别 · 干了活」，等于把人名换成了兜底标签。 */
                var unknownNameFor = function (c) {
                  if (role.id !== 'unknown' || !c) return role.role
                  var why = unknownReasonById[c.id]
                  return why ? role.role + '（' + why + '）' : role.role
                }
                var feedRoleName = function (f) { return unknownNameFor(f && f.child) }
                /* 折叠卡结论行：`第 4 轮 · 终审 diff`。去掉角色前缀（角色在卡头），
                 * 也去掉 GATE: 字样（chip 已经在说判定，写两遍就是糊成一串）。 */
                var lastText = safe(function () {
                  if (role.isRoot) return events.length ? rootLastText(events, role.role) : null
                  if (feedLast) {
                    var first = ''
                    if (feedLast.type === 'assistant/message' || feedLast.type === 'tool/result') {
                      var lines = textOf(feedLast.data).split(/\r?\n/)
                      for (var li = 0; li < lines.length; li += 1) {
                        var lineText = lines[li].trim()
                        if (!lineText || /^GATE[:：]/.test(lineText)) continue
                        first = lineText
                        break
                      }
                    } else if (feedLast.type === 'tool/call') {
                      first = str(feedLast.data && feedLast.data.name)
                    }
                    var namePrefix = role.id === 'unknown' ? unknownNameFor(children[0]) + ' · ' : ''
                    return lineOf(roundLabel ? roundLabel + ' · ' : '', namePrefix + clip(first || '（这一轮没有留下文字）', 60))
                  }
                  return hasChild
                    ? lineOf(role.id === 'unknown' ? unknownNameFor(children[0]) + ' · 已派工 · ' : '已派工 · ',
                      children[0].label || children[0].name || children[0].id)
                    : null
                }, null)

                var latestView = safe(function () { return feed ? roundView(feed.events, feed.gate) : null }, null)
                var latestGate = role.isRoot ? gateTok : (feed ? feed.gate : '')
                var chipCount = latestView ? latestView.opinions.length : 0
                var historyWorst = item.gate && latestGate && item.gate !== latestGate ? item.gate : ''
                var hiddenChildren = children.length > 3 ? children.slice(0, children.length - 3) : []
                var showAllHere = !!showAll[role.id]
                var roundChild = null
                if (openRound) {
                  for (var oi = 0; oi < children.length; oi += 1) if (children[oi].id === openRound) roundChild = children[oi]
                }
                var earlierFeeds = isOpen ? item.feeds.slice(0, item.feeds.length - 1) : []
                /* 折叠态只挂最近 3 张；「展开其余 N 轮」只多出轮次头（不 retain），
                 * 点某一轮才把那一轮加进来——否则一次点击就多开十几个会话。 */
                var probeChildren = isOpen ? children : children.slice(-3)
                if (roundChild && probeChildren.indexOf(roundChild) < 0) probeChildren = probeChildren.concat([roundChild])

                return h('article', {
                  key: role.id,
                  className: 'co-card',
                  'data-role': role.id,
                  'data-status': item.status,
                  'data-gate': item.gate || 'none',
                  'data-expanded': isOpen ? 'true' : 'false'
                },
                  h('div', { className: 'co-card-headrow' },
                    h('button', {
                      type: 'button',
                      className: 'co-card-head',
                      'aria-expanded': isOpen ? 'true' : 'false',
                      'aria-controls': 'co-body-' + role.id,
                      onClick: function () { toggle(role, hasChild) }
                    },
                      h('span', { className: 'co-dot', 'aria-hidden': 'true' }),
                      h('span', { className: 'co-role' }, roleLabel(role)),
                      h('span', { className: 'co-preset' }, role.id),
                      h('span', { className: 'co-spacer' })
                    ),
                    /* 根卡不挂 chip：它那枚是根会话自己的 GATE 行，和子代理结论可能互相打架；
                     * 结论看闸门角色卡头。data-gate 属性仍保留，排障用。 */
                    isGateRole(role.id)
                      ? h(GateChip, { code: latestGate, count: chipCount, history: historyWorst, expanded: isOpen, /* 折叠态那块 body 还没渲染，挂 aria-controls 只会指向 null */ controls: isOpen ? 'co-body-inner-' + role.id : null, onOpen: function () { openOpinions(role) } })
                      : null
                  ),
                  probeChildren.map(function (child) {
                    return h(RoleProbe, {
                      key: child.id,
                      ctx: ctx,
                      child: child,
                      parentSessionId: sessionId,
                      onFeed: function (id, data) {
                        setFeeds(function (prev) {
                          var old = prev[id]
                          var oldSeq = old && old.events.length ? old.events[old.events.length - 1].seq : -1
                          var newSeq = data.events.length ? data.events[data.events.length - 1].seq : -1
                          if (old && old.gate === data.gate && old.hasMore === data.hasMore && old.error === data.error && oldSeq === newSeq && old.events.length === data.events.length) return prev
                          var next = Object.assign({}, prev)
                          next[id] = data
                          return next
                        })
                      }
                    })
                  }),
                  lastText && !isOpen ? h('div', { className: 'co-last' }, lastText.text) : null,
                  !isOpen && hiddenChildren.length
                    ? h('button', {
                      type: 'button',
                      className: 'co-more-btn',
                      'aria-expanded': showAllHere ? 'true' : 'false',
                      'aria-controls': 'co-rounds-' + role.id,
                      onClick: function () {
                        setShowAll(function (prev) {
                          var next = Object.assign({}, prev)
                          next[role.id] = !prev[role.id]
                          return next
                        })
                      }
                    }, showAllHere ? '收起其余 ' + hiddenChildren.length + ' 轮' : '展开其余 ' + hiddenChildren.length + ' 轮')
                    : null,
                  !isOpen && showAllHere
                    ? h('ul', { className: 'co-rounds', id: 'co-rounds-' + role.id }, hiddenChildren.map(function (c, idx) {
                      return h('li', { key: c.id },
                        h('button', {
                          type: 'button',
                          className: 'co-round-btn',
                          'data-round-id': c.id,
                          'aria-expanded': openRound === c.id ? 'true' : 'false',
                          onClick: function () { setOpenRound(openRound === c.id ? '' : c.id) }
                        }, '第 ' + (idx + 1) + ' 轮 · ' + clip(c.label || c.name || c.id, 40)))
                    }))
                    : null,
                  !isOpen && roundChild && feeds[roundChild.id]
                    ? h(CardBody, {
                      bodyId: 'co-round-body-' + roundChild.id,
                      view: safe(function () { return roundView(feeds[roundChild.id].events, feeds[roundChild.id].gate) }, null),
                      events: feeds[roundChild.id].events,
                      roleName: unknownNameFor(roundChild),
                      roundLabel: '第 ' + (children.indexOf(roundChild) + 1) + ' 轮',
                      showOpinions: false,
                      rawOpen: rawOpen === roundChild.id,
                      onToggleRaw: function () { setRawOpen(rawOpen === roundChild.id ? '' : roundChild.id) },
                      rowKey: roundChild.id,
                      fullRows: fullRows,
                      onToggleRow: function (key) { markFull(key, !fullRows[key]) },
                      onOpenReceipt: function (seq) { openReceipt(roundChild.id, 'co-round-body-' + roundChild.id, seq) }
                    })
                    : null,
                  isOpen
                    ? h('div', { className: 'co-body', id: 'co-body-' + role.id },
                      h(CardBody, {
                        bodyId: 'co-body-inner-' + role.id,
                        view: safe(function () { return roundView(role.isRoot ? events : (feed ? feed.events : []), role.isRoot ? gateTok : (feed ? feed.gate : '')) }, null),
                        events: role.isRoot ? events : (feed ? feed.events : []),
                        roleName: role.isRoot ? role.role : feedRoleName(feed),
                        roundLabel: roundLabel,
                        failure: role.id === 'unknown' ? (unknownFault || '会话没有挂上') : '',
                        showOpinions: isGateRole(role.id),
                        rawOpen: rawOpen === role.id,
                        onToggleRaw: function () { setRawOpen(rawOpen === role.id ? '' : role.id) },
                        rowKey: role.id,
                        fullRows: fullRows,
                        onToggleRow: function (key) { markFull(key, !fullRows[key]) },
                        onOpenReceipt: function (seq) { openReceipt(role.id, 'co-body-inner-' + role.id, seq) }
                      }),
                      !role.isRoot && earlierFeeds.length
                        ? h('div', { className: 'co-sec', 'data-layer': 'f' },
                          h('div', { className: 'co-sec-h' }, '更早轮次'),
                          h('ul', { className: 'co-rounds' }, earlierFeeds.map(function (f) {
                            var idx2 = children.indexOf(f.child)
                            var open = openRound === f.child.id
                            return h('li', { key: f.child.id },
                              h('button', {
                                type: 'button',
                                className: 'co-round-btn',
                                'data-round-id': f.child.id,
                                'aria-expanded': open ? 'true' : 'false',
                                onClick: function () { setOpenRound(open ? '' : f.child.id) }
                              }, '第 ' + (idx2 + 1) + ' 轮 ' + (f.gate ? (gateChip(f.gate).symbol + ' ') : '') +
                                (formatTime(f.events[0] && f.events[0].time).slice(0, 5)) + ' ' +
                                roundHeadText(f.events, f.gate)),
                              open ? h('div', { className: 'co-raw' }, h(EventList, { events: f.events, roleName: feedRoleName(f) })) : null)
                          })),
                          h('div', { className: 'co-more' }, '只显示最近一轮')
                        )
                        : null,
                      role.isRoot && win.hasMore ? h('div', { className: 'co-more' }, '更早的事件未加载') : null,
                      !role.isRoot && !item.feeds.length ? h('div', { className: 'co-empty' }, '还没有派工记录。') : null
                    )
                    : null
                )
              }),
              !rootFault && !events.length && !win.hasMore ? h('div', { className: 'co-empty', 'data-empty': 'no-events' }, '这轮还没有事件。先在对话里说一句话，或派一张卡。') : null
            ),
            legendOpen ? h(Legend, { key: 'legend' }) : null,
            h('div', { className: 'co-foot' },
              h('button', { type: 'button', className: 'co-legend-btn', 'data-legend-toggle': 'true', 'aria-expanded': legendOpen ? 'true' : 'false', onClick: function () { setLegendOpen(!legendOpen) } }, '闸门怎么读'),
              windowShown && windowHidden
                ? h('span', { className: 'co-foot-note', 'data-foot-note': 'window', title: '只拿到了尾部窗口，更早的事件没有加载' }, '数据不完整 · 更早事件未加载')
                : null,
              h('button', { type: 'button', className: 'co-return', 'data-show': pinned ? 'false' : 'true', onClick: jumpLatest }, '回到最新', newCount ? ' · ' + newCount + ' 条' : '')
            ),
            h('div', { className: 'co-sr', 'aria-live': 'polite' }, announce)
          )
        )
      }

      function latestSeq(events) {
        return events.length ? (events[events.length - 1].seq || 0) : 0
      }



      function autoOpen(ctx) {
        function dismissed() {
          try { return window.localStorage.getItem(DISMISS_KEY) === '1' } catch (error) { return true }
        }
        function setDismissed(value) {
          try { window.localStorage.setItem(DISMISS_KEY, value ? '1' : '0') } catch (error) { /* storage unavailable */ }
        }
        var lastAuto = 0
        function openFor(sessionId) {
          if (!sessionId || dismissed()) return
          var preset = readPresetFromList(ctx, sessionId)
          if (preset !== rootPresetId()) return
          var tabs = ctx.sidebarRight.openTabs.getSnapshot() || []
          for (var i = 0; i < tabs.length; i += 1) {
            if (tabs[i].sessionId === sessionId && tabs[i].kind === KIND) return
          }
          try {
            ctx.sidebarRight.openTab(KIND)
            lastAuto = Date.now()
          } catch (error) { /* no on-screen session */ }
        }
        function tick() { openFor(ctx.sidebarRight.mounted.getSnapshot()) }
        var offMounted = ctx.sidebarRight.mounted.subscribe(function () { tick() })
        var offList = ctx.sessions.list.subscribe(function () { tick() })
        var previous = new Map()
        var offTabs = ctx.sidebarRight.openTabs.subscribe(function () {
          var tabs = ctx.sidebarRight.openTabs.getSnapshot() || []
          var present = new Map()
          for (var i = 0; i < tabs.length; i += 1) {
            if (tabs[i].kind !== KIND) continue
            present.set(tabs[i].sessionId, true)
          }
          present.forEach(function (_v, sessionId) { previous.set(sessionId, true) })
          var mountedNow = ctx.sidebarRight.mounted.getSnapshot()
          previous.forEach(function (_v, sessionId) {
            if (!present.get(sessionId)) {
              previous.delete(sessionId)
              var sameSession = sessionId === mountedNow
              var visible = typeof document !== 'undefined' && document.visibilityState === 'visible'
              if (sameSession && visible && Date.now() - lastAuto > 1200) setDismissed(true)
            }
          })
          if (!dismissed()) return
          var mounted = ctx.sidebarRight.mounted.getSnapshot()
          if (mounted && present.get(mounted) && Date.now() - lastAuto > 1200) setDismissed(false)
        })
        tick()
        return function () { offMounted(); offList(); offTabs() }
      }

      return {
        inject: ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions'],
        apply: function (ctx) {
          /* 三个席位各自独立：任何一个注册失败都只降级自己，不能让整份插件不加载。
           * （register 或 effect 同步抛出时，宿主会把它当成 apply 失败而卸掉整个 bundle。） */
          function guard(label, fn) {
            function warn(error) {
              var text = label + ' 注册失败：' + (error && error.message ? error.message : String(error))
              try { console.warn('[cto-office] ' + text) } catch (ignored) { /* console 也可能不可用 */ }
            }
            try {
              return ctx.effect(function () {
                try { return fn() } catch (error) { warn(error) }
              }, label)
            } catch (error) { warn(error) }
          }

          guard('cto-office: role-feed tab kind', function () {
            return ctx.sidebarRightTabs.register({
              id: TAB_ID,
              kind: KIND,
              priority: 'extension',
              title: function () { return '办公室信息流' },
              guide: [{ id: TAB_ID + ':guide', order: 10, title: function () { return '办公室信息流' }, description: function () { return '七角色实时信息流' } }],
              keepMounted: false
            })
          })

          guard('cto-office: role-feed pane', function () {
            return ctx.slots.inject('sidebar.right.pane.tab', function () {
              return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, function (props) {
                return h(ErrorBoundary, { sessionId: props && props.sessionId }, h(Panel, Object.assign({}, props, { ctx: ctx })))
              })
            })
          })

          guard('cto-office: role-feed auto open', function () { return autoOpen(ctx) })
        }
      }
    }
  })
})()
