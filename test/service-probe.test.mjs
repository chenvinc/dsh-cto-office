/**
 * alpha.5 回归：可选服务读取必须走 ctx.get，不能裸读未 inject 的属性。
 *
 * 模拟 cordis 4 的行为：未 inject 的服务属性直接抛
 * `cannot get property ... without inject`，只有 ctx.get(name) 能读。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optionalService } from '../lib/service-probe.js'

const service = { ask: async () => ({ answers: [] }) }

test('optionalService：属性裸读抛错时仍能经 ctx.get 拿到服务', () => {
  const ctx = new Proxy({ get: name => (name === 'userQuestions' ? service : undefined) }, {
    get(target, prop) {
      if (prop in target) return target[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  assert.equal(optionalService(ctx, 'userQuestions'), service)
})

test('optionalService：没有 get 时退回 reflect.get', () => {
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'reflect') return { get: () => service }
      if (prop in target) return target[prop]
      throw new Error('cannot get property without inject')
    },
  })
  assert.equal(optionalService(ctx, 'timer'), service)
})

test('optionalService：服务不存在 / ctx 为空 / get 抛错时返回 undefined 且不抛', () => {
  assert.equal(optionalService({ get: () => undefined }, 'nope'), undefined)
  assert.equal(optionalService(undefined, 'userQuestions'), undefined)
  assert.equal(optionalService({ get() { throw new Error('boom') } }, 'userQuestions'), undefined)
})