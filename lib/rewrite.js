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

import { abortError, isAbortError, runProcess } from './proc.js'
import { isSupportedVersion, parseRtkVersion } from './version.js'

export { parseRtkVersion } from './version.js'

/**
 * Probe the configured rtk binary once at load time.
 *
 * Never throws: a missing or unusable binary leaves the plugin inert rather
 * than failing plugin activation.
 */
export async function probeRtk({ binary, timeoutMs = 2000, signal }) {
  const { error, stdout, stderr } = await runProcess(binary, ['--version'], {
    timeout: timeoutMs,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (error) {
    if (isAbortError(error)) return { ok: false, reason: 'RTK probe was aborted' }
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
 * Interpret a completed `rtk rewrite` process result.
 *
 * This is the whole exit-code protocol as a pure function, so every branch is
 * testable without spawning a process. `rewriteCommand` only runs the child and
 * delegates here.
 *
 * Rules:
 *   0 / 3 with output    rewrite found (3 is an ask rule, handled like allow)
 *   0 / 3 without output fail open, the original command runs
 *   1                    no rewrite, run the original command
 *   2                    deny, never run the command
 *   any other exit       fail open, the original command runs
 *   spawn failure        fail open, the original command runs
 *
 * @param {object} [result] - collected child-process result.
 * @param {string} [result.binary] - rtk path, used only in fail-open text.
 * @param {Error & { code?: unknown, killed?: boolean }} [result.error] - execFile error.
 * @param {string} [result.stdout] - captured standard output.
 * @param {string} [result.stderr] - captured standard error.
 * @returns {{ kind: 'rewrite', command: string }
 *   | { kind: 'pass', reason: string }
 *   | { kind: 'deny', reason: string }}
 * @throws {Error} the canonical `AbortError` when the call was aborted.
 */
export function interpretRewrite({ binary, error, stdout = '', stderr = '' } = {}) {
  if (isAbortError(error)) throw abortError('rtk rewrite aborted')

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

/**
 * Ask rtk whether `command` has a rewrite and what it is.
 *
 * Resolves with one of:
 *   { kind: 'rewrite', command }  run this instead
 *   { kind: 'pass', reason }      run the original command
 *   { kind: 'deny', reason }      do not run; surface the reason
 *
 * Rejects only when the caller aborts (an `AbortError`).
 */
export async function rewriteCommand({ binary, command, cwd, timeoutMs = 2000, signal }) {
  if (typeof command !== 'string' || command.trim() === '') {
    return { kind: 'pass', reason: 'empty command' }
  }

  const options = {
    timeout: timeoutMs,
    ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    ...(signal !== undefined ? { signal } : {}),
  }

  const result = await runProcess(binary, ['rewrite', command], options)
  return interpretRewrite({ binary, ...result })
}
