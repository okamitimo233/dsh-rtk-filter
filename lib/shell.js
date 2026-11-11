/**
 * The preset-shell model, in one place.
 *
 * The plugin mirrors the bash tool an agent already has. That only works when
 * the mirror has the same shape as the preset's own shell: the minimal preset
 * composes a persistent shell whose only argument is `command`, while a
 * standard preset composes a one-shot shell with `description`, `workdir`,
 * and friends. Mirroring one plane's shell into the other changes the
 * model-facing schema and the execution semantics, so the shape is derived from
 * the captured definition, checked against a small preset policy, and used to
 * decide three follow-ups:
 *
 * - whether the shadow may be registered at all ({@link acceptsPresetShell}),
 * - how the managed binary reaches the delegated command
 *   ({@link withRtkPath}), and
 * - whether the model needs the command-only caveat
 *   ({@link composeAwareness}).
 *
 * `lib/awareness.js` stays plain text; this module owns when each text applies.
 */

import { awarenessText, shellOnlyNote } from './awareness.js'

/** Section name shared by the global awareness text and its per-agent note. */
export const SECTION_NAME = 'rtk:command-output'

/** The minimal preset's persistent shell, whose only argument is `command`. */
export const COMMAND_ONLY = 'command-only'

/** A one-shot shell that accepts `command` plus orchestration fields. */
export const STANDARD = 'standard'

/** Any other composition: another tool plane or a preset this plugin has not seen. */
export const CUSTOM = 'custom'

/**
 * The bash shape each stock preset composes, as far as a transparent filter
 * cares.
 *
 * A preset missing from this table is accepted as-is, so custom presets keep
 * working exactly as before. A captured definition that declares fields outside
 * its preset's entry came from another plane; because the mirror's own shape is
 * the only evidence left once it owns the `bash` name, that mismatch is what
 * the preset-switch reconciliation watches for.
 */
export const PRESET_SHELLS = {
  minimal: { required: ['command'], properties: ['command'] },
}

/** Quote one path for a POSIX shell single-quoted string. */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/**
 * Make the plugin-owned `rtk` visible to the delegated command.
 *
 * The inherited bash tool resolves `rtk` from its own `PATH`, not from this
 * plugin's configured binary, so a managed copy needs a per-call overlay. The
 * overlay runs on every call while the minimal preset's shell keeps its
 * environment between calls, so prepending unconditionally would grow `PATH`
 * by one entry per command; the directory is added only when it is not already
 * there. The directory travels in `__rtk_prefix` so user variables cannot
 * collide with it.
 */
export function withRtkPath(command, prefixDir) {
  if (typeof prefixDir !== 'string' || prefixDir === '') return command
  return `__rtk_prefix=${shellQuote(prefixDir)}; `
    + 'case ":$PATH:" in *":$__rtk_prefix:"*) ;; '
    + '*) export PATH="$__rtk_prefix:$PATH" ;; esac; '
    + command
}

/**
 * Derive the shell profile of a captured bash definition.
 *
 * The profile keeps the three facts the rest of the plugin needs: which kind of
 * shell this is, which fields it declares (so a preset policy can accept or
 * reject it), and a short description for logs.
 *
 * @param {object | undefined} base - the captured inherited `bash` definition.
 * @returns {{ kind: string, required: string[], properties: string[],
 *   description: string }}
 */
export function deriveShellProfile(base) {
  const parameters = base?.parameters
  const required = Array.isArray(parameters?.required) ? [...parameters.required] : []
  const properties = Object.keys(parameters?.properties ?? {})
  const description = typeof base?.description === 'string' ? base.description.slice(0, 40) : ''
  return { kind: classifyShell(required, properties), required, properties, description }
}

/** Classify a captured definition by the fields it declares. */
function classifyShell(required, properties) {
  const commandOnly = required.length === 1 && required[0] === 'command'
    && properties.length === 1 && properties[0] === 'command'
  if (commandOnly) return COMMAND_ONLY
  return properties.includes('command') ? STANDARD : CUSTOM
}

/**
 * Whether `profile` can belong to the given preset.
 *
 * A preset with no policy accepts any captured shell, preserving pre-existing
 * behaviour for custom presets. A registered policy accepts only definitions
 * whose declared fields are a subset of the preset's own, because a mirror is
 * transparent only when it mirrors this agent's preset bash.
 *
 * @param {ReturnType<typeof deriveShellProfile>} profile
 * @param {string | undefined} preset
 * @returns {boolean}
 */
export function acceptsPresetShell(profile, preset) {
  const policy = preset === undefined ? undefined : PRESET_SHELLS[preset]
  if (policy === undefined) return true
  return profile.required.every((field) => policy.required.includes(field))
    && profile.properties.every((field) => policy.properties.includes(field))
}

/** A short, log-safe description of a captured shell profile. */
export function describeShellProfile(profile) {
  return `bash "${profile.description}" (${profile.properties.join(',')})`
}

/**
 * The prompt text a mirrored shell needs.
 *
 * The base text is one text for every agent. The command-only caveat describes
 * a parameter only some presets lack, so it is only added for a mirror of the
 * persistent shell; a standard-preset session must not be told it has no
 * `workdir`. A missing profile composes the base text, which is what the
 * global section needs.
 *
 * @param {ReturnType<typeof deriveShellProfile>} [profile]
 * @returns {string}
 */
export function composeAwareness(profile) {
  return profile?.kind === COMMAND_ONLY ? `${awarenessText} ${shellOnlyNote}` : awarenessText
}
