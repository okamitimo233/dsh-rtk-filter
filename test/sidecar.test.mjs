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
import { dirname, join } from 'node:path'

import { createInstaller, createRtkManager, resolveCacheRoot } from '../lib/sidecar.js'
import { probeRtk, rewriteCommand } from '../lib/rewrite.js'
import { STATE_SCHEMA, layoutFor } from '../lib/store.js'
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
    assert.equal(current.tag, 'v1.2.0')
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
    assert.equal(manager.initial.versionText, '0.49.0')
    assert.equal(manager.canWrap, true)
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().binary, 'rtk')
    assert.equal(manager.current().versionText, '0.49.0')
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
    assert.equal(manager.initial.versionText, '1.2.0')
    assert.equal(manager.initial.tag, 'v1.2.0')
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().source, 'managed')
    assert.equal(fetched, 0)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('re-adopts an intact version directory after its state file disappears', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()

    rmSync(join(root, STATE), { force: true })
    const { manager } = await managerFor({
      root,
      release: {
        calls: [],
        fetchImpl: async () => {
          throw new Error('the adopted copy should not be downloaded again')
        },
      },
      settings: { autoUpdate: false },
    })
    assert.equal(manager.initial.source, 'managed')
    assert.equal(manager.initial.versionText, '1.2.0')
    assert.equal(manager.initial.tag, 'v1.2.0')
    assert.equal(await manager.start().ready, true)
    assert.equal(existsSync(join(root, STATE)), true)
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
    assert.equal(manager.initial.versionText, '0.49.0')
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

function seedState(layout, { tag = 'v1.2.0', version = '1.2.0' } = {}) {
  const binary = join(layout.versionsDir, version, 'rtk')
  mkdirSync(dirname(binary), { recursive: true })
  writeFileSync(binary, rtkScript(version), { mode: 0o755 })
  mkdirSync(dirname(layout.statePath), { recursive: true })
  writeFileSync(layout.statePath, JSON.stringify({
    schema: STATE_SCHEMA,
    edition: 'rtk',
    target: TARGET,
    tag,
    version,
    asset: '',
    sha256: '',
    binary: join('versions', 'rtk', TARGET, version, 'rtk'),
    installedAt: new Date(0).toISOString(),
  }))
  return binary
}

function makeInstaller(layout, overrides = {}) {
  return createInstaller({
    layout,
    edition: 'rtk',
    target: TARGET,
    fetchImpl: async () => { throw new Error('no network expected') },
    downloadTimeoutMs: 1_000,
    updateIntervalMs: 60_000,
    smokeRewrite: async () => ({ ok: true }),
    probe: async () => ({ ok: true, version: { major: 1, minor: 2, patch: 0 } }),
    signal: new AbortController().signal,
    logger: {},
    now: () => Date.now(),
    sleep: async () => {},
    lockTimeoutMs: 0,
    lockStaleMs: 60_000,
    ...overrides,
  })
}

test('resolves the cache root with a throwing profile lookup and a string home', () => {
  assert.equal(
    resolveCacheRoot({
      get() {
        throw new Error('profile unavailable')
      },
    }, { env: {}, home: '/home/u' }),
    join('/home/u', '.dsh', 'cache', 'rtk-filter'),
  )
})

test('a manager without a probe reports the missing capability', async () => {
  const manager = await createRtkManager({
    ctx: { get: () => undefined },
    settings: { autoInstall: false, autoUpdate: false },
    deps: {
      root: tempRoot(),
      platform: 'linux',
      arch: 'x64',
      env: {},
      home: () => '/home/test',
      probeRtk: undefined,
      logger: {},
    },
  })
  assert.equal(manager.canWrap, false)
  manager.dispose()
})

test('a throwing probe never fails source resolution', async () => {
  const root = tempRoot()
  try {
    const plain = await createRtkManager({
      ctx: { get: () => undefined },
      settings: { binary: '/missing/rtk' },
      deps: {
        root,
        platform: 'linux',
        arch: 'x64',
        env: {},
        home: () => '/home/test',
        probeRtk: async () => { throw new Error('probe boom') },
        logger: {},
      },
    })
    assert.equal(plain.canWrap, false)
    assert.equal(plain.reason, 'probe boom')
    plain.dispose()

    const aborted = await createRtkManager({
      ctx: { get: () => undefined },
      settings: { binary: '/missing/rtk' },
      deps: {
        root,
        platform: 'linux',
        arch: 'x64',
        env: {},
        home: () => '/home/test',
        probeRtk: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) },
        logger: {},
      },
    })
    assert.equal(aborted.reason, 'aborted')
    aborted.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit relative binary works but warns about the PATH lookup', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      settings: { binary: 'custom-rtk', autoUpdate: false },
      probe: async () => ({ ok: true, version: { major: 1, minor: 2, patch: 0, raw: 'rtk 1.2.0' } }),
    })
    assert.equal(manager.initial.source, 'explicit')
    assert.equal(manager.initial.binary, 'custom-rtk')
    assert.match(logs.warn.join('\n'), /not an absolute path/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unusable explicit binary leaves the plugin inert', async () => {
  const root = tempRoot()
  try {
    const withReason = await managerFor({
      root,
      settings: { binary: '/missing/rtk' },
      probe: async () => ({ ok: false, reason: 'not runnable' }),
    })
    assert.equal(withReason.manager.canWrap, false)
    assert.equal(withReason.manager.reason, 'not runnable')
    withReason.manager.dispose()

    const withoutReason = await managerFor({
      root,
      settings: { binary: '/missing/rtk' },
      probe: async () => ({ ok: false }),
    })
    assert.match(withoutReason.manager.reason, /could not be run/)
    withoutReason.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reads RTK_BIN from the environment', async () => {
  const root = tempRoot()
  const bin = join(tempRoot(), 'rtk')
  writeFileSync(bin, rtkScript('0.49.0'), { mode: 0o755 })
  try {
    const configured = await managerFor({
      root,
      settings: { autoUpdate: false },
      probe: makeProbe(),
      deps: { env: { RTK_BIN: `  ${bin}  ` } },
    })
    assert.equal(configured.manager.initial.source, 'explicit')
    assert.equal(configured.manager.initial.binary, bin)
    configured.manager.dispose()

    const blank = await managerFor({
      root,
      settings: { autoInstall: false, autoUpdate: false },
      probe: makeProbe({ pathOk: true }),
      deps: { env: { RTK_BIN: '   ' } },
    })
    assert.equal(blank.manager.initial.source, 'path')
    blank.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(dirname(bin), { recursive: true, force: true })
  }
})

test('a PATH fallback still wraps on an unsupported platform', async () => {
  const root = tempRoot()
  try {
    const { manager } = await managerFor({
      root,
      settings: { autoUpdate: false },
      probe: makeProbe({ pathOk: true }),
      deps: { platform: 'win32' },
    })
    assert.equal(manager.canWrap, true)
    assert.equal(manager.reason, undefined)
    assert.equal(manager.initial.source, 'path')
    assert.equal(await manager.start().ready, true)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('skips an installed version whose binary no longer runs', async () => {
  const root = tempRoot()
  try {
    const layout = layoutFor(root, 'rtk', TARGET)
    const binary = join(layout.versionsDir, '1.2.0', 'rtk')
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, '#!/bin/sh\nexit 1\n', { mode: 0o755 })

    const { manager } = await managerFor({
      root,
      settings: { autoUpdate: false },
      probe: makeProbe({ pathOk: true }),
    })
    assert.equal(manager.initial.source, 'path')
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('adopts a version directory even when its state file cannot be written', async () => {
  const root = tempRoot()
  try {
    const layout = layoutFor(root, 'rtk', TARGET)
    const binary = join(layout.versionsDir, '1.2.0', 'rtk')
    mkdirSync(dirname(binary), { recursive: true })
    writeFileSync(binary, rtkScript('1.2.0'), { mode: 0o755 })
    writeFileSync(join(root, 'state'), 'not a directory')

    const { manager } = await managerFor({ root, settings: { autoUpdate: false } })
    assert.equal(manager.initial.source, 'managed')
    assert.equal(manager.initial.versionText, '1.2.0')
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('falls back to PATH when the managed binary disappears', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    const managedBinary = first.manager.current().binary
    first.manager.dispose()

    const second = await managerFor({
      root,
      release: { calls: [], fetchImpl: async () => { throw new Error('no network') } },
      probe: makeProbe({ pathOk: true }),
      settings: { autoUpdate: false },
    })
    assert.equal(second.manager.current().source, 'managed')
    rmSync(managedBinary, { force: true })
    assert.equal(second.manager.current().source, 'path')
    assert.equal(second.manager.current().binary, 'rtk')
    second.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('warns about an invalid pinned version and ignores it', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      settings: { version: 'banana', autoInstall: false, autoUpdate: false },
      probe: makeProbe(),
    })
    assert.equal(manager.canWrap, false)
    assert.match(logs.warn.join('\n'), /ignoring invalid pinned version/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkNow reuses a fresh cached latest lookup', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({
      root,
      release: makeRelease(),
      settings: { autoUpdate: false },
      deps: { now: () => 1_000 },
    })
    await first.manager.start().ready
    first.manager.dispose()

    const release = {
      calls: [],
      fetchImpl: async (url) => {
        release.calls.push(url)
        throw new Error('the cached lookup should be reused')
      },
    }
    const second = await managerFor({
      root,
      release,
      settings: { autoUpdate: true },
      deps: { now: () => 1_000 },
    })
    await second.manager.start().ready
    await second.manager.checkNow()
    assert.equal(release.calls.length, 0)
    assert.equal(second.manager.current().versionText, '1.2.0')
    second.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a downloaded binary that does not run is rejected', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease({ script: '#!/bin/sh\nexit 1\n' }),
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /VERIFY/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a downloaded binary that does not run without a reason is rejected', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease(),
      probe: async () => ({ ok: false }),
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /unknown error/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a smoke rewrite that fails without a reason is rejected', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease(),
      deps: { smokeRewrite: async () => ({ ok: false }) },
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /unknown error/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an aborted pinned install stays silent', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: {
        calls: [],
        fetchImpl: async () => {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        },
      },
      settings: { version: '1.2.0', autoUpdate: false },
    })
    assert.equal(await manager.start().ready, false)
    assert.equal(logs.warn.length, 0)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('disposing before the first start resolves as not ready', async () => {
  const root = tempRoot()
  try {
    const { manager } = await managerFor({
      root,
      settings: { autoInstall: false, autoUpdate: false },
      probe: makeProbe(),
    })
    manager.dispose()
    assert.equal(await manager.start().ready, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the default lock wait sleeps while another install holds the lock', async () => {
  const root = tempRoot()
  try {
    mkdirSync(join(root, 'locks'), { recursive: true })
    writeFileSync(join(root, 'locks', `rtk__${TARGET}.lock`), 'other process\n')
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease(),
      deps: { lockTimeoutMs: 50 },
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /LOCK/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a scheduler failure inside a timer callback is swallowed', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()
    rmSync(join(root, 'latest.json'), { force: true })

    const timers = []
    let scheduled = 0
    const second = await managerFor({
      root,
      release: {
        calls: [],
        fetchImpl: async () => { throw new Error('network down') },
      },
      settings: { autoUpdate: true },
      deps: {
        setTimeout: (callback, delay) => {
          scheduled += 1
          if (scheduled > 1) throw new Error('timers unavailable')
          const handle = { callback, delay, unref() {} }
          timers.push(handle)
          return handle
        },
        clearTimeout: () => {},
      },
    })
    await second.manager.start().ready
    for (let attempt = 0; attempt < 200 && timers.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    timers[0].callback()
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    second.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a downloaded binary without a version is rejected', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease({ script: '#!/bin/sh\nexit 0\n' }),
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /no version/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an install without a rewrite smoke test is rejected', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease(),
      deps: { smokeRewrite: undefined },
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /no rewrite smoke test/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an install whose smoke rewrite fails is rejected', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease(),
      deps: { smokeRewrite: async () => ({ ok: false, reason: 'nope' }) },
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /failed its rewrite check/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('disposing after the smoke rewrite aborts before publishing', async () => {
  const root = tempRoot()
  let notifyStarted
  let releaseSmoke
  const started = new Promise((resolve) => { notifyStarted = resolve })
  try {
    const { manager } = await managerFor({
      root,
      release: makeRelease(),
      settings: { autoUpdate: false },
      deps: {
        smokeRewrite: async () => {
          notifyStarted()
          return new Promise((resolve) => { releaseSmoke = resolve })
        },
      },
    })
    const task = manager.start()
    await started
    manager.dispose()
    releaseSmoke({ ok: true })
    assert.equal(await task.ready, false)
    assert.equal(existsSync(join(root, STATE)), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('installTag validates, reuses state, and reports a matching held lock', async () => {
  const root = tempRoot()
  try {
    const layout = layoutFor(root, 'rtk', TARGET)
    assert.equal(await makeInstaller(layout).installTag('latest').catch((error) => error.code), 'TAG')

    seedState(layout)
    const reused = await makeInstaller(layout).installTag('v1.2.0')
    assert.equal(reused.source, 'managed')
    assert.equal(reused.versionText, '1.2.0')

    mkdirSync(dirname(layout.lockPath), { recursive: true })
    writeFileSync(layout.lockPath, 'other process\n')
    const locked = await makeInstaller(layout).installTag('v1.2.0')
    assert.equal(locked.versionText, '1.2.0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkNow reports a missing smoke test and skips when disposed', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()
    rmSync(join(root, 'latest.json'), { force: true })

    const { manager, logs } = await managerFor({
      root,
      release: makeRelease({ version: '1.3.0' }),
      settings: { autoUpdate: true },
      deps: { smokeRewrite: undefined },
    })
    await manager.start().ready
    await manager.checkNow()
    assert.match(logs.warn.join('\n'), /update failed.*VERIFY/)
    assert.equal(manager.current().versionText, '1.2.0')

    manager.dispose()
    assert.equal(await manager.checkNow(), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('concurrent checkNow calls share one update check', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()
    rmSync(join(root, 'latest.json'), { force: true })

    let releaseFetch
    const fetched = new Promise((resolve) => { releaseFetch = resolve })
    const calls = []
    const second = await managerFor({
      root,
      release: {
        calls,
        fetchImpl: async (url) => {
          calls.push(url)
          return fetched
        },
      },
      settings: { autoUpdate: true },
    })
    await second.manager.start().ready

    const one = second.manager.checkNow()
    const two = second.manager.checkNow()
    releaseFetch({
      ok: true,
      url: 'https://github.com/rtk-ai/rtk/releases/tag/v1.2.0',
      body: { cancel() {} },
    })
    await Promise.all([one, two])
    // The second call joined the first check instead of issuing its own lookup.
    assert.equal(calls.length, 1)
    assert.equal(second.manager.current().versionText, '1.2.0')
    second.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed scheduled check retries after the retry delay', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()
    rmSync(join(root, 'latest.json'), { force: true })

    const timers = []
    const second = await managerFor({
      root,
      release: {
        calls: [],
        fetchImpl: async () => { throw new Error('network down') },
      },
      settings: { autoUpdate: true },
      deps: {
        setTimeout: (callback, delay) => {
          const handle = { callback, delay, unref() {} }
          timers.push(handle)
          return handle
        },
        clearTimeout: () => {},
      },
    })
    await second.manager.start().ready
    for (let attempt = 0; attempt < 200 && timers.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 0)

    timers[0].callback()
    for (let attempt = 0; attempt < 200 && timers.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(timers.length, 2)
    assert.equal(timers[1].delay, 60 * 60_000)
    second.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a scheduler failure does not escape activation', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()
    rmSync(join(root, 'latest.json'), { force: true })

    const second = await managerFor({
      root,
      release: makeRelease(),
      settings: { autoUpdate: true },
      deps: {
        setTimeout: () => { throw new Error('timers unavailable') },
      },
    })
    await second.manager.start().ready
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    second.manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a successful install that disposes mid-flight reports not ready', async () => {
  const root = tempRoot()
  let manager
  const logs = []
  try {
    const built = await managerFor({
      root,
      release: makeRelease(),
      settings: { autoUpdate: false },
      deps: {
        logger: {
          info(message) {
            logs.push(message)
            if (message.includes('installed at')) manager.dispose()
          },
          warn(message) { logs.push(message) },
        },
      },
    })
    manager = built.manager
    assert.equal(await manager.start().ready, false)
    assert.equal(existsSync(join(root, STATE)), true)
    assert.equal(manager.current().source, 'managed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failed pinned install is reported and leaves the plugin inert', async () => {
  const root = tempRoot()
  try {
    const { manager, logs } = await managerFor({
      root,
      release: makeRelease({ checksum: 'a'.repeat(64) }),
      settings: { version: '1.2.0', autoUpdate: false },
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /could not install RTK 1\.2\.0/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('autoInstall: false keeps a mismatched managed version with a warning', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()

    const { manager, logs } = await managerFor({
      root,
      release: { calls: [], fetchImpl: async () => { throw new Error('no network') } },
      settings: { version: '1.3.0', autoInstall: false, autoUpdate: false },
    })
    assert.equal(await manager.start().ready, true)
    assert.match(logs.warn.join('\n'), /keeping RTK 1\.2\.0 instead of 1\.3\.0/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a pin that matches the adopted managed version needs no install', async () => {
  const root = tempRoot()
  try {
    const first = await managerFor({ root, release: makeRelease(), settings: { autoUpdate: false } })
    await first.manager.start().ready
    first.manager.dispose()

    const { manager } = await managerFor({
      root,
      release: { calls: [], fetchImpl: async () => { throw new Error('no network') } },
      settings: { version: '1.2.0', autoUpdate: false },
    })
    assert.equal(await manager.start().ready, true)
    assert.equal(manager.current().versionText, '1.2.0')
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('start is idempotent and disposing before or after is safe', async () => {
  const root = tempRoot()
  try {
    const { manager } = await managerFor({
      root,
      settings: { autoInstall: false, autoUpdate: false },
      probe: makeProbe(),
    })
    const first = manager.start()
    assert.equal(manager.start(), first)
    assert.equal(await first.ready, false)

    manager.dispose()
    manager.dispose()
    assert.equal(await manager.start().ready, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an invalid archive is reported with its tar category', async () => {
  const root = tempRoot()
  const archive = Buffer.from('not gzip')
  const digest = createHash('sha256').update(archive).digest('hex')
  const asset = `rtk-${TARGET}.tar.gz`
  try {
    const { manager, logs } = await managerFor({
      root,
      release: {
        calls: [],
        fetchImpl: async (url) => url.endsWith('/checksums.txt')
          ? { ok: true, arrayBuffer: async () => Buffer.from(`${digest}  ${asset}\n`) }
          : { ok: true, arrayBuffer: async () => archive },
      },
      settings: { version: '1.2.0', autoUpdate: false },
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /GZIP/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a filesystem failure during install is reported generically', async () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'tmp'), 'not a directory')
    const { manager, logs } = await managerFor({ root, release: makeRelease() })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.warn.join('\n'), /EEXIST/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a throwing warning logger still settles the ready promise', async () => {
  const root = tempRoot()
  const logs = []
  let warnings = 0
  try {
    const { manager } = await managerFor({
      root,
      release: makeRelease({ checksum: 'a'.repeat(64) }),
      deps: {
        logger: {
          info() {},
          warn(message) {
            warnings += 1
            if (warnings === 1) throw new Error('logger down')
            logs.push(message)
          },
        },
      },
    })
    assert.equal(await manager.start().ready, false)
    assert.match(logs.join('\n'), /RTK setup failed/)
    manager.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('derives the cache root from the profile when no root is supplied', async () => {
  const home = tempRoot()
  try {
    const manager = await createRtkManager({
      ctx: { get: () => ({ home }) },
      settings: { autoInstall: false, autoUpdate: false },
      deps: {
        platform: 'linux',
        arch: 'x64',
        env: {},
        home: () => '/home/test',
        probeRtk: async () => ({ ok: false, reason: 'none' }),
        logger: {},
      },
    })
    assert.equal(manager.meta.root, join(home, 'cache', 'rtk-filter'))
    manager.dispose()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('schedules the next update check from the cached lookup time', async () => {
  const root = tempRoot()
  const release = makeRelease()
  try {
    // Seed a managed copy whose latest.json records the lookup at now() = 1000.
    const first = await managerFor({
      root,
      release,
      settings: { autoUpdate: false },
      deps: { now: () => 1_000 },
    })
    await first.manager.start().ready
    first.manager.dispose()

    const timers = []
    const cleared = []
    const second = await managerFor({
      root,
      release: {
        calls: [],
        fetchImpl: async () => {
          throw new Error('no network expected while scheduling')
        },
      },
      settings: { autoUpdate: true },
      deps: {
        now: () => 1_000,
        setTimeout: (callback, delay) => {
          const handle = { callback, delay, unref() {} }
          timers.push(handle)
          return handle
        },
        clearTimeout: (handle) => cleared.push(handle),
      },
    })

    await second.manager.start().ready
    // scheduleNext runs in the background after ready resolves.
    for (let attempt = 0; attempt < 500 && timers.length === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 60_000)

    second.manager.dispose()
    assert.deepEqual(cleared, timers)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
