/**
 * Plugin option defaults, normalization, and the descriptor both consumers share.
 *
 * A row reaches this plugin in two forms: as raw `config` when a linked
 * checkout cannot load `@deepseek-ai/schemastery`, and as a validated object
 * when the Settings form generated from the schema submitted it. Both paths must
 * produce the same settings, so the defaults and the normalization rule for each
 * option live in one table; `index.js` builds its optional schema from that
 * table instead of repeating the literals.
 */

/**
 * Every plugin option, in the order the Settings form presents it.
 *
 * `kind` decides both the schemastery field and the normalization rule:
 * - `boolean`: only an explicit value opposite the default flips it, so an
 *   absent, malformed, or default-valued input keeps the documented default.
 * - `text`: trimmed; an empty or non-string value keeps the default.
 * - `enum`: one of `values`; anything else keeps the default.
 * - `number`: a finite value at or above `min`; anything else keeps the default.
 */
export const OPTIONS = [
  { key: 'enabled', kind: 'boolean', default: true },
  { key: 'awareness', kind: 'boolean', default: true },
  { key: 'binary', kind: 'text', default: 'rtk' },
  { key: 'rewriteTimeoutMs', kind: 'number', default: 2000, min: 1 },
  { key: 'logRewrites', kind: 'boolean', default: false },
  { key: 'autoInstall', kind: 'boolean', default: true },
  { key: 'autoUpdate', kind: 'boolean', default: true },
  { key: 'version', kind: 'text', default: 'latest' },
  { key: 'edition', kind: 'enum', default: 'rtk', values: ['rtk', 'rtk-oss'] },
  { key: 'updateIntervalMs', kind: 'number', default: 86_400_000, min: 60_000 },
  { key: 'downloadTimeoutMs', kind: 'number', default: 120_000, min: 1_000 },
]

/**
 * Normalize one raw option value.
 *
 * Every rule falls back to the descriptor default, so a malformed value behaves
 * exactly like an omitted one.
 */
function normalizeValue(option, value) {
  switch (option.kind) {
    case 'boolean':
      return value === !option.default ? !option.default : option.default
    case 'text':
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : option.default
    case 'enum':
      return option.values.includes(value) ? value : option.default
    case 'number':
      return Number.isFinite(value) && value >= option.min ? value : option.default
    default:
      return option.default
  }
}

/**
 * Normalize a raw plugin config into the settings every consumer reads.
 *
 * @param {object | undefined} config - the row's raw `config` value.
 * @returns {object} settings keyed like {@link OPTIONS}.
 */
export function normalizeConfig(config) {
  const source = config ?? {}
  const settings = {}
  for (const option of OPTIONS) settings[option.key] = normalizeValue(option, source[option.key])
  return settings
}

/** Build one schemastery field from an option descriptor. */
function schemaField(z, option) {
  switch (option.kind) {
    case 'boolean':
      return z.boolean().default(option.default)
    case 'text':
    case 'enum':
      return z.string().default(option.default)
    case 'number':
      return z.number().step(1).min(option.min).default(option.default)
    default:
      return z.any().default(option.default)
  }
}

/**
 * Build the plugin's configuration schema.
 *
 * The schema builder is passed in because the schemastery package is an
 * optional runtime import in a linked checkout; see `index.js`.
 *
 * @param {object} z - the schemastery module's default export.
 * @returns {object} an object schema usable as the plugin's `Config`.
 */
export function buildConfigSchema(z) {
  const fields = {}
  for (const option of OPTIONS) fields[option.key] = schemaField(z, option)
  return z.object(fields)
}
