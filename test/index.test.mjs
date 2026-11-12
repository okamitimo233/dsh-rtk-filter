import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, apply, inject, loadConfigSchema, name, smokeRewrite, toolAborted } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'rtk-dsh-index-'))

after(() => rmSync(dir, { recursive: true, force: true }))

function fake(name, body) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

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
  assert.equal(typeof schema.shape.edition.defaultValue, 'string')

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

test('smokeRewrite accepts a binary that rewrites the first probe', async () => {
  const binary = fake('rewrite-all', `case "$1" in
    rewrite) printf '%s' "rtk $2"; exit 0 ;;
  esac`)
  assert.deepEqual(await smokeRewrite({ binary }), { ok: true })
})

test('smokeRewrite tries the second probe when the first passes through', async () => {
  const binary = fake('rewrite-ls', `case "$1" in
    rewrite)
      case "$2" in
        ls) printf '%s' "rtk ls"; exit 0 ;;
        *) exit 1 ;;
      esac ;;
  esac`)
  assert.deepEqual(await smokeRewrite({ binary }), { ok: true })
})

test('smokeRewrite reports every pass-through probe', async () => {
  const binary = fake('rewrite-none', 'exit 1')
  const result = await smokeRewrite({ binary })
  assert.equal(result.ok, false)
  assert.match(result.reason, /git status: pass \(no RTK rewrite\)/)
  assert.match(result.reason, /ls: pass \(no RTK rewrite\)/)
})

test('smokeRewrite reports a denied probe', async () => {
  const binary = fake('rewrite-deny', `case "$1" in
    rewrite) printf '%s' 'blocked'; exit 2 ;;
  esac`)
  const result = await smokeRewrite({ binary })
  assert.equal(result.ok, false)
  assert.match(result.reason, /git status: deny \(blocked\)/)
})

test('smokeRewrite reports a throwing probe', async () => {
  const binary = fake('rewrite-abort', `case "$1" in
    rewrite) printf '%s' "rtk $2"; exit 0 ;;
  esac`)
  const result = await smokeRewrite({ binary, signal: AbortSignal.abort() })
  assert.equal(result.ok, false)
  assert.match(result.reason, /git status: .*abort/)
})

test('smokeRewrite renders a non-Error probe failure', async () => {
  const binary = fake('rewrite-weird', `case "$1" in
    rewrite) printf '%s' "rtk $2"; exit 0 ;;
  esac`)
  const result = await smokeRewrite({
    binary,
    signal: {
      get aborted() {
        throw 'weird signal'
      },
    },
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /git status: weird signal/)
})
