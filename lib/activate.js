/**
 * Plugin activation, kept free of runtime package imports so the behaviour can
 * be unit-tested with a fake Context. `index.js` wires in the probe, rewrite,
 * shadow factory, and managed-binary factory.
 *
 * The manager owns all network and filesystem work. Activation only probes the
 * available sources, registers a lazy bash shadow when a binary can plausibly
 * become available, and adds the prompt once filtering is actually active.
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
  autoInstall: true,
  autoUpdate: true,
  version: 'latest',
  edition: 'rtk',
  updateIntervalMs: 86_400_000,
  downloadTimeoutMs: 120_000,
}

function positiveNumber(value, fallback, minimum) {
  return Number.isFinite(value) && value >= minimum ? value : fallback
}

function normalizeConfig(config) {
  const source = config ?? {}
  return {
    enabled: source.enabled !== false,
    awareness: source.awareness !== false,
    binary: typeof source.binary === 'string' && source.binary.trim() !== ''
      ? source.binary.trim()
      : DEFAULTS.binary,
    rewriteTimeoutMs: positiveNumber(source.rewriteTimeoutMs, DEFAULTS.rewriteTimeoutMs, 1),
    logRewrites: source.logRewrites === true,
    autoInstall: source.autoInstall !== false,
    autoUpdate: source.autoUpdate !== false,
    version: typeof source.version === 'string' && source.version.trim() !== ''
      ? source.version.trim()
      : DEFAULTS.version,
    edition: source.edition === 'rtk-oss' ? 'rtk-oss' : DEFAULTS.edition,
    updateIntervalMs: positiveNumber(source.updateIntervalMs, DEFAULTS.updateIntervalMs, 60_000),
    downloadTimeoutMs: positiveNumber(source.downloadTimeoutMs, DEFAULTS.downloadTimeoutMs, 1000),
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
 * @param {Function} deps.createRtkManager - builds the managed-binary manager.
 * @param {{ probeRtk: Function, rewriteCommand: Function, createBashShadow: Function,
 *   toolAborted: () => Error, smokeRewrite: Function }} deps
 */
export async function activate(ctx, config, deps) {
  const settings = normalizeConfig(config)

  if (!settings.enabled) {
    ctx.logger?.info?.('[rtk] disabled by configuration')
    return
  }
  if (process.env.RTK_DISABLED === '1') {
    ctx.logger?.info?.('[rtk] disabled by RTK_DISABLED=1')
    return
  }

  let manager
  try {
    manager = await deps.createRtkManager({
      ctx,
      settings,
      deps: {
        logger: ctx.logger,
        probeRtk: deps.probeRtk,
        smokeRewrite: deps.smokeRewrite,
      },
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger?.warn?.(`[rtk] could not prepare the RTK binary manager: ${detail}; bash output will not be filtered`)
    return
  }

  const wrapped = manager?.canWrap === true
  const installed = new Map()
  const installing = new Set()
  let disposed = false
  let promptShown = false
  let task

  const current = () => {
    try {
      return manager?.current?.()
    } catch {
      return undefined
    }
  }

  const showPrompt = () => {
    if (promptShown || disposed || !settings.awareness) return
    promptShown = true
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: sectionOrder(ctx),
      text: awarenessText,
    }))
  }

  const log = settings.logRewrites
    ? (message) => ctx.logger?.info?.(message)
    : undefined

  const rewrite = (input) => {
    const entry = current()
    if (entry === undefined || entry === null) {
      return { kind: 'pass', reason: 'RTK is not ready yet' }
    }
    return deps.rewriteCommand({
      ...input,
      binary: entry.binary,
      timeoutMs: settings.rewriteTimeoutMs,
    })
  }

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
    if (!wrapped || disposed) return
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
        getPathPrefix: () => current()?.prefixDir,
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
    disposed = true
    try {
      manager?.dispose?.()
    } catch {
      // A disposed manager has already aborted its own work.
    }
    try {
      task?.dispose?.()
    } catch {
      // The manager owns its task dispose.
    }
    for (const dispose of installed.values()) {
      try {
        dispose()
      } catch {
        // A disposed agent context already owns its registrations.
      }
    }
    installed.clear()
  })

  const initial = manager?.initial

  if (wrapped && typeof manager.start === 'function') {
    try {
      task = manager.start()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[rtk] could not start the RTK manager: ${detail}; bash output will not be filtered`)
    }
  }

  if (initial !== undefined && initial !== null) {
    showPrompt()
    ctx.logger?.info?.(`[rtk] filtering bash output through ${initial.binary} for ${ctx.agents.list().length} agent(s)`)
  } else if (wrapped) {
    ctx.logger?.info?.('[rtk] installing RTK in the background; bash output is unfiltered until it is ready')
  } else {
    const detail = manager?.reason ?? 'RTK is not available'
    ctx.logger?.warn?.(`[rtk] ${detail}; bash output will not be filtered`)
  }

  if (wrapped && (initial === undefined || initial === null) && task?.ready !== undefined) {
    Promise.resolve(task.ready)
      .then((ready) => {
        if (disposed) return
        if (ready === true) {
          showPrompt()
          const entry = current()
          ctx.logger?.info?.(`[rtk] filtering bash output through ${entry?.binary ?? 'RTK'} for ${ctx.agents.list().length} agent(s)`)
        } else {
          ctx.logger?.warn?.('[rtk] RTK is not ready; bash output will not be filtered')
        }
      })
      .catch((error) => {
        if (disposed) return
        const detail = error instanceof Error ? error.message : String(error)
        ctx.logger?.warn?.(`[rtk] RTK setup failed: ${detail}; bash output will not be filtered`)
      })
  }
}
