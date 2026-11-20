/**
 * RTK for DeepSeek Harness.
 *
 * Registers a per-agent `bash` tool that shadows the built-in one with the
 * same name and schema. Each rewritable command is replaced with its `rtk`
 * equivalent before the original bash implementation runs, so filtered output
 * reaches the model without a new tool or a changed tool schema.
 */

import { activate } from './lib/activate.js'
import { buildConfigSchema } from './lib/config.js'
import { toolAbortedError } from './lib/proc.js'
import { probeRtk, rewriteCommand } from './lib/rewrite.js'
import { createBashShadow } from './lib/shadow.js'
import { installOfficialRtk } from './lib/installer.js'
import { createRtkManager } from './lib/manager.js'

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
export async function loadConfigSchema(load = () => import('@deepseek-ai/schemastery')) {
  try {
    const { default: z } = await load()
    return buildConfigSchema(z)
  } catch {
    return undefined
  }
}

export const Config = await loadConfigSchema()

/**
 * Cancellation error for a `rtk rewrite` that the caller aborted.
 *
 * The abort contract is shared through `lib/proc.js`; the shared pipeline
 * renders its message like any other tool failure.
 */
export const toolAborted = toolAbortedError

export function apply(ctx, config = {}) {
  return activate(ctx, config, {
    probeRtk,
    rewriteCommand,
    createBashShadow,
    createRtkManager,
    installOfficialRtk,
    toolAborted,
  })
}
