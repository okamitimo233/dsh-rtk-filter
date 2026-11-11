/**
 * Upstream RTK release access: target detection, asset names, the latest-tag
 * lookup, and checksum-verified archive downloads.
 *
 * Network access goes through the process-wide `fetch`, whose dispatcher the
 * DSH launcher configures from the user's proxy environment. Never build a
 * private `undici` agent here: doing so would bypass that policy.
 */

import { createHash } from 'node:crypto'

import { describeError, isAbortError } from './proc.js'
import { normalizeTag } from './version.js'

export const REPOSITORY = 'rtk-ai/rtk'
export const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`
export const USER_AGENT = 'dsh-rtk-filter'

const TARGETS = {
  linux: {
    x64: 'x86_64-unknown-linux-musl',
    arm64: 'aarch64-unknown-linux-musl',
  },
  darwin: {
    x64: 'x86_64-apple-darwin',
    arm64: 'aarch64-apple-darwin',
  },
}

const MAX_JSON_BYTES = 1024 * 1024
const MAX_CHECKSUMS_BYTES = 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024

/** Failure from the release pipeline, classified for logging and tests. */
export class ReleaseError extends Error {
  /**
   * @param {string} code - stable machine-readable category.
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'ReleaseError'
    this.code = code
  }
}

/**
 * Map the Host platform to the upstream asset target.
 *
 * @param {string} [platform]
 * @param {string} [arch]
 * @returns {string | undefined}
 */
export function supportedTarget(platform = process.platform, arch = process.arch) {
  return TARGETS[platform]?.[arch]
}

/** Asset name for one edition and target. */
export function assetName(edition, target) {
  return `${edition}-${target}.tar.gz`
}

/** Download URL for one tag and asset. */
export function releaseDownloadUrl(tag, asset) {
  return `${RELEASES_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`
}

/** URL of the checksums asset for a tag. */
export function checksumsUrl(tag) {
  return releaseDownloadUrl(tag, 'checksums.txt')
}

/** URL that redirects to the latest stable release. */
export function latestReleaseUrl() {
  return `${RELEASES_URL}/latest`
}

/** API fallback for the latest stable release. */
export function latestApiUrl() {
  return `https://api.github.com/repos/${REPOSITORY}/releases/latest`
}

/**
 * Parse a `sha256sum`-style checksums file into asset name -> hex digest.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseChecksums(text) {
  const checksums = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/)
    if (match === null) continue
    checksums.set(match[2], match[1].toLowerCase())
  }
  return checksums
}

/**
 * Extract a stable tag from the final URL of a `/releases/latest` redirect.
 *
 * @param {unknown} finalUrl
 * @returns {string | undefined} normalized tag such as `v1.2.0`.
 */
export function parseLatestTag(finalUrl) {
  if (typeof finalUrl !== 'string') return undefined
  const match = finalUrl.match(/\/releases\/tag\/([^/?#]+)\/?$/)
  if (match === null) return undefined
  let decoded
  try {
    decoded = decodeURIComponent(match[1])
  } catch {
    return undefined
  }
  return normalizeTag(decoded)?.tag
}

function requestHeaders() {
  return {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
  }
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 1))
  if (signal === undefined || signal === null) return timeout
  return AbortSignal.any([signal, timeout])
}

async function request(fetchImpl, url, { timeoutMs, signal, redirect = 'follow' } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ReleaseError('UNSUPPORTED', 'global fetch is unavailable in this Host')
  }
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect,
      headers: requestHeaders(),
      signal: requestSignal(signal, timeoutMs),
    })
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ReleaseError('NETWORK', `request for ${url} failed: ${describeError(error)}`)
  }
  if (response === null || typeof response !== 'object') {
    throw new ReleaseError('NETWORK', `request for ${url} returned no response`)
  }
  if (response.ok === false) {
    const status = typeof response.status === 'number' ? `HTTP ${response.status}` : 'HTTP error'
    throw new ReleaseError('HTTP', `${status} for ${url}`)
  }
  return response
}

async function readBuffer(response, maxBytes, label) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ReleaseError('TOO_LARGE', `${label} is larger than ${maxBytes} bytes`)
  }
  let value
  try {
    value = await response.arrayBuffer()
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ReleaseError('NETWORK', `could not read ${label}: ${describeError(error)}`)
  }
  const buffer = Buffer.from(value)
  if (buffer.length > maxBytes) {
    throw new ReleaseError('TOO_LARGE', `${label} is larger than ${maxBytes} bytes`)
  }
  return buffer
}

async function readText(response, maxBytes, label) {
  return (await readBuffer(response, maxBytes, label)).toString('utf8')
}

/**
 * Resolve the latest stable RTK tag.
 *
 * The release redirect is tried first because it does not consume the
 * anonymous GitHub API quota. The REST API is a fallback only.
 *
 * @param {{ fetchImpl?: Function, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<string>} normalized tag such as `v1.2.0`.
 */
export async function fetchLatestTag({ fetchImpl = globalThis.fetch, timeoutMs = 30_000, signal } = {}) {
  let redirectFailure
  try {
    const response = await request(fetchImpl, latestReleaseUrl(), { timeoutMs, signal })
    try {
      await response.body?.cancel?.()
    } catch {
      // The body is irrelevant; failing to cancel it is not a release failure.
    }
    const tag = parseLatestTag(response.url)
    if (tag !== undefined) return tag
    redirectFailure = new ReleaseError('LATEST', 'the latest-release redirect did not name a tag')
  } catch (error) {
    if (isAbortError(error)) throw error
    redirectFailure = error
  }

  try {
    const response = await request(fetchImpl, latestApiUrl(), { timeoutMs, signal })
    const text = await readText(response, MAX_JSON_BYTES, 'the GitHub release metadata')
    const payload = JSON.parse(text)
    const tag = normalizeTag(payload?.tag_name)?.tag
    if (tag !== undefined) return tag
    throw new ReleaseError('LATEST', 'the GitHub API response has no stable tag_name')
  } catch (error) {
    if (isAbortError(error)) throw error
    throw new ReleaseError(
      'LATEST',
      `could not resolve the latest RTK release (${describeError(redirectFailure)}; ${describeError(error)})`,
    )
  }
}

/**
 * Download and verify the archive for one tag.
 *
 * @param {object} options
 * @param {string} options.tag
 * @param {string} [options.edition]
 * @param {string} options.target
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ tag: string, version: string, asset: string, target: string,
 *   archive: Buffer, sha256: string }>}
 */
export async function downloadRelease({
  tag,
  edition = 'rtk',
  target,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120_000,
  signal,
} = {}) {
  const normalized = normalizeTag(tag)
  if (normalized === null) {
    throw new ReleaseError('TAG', `invalid RTK release tag "${String(tag)}"`)
  }
  if (edition !== 'rtk' && edition !== 'rtk-oss') {
    throw new ReleaseError('EDITION', `unknown RTK edition "${String(edition)}"`)
  }
  if (typeof target !== 'string' || target === '') {
    throw new ReleaseError('TARGET', 'no RTK release target was selected for this platform')
  }

  const asset = assetName(edition, target)
  const checksumsResponse = await request(fetchImpl, checksumsUrl(normalized.tag), { timeoutMs, signal })
  const checksumsText = await readText(checksumsResponse, MAX_CHECKSUMS_BYTES, 'checksums.txt')
  const expected = parseChecksums(checksumsText).get(asset)
  if (expected === undefined) {
    throw new ReleaseError('ASSET', `release ${normalized.tag} does not publish ${asset}`)
  }

  const archiveResponse = await request(fetchImpl, releaseDownloadUrl(normalized.tag, asset), { timeoutMs, signal })
  const archive = await readBuffer(archiveResponse, MAX_ARCHIVE_BYTES, asset)
  const sha256 = createHash('sha256').update(archive).digest('hex')
  if (sha256 !== expected) {
    throw new ReleaseError('CHECKSUM', `checksum mismatch for ${asset}: expected ${expected}, got ${sha256}`)
  }

  return {
    tag: normalized.tag,
    version: normalized.text,
    asset,
    target,
    archive,
    sha256,
  }
}
