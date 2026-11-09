import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createBashShadow } from '../lib/shadow.js'

const originalDisabled = process.env.RTK_DISABLED

afterEach(() => {
  if (originalDisabled === undefined) delete process.env.RTK_DISABLED
  else process.env.RTK_DISABLED = originalDisabled
})

function makeHarness({
  outcome = { kind: 'pass', reason: 'no rewrite' },
  onRewrite,
  hasBase = true,
  getPathPrefix,
} = {}) {
  const calls = []
  const rewriteCalls = []
  const logs = []

  let base = {
    name: 'bash',
    description: 'original description',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    output: { schema: { type: 'string' }, render: () => [] },
    timeoutMs: 1234,
    async execute(args, exec) {
      calls.push({ args, exec })
      return { echo: args.command }
    },
    isConcurrencySafe: () => true,
  }

  const shadow = createBashShadow({
    getBase: () => (hasBase ? base : undefined),
    rewrite: async (input) => {
      rewriteCalls.push(input)
      if (onRewrite !== undefined) return onRewrite(input)
      return outcome
    },
    cwdFor: () => '/work',
    getPathPrefix,
    toolAborted: () => Object.assign(new Error('tool call aborted'), { name: 'AbortError' }),
    log: (message) => logs.push(message),
  })

  return {
    shadow,
    calls,
    rewriteCalls,
    logs,
    setBase(overrides) {
      base = { ...base, ...overrides }
    },
  }
}

test('mirrors the captured inherited bash definition', () => {
  const harness = makeHarness()
  assert.equal(harness.shadow.name, 'bash')
  assert.equal(harness.shadow.description, 'original description')
  assert.equal(harness.shadow.timeoutMs, 1234)
  assert.deepEqual(harness.shadow.parameters, {
    type: 'object',
    properties: { command: { type: 'string' } },
  })
  assert.equal(harness.shadow.isConcurrencySafe(), true)

  harness.setBase({ description: 'updated description', timeoutMs: 4321 })
  assert.equal(harness.shadow.description, 'updated description')
  assert.equal(harness.shadow.timeoutMs, 4321)
})

test('delegates the rewritten command to the captured bash tool', async () => {
  const harness = makeHarness({ outcome: { kind: 'rewrite', command: 'rtk git status' } })
  const args = { command: 'git status', description: 'Show working tree status' }

  const result = await harness.shadow.execute(args, {})

  assert.deepEqual(result, { echo: 'rtk git status' })
  assert.equal(harness.calls.length, 1)
  assert.equal(harness.calls[0].args.command, 'rtk git status')
  assert.equal(harness.calls[0].args.description, 'Show working tree status')
  assert.equal(harness.rewriteCalls[0].command, 'git status')
  assert.equal(harness.rewriteCalls[0].cwd, '/work')
  assert.match(harness.logs[0], /git status -> rtk git status/)
})

test('passes the original command through unchanged', async () => {
  const harness = makeHarness()
  const args = { command: 'echo hello', description: 'Print greeting' }

  await harness.shadow.execute(args, {})

  assert.deepEqual(harness.calls[0].args, args)
})

test('a deny blocks the call', async () => {
  const harness = makeHarness({ outcome: { kind: 'deny', reason: 'blocked by a deny rule' } })
  await assert.rejects(
    harness.shadow.execute({ command: 'git push', description: 'Push' }, {}),
    /rtk denied this command: blocked by a deny rule/,
  )
  assert.equal(harness.calls.length, 0)
})

test('commands already starting with rtk are not rewritten', async () => {
  const harness = makeHarness()
  await harness.shadow.execute({ command: 'rtk git status', description: 'Status' }, {})
  assert.equal(harness.rewriteCalls.length, 0)
  assert.equal(harness.calls[0].args.command, 'rtk git status')
})

test('an empty command is not rewritten', async () => {
  const harness = makeHarness()
  await harness.shadow.execute({ command: '   ', description: 'Noop' }, {})
  assert.equal(harness.rewriteCalls.length, 0)
})

test('RTK_DISABLED=1 disables the rewrite', async () => {
  process.env.RTK_DISABLED = '1'
  const harness = makeHarness()
  await harness.shadow.execute({ command: 'git status', description: 'Status' }, {})
  assert.equal(harness.rewriteCalls.length, 0)
})

test('an abort surfaces the tool aborted error', async () => {
  const aborted = Object.assign(new Error('rtk rewrite aborted'), { name: 'AbortError' })
  const harness = makeHarness({ onRewrite: () => { throw aborted } })
  await assert.rejects(
    harness.shadow.execute({ command: 'git status', description: 'Status' }, {}),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  assert.equal(harness.calls.length, 0)
})

test('a missing inherited bash tool fails visibly', async () => {
  const harness = makeHarness({ hasBase: false })
  await assert.rejects(
    harness.shadow.execute({ command: 'git status', description: 'Status' }, {}),
    /bash tool is not available/,
  )
})

test('prepends the managed rtk directory to rewritten commands', async () => {
  const harness = makeHarness({
    outcome: { kind: 'rewrite', command: 'rtk git status' },
    getPathPrefix: () => '/cache/rtk-filter/versions/rtk/1.2.0',
  })
  await harness.shadow.execute({ command: 'git status', description: 'Status' }, {})
  assert.equal(
    harness.calls[0].args.command,
    `export PATH='/cache/rtk-filter/versions/rtk/1.2.0':"$PATH"; rtk git status`,
  )
})

test('prepends the managed rtk directory to pass-through commands', async () => {
  const harness = makeHarness({ getPathPrefix: () => '/cache/rtk' })
  await harness.shadow.execute({ command: 'echo hello', description: 'Greeting' }, {})
  assert.equal(harness.calls[0].args.command, `export PATH='/cache/rtk':"$PATH"; echo hello`)
})

test('prepends the managed rtk directory to commands already using rtk', async () => {
  const harness = makeHarness({ getPathPrefix: () => '/cache/rtk' })
  await harness.shadow.execute({ command: 'rtk gain', description: 'Gain' }, {})
  assert.equal(harness.rewriteCalls.length, 0)
  assert.equal(harness.calls[0].args.command, `export PATH='/cache/rtk':"$PATH"; rtk gain`)
})

test('no overlay is applied for empty commands, disabled rtk, or no prefix', async () => {
  const empty = makeHarness({ getPathPrefix: () => '/cache/rtk' })
  await empty.shadow.execute({ command: '   ', description: 'Noop' }, {})
  assert.equal(empty.calls[0].args.command, '   ')

  process.env.RTK_DISABLED = '1'
  const disabled = makeHarness({ getPathPrefix: () => '/cache/rtk' })
  await disabled.shadow.execute({ command: 'git status', description: 'Status' }, {})
  assert.equal(disabled.calls[0].args.command, 'git status')
  delete process.env.RTK_DISABLED

  const plain = makeHarness()
  await plain.shadow.execute({ command: 'git status', description: 'Status' }, {})
  assert.equal(plain.calls[0].args.command, 'git status')
})

test('the PATH overlay quotes embedded single quotes', async () => {
  const harness = makeHarness({
    outcome: { kind: 'rewrite', command: 'rtk git status' },
    getPathPrefix: () => "/cache/it's-rtk",
  })
  await harness.shadow.execute({ command: 'git status', description: 'Status' }, {})
  assert.equal(
    harness.calls[0].args.command,
    `export PATH='/cache/it'\\''s-rtk':"$PATH"; rtk git status`,
  )
})

test('the PATH overlay getter is read for every call', async () => {
  let prefix
  const harness = makeHarness({
    outcome: { kind: 'rewrite', command: 'rtk git status' },
    getPathPrefix: () => prefix,
  })
  await harness.shadow.execute({ command: 'git status', description: 'Status' }, {})
  assert.equal(harness.calls[0].args.command, 'rtk git status')

  prefix = '/cache/rtk'
  await harness.shadow.execute({ command: 'git status', description: 'Status' }, {})
  assert.equal(harness.calls[1].args.command, `export PATH='/cache/rtk':"$PATH"; rtk git status`)
})
