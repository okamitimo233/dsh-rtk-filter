/**
 * Plugin activation, kept free of runtime package imports so the behaviour can
 * be unit-tested with a fake Context. `index.js` wires in the probe, rewrite,
 * shadow factory, and abort error.
 */

import { awarenessText } from './awareness.js'

const SECTION_NAME = 'rtk:command-output'
const FALLBACK_SECTION_ORDER = 1001

const DEFAULTS = {
  enabled: true,
  awareness: true,
  binary: 'rtk',
  rewriteTimeoutMs: 2000,
  logRewrites: false,
}

function normalizeConfig(config) {
  const source = config ?? {}
  return {
    enabled: source.enabled !== false,
    awareness: source.awareness !== false,
    binary: typeof source.binary === 'string' && source.binary.trim() !== ''
      ? source.binary.trim()
      : DEFAULTS.binary,
    rewriteTimeoutMs: Number.isFinite(source.rewriteTimeoutMs) && source.rewriteTimeoutMs > 0
      ? source.rewriteTimeoutMs
      : DEFAULTS.rewriteTimeoutMs,
    logRewrites: source.logRewrites === true,
  }
}

/** Place the awareness section directly after the built-in bash guidance. */
function sectionOrder(ctx) {
  try {
    const order = ctx.systemPrompt.getSectionOrder('TOOL_BASH')
    return Number.isFinite(order) ? order + 1 : FALLBACK_SECTION_ORDER
  } catch {
    return FALLBACK_SECTION_ORDER
  }
}

/**
 * Activate the plugin.
 *
 * @param {object} ctx - Cordis Context for the plugin row.
 * @param {object} [config] - validated plugin configuration.
 * @param {object} deps
 * @param {{ probeRtk: Function, rewriteCommand: Function, createBashShadow: Function,
 *   toolAborted: () => Error }} deps
 */
export async function activate(ctx, config, deps) {
  const settings = normalizeConfig(config)

  if (!settings.enabled) {
    ctx.logger?.info?.('[rtk] disabled by configuration')
    return
  }

  const binary = process.env.RTK_BIN?.trim() || settings.binary
  const probe = await deps.probeRtk({ binary, timeoutMs: settings.rewriteTimeoutMs })
  if (!probe.ok) {
    ctx.logger?.warn?.(`[rtk] ${probe.reason}; bash output will not be filtered`)
    return
  }

  if (settings.awareness) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: sectionOrder(ctx),
      text: awarenessText,
    }))
  }

  const installed = new Map()
  const installing = new Set()

  ctx.logger?.info?.(`[rtk] filtering bash output through ${binary} for ${ctx.agents.list().length} agent(s)`)

  const log = settings.logRewrites
    ? (message) => ctx.logger?.info?.(message)
    : undefined

  const rewrite = (input) => deps.rewriteCommand({
    binary,
    timeoutMs: settings.rewriteTimeoutMs,
    ...input,
  })

  const cwdFor = (exec) => {
    try {
      const workingDirectory = ctx.get?.('workingDirectory')
      if (workingDirectory !== undefined && exec?.agent?.session !== undefined) {
        return workingDirectory.get(exec.agent.session)
      }
    } catch {
      // The rewrite decision does not depend on the directory; fall back to the
      // Host process directory rather than failing the tool call.
    }
    return undefined
  }

  const install = (agent) => {
    if (agent === undefined || agent === null) return
    if (installed.has(agent.id) || installing.has(agent.id)) return

    // In the Web surface the built-in bash tool is composed by the agent's
    // preset realm, not the host global plane, so it is only visible through
    // this agent's view. Capture it before registering: after registration the
    // same lookup returns the shadow itself.
    const base = ctx.tools.get('bash', agent)
    if (base === undefined) {
      return
    }

    installing.add(agent.id)
    try {
      const definition = deps.createBashShadow({
        getBase: () => base,
        rewrite,
        cwdFor,
        toolAborted: deps.toolAborted,
        log,
      })
      installed.set(agent.id, agent.ctx.tools.register(definition))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[rtk] could not filter bash for agent ${String(agent.id)}: ${detail}`)
    } finally {
      installing.delete(agent.id)
    }
  }

  for (const agent of ctx.agents.list()) install(agent)

  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    installed.delete(agent.id)
  })
  // A composition can mount the bash tool after the agent exists; retrying on
  // any tool change covers that ordering without polling.
  ctx.on('tools/change', () => {
    for (const agent of ctx.agents.list()) install(agent)
  })

  ctx.effect(() => () => {
    for (const dispose of installed.values()) {
      try {
        dispose()
      } catch {
        // A disposed agent context already owns its registrations.
      }
    }
    installed.clear()
  })
}
