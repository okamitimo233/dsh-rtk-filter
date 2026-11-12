/**
 * Plugin-owned RTK binary lifecycle.
 *
 * The binary is downloaded into `$DSH_HOME/cache/rtk-filter`, verified against
 * the upstream release checksums, and published atomically under a versioned
 * directory. Nothing is written into the profile, the bundle, or a directory
 * on the user's `PATH`.
 *
 * This module is the composition layer: it resolves the initial source
 * (explicit, managed, PATH), then schedules background install and update
 * work. `./store.js` owns the cache layout, and `./fsx.js` the filesystem
 * primitives. Node built-ins only: a linked-checkout bundle cannot resolve
 * DSH's shipped packages.
 */

import { chmod, mkdtemp, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

import { normalizeConfig } from './config.js'
import { ensureDir, isExecutableFileSync, removeQuietly } from './fsx.js'
import { abortError, describeError, isAbortError } from './proc.js'
import { ReleaseError, downloadRelease, fetchLatestTag, supportedTarget } from './release.js'
import {
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  STATE_SCHEMA,
  acquireLock,
  collectGarbage,
  entryFromState,
  layoutFor,
  listVersions,
  makeEntry,
  readLatest,
  readState,
  writeLatest,
  writeState,
} from './store.js'
import { extractFromTarGz, TarError } from './tar.js'
import { compareVersions, normalizeTag, parseRtkVersion } from './version.js'

export const CACHE_DIR_NAME = 'rtk-filter'

const WANTED_FILES = ['rtk', 'LICENSE', 'LICENSE-ENGINE']
const MODE_BIN = 0o755
const MODE_TEXT = 0o644
const UPDATE_RETRY_MS = 60 * 60_000

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

/** Failure detail with the release/tar category kept visible to the log. */
function describe(error) {
  if (error instanceof ReleaseError || error instanceof TarError) {
    return `${error.code}: ${error.message}`
  }
  if (isAbortError(error)) return 'aborted'
  return describeError(error)
}

/**
 * Probe one binary, converting a thrown failure into the manager's failure
 * shape so source resolution never rejects.
 *
 * @param {Function | undefined} probeRtk
 * @param {{ binary: string, timeoutMs: number, signal: AbortSignal }} request
 * @returns {Promise<{ ok: boolean, version?: object, reason?: string }>}
 */
async function probeBinary(probeRtk, { binary, timeoutMs, signal }) {
  if (typeof probeRtk !== 'function') {
    return { ok: false, reason: 'the RTK probe is unavailable' }
  }
  try {
    return await probeRtk({ binary, timeoutMs, signal })
  } catch (error) {
    return { ok: false, reason: isAbortError(error) ? 'aborted' : describe(error) }
  }
}

/**
 * Resolve an explicit `RTK_BIN` or non-default `binary` setting.
 *
 * @returns {Promise<{ entry?: object, reason?: string }>}
 */
async function resolveExplicit(probe, binary, logger) {
  const result = await probe(binary)
  if (!result.ok) {
    return { reason: result.reason ?? `RTK binary "${binary}" could not be run` }
  }
  if (!isAbsolute(binary) && binary !== 'rtk') {
    logger?.warn?.(`[rtk] binary "${binary}" is not an absolute path; rewritten commands still invoke "rtk" from PATH`)
  }
  return { entry: makeEntry({ binary, source: 'explicit', version: result.version }) }
}

/** Resolve the PATH fallback; undefined when no usable `rtk` is on PATH. */
async function resolvePath(probe) {
  const result = await probe('rtk')
  if (!result.ok) return undefined
  return makeEntry({ binary: 'rtk', source: 'path', version: result.version })
}

/**
 * Adopt the newest runnable version already present in the cache.
 *
 * A state file whose binary no longer runs is ignored, but an intact version
 * directory is re-adopted and its state rewritten so a deleted state file does
 * not force a download.
 *
 * @returns {Promise<object | undefined>} manager entry.
 */
async function resolveManaged(probe, { layout, edition, target, now }) {
  const state = await readState(layout)
  if (state !== undefined) {
    const result = await probe(state.binary)
    if (result.ok) return entryFromState(state)
  }
  for (const candidate of await listVersions(layout)) {
    const result = await probe(candidate.binary)
    if (!result.ok) continue
    const entry = makeEntry({
      binary: candidate.binary,
      source: 'managed',
      version: candidate.version,
      tag: `v${candidate.versionText}`,
    })
    await writeState(layout, {
      schema: STATE_SCHEMA,
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

/**
 * Choose the initial binary and whether wrapping is possible.
 *
 * Precedence: explicit binary, then a managed copy, then the PATH fallback. A
 * managed copy that is present but not runnable still leaves the wrapping
 * enabled when auto-install is on, so the shadow can be registered before the
 * background download finishes.
 *
 * @returns {Promise<{ current?: object, fallback?: object, canWrap: boolean, reason?: string }>}
 */
async function resolveInitialSource({
  explicitBinary,
  layout,
  probe,
  logger,
  platform,
  arch,
  autoInstall,
  edition,
  target,
  now,
}) {
  if (explicitBinary !== undefined) {
    const result = await resolveExplicit(probe, explicitBinary, logger)
    return {
      current: result.entry,
      fallback: undefined,
      canWrap: result.entry !== undefined,
      reason: result.reason,
    }
  }
  if (layout === undefined) {
    const current = await resolvePath(probe)
    return {
      current,
      fallback: undefined,
      canWrap: current !== undefined,
      reason: current === undefined ? `RTK auto-install is not supported on ${platform}/${arch}` : undefined,
    }
  }

  // Both probes are independent, and a ready managed copy should not wait on
  // the PATH probe. The PATH result stays the fallback for a managed binary
  // that later disappears.
  const [managed, fallback] = await Promise.all([
    resolveManaged(probe, { layout, edition, target, now }),
    resolvePath(probe),
  ])
  const current = managed ?? fallback
  if (current !== undefined) return { current, fallback, canWrap: true }
  if (autoInstall) return { current: undefined, fallback, canWrap: true }
  return { current: undefined, fallback, canWrap: false, reason: 'RTK is not installed and autoInstall is disabled' }
}

/**
 * The binary the shadow may use right now.
 *
 * A managed or explicit binary that disappeared falls back to the PATH copy,
 * but only while that copy still exists; otherwise the caller must fail open.
 *
 * @returns {object | undefined}
 */
function currentEntry(current, fallback) {
  if (current !== undefined) {
    if (!isAbsolute(current.binary)) return current
    if (isExecutableFileSync(current.binary)) return current
  }
  if (current?.source === 'managed' && fallback !== undefined) {
    if (!isAbsolute(fallback.binary)) return fallback
    return isExecutableFileSync(fallback.binary) ? fallback : undefined
  }
  return undefined
}

/**
 * Normalize plugin settings and Host environment into manager options.
 *
 * The defaults and clamps live in `./config.js`: activating through a
 * linked checkout passes the row's raw `config`, while the generated schema
 * path passes an already-validated object, and both must reach the manager with
 * the same settings. Normalizing here as well keeps the manager safe to call
 * directly (tests, embeddings) without repeating any literal.
 *
 * @param {object} rawSettings
 * @param {object} [environment]
 * @param {Record<string, string | undefined>} [environment.env]
 * @param {number} [environment.probeTimeoutMs]
 * @param {object} [environment.logger]
 */
function normalizeOptions(rawSettings, { env = process.env, probeTimeoutMs: configuredProbeTimeoutMs, logger } = {}) {
  const {
    autoInstall,
    autoUpdate,
    edition,
    version: versionSetting,
    rewriteTimeoutMs,
    updateIntervalMs,
    downloadTimeoutMs,
    binary,
  } = normalizeConfig(rawSettings)
  const probeTimeoutMs = configuredProbeTimeoutMs ?? Math.max(rewriteTimeoutMs, 2000)

  let pin
  if (versionSetting !== 'latest') {
    pin = normalizeTag(versionSetting) ?? undefined
    if (pin === undefined) {
      logger?.warn?.(`[rtk] ignoring invalid pinned version "${versionSetting}"; using latest`)
    }
  }

  const fromEnv = typeof env.RTK_BIN === 'string' && env.RTK_BIN.trim() !== ''
    ? env.RTK_BIN.trim()
    : undefined
  const explicitBinary = fromEnv ?? (binary === 'rtk' ? undefined : binary)

  return {
    autoInstall,
    autoUpdate,
    edition,
    pin,
    explicitBinary,
    updateIntervalMs,
    downloadTimeoutMs,
    probeTimeoutMs,
  }
}

/**
 * Build the install pipeline for one cache layout.
 *
 * `latestTag` caches the resolved tag for `updateIntervalMs`; `installTag`
 * serializes installs with the cross-process lock, reuses an existing state
 * when the requested tag is already installed, and never leaves a partial
 * version directory behind (staging happens under `tmp` and is removed on any
 * failure).
 */
function createInstaller({
  layout,
  edition,
  target,
  fetchImpl,
  downloadTimeoutMs,
  updateIntervalMs,
  smokeRewrite,
  probe,
  signal,
  logger,
  now,
  sleep,
  lockTimeoutMs,
  lockStaleMs,
}) {
  async function latestTag() {
    const cached = await readLatest(layout)
    if (cached.tag !== undefined && cached.checkedAt !== undefined
      && now() - cached.checkedAt < updateIntervalMs) {
      return cached.tag
    }
    const tag = await fetchLatestTag({ fetchImpl, timeoutMs: downloadTimeoutMs, signal })
    await writeLatest(layout, tag, now())
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
      signal,
    })
    const files = extractFromTarGz(release.archive, WANTED_FILES)
    const binaryData = files.get('rtk')
    if (binaryData === undefined || binaryData.length === 0) {
      throw new ReleaseError('ARCHIVE', `archive ${release.asset} contains no rtk executable`)
    }

    await ensureDir(layout.tmpDir)
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
      const smoke = await smokeRewrite({ binary: stagedBinary, signal })
      if (smoke?.ok !== true) {
        throw new ReleaseError('VERIFY', `downloaded RTK failed its rewrite check: ${smoke?.reason ?? 'unknown error'}`)
      }
      if (signal.aborted) throw abortError('RTK install aborted')

      const versionDir = join(layout.versionsDir, release.version)
      await ensureDir(versionDir)
      const finalBinary = join(versionDir, 'rtk')
      await rename(stagedBinary, finalBinary)
      await chmod(finalBinary, MODE_BIN)
      for (const [name, data] of files) {
        if (name === 'rtk') continue
        await writeFile(join(versionDir, name), data, { mode: MODE_TEXT })
      }

      await writeState(layout, {
        schema: STATE_SCHEMA,
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

      return makeEntry({
        binary: finalBinary,
        source: 'managed',
        version: expected,
        tag: release.tag,
      })
    } finally {
      await removeQuietly(staging)
    }
  }

  async function installTag(tag) {
    const normalized = normalizeTag(tag)
    if (normalized === null) {
      throw new ReleaseError('TAG', `invalid RTK release tag "${String(tag)}"`)
    }
    const unlock = await acquireLock(layout, { now, sleep, timeoutMs: lockTimeoutMs, staleMs: lockStaleMs })
    if (unlock === undefined) {
      const state = await readState(layout)
      if (state !== undefined && state.tag === normalized.tag) return entryFromState(state)
      throw new ReleaseError('LOCK', 'another RTK install is already in progress')
    }
    try {
      const existing = await readState(layout)
      if (existing !== undefined && existing.tag === normalized.tag) return entryFromState(existing)
      return await installRelease(normalized.tag)
    } finally {
      await unlock()
    }
  }

  return { latestTag, installTag }
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

  const options = normalizeOptions(settings, { env, probeTimeoutMs: deps.probeTimeoutMs, logger })
  const cacheRoot = root ?? resolveCacheRoot(ctx, { env, home })
  const target = supportedTarget(platform, arch)
  const layout = target === undefined ? undefined : layoutFor(cacheRoot, options.edition, target)
  const controller = new AbortController()

  const probe = (binary) => probeBinary(probeRtk, {
    binary,
    timeoutMs: options.probeTimeoutMs,
    signal: controller.signal,
  })

  const resolution = await resolveInitialSource({
    explicitBinary: options.explicitBinary,
    layout,
    probe,
    logger,
    platform,
    arch,
    autoInstall: options.autoInstall,
    edition: options.edition,
    target,
    now,
  })
  let current = resolution.current
  const fallback = resolution.fallback
  const reason = resolution.reason
  const canWrap = resolution.canWrap

  let started
  let timer
  let checking
  let nextDelayMs
  let disposed = false

  const installer = layout === undefined
    ? undefined
    : createInstaller({
      layout,
      edition: options.edition,
      target,
      fetchImpl,
      downloadTimeoutMs: options.downloadTimeoutMs,
      updateIntervalMs: options.updateIntervalMs,
      smokeRewrite,
      probe,
      signal: controller.signal,
      logger,
      now,
      sleep,
      lockTimeoutMs,
      lockStaleMs,
    })

  async function checkNow() {
    if (disposed) return undefined
    if (checking !== undefined) return checking
    if (options.pin !== undefined || !options.autoUpdate || layout === undefined || current?.source !== 'managed') {
      return undefined
    }
    checking = (async () => {
      let tag
      try {
        tag = await installer.latestTag()
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
      const entry = await installer.installTag(tag)
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
      const cached = await readLatest(layout)
      if (cached.checkedAt !== undefined) {
        delay = Math.max(0, cached.checkedAt + options.updateIntervalMs - now())
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
    if (layout === undefined || options.explicitBinary !== undefined) return current !== undefined

    if (options.pin !== undefined && options.autoInstall) {
      const matches = current?.source === 'managed' && current.versionText === options.pin.text
      if (!matches) {
        try {
          const entry = await installer.installTag(options.pin.tag)
          current = entry
          logger?.info?.(`[rtk] RTK ${entry.versionText} installed at ${entry.binary}`)
        } catch (error) {
          if (disposed || isAbortError(error)) return false
          logger?.warn?.(`[rtk] could not install RTK ${options.pin.text}: ${describe(error)}`)
        }
      }
    } else if (options.autoInstall && (current === undefined || current.source === 'path')) {
      try {
        const tag = await installer.latestTag()
        const entry = await installer.installTag(tag)
        current = entry
        logger?.info?.(`[rtk] RTK ${entry.versionText} installed at ${entry.binary}`)
      } catch (error) {
        if (disposed || isAbortError(error)) return false
        logger?.warn?.(`[rtk] could not install RTK: ${describe(error)}`)
      }
    } else if (options.pin !== undefined && !options.autoInstall && current?.source === 'managed'
      && current.versionText !== options.pin.text) {
      logger?.warn?.(`[rtk] autoInstall is disabled; keeping RTK ${current.versionText} instead of ${options.pin.text}`)
    }

    if (disposed) return false
    if (current?.source === 'managed' && options.autoUpdate && options.pin === undefined) {
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
      edition: options.edition,
      target,
      platform,
      arch,
      pin: options.pin?.tag,
    },
    current: () => currentEntry(current, fallback),
    start,
    checkNow,
    dispose,
  }
}
