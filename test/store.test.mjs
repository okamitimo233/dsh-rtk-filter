import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  MODE_DIR,
  MODE_JSON,
  ensureDir,
  isExecutableFile,
  isExecutableFileSync,
  readJson,
  removeQuietly,
  resolveInside,
  tempPath,
  writeJson,
} from '../lib/fsx.js'
import {
  LOCK_STALE_MS,
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
} from '../lib/store.js'

const TARGET = 'x86_64-unknown-linux-musl'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'rtk-store-'))
}

function makeLayout(root) {
  return layoutFor(root, 'rtk', TARGET)
}

function writeBinary(path, mode = 0o755) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, mode)
}

function stateRecord(layout, overrides = {}) {
  return {
    schema: STATE_SCHEMA,
    edition: layout.edition,
    target: layout.target,
    tag: 'v1.2.0',
    version: '1.2.0',
    asset: 'rtk-' + TARGET + '.tar.gz',
    sha256: 'a'.repeat(64),
    binary: join('versions', 'rtk', TARGET, '1.2.0', 'rtk'),
    installedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('layoutFor keeps one cache slice per edition and target', () => {
  const layout = layoutFor('/cache/rtk-filter', 'rtk-oss', TARGET)
  assert.equal(layout.root, '/cache/rtk-filter')
  assert.equal(layout.latestPath, join('/cache/rtk-filter', 'latest.json'))
  assert.equal(layout.statePath, join('/cache/rtk-filter', 'state', 'rtk-oss__' + TARGET + '.json'))
  assert.equal(layout.lockPath, join('/cache/rtk-filter', 'locks', 'rtk-oss__' + TARGET + '.lock'))
  assert.equal(layout.versionsDir, join('/cache/rtk-filter', 'versions', 'rtk-oss', TARGET))
  assert.equal(layout.tmpDir, join('/cache/rtk-filter', 'tmp'))
})

test('writeJson replaces files atomically and leaves no temp file', async () => {
  const root = tempRoot()
  try {
    const path = join(root, 'state', 'rtk.json')
    await writeJson(path, { schema: 1, value: 1 })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { schema: 1, value: 1 })
    assert.deepEqual(readdirSync(dirname(path)), ['rtk.json'])
    assert.equal(statSync(path).mode & 0o777, MODE_JSON)

    await writeJson(path, { schema: 1, value: 2 })
    assert.deepEqual(await readJson(path), { schema: 1, value: 2 })
    assert.deepEqual(readdirSync(dirname(path)), ['rtk.json'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readJson treats a missing or corrupt file as absent', async () => {
  const root = tempRoot()
  try {
    assert.equal(await readJson(join(root, 'missing.json')), undefined)
    const broken = join(root, 'broken.json')
    writeFileSync(broken, '{not json')
    assert.equal(await readJson(broken), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('tempPath returns unique sibling paths', () => {
  const first = tempPath('/cache/state/rtk.json')
  const second = tempPath('/cache/state/rtk.json')
  assert.notEqual(first, second)
  assert.equal(first.startsWith('/cache/state/rtk.json.'), true)
  assert.equal(first.endsWith('.tmp'), true)
})

test('resolveInside accepts only paths below the root', () => {
  assert.equal(resolveInside('/cache', 'state/rtk.json'), '/cache/state/rtk.json')
  assert.equal(resolveInside('/cache', '/cache/versions/1.2.0/rtk'), '/cache/versions/1.2.0/rtk')
  assert.equal(resolveInside('/cache', '../rtk.json'), undefined)
  assert.equal(resolveInside('/cache', '/cache'), undefined)
  assert.equal(resolveInside('/cache', '/etc/passwd'), undefined)
})

test('isExecutableFile reports regular executable files only', async () => {
  const root = tempRoot()
  try {
    const executable = join(root, 'rtk')
    writeBinary(executable)
    const text = join(root, 'LICENSE')
    writeFileSync(text, 'Apache-2.0', { mode: 0o644 })
    assert.equal(await isExecutableFile(executable), true)
    assert.equal(await isExecutableFile(text), false)
    assert.equal(await isExecutableFile(join(root, 'missing')), false)
    assert.equal(isExecutableFileSync(executable), true)
    assert.equal(isExecutableFileSync(text), false)
    assert.equal(isExecutableFileSync(join(root, 'missing')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureDir creates a plugin-private directory tree', async () => {
  const root = tempRoot()
  try {
    const target = join(root, 'a', 'b')
    await ensureDir(target)
    assert.equal(statSync(target).isDirectory(), true)
    assert.equal(statSync(target).mode & 0o777, MODE_DIR)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('removeQuietly removes files and directories but tolerates absence', async () => {
  const root = tempRoot()
  try {
    const file = join(root, 'file')
    writeFileSync(file, 'x')
    await removeQuietly(file)
    assert.equal(existsSync(file), false)

    const dir = join(root, 'dir', 'nested')
    writeBinary(join(dir, 'rtk'))
    await removeQuietly(join(root, 'dir'))
    assert.equal(existsSync(join(root, 'dir')), false)

    await removeQuietly(join(root, 'never-existed'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readState accepts a valid record and resolves its binary inside the root', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    writeBinary(join(layout.versionsDir, '1.2.0', 'rtk'))
    await writeState(layout, stateRecord(layout))

    const state = await readState(layout)
    assert.notEqual(state, undefined)
    assert.equal(state.tag, 'v1.2.0')
    assert.deepEqual(state.version, { major: 1, minor: 2, patch: 0, raw: '1.2.0' })
    assert.equal(state.binary, join(layout.versionsDir, '1.2.0', 'rtk'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readState rejects records that do not describe a runnable managed binary', async () => {
  const root = tempRoot()
  const layout = makeLayout(root)
  const binary = join(layout.versionsDir, '1.2.0', 'rtk')
  const cases = {
    'missing state': undefined,
    'foreign schema': stateRecord(layout, { schema: 2 }),
    'foreign edition': stateRecord(layout, { edition: 'rtk-oss' }),
    'foreign target': stateRecord(layout, { target: 'aarch64-apple-darwin' }),
    'unsupported version': stateRecord(layout, { version: '0.22.0' }),
    'unparseable version': stateRecord(layout, { version: 'latest' }),
    'empty binary': stateRecord(layout, { binary: '' }),
    'escaping binary': stateRecord(layout, { binary: '../outside/rtk' }),
  }
  try {
    for (const [label, record] of Object.entries(cases)) {
      rmSync(layout.statePath, { force: true })
      writeBinary(binary)
      if (record !== undefined) {
        mkdirSync(dirname(layout.statePath), { recursive: true })
        writeFileSync(layout.statePath, JSON.stringify(record))
      }
      assert.equal(await readState(layout), undefined, label)
    }

    // A binary that is missing is not usable.
    rmSync(layout.statePath, { force: true })
    rmSync(binary, { force: true })
    writeFileSync(layout.statePath, JSON.stringify(stateRecord(layout)))
    assert.equal(await readState(layout), undefined)

    // A binary that exists but is not executable is not usable either.
    rmSync(layout.statePath, { force: true })
    writeBinary(binary, 0o644)
    writeFileSync(layout.statePath, JSON.stringify(stateRecord(layout)))
    assert.equal(await readState(layout), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('entryFromState renders the manager view of a state record', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    writeBinary(join(layout.versionsDir, '1.2.0', 'rtk'))
    await writeState(layout, stateRecord(layout))
    const state = await readState(layout)
    const entry = entryFromState(state)
    assert.equal(entry.binary, state.binary)
    assert.equal(entry.prefixDir, dirname(state.binary))
    assert.equal(entry.source, 'managed')
    assert.equal(entry.versionText, '1.2.0')
    assert.equal(entry.tag, 'v1.2.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('makeEntry is the shared manager view and includes a tag only when provided', () => {
  const managed = makeEntry({
    binary: '/cache/versions/rtk/1.2.0/rtk',
    source: 'managed',
    version: { major: 1, minor: 2, patch: 0, raw: '1.2.0' },
    tag: 'v1.2.0',
  })
  assert.deepEqual(managed, {
    binary: '/cache/versions/rtk/1.2.0/rtk',
    prefixDir: '/cache/versions/rtk/1.2.0',
    source: 'managed',
    version: { major: 1, minor: 2, patch: 0, raw: '1.2.0' },
    versionText: '1.2.0',
    tag: 'v1.2.0',
  })

  const explicit = makeEntry({
    binary: '/opt/rtk',
    source: 'explicit',
    version: { major: 0, minor: 49, patch: 0, raw: '0.49.0' },
  })
  assert.equal(explicit.prefixDir, '/opt')
  assert.equal(explicit.versionText, '0.49.0')
  assert.equal('tag' in explicit, false)

  const pathEntry = makeEntry({ binary: 'rtk', source: 'path', version: null })
  assert.equal(pathEntry.prefixDir, undefined)
  assert.equal(pathEntry.versionText, undefined)
  assert.equal('tag' in pathEntry, false)
})

test('listVersions returns supported versions with a runnable binary, newest first', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    assert.deepEqual(await listVersions(layout), [])

    writeBinary(join(layout.versionsDir, '1.2.0', 'rtk'))
    writeBinary(join(layout.versionsDir, '1.3.0', 'rtk'))
    writeBinary(join(layout.versionsDir, '0.22.0', 'rtk'))
    writeBinary(join(layout.versionsDir, '1.4.0', 'rtk'), 0o644)
    mkdirSync(join(layout.versionsDir, '2.0.0'), { recursive: true })
    writeFileSync(join(layout.versionsDir, 'stray-file'), 'x')

    const versions = await listVersions(layout)
    assert.deepEqual(versions.map((version) => version.versionText), ['1.3.0', '1.2.0'])
    assert.equal(versions[0].binary, join(layout.versionsDir, '1.3.0', 'rtk'))
    assert.deepEqual(versions[1].version, { major: 1, minor: 2, patch: 0, raw: '1.2.0' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectGarbage keeps the current version, one predecessor, and fresh temp entries', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    for (const version of ['1.2.0', '1.3.0', '1.4.0', '1.5.0']) {
      writeBinary(join(layout.versionsDir, version, 'rtk'))
    }

    const stale = join(layout.tmpDir, 'install-stale')
    mkdirSync(stale, { recursive: true })
    utimesSync(stale, new Date(0), new Date(0))
    const fresh = join(layout.tmpDir, 'install-fresh')
    mkdirSync(fresh, { recursive: true })

    await collectGarbage(layout, '1.5.0', () => Date.now())

    assert.deepEqual(readdirSync(layout.versionsDir).sort(), ['1.4.0', '1.5.0'])
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(fresh), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectGarbage keeps the newest other version when the current one is absent from disk', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    for (const version of ['1.2.0', '1.3.0', '1.4.0']) {
      writeBinary(join(layout.versionsDir, version, 'rtk'))
    }
    await collectGarbage(layout, '1.9.0', () => Date.now())
    assert.deepEqual(readdirSync(layout.versionsDir).sort(), ['1.4.0'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readLatest validates the cached latest-tag record', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    assert.deepEqual(await readLatest(layout), {})

    await writeLatest(layout, 'v1.2.0', 1_000)
    assert.deepEqual(await readLatest(layout), { tag: 'v1.2.0', checkedAt: 1_000 })

    await writeLatest(layout, 'not-a-tag', 2_000)
    assert.deepEqual(await readLatest(layout), { tag: undefined, checkedAt: 2_000 })

    writeFileSync(layout.latestPath, '{broken')
    assert.deepEqual(await readLatest(layout), {})
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('acquireLock excludes a second caller and releases cleanly', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    const release = await acquireLock(layout, { now: () => 0 })
    assert.notEqual(release, undefined)
    assert.equal(existsSync(layout.lockPath), true)
    assert.equal(readFileSync(layout.lockPath, 'utf8'), String(process.pid) + '\n')

    const second = await acquireLock(layout, { now: () => 0, timeoutMs: 0 })
    assert.equal(second, undefined)

    await release()
    assert.equal(existsSync(layout.lockPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('acquireLock breaks an abandoned lock', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    mkdirSync(dirname(layout.lockPath), { recursive: true })
    writeFileSync(layout.lockPath, 'dead process\n')
    const stale = new Date(Date.now() - LOCK_STALE_MS - 60_000)
    utimesSync(layout.lockPath, stale, stale)

    const release = await acquireLock(layout)
    assert.notEqual(release, undefined)
    assert.equal(readFileSync(layout.lockPath, 'utf8'), String(process.pid) + '\n')
    await release()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('acquireLock retries a held lock until the deadline', async () => {
  const root = tempRoot()
  try {
    const layout = makeLayout(root)
    mkdirSync(dirname(layout.lockPath), { recursive: true })
    writeFileSync(layout.lockPath, 'other process\n')

    let clock = 0
    const sleeps = []
    const release = await acquireLock(layout, {
      now: () => clock,
      sleep: async (delay) => {
        sleeps.push(delay)
        clock += delay
      },
      timeoutMs: 1_000,
    })
    assert.equal(release, undefined)
    assert.deepEqual(sleeps, [200, 200, 200, 200, 200])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
