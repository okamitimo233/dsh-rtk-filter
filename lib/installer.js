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
import { join, resolve } from 'node:path'

import { abortError, isAbortError, runProcess } from './proc.js'

/** Official quick-install entry point. */
export const OFFICIAL_INSTALL_URL = 'https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh'

/** A download cap for the shell script; the real script is only a few KiB. */
export const MAX_INSTALL_SCRIPT_BYTES = 256 * 1024

/**
 * Total upper bound for the complete download + install operation.
 *
 * This runs synchronously during activation because the manager needs to know
 * whether a shadow can be registered. Keep the budget short enough that an
 * offline or restricted network cannot stall Host startup for minutes.
 */
export const DEFAULT_INSTALL_TIMEOUT_MS = 30 * 1000

/**
 * Path where the official installer writes its binary.
 *
 * The value is normalized once and the caller passes the same value to the
 * installer child process, so the path the installer writes and the path this
 * plugin probes cannot diverge.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {() => string} [options.home]
 * @returns {{ installDir: string, binary: string }}
 */
export function installBinaryPath({ env = process.env, home = homedir } = {}) {
  const configuredDir = typeof env.RTK_INSTALL_DIR === 'string' ? env.RTK_INSTALL_DIR.trim() : ''
  const installDir = resolve(configuredDir === '' ? join(home(), '.local', 'bin') : configuredDir)
  return { installDir, binary: join(installDir, 'rtk') }
}

function requestSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * Read a response body without first buffering an unbounded script.
 *
 * Real `fetch` responses expose a byte stream. The `text()` fallback exists
 * for test doubles and older runtimes that do not expose one; the size check
 * still runs there, but cannot prevent the allocation.
 */
async function readScriptBody(response) {
  const reader = response.body?.getReader?.()
  if (reader === undefined) {
    const script = await response.text()
    if (typeof script !== 'string' || Buffer.byteLength(script, 'utf8') > MAX_INSTALL_SCRIPT_BYTES) {
      throw new Error('RTK installer script is larger than expected')
    }
    return script
  }

  const decoder = new TextDecoder()
  let script = ''
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_INSTALL_SCRIPT_BYTES) {
        await reader.cancel()
        throw new Error('RTK installer script is larger than expected')
      }
      script += decoder.decode(value, { stream: true })
    }
    return script + decoder.decode()
  } finally {
    reader.releaseLock()
  }
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

  let script
  try {
    const response = await fetchImpl(OFFICIAL_INSTALL_URL, {
      signal: requestSignal(timeoutMs, signal),
    })
    if (response === null || response === undefined || response.ok !== true) {
      throw new Error(`RTK installer download failed (HTTP ${String(response?.status ?? 'unknown')})`)
    }

    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > MAX_INSTALL_SCRIPT_BYTES) {
      throw new Error('RTK installer script is larger than expected')
    }
    script = await readScriptBody(response)
  } catch (error) {
    if (isAbortError(error)) throw abortError('RTK installer download was aborted')
    throw error
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
  const installPath = installBinaryPath({ env, home })
  const installEnv = { ...env, RTK_INSTALL_DIR: installPath.installDir }
  const deadline = requestSignal(timeoutMs, signal)
  const script = await downloadInstallScript({ fetchImpl, timeoutMs, signal: deadline })
  const staging = await mkdtemp(join(tmpdir(), 'dsh-rtk-install-'))
  const scriptPath = join(staging, 'install.sh')
  try {
    await writeFile(scriptPath, script, { mode: 0o700 })
    const result = await run('sh', [scriptPath], {
      timeout: timeoutMs,
      env: installEnv,
      signal: deadline,
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

  return installPath
}
