/**
 * Resolve the RTK binary used by this plugin.
 *
 * The acquisition rule is intentionally simple:
 *
 *   1. `rtk` already available on the Host PATH
 *   2. `${RTK_INSTALL_DIR:-$HOME/.local/bin}/rtk` from a previous official install
 *   3. otherwise run the official upstream install script, then probe its path
 *
 * There is no private cache, no explicit-binary configuration layer, and no
 * background update loop.
 */

import { homedir } from 'node:os'
import { dirname, isAbsolute } from 'node:path'

import { normalizeConfig } from './config.js'
import { installBinaryPath } from './installer.js'
import { describeError } from './proc.js'
import { formatVersion } from './version.js'

function makeEntry({ binary, source, version }) {
  const entry = { binary, source, version }
  const versionText = formatVersion(version)
  if (versionText !== undefined) entry.versionText = versionText
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
    return { ok: false, reason: `RTK binary "${binary}" could not be probed (${describeError(error)})` }
  }
}

/**
 * Resolve RTK once for one plugin activation.
 *
 * The returned manager keeps the interface activation relies on:
 * `initial`, `canWrap`, `current()`, and `dispose()`.
 *
 * @param {object} options
 * @param {object} [options.settings] - raw or normalized plugin configuration.
 * @param {object} [options.deps]
 * @param {Function} [options.deps.probeRtk]
 * @param {Function} [options.deps.installRtk]
 * @param {Record<string, string | undefined>} [options.deps.env]
 * @param {() => string} [options.deps.home]
 * @param {number} [options.deps.probeTimeoutMs]
 */
export async function createRtkManager({ settings = {}, deps = {} } = {}) {
  const {
    probeRtk,
    installRtk,
    env = process.env,
    home = homedir,
    probeTimeoutMs: configuredProbeTimeoutMs,
  } = deps
  const { rewriteTimeoutMs } = normalizeConfig(settings)
  const probeTimeoutMs = configuredProbeTimeoutMs ?? Math.max(rewriteTimeoutMs, 2000)
  const controller = new AbortController()
  const probe = (binary) => probeBinary(probeRtk, {
    binary,
    timeoutMs: probeTimeoutMs,
    signal: controller.signal,
  })
  const installPath = installBinaryPath({ env, home })

  let entry
  let reason
  const onPath = await probe('rtk')
  if (onPath.ok) {
    entry = makeEntry({ binary: 'rtk', source: 'path', version: onPath.version })
  } else {
    const installed = await probe(installPath.binary)
    if (installed.ok) {
      entry = makeEntry({
        binary: installPath.binary,
        source: 'installed',
        version: installed.version,
      })
    } else if (typeof installRtk !== 'function') {
      reason = 'RTK is not installed and the official installer is unavailable'
    } else {
      try {
        const result = await installRtk({ env, signal: controller.signal })
        const binary = typeof result?.binary === 'string' && result.binary !== ''
          ? result.binary
          : installPath.binary
        const verified = await probe(binary)
        if (verified.ok) {
          entry = makeEntry({ binary, source: 'installed', version: verified.version })
        } else {
          reason = verified.reason ?? `installed RTK binary "${binary}" could not be run`
        }
      } catch (error) {
        reason = `RTK install failed: ${describeError(error)}`
      }
    }
  }

  let disposed = false
  function dispose() {
    disposed = true
    controller.abort()
  }

  return {
    initial: entry,
    canWrap: entry !== undefined,
    reason,
    current: () => (disposed ? undefined : entry),
    dispose,
  }
}
