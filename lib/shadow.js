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

const ALREADY_RTK = /^\s*rtk(?:\s|$)/

/** Quote one path for a POSIX shell single-quoted string. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * Make the plugin-owned `rtk` visible to the delegated command.
 *
 * The inherited bash tool resolves `rtk` from its own `PATH`, not from this
 * plugin's configured binary, so a managed copy needs a per-call overlay. The
 * overlay runs on every call while the minimal preset's shell keeps its
 * environment between calls, so prepending unconditionally would grow `PATH` by
 * one entry per command; add the directory only when it is not already there.
 */
function withRtkPath(command, prefixDir) {
  if (typeof prefixDir !== 'string' || prefixDir === '') return command
  return `__rtk_prefix=${shellQuote(prefixDir)}; `
    + 'case ":$PATH:" in *":$__rtk_prefix:"*) ;; '
    + '*) export PATH="$__rtk_prefix:$PATH" ;; esac; '
    + command
}

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

/** Error shape used when the caller aborts while `rtk rewrite` is running. */
function defaultToolAborted() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  return error
}

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
  toolAborted = defaultToolAborted,
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
        if (error instanceof Error && error.name === 'AbortError') throw toolAborted()
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
