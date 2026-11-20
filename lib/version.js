/**
 * Version helpers shared by the rewrite protocol and the external RTK
 * resolver. Kept dependency-free so it can be imported from a linked
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
