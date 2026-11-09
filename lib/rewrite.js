/**
 * Thin delegate to `rtk rewrite`, the single source of truth for rewrite
 * rules (see `src/discover/registry.rs` in the rtk repository).
 *
 * Exit-code protocol (documented in `docs/usage/FEATURES.md`):
 *
 *   0 + stdout  rewrite found; allow rules cover every command
 *   1           no rewrite, run the original command
 *   2           deny rule matched; do not run, surface the message
 *   3 + stdout  rewrite found; an ask rule or the default ask applies
 *
 * The DSH plugin gates the `bash` tool call itself, so 0 and 3 are handled
 * identically here: both execute the rewrite without a second prompt. This is
 * the same interpretation as the Pi/OMP and Hermes delegates, which do not set
 * `RTK_REWRITE_HOST` either.
 */

import { execFile } from 'node:child_process'

import { isSupportedVersion, parseRtkVersion } from './version.js'

export { parseRtkVersion } from './version.js'

const MAX_BUFFER = 1024 * 1024

/** Raised when the caller's abort signal cancelled `rtk rewrite`. */
export class RewriteAbortedError extends Error {
  constructor() {
    super('rtk rewrite aborted')
    this.name = 'AbortError'
  }
}

/**
 * Run one child process without a shell and collect its streams.
 *
 * `execFile` reports a non-zero exit and a spawn failure through the callback
 * instead of rejecting, so the caller can interpret them without a catch.
 */
function run(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      resolve({
        error,
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '',
      })
    })
  })
}

/** Whether an `execFile` error means the caller aborted the request. */
function isAbort(error) {
  return error !== undefined && error !== null
    && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

/**
 * Probe the configured rtk binary once at load time.
 *
 * Never throws: a missing or unusable binary leaves the plugin inert rather
 * than failing plugin activation.
 */
export async function probeRtk({ binary, timeoutMs = 2000, signal }) {
  const { error, stdout, stderr } = await run(binary, ['--version'], {
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (error) {
    if (isAbort(error)) return { ok: false, reason: 'RTK probe was aborted' }
    if (error.code === 'ENOENT') {
      return { ok: false, reason: `RTK binary "${binary}" was not found on the Host PATH` }
    }
    return { ok: false, reason: `RTK binary "${binary}" could not be run (${error.message})` }
  }
  const version = parseRtkVersion(stdout)
  if (version !== null && !isSupportedVersion(version)) {
    return {
      ok: false,
      reason: `RTK ${version.raw} is too old for \`rtk rewrite\`; need >= 0.23.0`,
    }
  }
  if (version === null && stderr.trim() !== '') {
    return { ok: false, reason: `RTK binary "${binary}" did not report a version: ${stderr.trim()}` }
  }
  return { ok: true, version }
}

/**
 * Ask rtk whether `command` has a rewrite and what it is.
 *
 * Resolves with one of:
 *   { kind: 'rewrite', command }  run this instead
 *   { kind: 'pass', reason }      run the original command
 *   { kind: 'deny', reason }      do not run; surface the reason
 *
 * Rejects only with {@link RewriteAbortedError}.
 */
export async function rewriteCommand({ binary, command, cwd, timeoutMs = 2000, signal }) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { kind: 'pass', reason: 'empty command' }
  }

  const options = {
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    ...(signal !== undefined ? { signal } : {}),
  }

  const { error, stdout, stderr } = await run(binary, ['rewrite', command], options)

  if (isAbort(error)) throw new RewriteAbortedError()

  if (error) {
    if (error.code === 'ENOENT') {
      return { kind: 'pass', reason: `RTK binary "${binary}" was not found` }
    }
    // A timeout kills the child; the original command is safer than a partial
    // rewrite decision.
    if (error.killed === true || typeof error.code !== 'number') {
      return { kind: 'pass', reason: `rtk rewrite failed: ${error.message}` }
    }
  }

  const code = error ? error.code : 0
  const rewritten = stdout.trim()
  const detail = stderr.trim()

  switch (code) {
    case 0:
    case 3:
      return rewritten === ''
        ? { kind: 'pass', reason: 'rtk returned an empty rewrite' }
        : { kind: 'rewrite', command: rewritten }
    case 1:
      return { kind: 'pass', reason: 'no RTK rewrite' }
    case 2:
      return {
        kind: 'deny',
        reason: rewritten !== ''
          ? rewritten
          : detail !== '' ? detail : 'denied by an RTK deny or pipeline rule',
      }
    default:
      return { kind: 'pass', reason: `unexpected rtk rewrite exit ${String(code)}` }
  }
}
