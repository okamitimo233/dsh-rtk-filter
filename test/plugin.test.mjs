import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { activate } from '../lib/activate.js'
import { awarenessText } from '../lib/awareness.js'

const originalBin = process.env.RTK_BIN
const originalDisabled = process.env.RTK_DISABLED

afterEach(() => {
  if (originalBin === undefined) delete process.env.RTK_BIN
  else process.env.RTK_BIN = originalBin
  if (originalDisabled === undefined) delete process.env.RTK_DISABLED
  else process.env.RTK_DISABLED = originalDisabled
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

const defaultInitial = {
  binary: '/managed/rtk',
  prefixDir: '/managed',
  source: 'managed',
  version: { major: 1, minor: 2, patch: 0 },
  versionText: '1.2.0',
}

function makeManager(overrides = {}) {
  const state = {
    initial: defaultInitial,
    canWrap: true,
    reason: undefined,
    ready: Promise.resolve(true),
    started: 0,
    disposed: 0,
    taskDisposed: 0,
    ...overrides,
  }
  state.current = state.initial
  const manager = {
    get initial() {
      return state.initial
    },
    get canWrap() {
      return state.canWrap
    },
    get reason() {
      return state.reason
    },
    current: () => state.current,
    start() {
      state.started += 1
      return {
        ready: state.ready,
        dispose() {
          state.taskDisposed += 1
        },
      }
    },
    async checkNow() {},
    dispose() {
      state.disposed += 1
    },
  }
  return { manager, state }
}

function makeCtx(agents = [makeAgent('agent-1')]) {
  const sections = []
  const handlers = new Map()
  const warnings = []
  const infos = []
  const effects = []
  const settings = []

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
      info(message) { infos.push(message) },
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

  const shadowCalls = []
  const rewriteCalls = []
  let managerForHarness

  const deps = {
    async createRtkManager(input) {
      settings.push(input.settings)
      return managerForHarness
    },
    async probeRtk(input) {
      return { ok: true, version: null }
    },
    async rewriteCommand(input) {
      rewriteCalls.push(input)
      return { kind: 'pass', reason: 'test' }
    },
    createBashShadow(options) {
      shadowCalls.push(options)
      return { name: 'bash', async execute() { return 'shadow' } }
    },
    smokeRewrite: async () => ({ ok: true }),
    toolAborted() {
      return Object.assign(new Error('tool call aborted'), { name: 'AbortError' })
    },
  }

  return {
    ctx,
    deps,
    sections,
    handlers,
    warnings,
    infos,
    effects,
    settings,
    shadowCalls,
    rewriteCalls,
    setManager(manager) {
      managerForHarness = manager
    },
  }
}

async function activateWith(harness, config, manager) {
  harness.setManager(manager ?? makeManager().manager)
  await activate(harness.ctx, config, harness.deps)
}

test('registers the awareness section and an agent-scoped bash shadow', async () => {
  const harness = makeCtx()
  const { manager } = makeManager()
  await activateWith(harness, {}, manager)

  assert.equal(harness.sections.length, 1)
  const section = harness.sections[0]
  assert.equal(section.name, 'rtk:command-output')
  assert.equal(section.order, 1001)
  assert.equal(section.text, awarenessText)
  assert.match(section.text, /RTK/)

  assert.equal(harness.settings[0].binary, 'rtk')
  assert.equal(harness.shadowCalls.length, 1)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
  assert.match(harness.infos.join('\n'), /filtering bash output through \/managed\/rtk/)
})

test('awareness: false keeps the tool shadow but removes the prompt text', async () => {
  const harness = makeCtx()
  await activateWith(harness, { awareness: false }, makeManager().manager)
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
})

test('an unusable manager leaves bash and the prompt untouched', async () => {
  const harness = makeCtx()
  const { manager } = makeManager({
    initial: undefined,
    canWrap: false,
    reason: 'RTK is not installed and autoInstall is disabled',
  })
  await activateWith(harness, { autoInstall: false }, manager)
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
  assert.match(harness.warnings.join('\n'), /autoInstall is disabled/)
  assert.match(harness.warnings.join('\n'), /will not be filtered/)
})

test('registers the shadow immediately and adds the prompt once installation is ready', async () => {
  let resolveReady
  const ready = new Promise((resolve) => {
    resolveReady = resolve
  })
  const harness = makeCtx()
  const { manager, state } = makeManager({ initial: undefined, canWrap: true, ready })
  await activateWith(harness, {}, manager)

  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
  assert.equal(harness.sections.length, 0)
  assert.match(harness.infos.join('\n'), /installing RTK in the background/)

  state.current = {
    binary: '/managed/rtk',
    prefixDir: '/managed',
    source: 'managed',
    version: { major: 1, minor: 2, patch: 0 },
    versionText: '1.2.0',
  }
  resolveReady(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.sections.length, 1)
  assert.match(harness.infos.join('\n'), /filtering bash output through \/managed\/rtk/)
})

test('a failed background installation leaves the pass-through shadow and no prompt', async () => {
  const harness = makeCtx()
  const { manager } = makeManager({
    initial: undefined,
    canWrap: true,
    ready: Promise.resolve(false),
  })
  await activateWith(harness, {}, manager)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
  assert.equal(harness.sections.length, 0)
  assert.match(harness.warnings.join('\n'), /RTK is not ready/)
})

test('a manager creation failure does not fail activation', async () => {
  const harness = makeCtx()
  harness.deps.createRtkManager = async () => {
    throw new Error('boom')
  }
  await activate(harness.ctx, {}, harness.deps)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
  assert.match(harness.warnings.join('\n'), /could not prepare the RTK binary manager: boom/)
})

test('enabled: false does not create a manager or register', async () => {
  const harness = makeCtx()
  let created = 0
  harness.deps.createRtkManager = async () => {
    created += 1
    return makeManager().manager
  }
  await activate(harness.ctx, { enabled: false }, harness.deps)
  assert.equal(created, 0)
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
})

test('RTK_DISABLED=1 skips manager creation and registration', async () => {
  process.env.RTK_DISABLED = '1'
  const harness = makeCtx()
  let created = 0
  harness.deps.createRtkManager = async () => {
    created += 1
    return makeManager().manager
  }
  await activate(harness.ctx, {}, harness.deps)
  assert.equal(created, 0)
  assert.equal(harness.sections.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
  assert.match(harness.infos.join('\n'), /RTK_DISABLED=1/)
})

test('installs for agents created after activation', async () => {
  const harness = makeCtx([])
  await activateWith(harness, {}, makeManager().manager)
  const created = makeAgent('agent-2')
  harness.handlers.get('agent/created')({ agent: created })
  assert.equal(created.registrations.length, 1)
})

test('tools/change does not register the shadow twice', async () => {
  const harness = makeCtx()
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  harness.handlers.get('tools/change')()
  harness.handlers.get('tools/change')()
  assert.equal(agent.registrations.length, 1)
})

test('the plugin cleanup disposes the manager, its task, and every registration', async () => {
  const harness = makeCtx()
  const { manager, state } = makeManager()
  await activateWith(harness, {}, manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.registrations.length, 1)

  assert.equal(harness.effects.length, 2)
  for (const effect of harness.effects) effect()
  assert.equal(agent.registrations.length, 0)
  assert.equal(state.disposed, 1)
  assert.equal(state.taskDisposed, 1)
})

test('rewrite uses the manager current binary and prefix', async () => {
  const harness = makeCtx()
  const { manager, state } = makeManager()
  await activateWith(harness, {}, manager)
  const options = harness.shadowCalls[0]

  const pass = await options.rewrite({ command: 'git status' })
  assert.equal(pass.kind, 'pass')
  assert.equal(harness.rewriteCalls[0].binary, '/managed/rtk')
  assert.equal(harness.rewriteCalls[0].timeoutMs, 2000)
  assert.equal(options.getPathPrefix(), '/managed')

  state.current = {
    binary: '/managed/rtk-2',
    prefixDir: '/managed-2',
    source: 'managed',
    version: { major: 1, minor: 3, patch: 0 },
    versionText: '1.3.0',
  }
  await options.rewrite({ command: 'git status' })
  assert.equal(harness.rewriteCalls[1].binary, '/managed/rtk-2')
  assert.equal(options.getPathPrefix(), '/managed-2')
})

test('rewrite passes through while no binary is ready', async () => {
  const harness = makeCtx()
  const { manager } = makeManager({ initial: undefined, canWrap: true })
  await activateWith(harness, {}, manager)
  const options = harness.shadowCalls[0]
  assert.deepEqual(await options.rewrite({ command: 'git status' }), {
    kind: 'pass',
    reason: 'RTK is not ready yet',
  })
  assert.equal(harness.rewriteCalls.length, 0)
})

test('config defaults reach the manager', async () => {
  const harness = makeCtx()
  await activateWith(harness, {}, makeManager().manager)
  const settings = harness.settings[0]
  assert.equal(settings.autoInstall, true)
  assert.equal(settings.autoUpdate, true)
  assert.equal(settings.version, 'latest')
  assert.equal(settings.edition, 'rtk')
  assert.equal(settings.updateIntervalMs, 86_400_000)
  assert.equal(settings.downloadTimeoutMs, 120_000)
})

test('explicit config reaches the manager unchanged', async () => {
  const harness = makeCtx()
  await activateWith(harness, {
    binary: '/opt/rtk',
    autoInstall: false,
    autoUpdate: false,
    version: '1.2.0',
    edition: 'rtk-oss',
    updateIntervalMs: 60_000,
    downloadTimeoutMs: 5_000,
  }, makeManager().manager)
  const settings = harness.settings[0]
  assert.equal(settings.binary, '/opt/rtk')
  assert.equal(settings.autoInstall, false)
  assert.equal(settings.autoUpdate, false)
  assert.equal(settings.version, '1.2.0')
  assert.equal(settings.edition, 'rtk-oss')
  assert.equal(settings.updateIntervalMs, 60_000)
  assert.equal(settings.downloadTimeoutMs, 5_000)
})
