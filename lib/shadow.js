/**
 * A drop-in `bash` tool definition for one agent.
 *
 * The definition is registered through `agent.ctx.tools.register`, where DSH
 * lets a scoped tool shadow the one the agent inherited. The inherited `bash`
 * is captured from the agent's own view before this registration: in the Web
 * surface the built-in tool lives in the agent-preset realm, so the global
 * (unscoped) lookup cannot see it, and looking it up after registration would
 * return this shadow itself.
 *
 * `execute` rewrites the command through RTK and then calls the captured
 * tool's own `execute`, preserving sandboxing, approval, jobs, timeouts,
 * rendering, and exit markers.
 */

import { abortError, isAbortError } from './proc.js'
import { withRtkPath } from './shell.js'

const ALREADY_RTK = /^\s*rtk(?:\s|$)/

const MIRRORED_FIELDS = [
  'description',
  'parameters',
  'output',
  'deferLoading',
  'timeoutMs',
  'projectContent',
  'finalizeContent',
  'presentCall',
  'presentResult',
  'isConcurrencySafe',
]

/**
 * @param {object} options
 * @param {() => object | undefined} options.getBase
 *   the inherited `bash` definition captured for this agent before registration
 * @param {(input: { command: string, cwd?: string, signal?: AbortSignal }) => Promise<
 *   { kind: 'rewrite', command: string } | { kind: 'pass', reason: string } |
 *   { kind: 'deny', reason: string }>} options.rewrite
 * @param {(exec: object) => string | undefined} [options.cwdFor]
 * @param {() => string | undefined} [options.getPathPrefix]
 *   directory containing the managed `rtk`, prepended to `PATH` for each call
 * @param {() => Error} [options.toolAborted]
 * @param {(message: string) => void} [options.log]
 */
export function createBashShadow({
  getBase,
  rewrite,
  cwdFor,
  getPathPrefix,
  toolAborted = () => abortError('tool call aborted'),
  log,
}) {
  const definition = {
    name: 'bash',

    async execute(args, exec) {
      const base = getBase()
      if (base === undefined) {
        throw new Error('rtk: the bash tool is not available in this composition')
      }

      const command = args?.command
      if (typeof command !== 'string' || command.trim() === '') {
        return base.execute(args, exec)
      }
      if (process.env.RTK_DISABLED === '1') {
        return base.execute(args, exec)
      }

      const prefix = getPathPrefix?.()
      const delegated = (text) => ({ ...args, command: withRtkPath(text, prefix) })

      if (ALREADY_RTK.test(command)) {
        return base.execute(delegated(command), exec)
      }

      let outcome
      try {
        outcome = await rewrite({
          command,
          cwd: cwdFor?.(exec),
          signal: exec.signal,
        })
      } catch (error) {
        if (isAbortError(error)) throw toolAborted()
        throw error
      }

      if (outcome.kind === 'pass') {
        return base.execute(delegated(command), exec)
      }
      if (outcome.kind === 'deny') {
        throw new Error(`rtk denied this command: ${outcome.reason}`)
      }

      const rewritten = outcome.command
      if (typeof rewritten !== 'string' || rewritten.trim() === '' || rewritten === command) {
        return base.execute(delegated(command), exec)
      }

      log?.(`[rtk] ${command} -> ${rewritten}`)
      return base.execute(delegated(rewritten), exec)
    },
  }

  for (const field of MIRRORED_FIELDS) {
    Object.defineProperty(definition, field, {
      enumerable: true,
      configurable: false,
      get() {
        return getBase()?.[field]
      },
    })
  }

  return definition
}
