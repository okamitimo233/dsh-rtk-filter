import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createRtkManager } from '../lib/manager.js'

const VERSION = { major: 1, minor: 2, patch: 1, raw: 'rtk 1.2.1' }

function ok(version = VERSION) {
  return { ok: true, version }
}

test('RTK_BIN wins over config and is probed as an explicit absolute binary', async () => {
  const calls = []
  const warnings = []
  const manager = await createRtkManager({
    settings: { binary: '/config/rtk', rewriteTimeoutMs: 5000 },
    deps: {
      env: { RTK_BIN: '  /env/bin/rtk  ' },
      probeTimeoutMs: 123,
      probeRtk: async (input) => {
        calls.push(input)
        return ok()
      },
      logger: { warn: (message) => warnings.push(message) },
    },
  })

  assert.equal(calls[0].binary, '/env/bin/rtk')
  assert.equal(calls[0].timeoutMs, 123)
  assert.ok(calls[0].signal instanceof AbortSignal)
  assert.deepEqual(manager.initial, {
    binary: '/env/bin/rtk',
    source: 'explicit',
    version: VERSION,
    versionText: '1.2.1',
    prefixDir: '/env/bin',
  })
  assert.equal(manager.canWrap, true)
  assert.equal(manager.reason, undefined)
  assert.equal(manager.current(), manager.initial)
  assert.equal(await manager.start().ready, true)
  assert.equal(warnings.length, 0)

  manager.dispose()
  assert.equal(manager.current(), undefined)
  assert.equal(await manager.start().ready, false)
})

test('a non-default binary is explicit and a relative one keeps PATH semantics with a warning', async () => {
  const calls = []
  const warnings = []
  const manager = await createRtkManager({
    settings: { binary: 'custom-rtk' },
    deps: {
      env: {},
      probeRtk: async (input) => {
        calls.push(input)
        return ok({ major: 1, minor: 3, patch: 0, raw: 'rtk 1.3.0' })
      },
      logger: { warn: (message) => warnings.push(message) },
    },
  })

  assert.equal(calls[0].binary, 'custom-rtk')
  assert.equal(calls[0].timeoutMs, 2000)
  assert.deepEqual(manager.initial, {
    binary: 'custom-rtk',
    source: 'explicit',
    version: { major: 1, minor: 3, patch: 0, raw: 'rtk 1.3.0' },
    versionText: '1.3.0',
  })
  assert.equal(manager.initial.prefixDir, undefined)
  assert.match(warnings.join('\n'), /is not an absolute path/)
})

test('default config resolves rtk from the Host PATH', async () => {
  const calls = []
  const manager = await createRtkManager({
    settings: {},
    deps: {
      env: { RTK_BIN: '   ' },
      rewriteTimeout: 1,
      probeRtk: async (input) => {
        calls.push(input)
        return ok()
      },
    },
  })

  assert.equal(calls[0].binary, 'rtk')
  assert.equal(calls[0].timeoutMs, 2000)
  assert.deepEqual(manager.initial, {
    binary: 'rtk',
    source: 'path',
    version: VERSION,
    versionText: '1.2.1',
  })
  assert.equal(manager.canWrap, true)
})

test('a versionless PATH binary is still usable', async () => {
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

test('a failed explicit probe keeps its diagnostic and leaves the plugin inert', async () => {
  const manager = await createRtkManager({
    settings: { binary: '/missing/rtk' },
    deps: {
      env: {},
      probeRtk: async () => ({ ok: false, reason: 'not found here' }),
    },
  })

  assert.equal(manager.initial, undefined)
  assert.equal(manager.canWrap, false)
  assert.equal(manager.reason, 'not found here')
  assert.equal(manager.current(), undefined)
})

test('an explicit probe without a reason gets a generic diagnostic', async () => {
  const manager = await createRtkManager({
    settings: { binary: '/missing/rtk' },
    deps: { env: {}, probeRtk: async () => ({ ok: false }) },
  })
  assert.match(manager.reason, /RTK binary "\/missing\/rtk" could not be run/)
})

test('a failed PATH probe keeps its diagnostic when autoInstall is disabled', async () => {
  const manager = await createRtkManager({
    settings: { autoInstall: false },
    deps: { env: {}, probeRtk: async () => ({ ok: false, reason: 'PATH is empty' }) },
  })
  assert.equal(manager.reason, 'PATH is empty')
  assert.equal(manager.canWrap, false)
})

test('a failed PATH probe without a reason gets a generic diagnostic when autoInstall is disabled', async () => {
  const manager = await createRtkManager({
    settings: { autoInstall: false },
    deps: { env: {}, probeRtk: async () => ({ ok: false }) },
  })
  assert.match(manager.reason, /RTK was not found on the Host PATH/)
})

test('a throwing probe is converted into a diagnostic', async () => {
  const errorManager = await createRtkManager({
    settings: { autoInstall: false },
    deps: {
      env: {},
      probeRtk: async () => { throw new Error('probe exploded') },
    },
  })
  assert.match(errorManager.reason, /could not be probed \(probe exploded\)/)

  const valueManager = await createRtkManager({
    settings: { autoInstall: false },
    deps: {
      env: {},
      probeRtk: async () => { throw 'probe exploded' },
    },
  })
  assert.match(valueManager.reason, /could not be probed \(probe exploded\)/)
})

test('a manager without a probe reports the missing capability', async () => {
  const manager = await createRtkManager({ settings: { autoInstall: false }, deps: { env: {} } })
  assert.equal(manager.canWrap, false)
  assert.match(manager.reason, /RTK probe is unavailable/)
})

test('a missing PATH binary triggers the official installer and uses its binary', async () => {
  const probes = []
  const installs = []
  const manager = await createRtkManager({
    deps: {
      env: { RTK_INSTALL_DIR: '/opt/rtk-bin' },
      probeRtk: async (input) => {
        probes.push(input)
        return input.binary === 'rtk' ? { ok: false, reason: 'missing from PATH' } : ok()
      },
      installRtk: async (input) => {
        installs.push(input)
        return { binary: '/opt/rtk-bin/rtk' }
      },
    },
  })

  assert.deepEqual(probes.map((probe) => probe.binary), ['rtk', '/opt/rtk-bin/rtk'])
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

test('autoInstall: false does not call the installer', async () => {
  let installs = 0
  const manager = await createRtkManager({
    settings: { autoInstall: false },
    deps: {
      env: {},
      probeRtk: async () => ({ ok: false, reason: 'missing from PATH' }),
      installRtk: async () => {
        installs += 1
        return { binary: '/opt/rtk' }
      },
    },
  })
  assert.equal(installs, 0)
  assert.equal(manager.reason, 'missing from PATH')
})

test('a missing installer capability is reported', async () => {
  const manager = await createRtkManager({
    deps: { env: {}, probeRtk: async () => ({ ok: false }) },
  })
  assert.match(manager.reason, /official installer is unavailable/)
})

test('installer failures are reported as diagnostics', async () => {
  const errorManager = await createRtkManager({
    deps: {
      env: {},
      probeRtk: async () => ({ ok: false }),
      installRtk: async () => { throw new Error('network down') },
    },
  })
  assert.match(errorManager.reason, /RTK install failed: network down/)

  const valueManager = await createRtkManager({
    deps: {
      env: {},
      probeRtk: async () => ({ ok: false }),
      installRtk: async () => { throw 'network down' },
    },
  })
  assert.match(valueManager.reason, /RTK install failed: network down/)
})

test('an installer that returns no binary path is reported', async () => {
  const manager = await createRtkManager({
    deps: {
      env: {},
      probeRtk: async () => ({ ok: false }),
      installRtk: async () => ({}),
    },
  })
  assert.match(manager.reason, /installer returned no binary path/)
})

test('an installed binary that cannot be probed is reported', async () => {
  const withReason = await createRtkManager({
    deps: {
      env: {},
      probeRtk: async (input) => input.binary === 'rtk'
        ? { ok: false }
        : { ok: false, reason: 'installed binary does not run' },
      installRtk: async () => ({ binary: '/opt/rtk' }),
    },
  })
  assert.equal(withReason.reason, 'installed binary does not run')

  const withoutReason = await createRtkManager({
    deps: {
      env: {},
      probeRtk: async (input) => input.binary === 'rtk' ? { ok: false } : { ok: false },
      installRtk: async () => ({ binary: '/opt/rtk' }),
    },
  })
  assert.match(withoutReason.reason, /installed RTK binary "\/opt\/rtk" could not be run/)
})
