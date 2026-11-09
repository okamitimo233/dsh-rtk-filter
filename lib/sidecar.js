/**
 * Plugin-owned RTK binary lifecycle.
 *
 * The binary is downloaded into `$DSH_HOME/cache/rtk-filter`, verified against
 * the upstream release checksums, and published atomically under a versioned
 * directory. Nothing is written into the profile, the bundle, or a directory
 * on the user's `PATH`.
 *
 * This module uses Node built-ins only: a linked-checkout bundle cannot
 * resolve DSH's shipped packages.
 */

import { chmod, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  ReleaseError,
  downloadRelease,
  fetchLatestTag,
  isAbortError,
  supportedTarget,
} from './release.js'
import { extractFromTarGz, TarError } from './tar.js'
import {
  compareVersions,
  formatVersion,
  isSupportedVersion,
  normalizeTag,
  parseRtkVersion,
} from './version.js'

export const CACHE_DIR_NAME = 'rtk-filter'

const WANTED_FILES = ['rtk', 'LICENSE', 'LICENSE-ENGINE']
const MODE_DIR = 0o700
const MODE_BIN = 0o755
const MODE_TEXT = 0o644
const LOCK_WAIT_MS = 30_000
const LOCK_STALE_MS = 10 * 60_000
const UPDATE_RETRY_MS = 60 * 60_000
const TEMP_STALE_MS = 24 * 60 * 60_000

let tempCounter = 0

/**
 * Resolve the plugin-owned cache root.
 *
 * Precedence: the live profile's resolved home, then `$DSH_HOME`, then
 * `~/.dsh`. The profile service is optional because the plugin can also run
 * in an embedding that did not boot from a profile.
 *
 * @param {object} [ctx]
 * @param {{ env?: Record<string, string | undefined>, home?: string | (() => string) }} [options]
 * @returns {string}
 */
export function resolveCacheRoot(ctx, { env = process.env, home = homedir } = {}) {
  let configured
  try {
    configured = ctx?.get?.('profileContext')?.home
  } catch {
    configured = undefined
  }
  const profileHome = typeof configured === 'string' ? configured.trim() : ''
  const envHome = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  const base = profileHome !== ''
    ? profileHome
    : envHome !== ''
      ? envHome
      : join(typeof home === 'function' ? home() : home, '.dsh')
  return join(base, 'cache', CACHE_DIR_NAME)
}

function layoutFor(root, edition, target) {
  return {
    root,
    edition,
    target,
    latestPath: join(root, 'latest.json'),
    statePath: join(root, 'state', `${edition}__${target}.json`),
    lockPath: join(root, 'locks', `${edition}__${target}.lock`),
    versionsDir: join(root, 'versions', edition, target),
    tmpDir: join(root, 'tmp'),
  }
}

function insideRoot(root, candidate) {
  const resolved = resolve(root, candidate)
  const rel = relative(root, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return resolved
}

function tempPath(path) {
  tempCounter += 1
  return `${path}.${process.pid}.${tempCounter}.tmp`
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: MODE_DIR })
  const temp = tempPath(path)
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

function abortedError() {
  const error = new Error('RTK install aborted')
  error.name = 'AbortError'
  error.code = 'ABORT_ERR'
  return error
}

function describe(error) {
  if (error instanceof ReleaseError || error instanceof TarError) {
    return `${error.code}: ${error.message}`
  }
  if (isAbortError(error)) return 'aborted'
  return error instanceof Error ? error.message : String(error)
}

function entryFromState(state) {
  return {
    binary: state.binary,
    prefixDir: dirname(state.binary),
    source: 'managed',
    version: state.version,
    versionText: formatVersion(state.version),
    tag: state.tag,
  }
}

async function readState(layout) {
  const raw = await readJson(layout.statePath)
  if (raw === null || typeof raw !== 'object') return undefined
  if (raw.schema !== 1 || raw.edition !== layout.edition || raw.target !== layout.target) return undefined
  const version = parseRtkVersion(raw.version)
  if (version === null || !isSupportedVersion(version)) return undefined
  if (typeof raw.binary !== 'string' || raw.binary === '') return undefined
  const binary = insideRoot(layout.root, raw.binary)
  if (binary === undefined) return undefined
  try {
    const info = await stat(binary)
    if (!info.isFile() || (info.mode & 0o111) === 0) return undefined
  } catch {
    return undefined
  }
  return { ...raw, binary, version }
}

async function writeState(layout, state) {
  await writeJson(layout.statePath, state)
}

async function listVersions(layout) {
  let entries
  try {
    entries = await readdir(layout.versionsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const versions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const version = parseRtkVersion(entry.name)
    if (version === null || !isSupportedVersion(version)) continue
    const binary = join(layout.versionsDir, entry.name, 'rtk')
    try {
      const info = await stat(binary)
      if (!info.isFile() || (info.mode & 0o111) === 0) continue
    } catch {
      continue
    }
    versions.push({
      version,
      versionText: entry.name,
      binary,
      dir: join(layout.versionsDir, entry.name),
    })
  }
  versions.sort((left, right) => compareVersions(right.version, left.version))
  return versions
}

async function collectGarbage(layout, keepVersionText, now) {
  const versions = await listVersions(layout)
  const keep = new Set([keepVersionText])
  for (const candidate of versions) {
    if (keep.size >= 2) break
    if (!keep.has(candidate.versionText)) keep.add(candidate.versionText)
  }
  for (const candidate of versions) {
    if (keep.has(candidate.versionText)) continue
    try {
      await rm(candidate.dir, { recursive: true, force: true })
    } catch {
      // A failed cleanup is not a reason to fail an otherwise valid install.
    }
  }
  try {
    for (const entry of await readdir(layout.tmpDir)) {
      const path = join(layout.tmpDir, entry)
      try {
        const info = await stat(path)
        if (now() - info.mtimeMs > TEMP_STALE_MS) {
          await rm(path, { recursive: true, force: true })
        }
      } catch {
        // Ignore entries that disappear while being inspected.
      }
    }
  } catch {
    // No temp directory yet.
  }
}

/**
 * Create the RTK manager for one plugin activation.
 *
 * @param {object} options
 * @param {object} options.ctx
 * @param {object} options.settings - normalized plugin configuration
 * @param {object} [options.deps]
 * @param {string} [options.deps.root] - override for tests
 * @param {string} [options.deps.platform]
 * @param {string} [options.deps.arch]
 * @param {Record<string, string | undefined>} [options.deps.env]
 * @param {Function} [options.deps.home]
 * @param {Function} [options.deps.fetchImpl]
 * @param {Function} [options.deps.probeRtk]
 * @param {Function} [options.deps.smokeRewrite]
 * @param {object} [options.deps.logger]
 * @param {Function} [options.deps.now]
 * @param {Function} [options.deps.setTimeout]
 * @param {Function} [options.deps.clearTimeout]
 * @param {Function} [options.deps.sleep]
 */
export async function createRtkManager({ ctx, settings = {}, deps = {} } = {}) {
  const {
    root,
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    home = homedir,
    fetchImpl = globalThis.fetch,
    probeRtk,
    smokeRewrite,
    logger,
    now = Date.now,
    setTimeout: schedule = (callback, delay) => setTimeout(callback, delay),
    clearTimeout: unschedule = (handle) => clearTimeout(handle),
    sleep = (delay) => new Promise((resolveSleep) => setTimeout(resolveSleep, delay)),
    lockTimeoutMs = LOCK_WAIT_MS,
    lockStaleMs = LOCK_STALE_MS,
  } = deps

  const autoInstall = settings.autoInstall !== false
  const autoUpdate = settings.autoUpdate !== false
  const edition = settings.edition === 'rtk-oss' ? 'rtk-oss' : 'rtk'
  const versionSetting = typeof settings.version === 'string' && settings.version.trim() !== ''
    ? settings.version.trim()
    : 'latest'
  const rewriteTimeoutMs = Number.isFinite(settings.rewriteTimeoutMs) && settings.rewriteTimeoutMs > 0
    ? settings.rewriteTimeoutMs
    : 2000
  const updateIntervalMs = Number.isFinite(settings.updateIntervalMs) && settings.updateIntervalMs >= 60_000
    ? settings.updateIntervalMs
    : 86_400_000
  const downloadTimeoutMs = Number.isFinite(settings.downloadTimeoutMs) && settings.downloadTimeoutMs >= 1000
    ? settings.downloadTimeoutMs
    : 120_000
  const probeTimeoutMs = deps.probeTimeoutMs ?? Math.max(rewriteTimeoutMs, 2000)

  const cacheRoot = root ?? resolveCacheRoot(ctx, { env, home })
  const target = supportedTarget(platform, arch)
  const layout = target === undefined ? undefined : layoutFor(cacheRoot, edition, target)
  const controller = new AbortController()

  let pin
  if (versionSetting !== 'latest') {
    pin = normalizeTag(versionSetting) ?? undefined
    if (pin === undefined) {
      logger?.warn?.(`[rtk] ignoring invalid pinned version "${versionSetting}"; using latest`)
    }
  }

  const explicitBinary = (() => {
    const fromEnv = typeof env.RTK_BIN === 'string' && env.RTK_BIN.trim() !== ''
      ? env.RTK_BIN.trim()
      : undefined
    if (fromEnv !== undefined) return fromEnv
    const configured = typeof settings.binary === 'string' && settings.binary.trim() !== ''
      ? settings.binary.trim()
      : 'rtk'
    return configured === 'rtk' ? undefined : configured
  })()

  let current
  let fallback
  let reason
  let canWrap = false
  let started
  let timer
  let checking
  let nextDelayMs
  let disposed = false

  async function probe(binary) {
    if (typeof probeRtk !== 'function') {
      return { ok: false, reason: 'the RTK probe is unavailable' }
    }
    try {
      return await probeRtk({ binary, timeoutMs: probeTimeoutMs, signal: controller.signal })
    } catch (error) {
      return { ok: false, reason: isAbortError(error) ? 'aborted' : describe(error) }
    }
  }

  function makeEntry(binary, source, version) {
    const absolute = isAbsolute(binary) ? binary : undefined
    return {
      binary,
      prefixDir: absolute === undefined ? undefined : dirname(absolute),
      source,
      version,
    }
  }

  async function resolveExplicit(binary) {
    const result = await probe(binary)
    if (!result.ok) {
      return { reason: result.reason ?? `RTK binary "${binary}" could not be run` }
    }
    if (!isAbsolute(binary) && binary !== 'rtk') {
      logger?.warn?.(`[rtk] binary "${binary}" is not an absolute path; rewritten commands still invoke "rtk" from PATH`)
    }
    return { entry: makeEntry(binary, 'explicit', result.version) }
  }

  async function resolvePath() {
    const result = await probe('rtk')
    if (!result.ok) return undefined
    return makeEntry('rtk', 'path', result.version)
  }

  async function resolveManaged() {
    if (layout === undefined) return undefined
    const state = await readState(layout)
    if (state !== undefined) {
      const result = await probe(state.binary)
      if (result.ok) return entryFromState(state)
    }
    for (const candidate of await listVersions(layout)) {
      const result = await probe(candidate.binary)
      if (!result.ok) continue
      const entry = {
        binary: candidate.binary,
        prefixDir: dirname(candidate.binary),
        source: 'managed',
        version: candidate.version,
        versionText: candidate.versionText,
        tag: `v${candidate.versionText}`,
      }
      await writeState(layout, {
        schema: 1,
        edition,
        target,
        tag: entry.tag,
        version: candidate.versionText,
        asset: '',
        sha256: '',
        binary: relative(layout.root, candidate.binary),
        installedAt: new Date(now()).toISOString(),
      }).catch(() => {})
      return entry
    }
    return undefined
  }

  if (explicitBinary !== undefined) {
    const result = await resolveExplicit(explicitBinary)
    current = result.entry
    reason = result.reason
    canWrap = current !== undefined
  } else if (layout === undefined) {
    current = await resolvePath()
    canWrap = current !== undefined
    if (current === undefined) {
      reason = `RTK auto-install is not supported on ${platform}/${arch}`
    }
  } else {
    current = await resolveManaged()
    fallback = await resolvePath()
    if (current === undefined) current = fallback
    if (current !== undefined) {
      canWrap = true
    } else if (autoInstall) {
      canWrap = true
    } else {
      reason = 'RTK is not installed and autoInstall is disabled'
    }
  }

  function currentEntry() {
    if (current !== undefined) {
      if (!isAbsolute(current.binary)) return current
      try {
        const info = statSync(current.binary)
        if (info.isFile() && (info.mode & 0o111) !== 0) return current
      } catch {
        // Managed or explicit binary disappeared; fall through to the PATH copy.
      }
    }
    if (current?.source === 'managed' && fallback !== undefined) {
      if (!isAbsolute(fallback.binary)) return fallback
      try {
        const info = statSync(fallback.binary)
        if (info.isFile() && (info.mode & 0o111) !== 0) return fallback
      } catch {
        return undefined
      }
    }
    return undefined
  }

  async function acquireLock() {
    await mkdir(dirname(layout.lockPath), { recursive: true, mode: MODE_DIR })
    const deadline = now() + lockTimeoutMs
    while (true) {
      let handle
      try {
        handle = await open(layout.lockPath, 'wx', 0o600)
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        let stale = false
        try {
          const info = await stat(layout.lockPath)
          stale = now() - info.mtimeMs > lockStaleMs
        } catch {
          stale = false
        }
        if (stale) {
          try {
            await rm(layout.lockPath, { force: true })
          } catch {
            // Another process may have removed it first.
          }
          continue
        }
        if (now() >= deadline) return undefined
        await sleep(200)
        continue
      }
      try {
        await handle.writeFile(`${process.pid}\n`)
      } catch {
        // The lock still serializes even when its owner record cannot be written.
      }
      return async () => {
        try {
          await handle.close()
        } catch {
          // Already closed.
        }
        try {
          await rm(layout.lockPath, { force: true })
        } catch {
          // Already removed.
        }
      }
    }
  }

  async function latestTag() {
    const cached = await readJson(layout.latestPath)
    if (cached !== null && typeof cached === 'object'
      && typeof cached.tag === 'string'
      && Number.isFinite(cached.checkedAt)
      && now() - cached.checkedAt < updateIntervalMs) {
      const normalized = normalizeTag(cached.tag)
      if (normalized !== null) return normalized.tag
    }
    const tag = await fetchLatestTag({
      fetchImpl,
      timeoutMs: downloadTimeoutMs,
      signal: controller.signal,
    })
    await writeJson(layout.latestPath, { tag, checkedAt: now() })
    return tag
  }

  async function installRelease(tag) {
    logger?.info?.(`[rtk] installing RTK ${tag} (${edition}, ${target})`)
    const release = await downloadRelease({
      tag,
      edition,
      target,
      fetchImpl,
      timeoutMs: downloadTimeoutMs,
      signal: controller.signal,
    })
    const files = extractFromTarGz(release.archive, WANTED_FILES)
    const binaryData = files.get('rtk')
    if (binaryData === undefined || binaryData.length === 0) {
      throw new ReleaseError('ARCHIVE', `archive ${release.asset} contains no rtk executable`)
    }

    await mkdir(layout.tmpDir, { recursive: true, mode: MODE_DIR })
    const staging = await mkdtemp(join(layout.tmpDir, 'install-'))
    const stagedBinary = join(staging, 'rtk')
    try {
      await writeFile(stagedBinary, binaryData, { mode: MODE_BIN })
      await chmod(stagedBinary, MODE_BIN)

      const verified = await probe(stagedBinary)
      if (!verified.ok) {
        throw new ReleaseError('VERIFY', `downloaded RTK did not run: ${verified.reason ?? 'unknown error'}`)
      }
      const expected = parseRtkVersion(release.version)
      if (verified.version === null || expected === null || compareVersions(verified.version, expected) !== 0) {
        throw new ReleaseError(
          'VERIFY',
          `downloaded RTK reports ${verified.version?.raw ?? 'no version'}, expected ${release.version}`,
        )
      }
      if (typeof smokeRewrite !== 'function') {
        throw new ReleaseError('VERIFY', 'no rewrite smoke test is configured')
      }
      const smoke = await smokeRewrite({ binary: stagedBinary, signal: controller.signal })
      if (smoke?.ok !== true) {
        throw new ReleaseError('VERIFY', `downloaded RTK failed its rewrite check: ${smoke?.reason ?? 'unknown error'}`)
      }
      if (controller.signal.aborted) throw abortedError()

      const versionDir = join(layout.versionsDir, release.version)
      await mkdir(versionDir, { recursive: true, mode: MODE_DIR })
      const finalBinary = join(versionDir, 'rtk')
      await rename(stagedBinary, finalBinary)
      await chmod(finalBinary, MODE_BIN)
      for (const [name, data] of files) {
        if (name === 'rtk') continue
        await writeFile(join(versionDir, name), data, { mode: MODE_TEXT })
      }

      await writeState(layout, {
        schema: 1,
        edition,
        target,
        tag: release.tag,
        version: release.version,
        asset: release.asset,
        sha256: release.sha256,
        binary: relative(layout.root, finalBinary),
        installedAt: new Date(now()).toISOString(),
      })
      await collectGarbage(layout, release.version, now)

      return {
        binary: finalBinary,
        prefixDir: versionDir,
        source: 'managed',
        version: expected,
        versionText: release.version,
        tag: release.tag,
      }
    } finally {
      try {
        await rm(staging, { recursive: true, force: true })
      } catch {
        // Staging cleanup is best effort.
      }
    }
  }

  async function installTag(tag) {
    const normalized = normalizeTag(tag)
    if (normalized === null) {
      throw new ReleaseError('TAG', `invalid RTK release tag "${String(tag)}"`)
    }
    const release = await acquireLock()
    if (release === undefined) {
      const state = await readState(layout)
      if (state !== undefined && state.tag === normalized.tag) return entryFromState(state)
      throw new ReleaseError('LOCK', 'another RTK install is already in progress')
    }
    try {
      const existing = await readState(layout)
      if (existing !== undefined && existing.tag === normalized.tag) return entryFromState(existing)
      return await installRelease(normalized.tag)
    } finally {
      await release()
    }
  }

  async function checkNow() {
    if (disposed) return undefined
    if (checking !== undefined) return checking
    if (pin !== undefined || !autoUpdate || layout === undefined || current?.source !== 'managed') {
      return undefined
    }
    checking = (async () => {
      let tag
      try {
        tag = await latestTag()
      } catch (error) {
        nextDelayMs = UPDATE_RETRY_MS
        throw error
      }
      const latest = parseRtkVersion(tag)
      const installed = current.version ?? parseRtkVersion(current.versionText)
      if (latest === null || installed === null || compareVersions(latest, installed) <= 0) return
      if (typeof smokeRewrite !== 'function') {
        throw new ReleaseError('VERIFY', 'no rewrite smoke test is configured')
      }
      const entry = await installTag(tag)
      current = entry
      logger?.info?.(`[rtk] RTK updated to ${entry.versionText}`)
    })()
      .catch((error) => {
        if (!disposed && !isAbortError(error)) {
          nextDelayMs = UPDATE_RETRY_MS
          logger?.warn?.(`[rtk] RTK update failed: ${describe(error)}`)
        }
      })
      .finally(() => {
        checking = undefined
      })
    return checking
  }

  async function scheduleNext() {
    if (disposed || timer !== undefined || layout === undefined) return
    let delay = 0
    if (nextDelayMs !== undefined) {
      delay = nextDelayMs
      nextDelayMs = undefined
    } else {
      const cached = await readJson(layout.latestPath)
      if (cached !== null && typeof cached === 'object' && Number.isFinite(cached.checkedAt)) {
        delay = Math.max(0, cached.checkedAt + updateIntervalMs - now())
      }
    }
    timer = schedule(() => {
      timer = undefined
      void checkNow().finally(() => {
        if (!disposed) void scheduleNext().catch(() => {})
      })
    }, delay)
    if (timer !== null && typeof timer === 'object' && typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  async function runInitial() {
    if (disposed) return false
    if (layout === undefined || explicitBinary !== undefined) return current !== undefined

    if (pin !== undefined && autoInstall) {
      const matches = current?.source === 'managed' && current.versionText === pin.text
      if (!matches) {
        try {
          const entry = await installTag(pin.tag)
          current = entry
          logger?.info?.(`[rtk] RTK ${entry.versionText} installed at ${entry.binary}`)
        } catch (error) {
          if (disposed || isAbortError(error)) return false
          logger?.warn?.(`[rtk] could not install RTK ${pin.text}: ${describe(error)}`)
        }
      }
    } else if (autoInstall && (current === undefined || current.source === 'path')) {
      try {
        const tag = await latestTag()
        const entry = await installTag(tag)
        current = entry
        logger?.info?.(`[rtk] RTK ${entry.versionText} installed at ${entry.binary}`)
      } catch (error) {
        if (disposed || isAbortError(error)) return false
        logger?.warn?.(`[rtk] could not install RTK: ${describe(error)}`)
      }
    } else if (pin !== undefined && !autoInstall && current?.source === 'managed'
      && current.versionText !== pin.text) {
      logger?.warn?.(`[rtk] autoInstall is disabled; keeping RTK ${current.versionText} instead of ${pin.text}`)
    }

    if (disposed) return false
    if (current?.source === 'managed' && autoUpdate && pin === undefined) {
      void scheduleNext().catch(() => {})
    }
    return current !== undefined
  }

  function start() {
    if (started !== undefined) return started
    const ready = disposed
      ? Promise.resolve(false)
      : runInitial().catch((error) => {
        if (!disposed && !isAbortError(error)) {
          logger?.warn?.(`[rtk] RTK setup failed: ${describe(error)}`)
        }
        return false
      })
    started = {
      ready,
      dispose,
    }
    return started
  }

  function dispose() {
    if (disposed) return
    disposed = true
    controller.abort()
    if (timer !== undefined) {
      unschedule(timer)
      timer = undefined
    }
  }

  return {
    initial: current,
    canWrap,
    reason,
    meta: {
      root: cacheRoot,
      edition,
      target,
      platform,
      arch,
      pin: pin?.tag,
    },
    current: currentEntry,
    start,
    checkNow,
    dispose,
  }
}
