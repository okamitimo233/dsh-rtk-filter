/**
 * Child-process and failure helpers shared by the modules that run external
 * commands (the filter protocol, the managed installer, and the status reader).
 *
 * The abort contract, the child-process collection shape, and the
 * error-to-text rule are defined once here so a fix in one of them reaches
 * every caller. Dependency-free, like the rest of `lib/`: a linked-checkout
 * bundle cannot resolve DSH's shipped packages.
 */

import { execFile } from 'node:child_process'

/** Default output cap for a child process, in bytes. */
export const DEFAULT_MAX_BUFFER = 1024 * 1024

/**
 * Whether an error came from aborting a request or a child process.
 *
 * Node reports cancellation both as `AbortError` (an `execFile` signal) and as
 * `ABORT_ERR` (an `AbortSignal` timeout), so both are accepted.
 */
export function isAbortError(error) {
  return error !== null && error !== undefined
    && (error.name === 'AbortError' || error.code === 'ABORT_ERR')
}

/** Build the canonical cancellation error, optionally with a caller code. */
export function abortError(message, code = 'ABORT_ERR') {
  const error = new Error(message)
  error.name = 'AbortError'
  error.code = code
  return error
}

/** Human-readable detail for a thrown value, which need not be an `Error`. */
export function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one child process without a shell and collect its streams.
 *
 * `execFile` reports a non-zero exit and a spawn failure through the callback
 * instead of rejecting, so every caller can interpret an exit code itself
 * instead of branching on a rejection. stdout/stderr are always strings.
 *
 * @param {string} file
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileOptions} [options]
 * @returns {Promise<{ error: (Error & { code?: unknown, killed?: boolean }) | undefined,
 *   stdout: string, stderr: string }>}
 */
export function runProcess(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: DEFAULT_MAX_BUFFER,
        ...options,
      },
      (error, stdout, stderr) => {
        resolve({
          error: error ?? undefined,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        })
      },
    )
  })
}
