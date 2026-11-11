/**
 * System-prompt text added while the plugin is active.
 *
 * Plain text data only: `lib/shell.js` decides which text applies to which
 * mirrored shell. The base text explains the condensed output without asking
 * the agent to prefix commands, because the plugin performs the rewrite itself.
 */
export const awarenessText = `Command output from bash may be condensed by RTK (Rust Token Killer) to save tokens, keeping every signal and dropping costly noise. Treat a condensed result as the complete result: run commands normally, and batch related commands into one call to avoid extra turns. Truncated results state their recovery path in their own output. Re-run a command as \`rtk bypass <cmd>\` only when its result is unusable: empty when output was clearly expected, contradicting its exit code, or garbled.`

/**
 * Note for agents whose bash is the minimal preset's persistent shell.
 *
 * That shell declares only `command`, so `workdir` and `timeoutMs` are
 * dropped without an error — which reads as a broken tool — and the directory
 * has to travel inside the command. A standard-preset session has those
 * parameters and must not be told otherwise; the note is therefore appended to a
 * per-agent section that shadows the global one.
 */
export const shellOnlyNote = `When the bash tool accepts only \`command\` (the minimal preset's persistent shell), it has no \`workdir\` or \`timeoutMs\`: carry the directory in the command itself (\`cd /path && ...\`) and that shell keeps it for later calls.`
