import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { activate } from '../lib/activate.js'
import { awarenessText } from '../lib/awareness.js'

const originalBin = process.env.RTK_BIN

afterEach(() => {
  if (originalBin === undefined) delete process.env.RTK_BIN
  else process.env.RTK_BIN = originalBin
})

function makeAgent(id) {
  const registrations = []
  return {
    id,
    registrations,
    ctx: {
      tools: {
        register(definition) {
          registrations.push(definition)
          return () => {
            registrations.splice(registrations.indexOf(definition), 1)
          }
        },
      },
    },
  }
}

function makeCtx(agents = [makeAgent('agent-1')]) {
  const sections = []
  const handlers = new Map()
  const warnings = []
  const effects = []
  const probes = []

  const ctx = {
    tools: {
      get(name, scope) {
        // Mimic the Web surface: the built-in bash tool lives in the agent
        // preset realm, so the unscoped global lookup does not see it.
        if (name !== 'bash' || scope === undefined) return undefined
        return {
          name: 'bash',
          description: 'inherited bash',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: () => [] },
          async execute() { return 'bash' },
        }
      },
    },
    agents: { list: () => agents },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
      getSectionOrder(name) {
        return name === 'TOOL_BASH' ? 1000 : 0
      },
    },
    logger: {
      warn(message) { warnings.push(message) },
      info() {},
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    on(name, fn) {
      handlers.set(name, fn)
      return () => {}
    },
    get() {
      return undefined
    },
  }

  const deps = {
    async probeRtk(input) {
      probes.push(input)
      return { ok: true, version: null }
    },
    async rewriteCommand() {
      return { kind: 'pass', reason: 'test' }
    },
    createBashShadow() {
      return { name: 'bash', async execute() { return 'shadow' } }
    },
    toolAborted() {
      return Object.assign(new Error('tool call aborted'), { name: 'AbortError' })
    },
  }

  return { ctx, deps, sections, handlers, warnings, effects, probes }
}

test('registers the awareness section and an agent-scoped bash shadow', async () => {
  const harness = makeCtx()
  await activate(harness.ctx, {}, harness.deps)

  assert.equal(harness.sections.length, 1)
  const section = harness.sections[0]
  assert.equal(section.name, 'rtk:command-output')
  assert.equal(section.order, 1001)
  assert.equal(section.text, awarenessText)
  assert.match(section.text, /RTK/)

  assert.equal(harness.probes.length, 1)
  assert.equal(harness.probes[0].binary, 'rtk')
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
})

test('awareness: false keeps the tool shadow but removes the prompt text', async () => {
  const harness = makeCtx()
  await activate(harness.ctx, { awareness: false }, harness.deps)
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
})

test('a failed probe leaves bash and the prompt untouched', async () => {
  const harness = makeCtx()
  harness.deps.probeRtk = async () => ({ ok: false, reason: 'RTK binary "rtk" was not found' })
  await activate(harness.ctx, {}, harness.deps)
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
  assert.match(harness.warnings.join('\n'), /will not be filtered/)
})

test('enabled: false does not probe or register', async () => {
  const harness = makeCtx()
  await activate(harness.ctx, { enabled: false }, harness.deps)
  assert.equal(harness.probes.length, 0)
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
})

test('installs for agents created after activation', async () => {
  const harness = makeCtx([])
  await activate(harness.ctx, {}, harness.deps)
  const created = makeAgent('agent-2')
  harness.handlers.get('agent/created')({ agent: created })
  assert.equal(created.registrations.length, 1)
})

test('tools/change does not register the shadow twice', async () => {
  const harness = makeCtx()
  await activate(harness.ctx, {}, harness.deps)
  const agent = harness.ctx.agents.list()[0]
  harness.handlers.get('tools/change')()
  harness.handlers.get('tools/change')()
  assert.equal(agent.registrations.length, 1)
})

test('the plugin cleanup disposes every agent registration', async () => {
  const harness = makeCtx()
  await activate(harness.ctx, {}, harness.deps)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.registrations.length, 1)

  const cleanup = harness.effects.at(-1)
  assert.equal(typeof cleanup, 'function')
  cleanup()
  assert.equal(agent.registrations.length, 0)
})

test('RTK_BIN overrides the configured binary', async () => {
  process.env.RTK_BIN = '/custom/rtk'
  const harness = makeCtx()
  await activate(harness.ctx, { binary: 'configured-rtk' }, harness.deps)
  assert.equal(harness.probes[0].binary, '/custom/rtk')
})
