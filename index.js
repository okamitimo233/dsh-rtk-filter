/**
 * RTK for DeepSeek Harness.
 *
 * Registers a per-agent `bash` tool that shadows the built-in one with the
 * same name and schema. Each rewritable command is replaced with its `rtk`
 * equivalent before the original bash implementation runs, so filtered output
 * reaches the model without a new tool or a changed tool schema.
 */

import { tmpdir } from 'node:os'

import { activate } from './lib/activate.js'
import { buildConfigSchema } from './lib/config.js'
import { abortError } from './lib/proc.js'
import { probeRtk, rewriteCommand } from './lib/rewrite.js'
import { createBashShadow } from './lib/shadow.js'
import { createRtkManager } from './lib/sidecar.js'

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
  Config = buildConfigSchema(z)
} catch {
  Config = undefined
}

/**
 * Cancellation error for a `rtk rewrite` that the caller aborted.
 *
 * The abort contract is shared through `lib/proc.js`; the shared pipeline
 * renders its message like any other tool failure.
 */
const toolAborted = () => abortError('tool call aborted', 'ABORTED')

/**
 * Verify that a freshly downloaded binary still speaks the rewrite protocol.
 * Try two ubiquitous commands so a project-local deny rule for one of them
 * does not reject an otherwise valid download; at least one must rewrite.
 */
async function smokeRewrite({ binary, signal }) {
  const failures = []
  for (const command of ['git status', 'ls']) {
    try {
      const outcome = await rewriteCommand({
        binary,
        command,
        cwd: tmpdir(),
        timeoutMs: 5000,
        signal,
      })
      if (outcome.kind === 'rewrite') return { ok: true }
      failures.push(`${command}: ${outcome.kind}${outcome.reason ? ` (${outcome.reason})` : ''}`)
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { ok: false, reason: `expected a rewrite for at least one probe command; ${failures.join('; ')}` }
}

export function apply(ctx, config = {}) {
  return activate(ctx, config, {
    probeRtk,
    rewriteCommand,
    createBashShadow,
    createRtkManager,
    smokeRewrite,
    toolAborted,
  })
}
