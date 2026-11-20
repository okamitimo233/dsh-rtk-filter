/**
 * Install RTK by running the official upstream install script.
 *
 * This is intentionally not a package manager: the script installs one global
 * `rtk` executable into `${RTK_INSTALL_DIR:-$HOME/.local/bin}` and verifies the
 * release checksum itself. The plugin only downloads the published script,
 * executes it once when no usable binary exists, and then probes the installed
 * executable. It never keeps a private cache or updates RTK in the background.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { abortError, isAbortError, runProcess } from './proc.js'

/** Official quick-install entry point. */
export const OFFICIAL_INSTALL_URL = 'https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh'

/** A download cap for the shell script; the real script is only a few KiB. */
export const MAX_INSTALL_SCRIPT_BYTES = 256 * 1024

/** Default upper bound for the complete download + install operation. */
export const DEFAULT_INSTALL_TIMEOUT_MS = 120 * 1000

function requestSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Download and lightly validate the official install script.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>}
 */
export async function downloadInstallScript({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable')

  let response
  try {
    response = await fetchImpl(OFFICIAL_INSTALL_URL, { signal: requestSignal(timeoutMs, signal) })
  } catch (error) {
    if (isAbortError(error)) throw abortError('RTK installer download was aborted')
    throw error
  }
  if (response === null || response === undefined || response.ok !== true) {
    throw new Error(`RTK installer download failed (HTTP ${String(response?.status ?? 'unknown')})`)
  }

  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > MAX_INSTALL_SCRIPT_BYTES) {
    throw new Error('RTK installer script is larger than expected')
  }
  const script = await response.text()
  if (typeof script !== 'string' || Buffer.byteLength(script, 'utf8') > MAX_INSTALL_SCRIPT_BYTES) {
    throw new Error('RTK installer script is larger than expected')
  }
  if (!script.includes('rtk-ai/rtk') || !script.includes('INSTALL_DIR')) {
    throw new Error('downloaded RTK installer script does not look official')
  }
  return script
}

/**
 * Run the official installer and return the executable it should have written.
 *
 * The caller probes the returned path; the installer intentionally does not
 * treat a zero exit code as proof that the binary is usable.
 *
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.run]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {() => string} [options.home]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ binary: string, installDir: string }>}
 */
export async function installOfficialRtk({
  fetchImpl = globalThis.fetch,
  run = runProcess,
  env = process.env,
  home = homedir,
  timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS,
  signal,
} = {}) {
  const script = await downloadInstallScript({ fetchImpl, timeoutMs, signal })
  const staging = await mkdtemp(join(tmpdir(), 'dsh-rtk-install-'))
  const scriptPath = join(staging, 'install.sh')
  try {
    await writeFile(scriptPath, script, { mode: 0o700 })
    const result = await run('sh', [scriptPath], {
      timeout: timeoutMs,
      env,
      ...(signal !== undefined ? { signal } : {}),
    })
    if (result.error) {
      if (isAbortError(result.error)) throw abortError('RTK installer was aborted')
      const detail = result.stderr.trim()
      throw new Error(
        detail !== ''
          ? `official RTK installer failed: ${detail}`
          : `official RTK installer failed: ${result.error.message}`,
      )
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }

  const configuredDir = typeof env.RTK_INSTALL_DIR === 'string' && env.RTK_INSTALL_DIR.trim() !== ''
    ? env.RTK_INSTALL_DIR.trim()
    : undefined
  const installDir = configuredDir ?? join(home(), '.local', 'bin')
  return { installDir, binary: join(installDir, 'rtk') }
}
