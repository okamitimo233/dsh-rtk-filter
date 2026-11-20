import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRtkManager } from '../lib/manager.js'

const VERSION = { major: 1, minor: 2, patch: 1, raw: 'rtk 1.2.1' }

function ok(version = VERSION) {
  return { ok: true, version }
}

test('uses rtk from the Host PATH when it is already installed', async () => {
  const calls = []
  let installs = 0
  const manager = await createRtkManager({
    deps: {
      env: {},
      probeRtk: async (input) => {
        calls.push(input)
        return ok()
      },
      installRtk: async () => {
        installs += 1
        return { binary: '/unused' }
      },
    },
  })

  assert.deepEqual(calls.map((call) => call.binary), ['rtk'])
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.equal(calls[0].timeoutMs, 2000)
  assert.equal(installs, 0)
  assert.deepEqual(manager.initial, {
    binary: 'rtk',
    source: 'path',
    version: VERSION,
    versionText: '1.2.1',
  })
  assert.equal(manager.canWrap, true)
  assert.equal(manager.reason, undefined)
  assert.equal(manager.current(), manager.initial)

  manager.dispose()
  assert.equal(manager.current(), undefined)
})

test('uses an existing official installation even when rtk is not on PATH', async () => {
  const calls = []
  let installs = 0
  const manager = await createRtkManager({
    deps: {
      env: {},
      home: () => '/home/u',
      probeRtk: async (input) => {
        calls.push(input.binary)
        return input.binary === 'rtk' ? { ok: false, reason: 'not on PATH' } : ok()
      },
      installRtk: async () => {
        installs += 1
        return { binary: '/unused' }
      },
    },
  })

  assert.deepEqual(calls, ['rtk', '/home/u/.local/bin/rtk'])
  assert.equal(installs, 0)
  assert.deepEqual(manager.initial, {
    binary: '/home/u/.local/bin/rtk',
    source: 'installed',
    version: VERSION,
    versionText: '1.2.1',
    prefixDir: '/home/u/.local/bin',
  })
})

test('honors RTK_INSTALL_DIR when looking for an existing installation', async () => {
  const calls = []
  const manager = await createRtkManager({
    deps: {
      env: { RTK_INSTALL_DIR: '  /opt/rtk-bin  ' },
      home: () => '/home/u',
      probeRtk: async (input) => {
        calls.push(input.binary)
        return input.binary === 'rtk' ? { ok: false } : ok()
      },
    },
  })

  assert.deepEqual(calls, ['rtk', '/opt/rtk-bin/rtk'])
  assert.equal(manager.initial.binary, '/opt/rtk-bin/rtk')
  assert.equal(manager.initial.source, 'installed')
})

test('runs the official installer when no local installation exists', async () => {
  const probes = []
  const installs = []
  let installed = false
  const manager = await createRtkManager({
    deps: {
      env: { RTK_INSTALL_DIR: '/opt/rtk-bin' },
      probeRtk: async (input) => {
        probes.push(input)
        if (input.binary === 'rtk') return { ok: false }
        return installed ? ok() : { ok: false }
      },
      installRtk: async (input) => {
        installs.push(input)
        installed = true
        return { binary: '/opt/rtk-bin/rtk' }
      },
    },
  })

  assert.deepEqual(probes.map((probe) => probe.binary), ['rtk', '/opt/rtk-bin/rtk', '/opt/rtk-bin/rtk'])
  assert.deepEqual(installs[0].env, { RTK_INSTALL_DIR: '/opt/rtk-bin' })
  assert.ok(installs[0].signal instanceof AbortSignal)
  assert.deepEqual(manager.initial, {
    binary: '/opt/rtk-bin/rtk',
    source: 'installed',
    version: VERSION,
    versionText: '1.2.1',
    prefixDir: '/opt/rtk-bin',
  })
  assert.equal(manager.canWrap, true)
})

test('falls back to the standard install path when the installer omits a path', async () => {
  for (const installResult of [undefined, null, {}, { binary: '' }]) {
    let installed = false
    const manager = await createRtkManager({
      deps: {
        env: {},
        home: () => '/home/u',
        probeRtk: async (input) => {
          if (input.binary === 'rtk') return { ok: false }
          return installed ? ok() : { ok: false }
        },
        installRtk: async () => {
          installed = true
          return installResult
        },
      },
    })
    assert.equal(manager.initial.binary, '/home/u/.local/bin/rtk')
    assert.equal(manager.initial.source, 'installed')
  }
})

test('a versionless binary is still usable', async () => {
  const manager = await createRtkManager({
    deps: {
      env: {},
      probeRtk: async () => ok(null),
    },
  })
  assert.deepEqual(manager.initial, { binary: 'rtk', source: 'path', version: null })
  assert.equal(manager.canWrap, true)
})

test('rewriteTimeoutMs raises the default probe timeout', async () => {
  const calls = []
  await createRtkManager({
    settings: { rewriteTimeoutMs: 5000 },
    deps: {
      env: {},
      probeRtk: async (input) => {
        calls.push(input)
        return ok()
      },
    },
  })
  assert.equal(calls[0].timeoutMs, 5000)
})

test('an explicit probe timeout overrides the setting', async () => {
  const calls = []
  await createRtkManager({
    settings: { rewriteTimeoutMs: 5000 },
    deps: {
      env: {},
      probeTimeoutMs: 123,
      probeRtk: async (input) => {
        calls.push(input)
        return ok()
      },
    },
  })
  assert.equal(calls[0].timeoutMs, 123)
})

test('missing probe support is reported', async () => {
  const manager = await createRtkManager({
    deps: { env: {}, home: () => '/home/u' },
  })
  assert.equal(manager.canWrap, false)
  assert.match(manager.reason, /official installer is unavailable/)
})

test('a throwing probe is converted into a diagnostic', async () => {
  const errorManager = await createRtkManager({
    deps: {
      env: {},
      home: () => '/home/u',
      probeRtk: async () => { throw new Error('probe exploded') },
    },
  })
  assert.match(errorManager.reason, /official installer is unavailable/)

  const installerManager = await createRtkManager({
    deps: {
      env: {},
      home: () => '/home/u',
      probeRtk: async () => { throw 'probe exploded' },
      installRtk: async () => ({ binary: '/home/u/.local/bin/rtk' }),
    },
  })
  assert.match(installerManager.reason, /could not be probed \(probe exploded\)/)
})

test('installer failures are reported as diagnostics', async () => {
  const errorManager = await createRtkManager({
    deps: {
      env: {},
      home: () => '/home/u',
      probeRtk: async () => ({ ok: false }),
      installRtk: async () => { throw new Error('network down') },
    },
  })
  assert.match(errorManager.reason, /RTK install failed: network down/)

  const valueManager = await createRtkManager({
    deps: {
      env: {},
      home: () => '/home/u',
      probeRtk: async () => ({ ok: false }),
      installRtk: async () => { throw 'network down' },
    },
  })
  assert.match(valueManager.reason, /RTK install failed: network down/)
})

test('an installed binary that cannot be probed is reported', async () => {
  const withReason = await createRtkManager({
    deps: {
      env: {},
      home: () => '/home/u',
      probeRtk: async (input) => input.binary === '/home/u/.local/bin/rtk'
        ? { ok: false, reason: 'installed binary does not run' }
        : { ok: false },
      installRtk: async () => ({ binary: '/home/u/.local/bin/rtk' }),
    },
  })
  assert.equal(withReason.reason, 'installed binary does not run')

  const withoutReason = await createRtkManager({
    deps: {
      env: {},
      home: () => '/home/u',
      probeRtk: async () => ({ ok: false }),
      installRtk: async () => ({ binary: '/home/u/.local/bin/rtk' }),
    },
  })
  assert.match(withoutReason.reason, /installed RTK binary "\/home\/u\/.local\/bin\/rtk" could not be run/)
})
