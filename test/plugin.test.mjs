import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { activate } from '../lib/activate.js'
import { awarenessText, shellOnlyNote } from '../lib/awareness.js'
import { aggregateGain, STATUS_PATH } from '../lib/status.js'

const originalBin = process.env.RTK_BIN
const originalDisabled = process.env.RTK_DISABLED

afterEach(() => {
  if (originalBin === undefined) delete process.env.RTK_BIN
  else process.env.RTK_BIN = originalBin
  if (originalDisabled === undefined) delete process.env.RTK_DISABLED
  else process.env.RTK_DISABLED = originalDisabled
})

function makeAgent(id, agentPreset) {
  const registrations = []
  const sections = []
  const agent = {
    id,
    registrations,
    sections,
    ctx: {
      systemPrompt: {
        section(section) {
          if (agent.failSection) throw new Error('section registration failed')
          sections.push(section)
          return () => {
            if (agent.failDispose) throw new Error('dispose failed')
            const index = sections.indexOf(section)
            if (index !== -1) sections.splice(index, 1)
          }
        },
      },
      tools: {
        register(definition) {
          registrations.push(definition)
          return () => {
            if (agent.failDispose) throw new Error('dispose failed')
            const index = registrations.indexOf(definition)
            if (index !== -1) registrations.splice(index, 1)
          }
        },
      },
    },
  }
  agent.session = { id, header: {} }
  if (agentPreset !== undefined) agent.session.header.agentPreset = agentPreset
  return agent
}

/** The persistent bash the `minimal` preset composes: only `command`. */
function persistentBash() {
  return {
    name: 'bash',
    description: 'Run commands in a bash shell',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return 'persistent' },
  }
}

/** The one-shot bash the `standard` preset composes: `description` required. */
function standardBash() {
  return {
    name: 'bash',
    description: 'Execute a bash command',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        command: { type: 'string' },
        workdir: { type: 'string' },
      },
      required: ['description', 'command'],
    },
    output: { schema: { type: 'string' }, render: () => [] },
    async execute() { return 'standard' },
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
  const {
    startThrows = false,
    disposeThrows = false,
    taskDisposeThrows = false,
    ...rest
  } = overrides
  const state = {
    initial: defaultInitial,
    canWrap: true,
    reason: undefined,
    ready: Promise.resolve(true),
    started: 0,
    disposed: 0,
    taskDisposed: 0,
    ...rest,
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
      if (startThrows) throw new Error('start failed')
      state.started += 1
      return {
        ready: state.ready,
        dispose() {
          if (taskDisposeThrows) throw new Error('task dispose failed')
          state.taskDisposed += 1
        },
      }
    },
    async checkNow() {},
    dispose() {
      state.disposed += 1
      if (disposeThrows) throw new Error('manager dispose failed')
    },
  }
  return { manager, state }
}

function makeCtx(agents = [makeAgent('agent-1')], options = {}) {
  const sections = []
  const handlers = new Map()
  const warnings = []
  const infos = []
  const effects = []
  const settings = []
  const services = options.services ?? {}

  let visibleBash = 'bash' in options
    ? options.bash
    : {
      name: 'bash',
      description: 'inherited bash',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: () => [] },
      async execute() { return 'bash' },
    }

  const ctx = {
    tools: {
      get(name, scope) {
        // Mimic the Web surface: the built-in bash tool lives in the agent
        // preset realm, so the unscoped global lookup does not see it, and a
        // registered shadow takes the name over from what it mirrors.
        if (name !== 'bash' || scope === undefined) return undefined
        return scope.registrations?.at(-1) ?? visibleBash
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
    get(name) {
      return services[name]
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
    setBash(next) {
      visibleBash = next
    },
  }
}

/** A registry stand-in whose committed selection the test can advance. */
function makePresets(initial) {
  const state = { preset: initial }
  return {
    state,
    service: { presetForSession: () => state.preset },
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
  // The command-only caveat is per-agent: a standard session has `workdir` and
  // must not be told otherwise.
  assert.doesNotMatch(section.text, /cd \/path/)

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

test('malformed config values fall back to the documented defaults', async () => {
  const harness = makeCtx()
  await activateWith(harness, {
    enabled: 0,
    awareness: 1,
    binary: '   ',
    rewriteTimeoutMs: 0,
    logRewrites: 'yes',
    version: '',
    edition: 'unknown-edition',
    updateIntervalMs: 59_999,
    downloadTimeoutMs: Number.NaN,
  }, makeManager().manager)
  const settings = harness.settings[0]
  assert.equal(settings.enabled, true)
  assert.equal(settings.awareness, true)
  assert.equal(settings.binary, 'rtk')
  assert.equal(settings.rewriteTimeoutMs, 2000)
  assert.equal(settings.logRewrites, false)
  assert.equal(settings.version, 'latest')
  assert.equal(settings.edition, 'rtk')
  assert.equal(settings.updateIntervalMs, 86_400_000)
  assert.equal(settings.downloadTimeoutMs, 120_000)
})

test('the optional Config schema is generated from the shared option table', async () => {
  const { OPTIONS, buildConfigSchema, normalizeConfig } = await import('../lib/config.js')
  const field = (kind, value) => {
    const builder = {
      kind,
      value,
      default(value) { builder.defaultValue = value; return builder },
      step(value) { builder.stepValue = value; return builder },
      min(value) { builder.minValue = value; return builder },
    }
    return builder
  }
  const z = {
    boolean: () => field('boolean'),
    string: () => field('string'),
    number: () => field('number'),
    const: (value) => field('const', value),
    union: (members) => {
      const builder = field('union')
      builder.members = members
      return builder
    },
    object: (shape) => ({ shape }),
  }
  const schema = buildConfigSchema(z)
  assert.deepEqual(Object.keys(schema.shape), OPTIONS.map((option) => option.key))
  for (const option of OPTIONS) {
    const builder = schema.shape[option.key]
    assert.equal(builder.defaultValue, option.default)
    if (option.kind === 'number') {
      assert.equal(builder.stepValue, 1)
      assert.equal(builder.minValue, option.min)
    }
    if (option.kind === 'enum') {
      assert.equal(builder.kind, 'union')
      assert.deepEqual(builder.members.map((member) => member.value), option.values)
    }
  }
  assert.deepEqual(Object.keys(normalizeConfig(undefined)), OPTIONS.map((option) => option.key))
})

test('an unknown option kind keeps its documented default', async () => {
  const { OPTIONS, buildConfigSchema, normalizeConfig } = await import('../lib/config.js')
  const extra = { key: 'mystery', kind: 'mystery', default: 'fallback' }
  OPTIONS.push(extra)
  try {
    assert.equal(normalizeConfig({ mystery: 'anything' }).mystery, 'fallback')
    const field = () => {
      const builder = {
        defaultValue: undefined,
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
      any: field,
      object: (shape) => ({ shape }),
    }
    assert.equal(buildConfigSchema(z).shape.mystery.defaultValue, 'fallback')
  } finally {
    OPTIONS.pop()
  }
})

test('registers a status route when the web server is present', async () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const harness = makeCtx([makeAgent('agent-1')], { services: { webServer } })
  harness.deps.readGainStatus = async ({ binary, days }) => {
    assert.equal(binary, '/managed/rtk')
    return aggregateGain({
      daily: [{
        date: '2026-11-10',
        commands: 4,
        input_tokens: 400,
        output_tokens: 100,
        saved_tokens: 300,
      }],
    }, { days, now: new Date('2026-11-10T12:00:00.000Z') })
  }
  await activateWith(harness, {}, makeManager().manager)

  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'exact')
  assert.equal(routes[0].path, STATUS_PATH)

  const res = {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body
    },
  }
  await routes[0].handler({ method: 'GET', url: '/rtk-filter/status?days=7', headers: {} }, res)
  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.runtime.state, 'ready')
  assert.equal(payload.runtime.version, '1.2.0')
  assert.equal(payload.summary.calls, 4)
  assert.equal(payload.summary.savedTokens, 300)
})

test('the minimal preset leaves a standard-shaped bash unfiltered', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'minimal')], { bash: standardBash() })
  await activateWith(harness, {}, makeManager().manager)

  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
  assert.equal(harness.shadowCalls.length, 0)
  assert.match(harness.infos.join('\n'), /leaving the minimal preset's bash unfiltered/)
})

test('the minimal preset filters its own persistent bash', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'minimal')], { bash: persistentBash() })
  await activateWith(harness, {}, makeManager().manager)

  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.registrations.length, 1)
  assert.equal(harness.shadowCalls.length, 1)
  assert.equal(harness.shadowCalls[0].getBase().description, 'Run commands in a bash shell')
})

test('the persistent-shell note is scoped to the agent whose bash is command-only', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'minimal')], { bash: persistentBash() })
  await activateWith(harness, {}, makeManager().manager)

  const agent = harness.ctx.agents.list()[0]
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].text, awarenessText)
  assert.equal(agent.sections.length, 1)
  assert.equal(agent.sections[0].name, 'rtk:command-output')
  assert.equal(agent.sections[0].text, `${awarenessText} ${shellOnlyNote}`)
  assert.match(agent.sections[0].text, /cd \/path/)
})

test('a standard bash gets no persistent-shell note', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'standard')], { bash: standardBash() })
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.ctx.agents.list()[0].sections.length, 0)
})

test('a preset switch away from the persistent shell removes the note', async () => {
  const presets = makePresets('minimal')
  const harness = makeCtx([makeAgent('agent-1', 'minimal')], {
    bash: persistentBash(),
    services: { agentPresets: presets.service },
  })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.sections.length, 1)

  harness.setBash(standardBash())
  presets.state.preset = 'standard'
  harness.handlers.get('agent-preset/selected')(agent.session.id)

  assert.equal(agent.sections.length, 0)
  assert.equal(agent.registrations.length, 1)
})

test('the standard preset keeps filtering its standard bash', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'standard')], { bash: standardBash() })
  await activateWith(harness, {}, makeManager().manager)

  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
  assert.equal(harness.shadowCalls.length, 1)
})

test('a preset bash that mounts late is picked up on tools/change', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'minimal')], { bash: standardBash() })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.registrations.length, 0)

  harness.setBash(persistentBash())
  harness.handlers.get('tools/change')()

  assert.equal(agent.registrations.length, 1)
  assert.equal(harness.shadowCalls.length, 1)
  assert.equal(harness.shadowCalls[0].getBase().description, 'Run commands in a bash shell')
})

test('a preset switch re-captures the bash the new composition mounts', async () => {
  const presets = makePresets('standard')
  const harness = makeCtx([makeAgent('agent-1', 'standard')], {
    bash: standardBash(),
    services: { agentPresets: presets.service },
  })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.registrations.length, 1)
  assert.equal(harness.shadowCalls[0].getBase().description, 'Execute a bash command')

  // The registry recomposes the agent first and appends the selection after.
  harness.setBash(persistentBash())
  presets.state.preset = 'minimal'
  harness.handlers.get('agent-preset/selected')(agent.session.id)

  assert.equal(agent.registrations.length, 1)
  assert.equal(harness.shadowCalls.length, 2)
  assert.equal(harness.shadowCalls[1].getBase().description, 'Run commands in a bash shell')
})

test('a switch to minimal drops a shadow captured under the previous preset', async () => {
  const presets = makePresets('ops-ptc')
  const harness = makeCtx([makeAgent('agent-1', 'ops-ptc')], {
    bash: standardBash(),
    services: { agentPresets: presets.service },
  })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.registrations.length, 1)

  presets.state.preset = 'minimal'
  harness.handlers.get('agent-preset/selected')(agent.session.id)

  // The standard bash is still the only one visible: leave it unfiltered rather
  // than keep mirroring a shape the minimal preset never composes.
  assert.equal(agent.registrations.length, 0)
  assert.equal(harness.shadowCalls.length, 1)
  assert.match(harness.infos.join('\n'), /leaving the minimal preset's bash unfiltered/)
})

test('the section order falls back when the prompt service cannot advise one', async () => {
  const harness = makeCtx()
  harness.ctx.systemPrompt.getSectionOrder = () => {
    throw new Error('no ordering')
  }
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(harness.sections[0].order, 1001)
})

test('the section order falls back when the prompt service returns no number', async () => {
  const harness = makeCtx()
  harness.ctx.systemPrompt.getSectionOrder = () => undefined
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(harness.sections[0].order, 1001)
})

test('a throwing preset registry falls back to the session header', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'standard')], { bash: standardBash() })
  harness.ctx.get = (name) => {
    if (name === 'agentPresets') {
      return { presetForSession() { throw new Error('registry down') } }
    }
    return undefined
  }
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
})

test('a throwing session header leaves the preset unknown', async () => {
  const agent = makeAgent('agent-1')
  agent.session = {
    id: 'agent-1',
    get header() {
      throw new Error('header unavailable')
    },
  }
  const harness = makeCtx([agent], { bash: standardBash() })
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(agent.registrations.length, 1)
})

test('a throwing current lookup is treated as no binary', async () => {
  const harness = makeCtx()
  const { manager } = makeManager()
  manager.current = () => {
    throw new Error('manager is torn down')
  }
  await activateWith(harness, {}, manager)
  const options = harness.shadowCalls[0]
  assert.deepEqual(await options.rewrite({ command: 'git status' }), {
    kind: 'pass',
    reason: 'RTK is not ready yet',
  })
  assert.equal(options.getPathPrefix(), undefined)
})

test('the status route reports an installing runtime', async () => {
  const routes = []
  const harness = makeCtx([makeAgent('agent-1')], {
    services: { webServer: { register(route) { routes.push(route); return () => {} } } },
  })
  harness.deps.readGainStatus = async () => aggregateGain({ daily: [] })
  await activateWith(harness, {}, makeManager({ initial: undefined, canWrap: true }).manager)

  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(body) { this.body = body },
  }
  await routes[0].handler({ method: 'GET', url: '/rtk-filter/status', headers: {} }, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.runtime.state, 'installing')
  assert.equal(payload.runtime.version, null)
  assert.equal(payload.runtime.source, null)
})

test('the status route reports an unavailable runtime', async () => {
  const routes = []
  const harness = makeCtx([makeAgent('agent-1')], {
    services: { webServer: { register(route) { routes.push(route); return () => {} } } },
  })
  harness.deps.readGainStatus = async () => aggregateGain({ daily: [] })
  await activateWith(harness, {}, makeManager({ initial: undefined, canWrap: false }).manager)

  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(body) { this.body = body },
  }
  await routes[0].handler({ method: 'GET', url: '/rtk-filter/status', headers: {} }, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.runtime.state, 'unavailable')
})

test('the status route uses the built-in gain reader by default', async () => {
  const routes = []
  const harness = makeCtx([makeAgent('agent-1')], {
    services: { webServer: { register(route) { routes.push(route); return () => {} } } },
  })
  await activateWith(harness, {}, makeManager().manager)
  delete harness.deps.readGainStatus

  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value },
    end(body) { this.body = body },
  }
  await routes[0].handler({ method: 'GET', url: '/rtk-filter/status', headers: {} }, res)
  assert.equal(res.statusCode, 200)
})

test('logRewrites installs the rewrite log callback', async () => {
  const harness = makeCtx()
  await activateWith(harness, { logRewrites: true }, makeManager().manager)
  harness.shadowCalls[0].log('[rtk] git status -> rtk git status')
  assert.match(harness.infos.join('\n'), /git status -> rtk git status/)
})

test('cwdFor resolves the session working directory and fails open', async () => {
  const session = { id: 'session-1' }
  const agent = makeAgent('agent-1')
  agent.session = session
  const harness = makeCtx([agent], {
    services: {
      workingDirectory: {
        get(input) { return input === session ? '/work' : undefined },
      },
    },
  })
  await activateWith(harness, {}, makeManager().manager)
  const options = harness.shadowCalls[0]

  assert.equal(options.cwdFor({ agent: { session } }), '/work')
  assert.equal(options.cwdFor({ agent: {} }), undefined)
  assert.equal(options.cwdFor({}), undefined)

  harness.ctx.get = () => {
    throw new Error('service lookup failed')
  }
  assert.equal(options.cwdFor({ agent: { session } }), undefined)
})

test('an agent without a visible bash stays unfiltered', async () => {
  const harness = makeCtx([makeAgent('agent-1')], { bash: undefined })
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(harness.shadowCalls.length, 0)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 0)
})

test('a throwing web server lookup skips the status route', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'standard')], { bash: standardBash() })
  harness.ctx.get = () => {
    throw new Error('service lookup failed')
  }
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
})

test('a non-Error shadow failure is reported', async () => {
  const harness = makeCtx()
  harness.deps.createBashShadow = () => {
    throw 'shadow boom'
  }
  await activateWith(harness, {}, makeManager().manager)
  assert.match(harness.warnings.join('\n'), /shadow boom/)
})

test('a non-Error scoped section failure is reported', async () => {
  const agent = makeAgent('agent-1', 'minimal')
  agent.ctx.systemPrompt.section = () => {
    throw 'section boom'
  }
  const harness = makeCtx([agent], { bash: persistentBash() })
  await activateWith(harness, {}, makeManager().manager)
  assert.match(harness.warnings.join('\n'), /section boom/)
})

test('an already-installed agent is not registered twice', async () => {
  const harness = makeCtx()
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  harness.handlers.get('agent/created')({ agent })
  assert.equal(agent.registrations.length, 1)
  assert.equal(harness.shadowCalls.length, 1)
})

test('a non-Error manager start failure is reported', async () => {
  const harness = makeCtx()
  const { manager } = makeManager({ initial: undefined, canWrap: true })
  manager.start = () => {
    throw 'start boom'
  }
  await activateWith(harness, {}, manager)
  assert.match(harness.warnings.join('\n'), /could not start the RTK manager: start boom/)
})

test('a shadow or registration failure leaves the agent unfiltered', async () => {
  const shadowFailure = makeCtx()
  shadowFailure.deps.createBashShadow = () => {
    throw new Error('shadow factory failed')
  }
  await activateWith(shadowFailure, {}, makeManager().manager)
  assert.match(shadowFailure.warnings.join('\n'), /could not filter bash for agent agent-1: shadow factory failed/)

  const registerFailure = makeCtx()
  registerFailure.ctx.agents.list()[0].ctx.tools.register = () => {
    throw new Error('registration failed')
  }
  await activateWith(registerFailure, {}, makeManager().manager)
  assert.match(registerFailure.warnings.join('\n'), /registration failed/)
})

test('a command-only agent without a scoped prompt gets no note', async () => {
  const agent = makeAgent('agent-1', 'minimal')
  agent.ctx.systemPrompt = {}
  const harness = makeCtx([agent], { bash: persistentBash() })
  await activateWith(harness, {}, makeManager().manager)
  assert.equal(agent.registrations.length, 1)
  assert.equal(agent.sections.length, 0)
})

test('a failing scoped section registration is reported', async () => {
  const agent = makeAgent('agent-1', 'minimal')
  agent.failSection = true
  const harness = makeCtx([agent], { bash: persistentBash() })
  await activateWith(harness, {}, makeManager().manager)
  assert.match(harness.warnings.join('\n'), /could not add the persistent-shell note/)
})

test('a throwing registration disposer does not fail a preset switch', async () => {
  const presets = makePresets('minimal')
  const agent = makeAgent('agent-1', 'minimal')
  agent.failDispose = true
  const harness = makeCtx([agent], {
    bash: persistentBash(),
    services: { agentPresets: presets.service },
  })
  await activateWith(harness, {}, makeManager().manager)
  presets.state.preset = 'standard'
  harness.setBash(standardBash())
  harness.handlers.get('agent-preset/selected')(agent.session.id)
  // The throwing disposer left the old shadow registered, so the next capture
  // mirrors it and adds another registration; the important part is that the
  // switch did not throw.
  assert.equal(agent.registrations.length, 2)
})

test('tools/change re-captures when the preset no longer accepts the mirrored shape', async () => {
  const presets = makePresets('standard')
  const harness = makeCtx([makeAgent('agent-1', 'standard')], {
    bash: standardBash(),
    services: { agentPresets: presets.service },
  })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.registrations.length, 1)

  presets.state.preset = 'minimal'
  harness.handlers.get('tools/change')()

  assert.equal(agent.registrations.length, 0)
  assert.match(harness.infos.join('\n'), /leaving the minimal preset's bash unfiltered/)
})

test('tools/change re-captures a bash replaced by another plugin', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'standard')], { bash: standardBash() })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(harness.shadowCalls[0].getBase().description, 'Execute a bash command')

  const replacement = { ...standardBash(), description: 'replaced bash' }
  agent.registrations.push(replacement)
  harness.handlers.get('tools/change')()

  assert.equal(harness.shadowCalls.length, 2)
  assert.equal(harness.shadowCalls[1].getBase().description, 'replaced bash')
  assert.equal(agent.registrations.length, 2)
})

test('agent/created with no agent is ignored and an inert manager registers nothing', async () => {
  const harness = makeCtx([])
  await activateWith(harness, {}, makeManager().manager)
  harness.handlers.get('agent/created')({ agent: undefined })
  assert.equal(harness.shadowCalls.length, 0)

  const inert = makeCtx([])
  await activateWith(inert, {}, makeManager({ canWrap: false }).manager)
  const created = makeAgent('agent-2')
  inert.handlers.get('agent/created')({ agent: created })
  assert.equal(created.registrations.length, 0)
})

test('agent/disposed forgets the shadow and its note', async () => {
  const harness = makeCtx([makeAgent('agent-1', 'minimal')], { bash: persistentBash() })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]
  assert.equal(agent.sections.length, 1)

  harness.handlers.get('agent/disposed')({ agent })
  assert.equal(agent.sections.length, 0)
})

test('cleanup tolerates throwing disposers and removes scoped notes', async () => {
  const agent = makeAgent('agent-1', 'minimal')
  agent.failDispose = true
  const harness = makeCtx([agent], { bash: persistentBash() })
  const { manager } = makeManager({ disposeThrows: true, taskDisposeThrows: true })
  await activateWith(harness, {}, manager)

  for (const effect of harness.effects) {
    assert.doesNotThrow(() => effect())
  }
  assert.equal(agent.registrations.length, 1)
})

test('a manager start failure is reported without failing activation', async () => {
  const harness = makeCtx()
  const { manager } = makeManager({ initial: undefined, canWrap: true, startThrows: true })
  await activateWith(harness, {}, manager)
  assert.match(harness.warnings.join('\n'), /could not start the RTK manager: start failed/)
  assert.equal(harness.ctx.agents.list()[0].registrations.length, 1)
})

test('an unavailable manager without a reason gets the default warning', async () => {
  const harness = makeCtx()
  await activateWith(harness, {}, makeManager({ initial: undefined, canWrap: false, reason: undefined }).manager)
  assert.match(harness.warnings.join('\n'), /RTK is not available/)
})

test('a ready signal that arrives after disposal is ignored', async () => {
  let resolveReady
  const ready = new Promise((resolve) => { resolveReady = resolve })
  const harness = makeCtx()
  await activateWith(harness, {}, makeManager({ initial: undefined, canWrap: true, ready }).manager)

  for (const effect of harness.effects) effect()
  resolveReady(true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.sections.length, 0)
})

test('a ready rejection after disposal is ignored', async () => {
  let rejectReady
  const ready = new Promise((resolve, reject) => { rejectReady = reject })
  const harness = makeCtx()
  await activateWith(harness, {}, makeManager({ initial: undefined, canWrap: true, ready }).manager)

  for (const effect of harness.effects) effect()
  rejectReady(new Error('late failure'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(harness.warnings.length, 0)
})

test('a rejected ready signal is reported without failing activation', async () => {
  const harness = makeCtx()
  await activateWith(harness, {}, makeManager({
    initial: undefined,
    canWrap: true,
    ready: Promise.reject(new Error('setup exploded')),
  }).manager)
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(harness.warnings.join('\n'), /RTK setup failed: setup exploded/)

  const nonError = makeCtx()
  await activateWith(nonError, {}, makeManager({
    initial: undefined,
    canWrap: true,
    ready: Promise.reject('setup exploded'),
  }).manager)
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(nonError.warnings.join('\n'), /RTK setup failed: setup exploded/)
})

test('a non-Error manager creation failure is reported', async () => {
  const harness = makeCtx()
  harness.deps.createRtkManager = async () => {
    throw 'boom'
  }
  await activate(harness.ctx, {}, harness.deps)
  assert.match(harness.warnings.join('\n'), /could not prepare the RTK binary manager: boom/)
})

test('a selection event for another session leaves this agent alone', async () => {
  const presets = makePresets('standard')
  const harness = makeCtx([makeAgent('agent-1', 'standard')], {
    bash: standardBash(),
    services: { agentPresets: presets.service },
  })
  await activateWith(harness, {}, makeManager().manager)
  const agent = harness.ctx.agents.list()[0]

  harness.handlers.get('agent-preset/selected')('session-someone-else')

  assert.equal(agent.registrations.length, 1)
  assert.equal(harness.shadowCalls.length, 1)
})
