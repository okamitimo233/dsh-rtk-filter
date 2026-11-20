/**
 * Resolve the external RTK binary used by this plugin.
 *
 * The plugin no longer downloads, installs, caches, or updates RTK itself.
 * Source precedence is intentionally small:
 *
 *   RTK_BIN / non-default `binary` -> explicit executable
 *   otherwise                     -> `rtk` from the Host PATH
 *
 * There is no fallback from a broken explicit binary to PATH: an explicit
 * choice that cannot be run leaves the plugin inert and reports the reason.
 */

import { dirname, isAbsolute } from 'node:path'

import { normalizeConfig } from './config.js'

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function makeEntry({ binary, source, version }) {
  const entry = { binary, source, version }
  if (version !== null && version !== undefined) {
    entry.versionText = `${version.major}.${version.minor}.${version.patch}`
  }
  if (isAbsolute(binary)) entry.prefixDir = dirname(binary)
  return entry
}

/**
 * Probe one binary without allowing a probe failure to fail activation.
 *
 * @param {Function | undefined} probeRtk
 * @param {{ binary: string, timeoutMs: number }} request
 * @returns {Promise<{ ok: boolean, version?: object | null, reason?: string }>}
 */
async function probeBinary(probeRtk, { binary, timeoutMs }) {
  if (typeof probeRtk !== 'function') {
    return { ok: false, reason: 'the RTK probe is unavailable' }
  }
  try {
    return await probeRtk({ binary, timeoutMs })
  } catch (error) {
    return { ok: false, reason: `RTK binary "${binary}" could not be probed (${describe(error)})` }
  }
}

/**
 * Resolve one explicit executable or the Host PATH fallback.
 *
 * @param {object} options
 * @param {string | undefined} options.explicitBinary
 * @param {(binary: string) => Promise<object>} options.probe
 * @param {object} [options.logger]
 * @returns {Promise<{ entry?: object, reason?: string }>}
 */
async function resolveSource({ explicitBinary, probe, logger }) {
  if (explicitBinary !== undefined) {
    const result = await probe(explicitBinary)
    if (!result.ok) {
      return { reason: result.reason ?? `RTK binary "${explicitBinary}" could not be run` }
    }
    if (!isAbsolute(explicitBinary) && explicitBinary !== 'rtk') {
      logger?.warn?.(`[rtk] binary "${explicitBinary}" is not an absolute path; rewritten commands still invoke "rtk" from PATH`)
    }
    return {
      entry: makeEntry({ binary: explicitBinary, source: 'explicit', version: result.version }),
    }
  }

  const result = await probe('rtk')
  if (!result.ok) {
    return { reason: result.reason ?? 'RTK was not found on the Host PATH' }
  }
  return { entry: makeEntry({ binary: 'rtk', source: 'path', version: result.version }) }
}

/**
 * Resolve the RTK source once for one plugin activation.
 *
 * The returned manager keeps the interface activation already relies on:
 * `initial`, `canWrap`, `current()`, `start()`, and `dispose()`.
 *
 * @param {object} options
 * @param {object} [options.ctx]
 * @param {object} [options.settings] - raw or normalized plugin configuration.
 * @param {object} [options.deps]
 * @param {Function} [options.deps.probeRtk]
 * @param {object} [options.deps.logger]
 * @param {Record<string, string | undefined>} [options.deps.env]
 * @param {number} [options.deps.probeTimeoutMs]
 */
export async function createRtkManager({ settings = {}, deps = {} } = {}) {
  const {
    probeRtk,
    logger,
    env = process.env,
    probeTimeoutMs: configuredProbeTimeoutMs,
  } = deps
  const { binary, rewriteTimeoutMs } = normalizeConfig(settings)
  const probeTimeoutMs = configuredProbeTimeoutMs ?? Math.max(rewriteTimeoutMs, 2000)
  const fromEnv = typeof env.RTK_BIN === 'string' && env.RTK_BIN.trim() !== ''
    ? env.RTK_BIN.trim()
    : undefined
  const explicitBinary = fromEnv ?? (binary === 'rtk' ? undefined : binary)

  const probe = (target) => probeBinary(probeRtk, { binary: target, timeoutMs: probeTimeoutMs })
  const resolution = await resolveSource({ explicitBinary, probe, logger })
  let disposed = false

  function dispose() {
    disposed = true
  }

  function start() {
    return {
      ready: Promise.resolve(!disposed && resolution.entry !== undefined),
      dispose,
    }
  }

  return {
    initial: resolution.entry,
    canWrap: resolution.entry !== undefined,
    reason: resolution.reason,
    current: () => (disposed ? undefined : resolution.entry),
    start,
    dispose,
  }
}
