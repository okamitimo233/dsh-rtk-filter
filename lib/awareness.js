/**
 * System-prompt text added while the plugin is active.
 *
 * Kept in one place so the wording can be reviewed against
 * `hooks/rtk-awareness.md` in the repository root. It explains the condensed
 * output without asking the agent to prefix commands: the plugin performs the
 * rewrite itself.
 */
export const awarenessText = `Command output from bash may be condensed by RTK (Rust Token Killer) to save tokens, keeping every signal and dropping costly noise. Treat a condensed result as the complete result: run commands normally, and batch related commands into one call to avoid extra turns. Truncated results state their recovery path in their own output. Re-run a command as \`rtk bypass <cmd>\` only when its result is unusable: empty when output was clearly expected, contradicting its exit code, or garbled.`
