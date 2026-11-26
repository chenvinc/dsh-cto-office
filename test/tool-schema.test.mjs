/**
 * 工具 schema 形状检查（回归护栏）。
 *
 * 为什么单独一个文件：这是**第三次**被 schema 方言咬到。
 *   发现 1：`output.schema` 的属性级 `required` → 宿主拒
 *   发现 4：`parameters` 的属性级 `required` → 静默放行后类型错乱
 *   真机第三次：`type: ['number','null']` → JsonSchemaError → 挂这颗插件的
 *              preset 整条激活失败（模式选择里 CTO 消失，只剩岗位）
 *
 * 宿主的 schema 子集（见 `dsh-tools/lib/types/json-schema.js` 头注释）：
 *   任意 JSON 根 / 纯注解 schema / **单一** `type` / 对象的 properties+required+
 *   布尔 additionalProperties / 数组 items / 类型正确的 enum+const / 恰好一个 oneOf。
 *   **不支持的写法是拒绝，不是忽略** —— 所以一次写错就等于插件起不来。
 *
 * 这里只做**形状 lint**（type 不许是数组、关键词不许越界、属性上不许写 required），
 * 不做语义校验 —— 语义由探针在 Electron 下用宿主真校验器复核（platform-probe 的 SELF-4）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildTools } from '../lib/tools.js'

const TOOLS = buildTools({}, { registry: { get: () => ({}) }, config: {} })

const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
/** 宿主不支持的常见写法：一旦出现就是「插件起不来」级别的问题。 */
const BANNED = ['anyOf', 'allOf', 'not', 'notEmpty', '$ref', 'patternProperties', 'format', 'if', 'then', 'else', 'dependencies', 'uniqueItems', 'minItems', 'maxItems']

function walk(schema, path, problems, seen = new Set()) {
  if (schema === null || typeof schema !== 'object') return
  if (seen.has(schema)) return
  seen.add(schema)

  for (const key of Object.keys(schema)) {
    if (BANNED.includes(key)) problems.push(`${path}.${key} 是不受支持的关键词`)
    else if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) problems.push(`${path}.${key} 不在已知关键词里`)
  }
  if ('type' in schema) {
    if (Array.isArray(schema.type)) problems.push(`${path}.type 是数组（宿主只接受单一 type 字符串）`)
    else if (!ALLOWED_TYPES.has(schema.type)) problems.push(`${path}.type=${schema.type} 不在允许集合内`)
  }
  if ('required' in schema && !Array.isArray(schema.required)) {
    problems.push(`${path}.required 必须是字符串数组（属性级 required: true 会被拒/静默放行）`)
  }
  if (Array.isArray(schema.oneOf)) schema.oneOf.forEach((sub, i) => walk(sub, `${path}.oneOf[${i}]`, problems, seen))
  if (schema.items) walk(schema.items, `${path}.items`, problems, seen)
  if (schema.properties) {
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (sub && typeof sub === 'object' && 'required' in sub) problems.push(`${path}.properties.${key} 属性上不得出现 required`)
      walk(sub, `${path}.properties.${key}`, problems, seen)
    }
  }
}

test('schema 形状：所有工具的 parameters 都落在宿主支持的子集内', () => {
  const problems = []
  for (const [name, tool] of Object.entries(TOOLS)) {
    if (!tool.parameters) { problems.push(`${name} 缺 parameters`); continue }
    walk(tool.parameters, `${name}.parameters`, problems)
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('schema 形状：所有工具的 output.schema 都落在宿主支持的子集内', () => {
  const problems = []
  for (const [name, tool] of Object.entries(TOOLS)) {
    const schema = tool.output?.schema
    if (!schema) { problems.push(`${name} 缺 output.schema`); continue }
    walk(schema, `${name}.output`, problems)
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('schema 形状：可空数值必须用 oneOf 表达，不许用 type 数组', () => {
  // 直接盯住真机踩到的那一处：office_metrics 的三个比率可以为 null（样本不足）
  const schema = TOOLS.metrics.output.schema
  for (const field of ['blockRate', 'reworkRate', 'outOfScopeRate']) {
    const prop = schema.properties[field]
    assert.equal(prop.type, undefined, `${field} 不能写 type`)
    assert.deepEqual(prop.oneOf?.map(s => s.type), ['number', 'null'], `${field} 用 oneOf 表达可空`)
  }
})
