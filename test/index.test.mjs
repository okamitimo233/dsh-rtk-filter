import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply, inject, loadConfigSchema, name, toolAborted } from '../index.js'

test('the entry exposes the Loader contract without the optional schema', () => {
  assert.equal(name, 'rtk-filter')
  assert.deepEqual(inject, ['tools', 'agents', 'systemPrompt'])
  // The test checkout cannot resolve DSH's shipped schemastery package.
  assert.equal(Config, undefined)
})

test('loadConfigSchema builds the schema when the package resolves', async () => {
  const field = () => {
    const builder = {
      default(value) {
        builder.defaultValue = value
        return builder
      },
      step() {
        return builder
      },
      min() {
        return builder
      },
    }
    return builder
  }
  const z = {
    boolean: field,
    string: field,
    number: field,
    const: field,
    union: () => field(),
    object: (shape) => ({ shape }),
  }
  const schema = await loadConfigSchema(async () => ({ default: z }))
  assert.equal(typeof schema.shape.enabled.defaultValue, 'boolean')
  assert.equal(typeof schema.shape.binary.defaultValue, 'string')

  assert.equal(await loadConfigSchema(async () => { throw new Error('missing') }), undefined)
})

test('toolAborted uses the tool-call cancellation code', () => {
  const error = toolAborted()
  assert.equal(error.name, 'AbortError')
  assert.equal(error.code, 'ABORTED')
  assert.equal(error.message, 'tool call aborted')
})

test('apply returns early for a disabled configuration', async () => {
  let logged = 0
  const ctx = { logger: { info() { logged += 1 } } }
  await apply(ctx, { enabled: false })
  assert.equal(logged, 1)
})
