/**
 * On-disk layout of the managed RTK cache.
 *
 * One edition/target slice owns a state file, an install lock, a version
 * directory per installed release, and the cached latest-tag lookup. This
 * module owns that schema: validation, atomic state writes, version listing,
 * garbage collection, and the cross-process lock all live here, so the
 * manager only decides when to call them.
 *
 * Dependency-free, like the rest of `lib/`.
 */

import { open, readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { ensureDir, isExecutableFile, readJson, removeQuietly, resolveInside, writeJson } from './fsx.js'
import { compareVersions, formatVersion, isSupportedVersion, normalizeTag, parseRtkVersion } from './version.js'

/** State-file schema version understood by this module. */
export const STATE_SCHEMA = 1

/** How long an untouched lock file may exist before it is considered abandoned. */
export const LOCK_STALE_MS = 10 * 60_000

/** How long a caller waits for another process's install lock before giving up. */
export const LOCK_WAIT_MS = 30_000

/** How old a temp file must be before garbage collection removes it. */
const TEMP_STALE_MS = 24 * 60 * 60_000

/** Delay between two lock attempts while another process is installing. */
const LOCK_POLL_MS = 200

/**
 * Paths of one edition/target cache slice below the plugin cache root.
 *
 * @param {string} root
 * @param {string} edition
 * @param {string} target
 */
export function layoutFor(root, edition, target) {
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

/**
 * Manager view of one resolved binary.
 *
 * This is the single constructor for the entry shape shared by the store and
 * the manager, so every source reports the same fields. `prefixDir` exists
 * only for an absolute binary; `versionText` is derived from the parsed
 * version and stays undefined when the version is unknown. A tag is included
 * only when the source has one, keeping explicit and PATH entries unchanged.
 *
 * @param {object} entry
 * @param {string} entry.binary
 * @param {'managed' | 'explicit' | 'path'} entry.source
 * @param {object | null | undefined} entry.version
 * @param {string} [entry.tag]
 */
export function makeEntry({ binary, source, version, tag }) {
  return {
    binary,
    prefixDir: isAbsolute(binary) ? dirname(binary) : undefined,
    source,
    version,
    versionText: formatVersion(version),
    ...(tag === undefined ? {} : { tag }),
  }
}

/**
 * Manager view of one installed release.
 *
 * @param {object} state - validated state record.
 */
export function entryFromState(state) {
  return makeEntry({
    binary: state.binary,
    source: 'managed',
    version: state.version,
    tag: state.tag,
  })
}

/**
 * Read and validate the state file for a layout.
 *
 * A state record is usable only when it was written for the same edition and
 * target, names a supported version, points at an executable file inside the
 * cache root, and carries the current schema. Anything else means "nothing is
 * installed" and the caller falls back to probing version directories.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @returns {Promise<(Record<string, unknown> & { binary: string, version: object }) | undefined>}
 */
export async function readState(layout) {
  const raw = await readJson(layout.statePath)
  if (raw === null || typeof raw !== 'object') return undefined
  if (raw.schema !== STATE_SCHEMA || raw.edition !== layout.edition || raw.target !== layout.target) return undefined
  const version = parseRtkVersion(raw.version)
  if (version === null || !isSupportedVersion(version)) return undefined
  if (typeof raw.binary !== 'string' || raw.binary === '') return undefined
  const binary = resolveInside(layout.root, raw.binary)
  if (binary === undefined) return undefined
  if (!(await isExecutableFile(binary))) return undefined
  return { ...raw, binary, version }
}

/**
 * Persist the state record atomically.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @param {object} state
 */
export async function writeState(layout, state) {
  await writeJson(layout.statePath, state)
}

/**
 * Installed versions that still have an executable binary, newest first.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @returns {Promise<Array<{ version: object, versionText: string, binary: string, dir: string }>>}
 */
export async function listVersions(layout) {
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
    if (!(await isExecutableFile(binary))) continue
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

/**
 * Keep the current version and the newest other one; remove the rest.
 *
 * Also drops staging directories under `tmp` that are older than a day, so a
 * crashed install cannot accumulate forever. Cleanup failures are ignored:
 * they are never a reason to fail an otherwise valid install.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @param {string} keepVersionText - version that was just installed or adopted.
 * @param {() => number} [now]
 */
export async function collectGarbage(layout, keepVersionText, now = Date.now) {
  const versions = await listVersions(layout)
  const keep = new Set([keepVersionText])
  for (const candidate of versions) {
    if (keep.size >= 2) break
    if (!keep.has(candidate.versionText)) keep.add(candidate.versionText)
  }
  for (const candidate of versions) {
    if (keep.has(candidate.versionText)) continue
    await removeQuietly(candidate.dir)
  }

  let entries
  try {
    entries = await readdir(layout.tmpDir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(layout.tmpDir, entry)
    try {
      const info = await stat(path)
      if (now() - info.mtimeMs > TEMP_STALE_MS) await removeQuietly(path)
    } catch {
      // Ignore entries that disappear while being inspected.
    }
  }
}

/**
 * Cached latest-release lookup for a layout.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @returns {Promise<{ tag?: string, checkedAt?: number }>} the record that
 *   survived parsing; fields are undefined when the file is missing or holds
 *   no usable value.
 */
export async function readLatest(layout) {
  const cached = await readJson(layout.latestPath)
  if (cached === null || typeof cached !== 'object') return {}
  return {
    tag: typeof cached.tag === 'string' ? normalizeTag(cached.tag)?.tag : undefined,
    checkedAt: Number.isFinite(cached.checkedAt) ? cached.checkedAt : undefined,
  }
}

/**
 * Record a successful latest-tag lookup.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @param {string} tag
 * @param {number} checkedAt
 */
export async function writeLatest(layout, tag, checkedAt) {
  await writeJson(layout.latestPath, { tag, checkedAt })
}

/**
 * Record the owning process in a lock file.
 *
 * A failure here does not weaken mutual exclusion: the exclusively created
 * lock file already serializes installers. Exported so the best-effort
 * branch can be exercised with a faulty handle.
 *
 * @param {{ writeFile: (text: string) => Promise<unknown> }} handle
 * @param {number} [pid]
 */
export async function writeLockOwner(handle, pid = process.pid) {
  try {
    await handle.writeFile(`${pid}\n`)
  } catch {
    // The lock still serializes even when its owner record cannot be written.
  }
}

/**
 * Close a lock handle, tolerating an already-closed handle.
 *
 * @param {{ close: () => Promise<unknown> }} handle
 */
export async function closeQuietly(handle) {
  try {
    await handle.close()
  } catch {
    // Already closed.
  }
}

/**
 * Acquire the per edition/target install lock.
 *
 * The lock is an exclusively created file; a lock older than `staleMs` is
 * broken because the owning process may have died. Waiting is bounded so a
 * stuck peer cannot block activation forever.
 *
 * @param {ReturnType<typeof layoutFor>} layout
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.staleMs]
 * @returns {Promise<(() => Promise<void>) | undefined>} release callback, or
 *   undefined when the lock stayed held past the deadline.
 */
export async function acquireLock(layout, {
  now = Date.now,
  sleep = (delay) => new Promise((resolveSleep) => setTimeout(resolveSleep, delay)),
  timeoutMs = LOCK_WAIT_MS,
  staleMs = LOCK_STALE_MS,
} = {}) {
  await ensureDir(dirname(layout.lockPath))
  const deadline = now() + timeoutMs
  while (true) {
    let handle
    try {
      handle = await open(layout.lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      let stale = false
      try {
        stale = now() - (await stat(layout.lockPath)).mtimeMs > staleMs
      } catch {
        stale = false
      }
      if (stale) {
        await removeQuietly(layout.lockPath)
        continue
      }
      if (now() >= deadline) return undefined
      await sleep(LOCK_POLL_MS)
      continue
    }
    await writeLockOwner(handle)
    return async () => {
      await closeQuietly(handle)
      await removeQuietly(layout.lockPath)
    }
  }
}
