/**
 * RTK for DeepSeek Harness.
 *
 * Registers a per-agent `bash` tool that shadows the built-in one with the
 * same name and schema. Each rewritable command is replaced with its `rtk`
 * equivalent before the original bash implementation runs, so filtered output
 * reaches the model without a new tool or a changed tool schema.
 */

import { activate } from './lib/activate.js'
import { probeRtk, rewriteCommand } from './lib/rewrite.js'
import { createBashShadow } from './lib/shadow.js'

/** Plugin name registered with the Loader. */
export const name = 'rtk-filter'

/** Host services this plugin consumes. */
export const inject = ['tools', 'agents', 'systemPrompt']

/**
 * Runtime configuration schema for the plugin row.
 *
 * A bundle linked from a checkout resolves no shipped `@deepseek-ai/*`
 * packages, so the schema is loaded opportunistically. Without it the row's
 * raw `config` still reaches `apply` and `lib/activate.js` applies the same
 * defaults; only the generated settings form is unavailable.
 */
export let Config
try {
  const { default: z } = await import('@deepseek-ai/schemastery')
  Config = z.object({
    enabled: z.boolean().default(true),
    awareness: z.boolean().default(true),
    binary: z.string().default('rtk'),
    rewriteTimeoutMs: z.number().step(1).min(1).default(2000),
    logRewrites: z.boolean().default(false),
  })
} catch {
  Config = undefined
}

/**
 * Cancellation error for a `rtk rewrite` that the caller aborted.
 *
 * A plain error keeps this module free of shipped-package imports. The shared
 * pipeline renders its message like any other tool failure.
 */
function toolAborted() {
  const error = new Error('tool call aborted')
  error.name = 'AbortError'
  error.code = 'ABORTED'
  return error
}

export function apply(ctx, config = {}) {
  return activate(ctx, config, {
    probeRtk,
    rewriteCommand,
    createBashShadow,
    toolAborted,
  })
}
