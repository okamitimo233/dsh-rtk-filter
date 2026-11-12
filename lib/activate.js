/**
 * Plugin activation, kept free of runtime package imports so the behaviour can
 * be unit-tested with a fake Context. `index.js` wires in the probe, rewrite,
 * shadow factory, and managed-binary factory.
 *
 * The manager owns all network and filesystem work. Activation only probes the
 * available sources, registers a lazy bash shadow when a binary can plausibly
 * become available, and adds the prompt once filtering is actually active.
 *
 * The preset-shell model itself lives in `lib/shell.js` (profile derivation,
 * preset policy, PATH overlay, note composition) and the option defaults live in
 * `lib/config.js`, so this module only applies them.
 */

import { normalizeConfig } from './config.js'
import {
  acceptsPresetShell,
  composeAwareness,
  deriveShellProfile,
  describeShellProfile,
  SECTION_NAME,
} from './shell.js'
import { readGainStatus, registerStatusRoute } from './status.js'

const FALLBACK_SECTION_ORDER = 1001

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
 * The preset the agent is running now.
 *
 * The creation header only records what the session was born with: the Web
 * surface creates a session under the registry default and selects the user's
 * preset afterwards, so a switched session keeps the old header forever. The
 * registry's projection is the truthful source once a selection exists; the
 * header stays as the fallback for compositions that have no registry.
 */
function presetOf(ctx, agent) {
  try {
    const presets = ctx.get?.('agentPresets')
    const selected = presets?.presetForSession?.(agent?.session)
    if (typeof selected === 'string' && selected !== '') return selected
  } catch {
    // The registry is optional; the header remains the fallback.
  }
  try {
    return agent?.session?.header?.agentPreset
  } catch {
    return undefined
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
 *   toolAborted: () => Error, smokeRewrite: Function,
 *   readGainStatus?: Function }} deps
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
  const shellNotes = new Map()
  const installing = new Set()
  const skipped = new Set()
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

  /**
   * Public health projection for the Settings page. Paths stay on the Host;
   * the browser only needs the badge and human-readable version.
   */
  const runtimeStatus = () => {
    const entry = current()
    return {
      state: entry !== undefined && entry !== null
        ? 'ready'
        : wrapped ? 'installing' : 'unavailable',
      version: entry?.versionText ?? null,
      source: entry?.source ?? null,
    }
  }

  // The Web GUI asks for the status through a same-origin JSON resource. This
  // stays optional so headless and embedded compositions still activate.
  let webServer
  try {
    webServer = ctx.get?.('webServer')
  } catch {
    webServer = undefined
  }
  if (webServer !== undefined && typeof webServer.register === 'function') {
    const statusReader = deps.readGainStatus ?? readGainStatus
    ctx.effect(() => registerStatusRoute({
      ctx,
      webServer,
      getRuntime: runtimeStatus,
      getBinary: () => current()?.binary,
      readStatus: (input) => statusReader(input),
    }), 'rtk-filter: GET /rtk-filter/status')
  }

  const showPrompt = () => {
    if (promptShown || disposed || !settings.awareness) return
    promptShown = true
    ctx.effect(() => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: sectionOrder(ctx),
      text: composeAwareness(),
    }))
    for (const agent of ctx.agents.list()) showShellNote(agent)
  }

  // The global section above is one text for every agent, so it cannot carry a
  // caveat about a parameter only some presets lack. A scoped section with the
  // same name shadows it in this agent's prompt alone, which puts the note
  // exactly where the command-only shell is.
  const showShellNote = (agent) => {
    if (disposed || !settings.awareness || !promptShown) return
    const entry = installed.get(agent.id)
    if (entry === undefined || !entry.profile.commandOnly) return
    const prompt = agent.ctx?.systemPrompt
    if (typeof prompt?.section !== 'function') return
    try {
      shellNotes.set(agent.id, prompt.section({
        name: SECTION_NAME,
        order: sectionOrder(ctx),
        text: composeAwareness(entry.profile),
      }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[rtk] could not add the persistent-shell note for agent ${String(agent.id)}: ${detail}`)
    }
  }

  const dropShellNote = (agentId) => {
    const dispose = shellNotes.get(agentId)
    if (dispose === undefined) return
    shellNotes.delete(agentId)
    try {
      dispose()
    } catch {
      // A disposed agent context already owns its registrations.
    }
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

    // Mirror only this agent's own preset bash. A shape the preset cannot
    // compose means the lookup resolved a different plane; registering here
    // would change the tool's schema and semantics (for example the persistent
    // minimal shell would become a fresh-shell bash with a required
    // `description`), so leave the preset's bash unfiltered instead.
    const profile = deriveShellProfile(base)
    const preset = presetOf(ctx, agent)
    if (!acceptsPresetShell(profile, preset)) {
      if (!skipped.has(agent.id)) {
        skipped.add(agent.id)
        ctx.logger?.info?.(
          `[rtk] leaving the ${String(preset)} preset's bash unfiltered: ${describeShellProfile(profile)} does not match that preset`,
        )
      }
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
      installed.set(agent.id, {
        definition,
        base,
        profile,
        dispose: agent.ctx.tools.register(definition),
      })
      showShellNote(agent)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[rtk] could not filter bash for agent ${String(agent.id)}: ${detail}`)
    } finally {
      installing.delete(agent.id)
    }
  }

  /** Give the bash name back to the preset: forget the shadow and its capture. */
  const drop = (agent) => {
    const entry = installed.get(agent.id)
    if (entry !== undefined) {
      try {
        entry.dispose?.()
      } catch {
        // A disposed agent context already owns its registrations.
      }
    }
    installed.delete(agent.id)
    skipped.delete(agent.id)
    dropShellNote(agent.id)
  }

  /**
   * Re-evaluate one agent after a tool change or a preset switch.
   *
   * Two things invalidate a capture. A preset can mount its bash after this
   * plugin captured one, and an upstream plugin can replace the definition
   * later; then the visible bash is neither the shadow nor the definition it
   * mirrors, and installing again is enough. The harder case is a preset
   * switch: the shadow keeps the `bash` name, so the preset's own bash never
   * becomes visible, and a capture taken under the previous preset would keep
   * deciding the model-facing schema. Comparing the capture against the preset
   * the agent runs now catches that, because the mirror's own shape is the only
   * evidence left once it owns the name.
   */
  const reconcile = (agent) => {
    const entry = installed.get(agent.id)
    if (entry === undefined) {
      install(agent)
      return
    }
    const visible = ctx.tools.get('bash', agent)
    if (visible === entry.definition) {
      if (acceptsPresetShell(entry.profile, presetOf(ctx, agent))) return
      drop(agent)
      install(agent)
      return
    }
    if (visible !== undefined && visible !== entry.base) {
      drop(agent)
      install(agent)
    }
  }

  for (const agent of ctx.agents.list()) install(agent)

  ctx.on('agent/created', ({ agent }) => install(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    installed.delete(agent.id)
    skipped.delete(agent.id)
    dropShellNote(agent.id)
  })
  // A selection recomposes the agent before it appends its event, so the preset's
  // own bash is already mounted when this runs: the shadow has to step aside for
  // that bash to become visible again, and the next capture is taken from it.
  ctx.on('agent-preset/selected', (sessionId) => {
    for (const agent of ctx.agents.list()) {
      if (agent?.session?.id !== sessionId) continue
      drop(agent)
      install(agent)
    }
  })
  // A composition can mount the bash tool after the agent exists, and a preset
  // can recompose it later; both are reconciled on any tool change, without
  // polling.
  ctx.on('tools/change', () => {
    for (const agent of ctx.agents.list()) reconcile(agent)
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
    for (const entry of installed.values()) {
      try {
        entry.dispose?.()
      } catch {
        // A disposed agent context already owns its registrations.
      }
    }
    for (const agentId of [...shellNotes.keys()]) dropShellNote(agentId)
    installed.clear()
    skipped.clear()
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
