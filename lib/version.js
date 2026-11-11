/**
 * Version helpers shared by the rewrite protocol and the managed RTK
 * installer. Kept dependency-free so it can be imported from a linked
 * checkout, which cannot resolve DSH's shipped packages.
 */

/** `rtk rewrite` was introduced in rtk 0.23.0. */
export const MIN_RTK_MAJOR = 0
export const MIN_RTK_MINOR = 23

/** Turn a regex capture of `major.minor.patch` into a version object. */
function partsFromMatch(match) {
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/**
 * Parse `rtk X.Y.Z` (or any string containing a semver) into its parts.
 *
 * @param {unknown} raw - text printed by `rtk --version` or a release tag.
 * @returns {{ major: number, minor: number, patch: number, raw: string } | null}
 */
export function parseRtkVersion(raw) {
  if (typeof raw !== 'string') return null
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return { ...partsFromMatch(match), raw: raw.trim() }
}

function versionParts(value) {
  if (value === null || typeof value !== 'object') return null
  const { major, minor, patch } = value
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return null
  }
  return { major, minor, patch }
}

/**
 * Compare two version-like objects numerically.
 *
 * @returns {number} -1, 0, or 1; 0 when either side is not a version.
 */
export function compareVersions(left, right) {
  const a = versionParts(left)
  const b = versionParts(right)
  if (a === null || b === null) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  return 0
}

/** Whether a version is new enough to expose `rtk rewrite`. */
export function isSupportedVersion(version) {
  const parts = versionParts(version)
  if (parts === null) return false
  return parts.major > MIN_RTK_MAJOR
    || (parts.major === MIN_RTK_MAJOR && parts.minor >= MIN_RTK_MINOR)
}

/** Render a version object as `major.minor.patch`. */
export function formatVersion(version) {
  const parts = versionParts(version)
  if (parts === null) return undefined
  return `${parts.major}.${parts.minor}.${parts.patch}`
}

/**
 * Normalize a stable release tag or bare version.
 *
 * `1.2.0` and `v1.2.0` both become `{ tag: 'v1.2.0', text: '1.2.0', ... }`.
 * Prerelease and range-like values are rejected; the installer only accepts
 * exact stable releases.
 *
 * @param {unknown} value
 * @returns {{ tag: string, text: string, version: { major: number, minor: number, patch: number } } | null}
 */
export function normalizeTag(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^v/i, '')
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) return null
  return {
    tag: `v${text}`,
    text,
    version: partsFromMatch(match),
  }
}

/** Extract the version object from a tag, or null. */
export function tagVersion(tag) {
  return normalizeTag(tag)?.version ?? null
}
