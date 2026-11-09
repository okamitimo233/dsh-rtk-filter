import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createBashShadow } from '../lib/shadow.js'

const originalDisabled = process.env.RTK_DISABLED

afterEach(() => {
  if (originalDisabled === undefined) delete process.env.RTK_DISABLED
  else process.env.RTK_DISABLED = originalDisabled
})

function makeHarness({ outcome = { kind: 'pass', reason: 'no rewrite' }, onRewrite, hasBase = true } = {}) {
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
