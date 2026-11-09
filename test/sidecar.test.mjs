import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRtkManager, resolveCacheRoot } from '../lib/sidecar.js'
import { probeRtk, rewriteCommand } from '../lib/rewrite.js'
import { rtkScript, tarGz } from './helpers.mjs'

const TARGET = 'x86_64-unknown-linux-musl'
const STATE = join('state', `rtk__${TARGET}.json`)
const VERSIONS = join('versions', 'rtk', TARGET)

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'rtk-sidecar-'))
}

function makeRelease({
  version = '1.2.0',
  target = TARGET,
  script,
  checksum,
  entries,
  missingAsset = false,
  latestTag,
} = {}) {
  const files = entries ?? [
    { name: 'rtk', data: script ?? rtkScript(version), mode: 0o755 },
    { name: 'LICENSE', data: 'Apache-2.0' },
    { name: 'LICENSE-ENGINE', data: 'BUSL-1.1' },
  ]
  const archive = tarGz(files)
  const digest = createHash('sha256').update(archive).digest('hex')
  const asset = `rtk-${target}.tar.gz`
  const checksums = missingAsset
    ? `${digest}  rtk-aarch64-apple-darwin.tar.gz\n`
    : `${checksum ?? digest}  ${asset}\n`
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    if (url.endsWith('/releases/latest')) {
      return {
        ok: true,
        url: `https://github.com/rtk-ai/rtk/releases/tag/${latestTag ?? `v${version}`}`,
        body: { cancel() {} },
      }
    }
    if (url.endsWith('/checksums.txt')) {
      return { ok: true, arrayBuffer: async () => Buffer.from(checksums) }
    }
    if (url.endsWith(`/${asset}`)) {
      return { ok: true, arrayBuffer: async () => archive }
    }
    throw new Error(`unexpected URL ${url}`)
  }
  return { archive, digest, asset, checksums, calls, fetchImpl }
}

function makeProbe({ pathOk = false, pathVersion = 'rtk 0.49.0' } = {}) {
  return async ({ binary, timeoutMs, signal }) => {
    if (binary === 'rtk') {
      return pathOk
        ? { ok: true, version: { major: 0, minor: 49, patch: 0, raw: pathVersion } }
        : { ok: false, reason: 'not found on the test PATH' }
    }
    return probeRtk({ binary, timeoutMs, signal })
  }
}

async function smokeRewrite({ binary, signal }) {
  const outcome = await rewriteCommand({ binary, command: 'git status', timeoutMs: 5000, signal })
  return outcome.kind === 'rewrite'
    ? { ok: true }
    : { ok: false, reason: `expected a rewrite, got ${outcome.kind}` }
}

async function managerFor({ root, release, settings = {}, probe = makeProbe(), deps = {} } = {}) {
  const logs = { info: [], warn: [] }
  const manager = await createRtkManager({
    ctx: { get: () => undefined },
    settings: {
      rewriteTimeoutMs: 2000,
      downloadTimeoutMs: 5000,
      updateIntervalMs: 60_000,
      ...settings,
    },
    deps: {
      root,
      platform: 'linux',
      arch: 'x64',
      env: {},
      home: () => '/home/test',
      fetchImpl: release?.fetchImpl,
      probeRtk: probe,
      smokeRewrite,
      logger: {
        info: (message) => logs.info.push(message),
        warn: (message) => logs.warn.push(message),
      },
      ...deps,
    },
  })
  return { manager, logs }
}

test('resolves the cache root from the profile, DSH_HOME, or the default home', () => {
  assert.equal(
    resolveCacheRoot({ get: () => ({ home: '/profiles/web-home' }) }, { env: {}, home: () => '/home/u' }),
    join('/profiles/web-home', 'cache', 'rtk-filter'),
  )
  assert.equal(
    resolveCacheRoot(undefined, { env: { DSH_HOME: '/custom/home' }, home: () => '/home/u' }),
    join('/custom/home', 'cache', 'rtk-filter'),
  )
  assert.equal(
    resolveCacheRoot(undefined, { env: { DSH_HOME: '   ' }, home: () => '/home/u' }),
    join('/home/u', '.dsh', 'cache', 'rtk-filter'),
  )
  assert.equal(
    resolveCacheRoot({ get: () => ({ home: '   ' }) }, { env: { DSH_HOME: '/custom/home' }, home: () => '/home/u' }),
    join('/custom/home', 'cache', 'rtk-filter'),
  )
})

test('installs the latest release into the plugin cache', async () => {
  const root = tempRoot()
  const release = makeRelease()
  try {
    const { manager, logs } = await managerFor({ root, release, settings: { autoUpdate: false } })
    assert.equal(manager.canWrap, true)
    assert.equal(manager.initial, undefined)

    const task = manager.start()
    assert.equal(await task.ready, true)

    const current = manager.current()
    assert.equal(current.source, 'managed')
    assert.equal(current.versionText, '1.2.0')
    assert.equal(current.prefixDir, join(root, VERSIONS, '1.2.0'))
    assert.equal(existsSync(current.binary), true)
    assert.equal((await probeRtk({ binary: current.binary })).ok, true)

    const state = JSON.parse(readFileSync(join(root, STATE), 'utf8'))
    assert.equal(state.tag, 'v1.2.0')
    assert.equal(state.version, '1.2.0')
    assert.equal(state.sha256, release.digest)
    assert.equal(state.binary, join(VERSIONS, '1.2.0', 'rtk'))
    assert.equal(existsSync(join(root, VERSIONS, '1.2.0', 'LICENSE')), true)
    assert.equal(existsSync(join(root, VERSIONS, '1.2.0', 'LICENSE-ENGINE')), true)

    assert.match(logs.info.join('\n'), /installing RTK v1\.2\.0/)
    assert.match(logs.info.join('\n'), /installed at/)
    assert.equal(logs.warn.length, 0)

    const fetches = release.calls.length
    await manager.checkNow()
    assert.equal(release.calls.length, fetches)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uses PATH when autoInstall is disabled and no managed copy exists', async () => {
  const root = tempRoot()
  const release = makeRelease()
  try {
    const { manager } = await managerFor({
      root,
      release,
      probe: makeProbe({ pathOk: true }),
      settings: { autoInstall: false, autoUpdate: false },
    })
    assert.equal(manager.initial.source, 'path')
    assert.equal(manager.canWrap, true)
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().binary, 'rtk')
    assert.equal(release.calls.length, 0)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installs a managed copy even when PATH is the interim fallback', async () => {
  const root = tempRoot()
  const release = makeRelease()
  try {
    const { manager, logs } = await managerFor({
      root,
      release,
      probe: makeProbe({ pathOk: true }),
      settings: { autoUpdate: false },
    })
    assert.equal(manager.initial.source, 'path')
    assert.equal(manager.canWrap, true)
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().source, 'managed')
    assert.match(logs.info.join('\n'), /installed at/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prefers a managed copy over PATH and does not refetch it', async () => {
  const root = tempRoot()
  const release = makeRelease()
  try {
    const first = await managerFor({ root, release, settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()

    let fetched = 0
    const secondRelease = {
      calls: [],
      fetchImpl: async () => {
        fetched += 1
        throw new Error('the managed copy should not be downloaded again')
      },
    }
    const { manager } = await managerFor({
      root,
      release: secondRelease,
      probe: makeProbe({ pathOk: true }),
      settings: { autoUpdate: false },
    })
    assert.equal(manager.initial.source, 'managed')
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().source, 'managed')
    assert.equal(fetched, 0)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('updates a managed copy and garbage-collects older versions', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()

    rmSync(join(root, 'latest.json'), { force: true })
    const second = await managerFor({
      root,
      release: makeRelease({ version: '1.3.0' }),
      settings: { autoUpdate: true },
    })
    assert.equal(second.manager.initial.versionText, '1.2.0')
    await second.manager.checkNow()
    assert.equal(second.manager.current().versionText, '1.3.0')
    assert.deepEqual(readdirSync(join(root, VERSIONS)).sort(), ['1.2.0', '1.3.0'])
    second.manager.dispose()

    rmSync(join(root, 'latest.json'), { force: true })
    const third = await managerFor({
      root,
      release: makeRelease({ version: '1.4.0' }),
      settings: { autoUpdate: true },
    })
    await third.manager.checkNow()
    assert.equal(third.manager.current().versionText, '1.4.0')
    assert.deepEqual(readdirSync(join(root, VERSIONS)).sort(), ['1.3.0', '1.4.0'])
    third.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed update keeps the installed version', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()

    rmSync(join(root, 'latest.json'), { force: true })
    const failing = {
      calls: [],
      fetchImpl: async () => {
        throw new Error('network down')
      },
    }
    const { manager, logs } = await managerFor({
      root,
      release: failing,
      settings: { autoUpdate: true },
    })
    await manager.checkNow()
    assert.equal(manager.current().versionText, '1.2.0')
    assert.match(logs.warn.join('\n'), /update failed/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a pinned version is installed without a latest lookup', async () => {
  const root = tempRoot()
  const release = makeRelease({ version: '1.2.0' })
  try {
    const { manager } = await managerFor({
      root,
      release,
      settings: { version: '1.2.0', autoUpdate: true },
    })
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().versionText, '1.2.0')
    assert.equal(release.calls.some((url) => url.endsWith('/releases/latest')), false)
    assert.equal(release.calls.some((url) => url.includes('/download/v1.2.0/')), true)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit binary is used without a download', async () => {
  const root = tempRoot()
  const bin = join(tempRoot(), 'rtk')
  writeFileSync(bin, rtkScript('0.49.0'), { mode: 0o755 })
  try {
    const { manager } = await managerFor({ root, settings: { binary: bin } })
    assert.equal(manager.initial.source, 'explicit')
    assert.equal(manager.initial.binary, bin)
    assert.equal(manager.initial.prefixDir, join(bin, '..'))
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().binary, bin)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(bin, '..'), { recursive: true, force: true })
  }
})

test('autoInstall: false leaves the plugin inert without a binary', async () => {
  const root = tempRoot()
  const release = makeRelease()
  try {
    const { manager, logs } = await managerFor({
      root,
      release,
      settings: { autoInstall: false, autoUpdate: false },
    })
    assert.equal(manager.canWrap, false)
    assert.match(manager.reason, /autoInstall is disabled/)
    assert.equal(await manager.start().ready, false)
    assert.equal(release.calls.length, 0)
    assert.equal(manager.current(), undefined)
    manager.dispose()
    assert.equal(logs.warn.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a checksum mismatch leaves no installed state', async () => {
  const root = tempRoot()
  const release = makeRelease({ checksum: 'a'.repeat(64) })
  try {
    const { manager, logs } = await managerFor({ root, release })
    assert.equal(await manager.start().ready, false)
    assert.equal(manager.current(), undefined)
    assert.equal(existsSync(join(root, STATE)), false)
    assert.match(logs.warn.join('\n'), /CHECKSUM/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an archive without rtk is rejected', async () => {
  const root = tempRoot()
  const release = makeRelease({ entries: [{ name: 'LICENSE', data: 'Apache-2.0' }] })
  try {
    const { manager, logs } = await managerFor({ root, release })
    assert.equal(await manager.start().ready, false)
    assert.equal(manager.current(), undefined)
    assert.match(logs.warn.join('\n'), /ARCHIVE/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a binary whose version does not match the tag is rejected', async () => {
  const root = tempRoot()
  const release = makeRelease({ version: '1.2.0', script: rtkScript('9.9.9') })
  try {
    const { manager, logs } = await managerFor({ root, release })
    assert.equal(await manager.start().ready, false)
    assert.equal(manager.current(), undefined)
    assert.match(logs.warn.join('\n'), /VERIFY/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a held lock makes the install fail without corrupting state', async () => {
  const root = tempRoot()
  mkdirSync(join(root, 'locks'), { recursive: true })
  writeFileSync(join(root, 'locks', `rtk__${TARGET}.lock`), 'other process\n')
  const release = makeRelease()
  try {
    const { manager, logs } = await managerFor({
      root,
      release,
      deps: { lockTimeoutMs: 0, sleep: async () => {} },
    })
    assert.equal(await manager.start().ready, false)
    assert.equal(manager.current(), undefined)
    assert.match(logs.warn.join('\n'), /LOCK/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('disposing during an install aborts the request and writes no state', async () => {
  const root = tempRoot()
  let notifyStarted
  const started = new Promise((resolve) => {
    notifyStarted = resolve
  })
  const fetchImpl = (url, options = {}) => new Promise((resolve, reject) => {
    notifyStarted()
    options.signal?.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    })
  })
  try {
    const { manager } = await managerFor({
      root,
      release: { calls: [], fetchImpl },
      settings: { autoUpdate: false },
    })
    const task = manager.start()
    await started
    manager.dispose()
    assert.equal(await task.ready, false)
    assert.equal(existsSync(join(root, STATE)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unsupported platform does not attempt a download', async () => {
  const root = tempRoot()
  const release = makeRelease()
  try {
    const { manager } = await managerFor({
      root,
      release,
      deps: { platform: 'win32', arch: 'x64' },
    })
    assert.equal(manager.canWrap, false)
    assert.match(manager.reason, /not supported/)
    assert.equal(await manager.start().ready, false)
    assert.equal(release.calls.length, 0)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
