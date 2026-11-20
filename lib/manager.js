/**
 * Resolve the external RTK binary used by this plugin.
 *
 * Source precedence is intentionally small:
 *
 *   RTK_BIN / non-default `binary` -> explicit executable
 *   otherwise                     -> `rtk` from the Host PATH
 *   otherwise, autoInstall        -> official upstream install script
 *
 * There is no fallback from a broken explicit binary to PATH or to the
 * installer: an explicit choice that cannot be run leaves the plugin inert and
 * reports the reason. The installer writes a normal global binary; the plugin
 * does not keep a private cache or run background updates.
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
 * @param {{ binary: string, timeoutMs: number, signal?: AbortSignal }} request
 * @returns {Promise<{ ok: boolean, version?: object | null, reason?: string }>}
 */
async function probeBinary(probeRtk, { binary, timeoutMs, signal }) {
  if (typeof probeRtk !== 'function') {
    return { ok: false, reason: 'the RTK probe is unavailable' }
  }
  try {
    return await probeRtk({ binary, timeoutMs, signal })
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
 * @param {boolean} options.autoInstall
 * @param {Function | undefined} options.installRtk
 * @param {Record<string, string | undefined>} options.env
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ entry?: object, reason?: string }>}
 */
async function resolveSource({ explicitBinary, probe, logger, autoInstall, installRtk, env, signal }) {
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
  if (result.ok) {
    return { entry: makeEntry({ binary: 'rtk', source: 'path', version: result.version }) }
  }
  if (!autoInstall) {
    return { reason: result.reason ?? 'RTK was not found on the Host PATH' }
  }
  if (typeof installRtk !== 'function') {
    return { reason: 'RTK is not available and the official installer is unavailable' }
  }

  let installed
  try {
    installed = await installRtk({ env, signal })
  } catch (error) {
    return { reason: `RTK install failed: ${describe(error)}` }
  }
  if (installed === null || installed === undefined || typeof installed.binary !== 'string' || installed.binary === '') {
    return { reason: 'RTK install failed: the installer returned no binary path' }
  }
  const verified = await probe(installed.binary)
  if (!verified.ok) {
    return { reason: verified.reason ?? `installed RTK binary "${installed.binary}" could not be run` }
  }
  return {
    entry: makeEntry({ binary: installed.binary, source: 'installed', version: verified.version }),
  }
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
 * @param {Function} [options.deps.installRtk]
 * @param {object} [options.deps.logger]
 * @param {Record<string, string | undefined>} [options.deps.env]
 * @param {number} [options.deps.probeTimeoutMs]
 */
export async function createRtkManager({ settings = {}, deps = {} } = {}) {
  const {
    probeRtk,
    installRtk,
    logger,
    env = process.env,
    probeTimeoutMs: configuredProbeTimeoutMs,
  } = deps
  const { binary, autoInstall, rewriteTimeoutMs } = normalizeConfig(settings)
  const probeTimeoutMs = configuredProbeTimeoutMs ?? Math.max(rewriteTimeoutMs, 2000)
  const fromEnv = typeof env.RTK_BIN === 'string' && env.RTK_BIN.trim() !== ''
    ? env.RTK_BIN.trim()
    : undefined
  const explicitBinary = fromEnv ?? (binary === 'rtk' ? undefined : binary)
  const controller = new AbortController()

  const probe = (target) => probeBinary(probeRtk, {
    binary: target,
    timeoutMs: probeTimeoutMs,
    signal: controller.signal,
  })
  const resolution = await resolveSource({
    explicitBinary,
    probe,
    logger,
    autoInstall,
    installRtk,
    env,
    signal: controller.signal,
  })
  let disposed = false

  function dispose() {
    disposed = true
    controller.abort()
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
