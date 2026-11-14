#!/usr/bin/env node
// sync-office-data@2 — 从 cordis.patch.yml 抽取工具边界事实，生成 docs/office.json
// 并写入 docs/architecture.html 的 <!-- office-data:start --> … <!-- office-data:end --> 区间。
// 零依赖；Node >= 22。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = '@chy/dsh-cto-office@0.1.0';
const SCHEMA = 'cto-office/office-data@1';
const SCRIPT_ID = 'sync-office-data@2';

const DEFAULTS = {
  patch: 'cordis.patch.yml',
  html: 'docs/architecture.html',
  json: 'docs/office.json'
};

const START = '<!-- office-data:start -->';
const END = '<!-- office-data:end -->';

// 口径不可回潮：页面不得再出现串行双闸的旧说法。
// 字面量用转义写，避免扫描器自身被仓库全文自检命中。
const BANNED = ['\u8fc7\u53cc\u95f8', '\u904e\u96d9\u9598'];

// 去空白并反转义 \\uXXXX，防止拆字 / 转义绕过禁用词扫描。
function normalizeBanText(line) {
  return line.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, '');
}

const ALLOWLIST = new Set([
  'tool-bash', 'tool-pwsh', 'tool-fs', 'tool-fs-search', 'tool-jobs', 'tool-ask-user',
  'tool-todo', 'tool-web', 'tool-skill', 'tool-office', 'tool-goal', 'tool-subagent',
  'tool-subagent-control', 'present', 'command-goal', 'command-compact', 'persona',
  'agent-instructions', 'time-context', 'skill-filesystem', 'compaction-basic',
  'tool-result-pruner'
]);

const TOOL_KEYS = ['read', 'write', 'edit', 'applyPatch', 'bash', 'pwsh', 'search', 'jobs',
  'todo', 'web', 'askUser', 'present', 'goal', 'office', 'subagent', 'skill', 'fsSearch'];

// 页面 copy.meta.toolSemantics 只列这 14 项；web / skill / fsSearch 有行号但不在页面语义里。
const SEMANTIC_KEYS = TOOL_KEYS.filter((key) => !['web', 'skill', 'fsSearch'].includes(key));

const MOUNT_TO_KEY = {
  'tool-bash': 'bash',
  'tool-pwsh': 'pwsh',
  'tool-fs-search': 'search',
  'tool-jobs': 'jobs',
  'tool-todo': 'todo',
  'tool-web': 'web',
  'tool-ask-user': 'askUser',
  present: 'present',
  'tool-goal': 'goal',
  'tool-office': 'office',
  'tool-subagent': 'subagent',
  'tool-skill': 'skill',
  'skill-filesystem': 'fsSearch'
};

const EXPECTED = (() => {
  const all = Object.fromEntries(TOOL_KEYS.map((k) => [k, true]));
  all.applyPatch = false;
  const roNoWeb = { ...all, write: false, edit: false, jobs: false, web: false, askUser: false,
    present: false, goal: false, office: false, subagent: false };
  const roWeb = { ...roNoWeb, web: true };
  const builder = { ...all, web: false, askUser: false, present: false, goal: false,
    office: false, subagent: false };
  return {
    'cto-office': all,
    'cto-architect': roWeb,
    'cto-builder': builder,
    'cto-reviewer': roNoWeb,
    'cto-qa': roNoWeb,
    'cto-ux': roWeb,
    'cto-product': roWeb
  };
})();

function fail(code, message) {
  process.stderr.write('E_' + code + ': ' + message + '\n');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { check: false, stdout: false, quiet: false, patch: DEFAULTS.patch,
    html: DEFAULTS.html, json: DEFAULTS.json };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--stdout') opts.stdout = true;
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--patch' || arg === '--html' || arg === '--json') {
      const value = argv[i + 1];
      if (!value) fail('ARGS', arg + ' 需要参数');
      opts[arg.slice(2)] = value;
      i += 1;
    } else fail('ARGS', '未知参数 ' + arg);
  }
  if (opts.check && opts.stdout) fail('ARGS', '--check 与 --stdout 不能同时使用');
  for (const key of ['patch', 'html', 'json']) {
    if (!path.isAbsolute(opts[key])) opts[key] = path.join(ROOT, opts[key]);
  }
  return opts;
}

function indentOf(line) {
  const m = line.match(/^ */);
  return m ? m[0].length : 0;
}

function blankTools() {
  const out = {};
  for (const key of TOOL_KEYS) out[key] = false;
  return out;
}

function parsePatch(text) {
  const lines = text.split('\n');
  const presets = [];
  let i = 0;
  while (i < lines.length) {
    const head = lines[i].match(/^ {4}- id: preset-(cto-[a-z0-9-]+)$/);
    if (!head) { i += 1; continue; }
    const preset = {
      id: head[1],
      line: i + 1,
      name: null,
      order: null,
      description: null,
      tools: blankTools(),
      mountLines: {},
      fsLines: {},
      delegationLine: null,
      delegation: { mounted: false, defaultPreset: null, interrupt: null, allowedAgentPresets: [] }
    };
    let j = i + 1;
    let skipIndent = -1;
    let currentMount = null;
    let inAllowed = false;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') { inAllowed = false; continue; }
      const ind = indentOf(line);
      if (ind <= 4) break;
      if (skipIndent >= 0) {
        if (ind > skipIndent) continue;
        skipIndent = -1;
      }
      if (/^ *- !!js \|$/.test(line)) {
        skipIndent = ind;
        continue;
      }
      const field = line.match(/^ {8}(id|name|order|description): (.*)$/);
      if (field) {
        const value = field[2].trim();
        if (field[1] === 'order') preset.order = Number(value);
        else if (field[1] === 'name') preset.name = value;
        else if (field[1] === 'description') preset.description = value;
        inAllowed = false;
        continue;
      }
      const nestedTool = line.match(/^ {10,}- id: (tool-[a-z0-9-]+)$/);
      if (nestedTool && ind > 10) {
        if (!ALLOWLIST.has(nestedTool[1])) {
          fail('UNKNOWN_TOOL', 'preset ' + preset.id + ' 第 ' + (j + 1) + ' 行：未知挂载 ' + nestedTool[1] + '（不在 ALLOWLIST）');
        }
        continue;
      }
      const mount = line.match(/^ {10}- id: ([a-z0-9][a-z0-9-]*)$/);
      if (mount) {
        const id = mount[1];
        currentMount = id;
        inAllowed = false;
        if (id === 'delegation') {
          preset.delegationLine = j + 1;
          preset.delegation.mounted = true;
          preset.tools.subagent = true;
          continue;
        }
        if (!ALLOWLIST.has(id)) {
          if (id.startsWith('tool-')) {
            fail('UNKNOWN_TOOL', 'preset ' + preset.id + ' 第 ' + (j + 1) + ' 行：未知挂载 ' + id + '（不在 ALLOWLIST）');
          }
          continue;
        }
        if (id === 'tool-fs') {
          preset.tools.read = true;
          preset.tools.write = true;
          preset.tools.edit = true;
          preset.tools.applyPatch = true;
        }
        const key = MOUNT_TO_KEY[id];
        if (key) preset.tools[key] = true;
        preset.mountLines[id] = j + 1;
        continue;
      }
      const fsCfg = line.match(/^ {14}(write|edit|applyPatch): (true|false)$/);
      if (fsCfg && (currentMount === 'tool-fs' || currentMount === 'tool-fs-search')) {
        const key = fsCfg[1];
        if (key === 'write' || key === 'edit' || key === 'applyPatch') {
          preset.tools[key] = fsCfg[2] === 'true';
          preset.fsLines[key] = j + 1;
        }
        continue;
      }
      if (currentMount === 'tool-bash' || currentMount === 'tool-pwsh') {
        if (/^ {12,14}disabled: !!js /.test(line)) {
          preset.fsLines[currentMount + '.disabled'] = j + 1;
          continue;
        }
      }
      if (currentMount === 'delegation' || inAllowed) {
        if (/^ *allowedAgentPresets:\s*$/.test(line)) { inAllowed = true; continue; }
        if (inAllowed) {
          const item = line.match(/^ {20}- (cto-[a-z0-9-]+)$/);
          if (item) { preset.delegation.allowedAgentPresets.push(item[1]); continue; }
          inAllowed = false;
        }
        const dflt = line.match(/^ *agentPreset: (cto-[a-z0-9-]+)$/);
        if (dflt) { preset.delegation.defaultPreset = dflt[1]; continue; }
        const intr = line.match(/^ *interrupt: (true|false)$/);
        if (intr) { preset.delegation.interrupt = intr[2] === 'true'; continue; }
      }
    }
    if (preset.name == null || preset.order == null) {
      fail('FIXTURE', 'preset ' + preset.id + ' 缺少 name/order');
    }
    preset.isRoot = preset.id === 'cto-office';
    preset.canDispatch = preset.delegation.mounted && preset.delegation.allowedAgentPresets.length > 0;
    presets.push(preset);
    i = j;
  }
  return { lines, presets };
}

function assertFixture(presets, lineCount) {
  if (presets.length !== 7) fail('FIXTURE', '预设数量 ' + presets.length + ' ≠ 7');
  const ids = new Set();
  const orders = new Set();
  for (const p of presets) {
    if (ids.has(p.id)) fail('FIXTURE', 'id 重复 ' + p.id);
    if (orders.has(p.order)) fail('FIXTURE', 'order 重复 ' + p.order);
    ids.add(p.id);
    orders.add(p.order);
    const want = EXPECTED[p.id];
    if (!want) fail('FIXTURE', '未知 preset ' + p.id);
    for (const key of TOOL_KEYS) {
      if (p.tools[key] !== want[key]) {
        fail('FIXTURE', p.id + '.' + key + ': 实测 ' + p.tools[key] + ' 期望 ' + want[key]);
      }
    }
  }
  const roots = presets.filter((p) => p.isRoot);
  if (roots.length !== 1) fail('FIXTURE', '根 preset 数量 ' + roots.length + ' ≠ 1');
  if (!roots[0].canDispatch) fail('FIXTURE', '根 preset 不能派工');
  if (roots[0].delegation.allowedAgentPresets.length !== 6) {
    fail('FIXTURE', 'allowedAgentPresets 长度 ' + roots[0].delegation.allowedAgentPresets.length + ' ≠ 6');
  }
  const allowedList = roots[0].delegation.allowedAgentPresets;
  if (new Set(allowedList).size !== allowedList.length) {
    fail('FIXTURE', 'allowedAgentPresets 有重复 id');
  }
  if (allowedList.includes(roots[0].id)) fail('FIXTURE', 'allowedAgentPresets 含 root id');
  for (const id of allowedList) {
    if (!ids.has(id)) fail('FIXTURE', 'allowedAgentPresets 含未知 id ' + id);
  }
  if (!lineCount) fail('FIXTURE', 'patch 为空');
}

function buildFacts(patchText, opts) {
  const sha256 = crypto.createHash('sha256').update(patchText).digest('hex');
  const { lines, presets } = parsePatch(patchText);
  assertFixture(presets, lines.length - 1);

  const toolLines = {};
  const refs = {};
  for (const p of presets) {
    const linesFor = {};
    for (const [key, value] of Object.entries(p.mountLines)) {
      const toolKey = MOUNT_TO_KEY[key];
      if (toolKey && !linesFor[toolKey]) linesFor[toolKey] = value;
    }
    for (const [key, value] of Object.entries(p.fsLines)) {
      if (key === 'write' || key === 'edit' || key === 'applyPatch') {
        if (!linesFor[key]) linesFor[key] = value;
      }
    }
    if (linesFor.read == null) linesFor.read = p.mountLines['tool-fs'] || p.line;
    if (linesFor.applyPatch == null) linesFor.applyPatch = p.line;
    // sourceRefs: preset 行 + 每个工具首次出现的行，升序去重
    const refSet = new Set([p.line]);
    for (const value of Object.values(linesFor)) refSet.add(value);
    if (p.delegationLine) refSet.add(p.delegationLine);
    refs[p.id] = Array.from(refSet).sort((a, b) => a - b);
    toolLines[p.id] = {};
    for (const key of TOOL_KEYS) {
      if (linesFor[key] != null) toolLines[p.id][key] = linesFor[key];
    }
  }

  const hintTools = {};
  for (const key of SEMANTIC_KEYS) {
    const set = new Set();
    for (const p of presets) {
      const value = toolLines[p.id][key];
      if (value != null) set.add(value);
    }
    hintTools[key] = Array.from(set).sort((a, b) => a - b);
  }
  const applyPatchLines = (hintTools.applyPatch || []).slice();
  const forkLines = [];
  const workflowLines = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('#')) return;
    if (/subagent_fork|\bfork\b/i.test(trimmed)) forkLines.push(index + 1);
  });
  // workflow 只在 delegation 组紧邻上方的连续注释里取证，避免把设计意图注释也算进来。
  for (const p of presets) {
    if (!p.delegationLine) continue;
    for (let k = p.delegationLine - 2; k >= 0; k -= 1) {
      const text = lines[k].trim();
      if (!text.startsWith('#')) break;
      if (/workflow/i.test(text) && /不挂|未挂载|没有/.test(text)) workflowLines.push(k + 1);
    }
  }
  workflowLines.sort((a, b) => a - b);

  const outPresets = presets.map((p) => {
    const tools = {};
    for (const key of TOOL_KEYS) tools[key] = p.tools[key];
    return {
      id: p.id,
      name: p.name,
      order: p.order,
      description: p.description,
      isRoot: p.isRoot,
      canDispatch: p.canDispatch,
      tools,
      delegation: {
        mounted: p.delegation.mounted,
        defaultPreset: p.delegation.defaultPreset,
        interrupt: p.delegation.interrupt,
        allowedAgentPresets: p.delegation.allowedAgentPresets
      },
      sourceRefs: refs[p.id],
      toolLines: toolLines[p.id]
    };
  });

  const rootPresets = outPresets.filter((p) => p.isRoot);
  const allowed = rootPresets[0].delegation.allowedAgentPresets;

  return {
    schema: SCHEMA,
    bundle: BUNDLE,
    provenance: {
      sourceFile: path.basename(opts.patch),
      sha256,
      sha256Short: sha256.slice(0, 8),
      lines: lines.length - 1,
      script: SCRIPT_ID,
      verify: 'generated-from-patch'
    },
    counts: {
      presets: outPresets.length,
      root: rootPresets.length,
      posts: outPresets.length - rootPresets.length,
      dispatchEdges: allowed.length,
      allowedPresets: allowed.length
    },
    presets: outPresets,
    lineHints: {
      tools: hintTools,
      disabledTools: {
        apply_patch: applyPatchLines,
        subagent_fork: forkLines,
        workflow: workflowLines
      }
    }
  };
}

function stableJson(facts) {
  return JSON.stringify(facts, null, 2) + '\n';
}

function htmlScriptBody(json) {
  return '<script type="application/json" id="office-data">\n' + json + '</script>\n';
}

function markersIn(text) {
  const lines = text.split('\n');
  const starts = [];
  const ends = [];
  lines.forEach((line, index) => {
    if (line === START) starts.push(index);
    if (line === END) ends.push(index);
  });
  if (starts.length !== 1 || ends.length !== 1) {
    fail('MARKERS', '标记数量 start=' + starts.length + ' end=' + ends.length + '（各需 1）');
  }
  if (starts[0] > ends[0]) fail('MARKERS', 'start 在 end 之后');
  const inner = lines.slice(starts[0] + 1, ends[0]);
  if (inner.some((line) => line === START || line === END)) {
    fail('MARKERS', '区间内出现重复标记');
  }
  return { lines, starts: starts[0], ends: ends[0], inner };
}

function injectHtml(htmlText, json) {
  const { lines, starts, ends } = markersIn(htmlText);
  const body = htmlScriptBody(json).replace(/\n$/, '');
  const next = lines.slice(0, starts + 1).concat(body.split('\n'), lines.slice(ends));
  return next.join('\n');
}

function readInput(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    fail('FILE', path.relative(ROOT, file) + ' 不存在或不可读');
  }
}

function stageFile(file, content) {
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { /* missing */ }
  if (current === content) return null;
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.tmp-' + path.basename(file) + '-' + process.pid);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    let mode = 0o644;
    try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
    fs.chmodSync(tmp, mode);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* nothing staged */ }
    fail('FILE', path.relative(ROOT, file) + ' 不可写');
  }
  return tmp;
}

function writeIfChanged(file, content) {
  const tmp = stageFile(file, content);
  if (!tmp) return false;
  try {
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
  }
  return true;
}

function flatten(value, prefix, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const key = item && typeof item === 'object' && item.id ? item.id : String(index);
      flatten(item, prefix + '[' + key + ']', out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) flatten(value[key], prefix ? prefix + '.' + key : key, out);
  } else {
    out[prefix] = value;
  }
  return out;
}

function diffObjects(expected, actual) {
  const a = flatten(expected, '', {});
  const b = flatten(actual, '', {});
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const rows = [];
  for (const key of Array.from(keys).sort()) {
    const left = JSON.stringify(b[key]);
    const right = JSON.stringify(a[key]);
    if (left !== right) rows.push({ key, actual: left, expected: right });
  }
  return rows;
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return n;
}

function copyKeysFromHtml(htmlText) {
  const m = htmlText.match(/<script type="application\/json" id="office-copy">\n([\s\S]*?)\n<\/script>/);
  if (!m) return null;
  try {
    const copy = JSON.parse(m[1]);
    const table = copy && copy.meta && copy.meta.toolSemantics;
    return table && typeof table === 'object' ? Object.keys(table).sort() : null;
  } catch {
    return null;
  }
}

function checkMode(opts, facts, json) {
  const commit = gitCommit();
  process.stdout.write('patch sha256=' + facts.provenance.sha256 + ' lines=' + facts.provenance.lines +
    ' script=' + SCRIPT_ID + ' commit=' + (commit || '(unavailable)') + '\n');
  let dirty = false;
  const jsonRel = path.relative(ROOT, opts.json) || opts.json;
  if (!fs.existsSync(opts.json)) {
    process.stdout.write(jsonRel + ': 文件不存在\n');
    dirty = true;
  } else {
    const raw = fs.readFileSync(opts.json, 'utf8');
    let actual = null;
    try { actual = JSON.parse(raw); } catch { actual = null; }
    if (!actual) {
      process.stdout.write(jsonRel + ': 不是合法 JSON\n');
      dirty = true;
    } else {
      const rows = diffObjects(facts, actual);
      for (const row of rows) {
        process.stdout.write(row.key + ': file=' + row.actual + ' patch=' + row.expected + '\n');
      }
      if (raw !== json) {
        if (rows.length === 0) {
          const at = firstDiffIndex(raw, json);
          const line = raw.slice(0, at).split('\n').length;
          process.stdout.write(jsonRel + ': 内容顺序/格式与 patch 不一致（首个差异 行 ' + line + '，偏移 ' + at + '）\n');
        }
        dirty = true;
      }
      if (actual.provenance && actual.provenance.script !== SCRIPT_ID) {
        process.stdout.write('provenance.script: file=' + JSON.stringify(actual.provenance.script) +
          ' patch=' + JSON.stringify(SCRIPT_ID) + '\n');
        dirty = true;
      }
    }
  }
  const htmlRel = path.relative(ROOT, opts.html) || opts.html;
  if (!fs.existsSync(opts.html)) {
    process.stdout.write(htmlRel + ': 文件不存在\n');
    dirty = true;
  } else {
    const html = fs.readFileSync(opts.html, 'utf8');
    html.split('\n').forEach((line, index) => {
      const normalized = normalizeBanText(line);
      for (const word of BANNED) {
        if (normalized.includes(word)) {
          process.stdout.write('E_BANNED: ' + htmlRel + ':' + (index + 1) + ' 命中禁用词「' + word + '」\n');
          dirty = true;
        }
      }
    });
    const { inner } = markersIn(html);
    const text = inner.join('\n');
    const m = text.match(/<script type="application\/json" id="office-data">\n([\s\S]*)\n<\/script>/);
    if (!m) {
      process.stdout.write(htmlRel + ': 区间内没有 office-data script\n');
      dirty = true;
    } else if (m[1] + '\n' !== json) {
      process.stdout.write('html#office-data: 与 patch 不一致\n');
      dirty = true;
    }
    const copyKeys = copyKeysFromHtml(html);
    if (!copyKeys) {
      process.stdout.write(htmlRel + ': office-copy 缺失或 toolSemantics 不可解析\n');
      dirty = true;
    } else {
      const hintKeys = Object.keys(facts.lineHints.tools).sort();
      if (copyKeys.join(',') !== hintKeys.join(',')) {
        process.stdout.write('toolSemantics 键集 [' + copyKeys.join(',') + '] ≠ lineHints [' + hintKeys.join(',') + ']\n');
        dirty = true;
      }
    }
  }
  process.exit(dirty ? 1 : 0);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const patchText = readInput(opts.patch);
  const facts = buildFacts(patchText, opts);
  const json = stableJson(facts);
  if (opts.stdout) {
    process.stdout.write(json);
    return;
  }
  if (opts.check) {
    checkMode(opts, facts, json);
    return;
  }
  const htmlText = readInput(opts.html);
  const nextHtml = injectHtml(htmlText, json);
  markersIn(nextHtml);
  let tmpJson = null;
  let tmpHtml = null;
  let wroteJson = false;
  let wroteHtml = false;
  try {
    tmpJson = stageFile(opts.json, json);
    tmpHtml = stageFile(opts.html, nextHtml);
    if (tmpJson) { fs.renameSync(tmpJson, opts.json); tmpJson = null; wroteJson = true; }
    if (tmpHtml) { fs.renameSync(tmpHtml, opts.html); tmpHtml = null; wroteHtml = true; }
  } finally {
    for (const tmp of [tmpJson, tmpHtml]) {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* renamed or gone */ } }
    }
  }
  if (!opts.quiet) {
    process.stdout.write('patch sha256=' + facts.provenance.sha256 + ' lines=' + facts.provenance.lines + '\n');
    process.stdout.write((wroteJson ? 'wrote ' : 'unchanged ') + path.relative(ROOT, opts.json) + '\n');
    process.stdout.write((wroteHtml ? 'wrote ' : 'unchanged ') + path.relative(ROOT, opts.html) + '\n');
  }
}

main();
