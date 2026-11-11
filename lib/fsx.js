/**
 * Filesystem primitives for the managed RTK cache.
 *
 * The cache is a best-effort structure: a missing or corrupt file means
 * "nothing is installed", never a failed activation. Writes are atomic
 * (sibling temp file plus rename) so a process that dies mid-write cannot
 * leave a half-written state or latest-tag file behind.
 *
 * Dependency-free, like the rest of `lib/`: a linked-checkout bundle cannot
 * resolve DSH's shipped packages.
 */

import { statSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Mode for plugin-owned cache directories. */
export const MODE_DIR = 0o700

/** Mode for atomically written JSON files. */
export const MODE_JSON = 0o600

let tempCounter = 0

/** Unique sibling temp path for one atomic write. */
export function tempPath(path) {
  tempCounter += 1
  return `${path}.${process.pid}.${tempCounter}.tmp`
}

/** Create a plugin-owned directory, including missing parents. */
export async function ensureDir(path) {
  await mkdir(path, { recursive: true, mode: MODE_DIR })
}

/**
 * Read and parse a JSON file, treating a missing, unreadable, or corrupt file
 * as absent. A cache read must never fail an activation.
 *
 * @param {string} path
 * @returns {Promise<unknown>} parsed value, or undefined.
 */
export async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write JSON atomically: serialize into a sibling temp file, then rename over
 * the destination. A concurrent reader observes either the old file or the
 * new one, never a partial write.
 *
 * @param {string} path
 * @param {unknown} value
 */
export async function writeJson(path, value) {
  await ensureDir(dirname(path))
  const temp = tempPath(path)
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: MODE_JSON })
    await rename(temp, path)
  } catch (error) {
    await removeQuietly(temp)
    throw error
  }
}

/**
 * Remove a file or directory without surfacing cleanup failures.
 *
 * @param {string} path
 */
export async function removeQuietly(path) {
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    // Cleanup is best effort; a stale entry is collected by the next GC pass.
  }
}

/**
 * Resolve `candidate` against `root` when it stays inside `root`.
 *
 * @param {string} root
 * @param {string} candidate
 * @returns {string | undefined} absolute path, or undefined when it escapes.
 */
export function resolveInside(root, candidate) {
  const base = resolve(root)
  const target = resolve(base, candidate)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return target
}

/**
 * Whether a path is a regular executable file.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isExecutableFileSync(path) {
  try {
    const info = statSync(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

/**
 * Asynchronous variant of {@link isExecutableFileSync} for callers already
 * awaiting filesystem work.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function isExecutableFile(path) {
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}
