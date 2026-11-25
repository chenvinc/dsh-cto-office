/**
 * 参数 schema 转换与校验（W0 真机发现 2 号问题）。
 *
 * 背景：`ToolSchema.parameters` 的契约是**标准 JSON Schema**（`{type:'object', properties,
 * required:[...]}`）。我最初按 DSH 作者声明方言写了属性级 `required: true`，
 * 结果是宿主不校验、array/整型参数被字符串化后静默落盘：
 *   include:  "[\"test/w1.test.mjs\"]"      ← 应为数组
 *   declared.files: "1"                      ← 应为整数
 *
 * 这里做两件事：
 *  1. `toStandardSchema()`：把紧凑写法转成标准 JSON Schema；
 *  2. `coerceArgs()`：显式做类型归一 —— 只接受「字符串里就是合法 JSON」这种情况并记录，
 *     其余一律抛清晰错误。绝不再静默放行。
 */

/**
 * @param spec { [name]: { type, description?, required?, enum?, items? } }
 */
export function toStandardSchema(spec) {
  const properties = {}
  const required = []
  for (const [name, def] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = def
    properties[name] = rest
    if (isRequired) required.push(name)
  }
  return {
    type: 'object',
    properties,
    additionalProperties: false,
    ...(required.length ? { required } : {}),
  }
}

const TYPE_CHECKS = {
  string: v => typeof v === 'string',
  integer: v => Number.isInteger(v),
  number: v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  array: v => Array.isArray(v),
  object: v => v !== null && typeof v === 'object' && !Array.isArray(v),
}

/**
 * 归一 + 校验。返回 { args, corrections }。
 * 仅当字符串内容是该类型的合法 JSON 时才转换（例如 "[a]" → ["a"]），并记录一次更正；
 * 其余类型不符直接抛错，错误信息里带期望类型与实际值。
 */
export function coerceArgs(toolName, spec, raw) {
  const args = { ...(raw ?? {}) }
  const corrections = []

  for (const [name, def] of Object.entries(spec)) {
    const value = args[name]
    if (value === undefined || value === null) continue
    const expect = def.type
    const check = TYPE_CHECKS[expect]
    if (!check || check(value)) continue

    if (typeof value === 'string' && (expect === 'array' || expect === 'object' || expect === 'integer' || expect === 'boolean')) {
      try {
        const parsed = JSON.parse(value)
        if (check(parsed)) {
          args[name] = parsed
          corrections.push(`${name}: 字符串 → ${expect}`)
          continue
        }
      } catch {
        // 落到下面统一报错
      }
    }
    throw new Error(
      `${toolName}.${name} 类型错误：期望 ${expect}，收到 ${Array.isArray(value) ? 'array' : typeof value}`
      + `（值：${JSON.stringify(value).slice(0, 80)}）。请按 schema 传参，不要把它序列化成字符串。`,
    )
  }
  return { args, corrections }
}

/** 把 required 缺失也挡掉（宿主 schema 不强制时，我们自己强）。 */
export function assertRequired(toolName, spec, args) {
  const missing = Object.entries(spec).filter(([name, def]) => def.required && (args[name] === undefined || args[name] === null)).map(([name]) => name)
  if (missing.length) throw new Error(`${toolName} 缺少必填参数：${missing.join(', ')}`)
}
