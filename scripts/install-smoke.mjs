#!/usr/bin/env node
/**
 * End-to-end install smoke test.
 *
 * Downloads the real RTK release into a temporary `DSH_HOME` (no global
 * install, no writes outside that directory), verifies the checksum-validated
 * install, and exercises the protocol the plugin depends on. This is the only
 * check that needs the network, so it is not part of `node --test`; run it
 * manually or from the install-smoke workflow:
 *
 *   npm run smoke
 *
 * Exits non-zero when any assertion fails, so CI can gate on it.
 */

import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeRtk, rewriteCommand } from '../lib/rewrite.js'
import { createRtkManager } from '../lib/sidecar.js'
import { runGain } from '../lib/status.js'

const home = await mkdtemp(join(tmpdir(), 'dsh-rtk-smoke-'))
process.stdout.write(`smoke DSH_HOME=${home}\n`)

let manager
try {
  manager = await createRtkManager({
    ctx: { get: () => ({ home }) },
    settings: { autoUpdate: false },
    deps: {
      probeRtk,
      smokeRewrite: async ({ binary, signal }) =>
        (await rewriteCommand({ binary, command: 'git status', signal })).kind === 'rewrite'
          ? { ok: true } : { ok: false, reason: 'no rewrite' },
      logger: console,
    },
  })

  assert.equal(
    await manager.start().ready,
    true,
    'the manager must report ready after a successful install',
  )

  const entry = manager.current()
  assert.equal(entry.source, 'managed', 'the smoke must exercise a managed install')
  assert.match(entry.versionText, /^\d+\.\d+\.\d+$/, 'the managed entry must report a version')
  await access(entry.binary, constants.X_OK | constants.R_OK)

  const probe = await probeRtk({ binary: entry.binary })
  assert.equal(probe.ok, true, `probe failed: ${probe.reason ?? 'unknown'}`)

  const rewrite = await rewriteCommand({ binary: entry.binary, command: 'git status' })
  assert.equal(rewrite.kind, 'rewrite', `expected a rewrite for 'git status', got ${rewrite.kind}`)

  const gain = await runGain({ binary: entry.binary })
  assert.ok(gain !== null && typeof gain === 'object', 'rtk gain must answer a JSON object')

  const stateDir = join(home, 'cache', 'rtk-filter', 'state')
  const states = await readdir(stateDir)
  assert.equal(states.length, 1, 'exactly one edition/target state file expected')
  const state = JSON.parse(await readFile(join(stateDir, states[0]), 'utf8'))
  assert.equal(state.version, entry.versionText, 'the state must record the installed version')
  assert.match(state.sha256, /^[a-f0-9]{64}$/, 'the state must record the verified checksum')
  assert.equal(state.edition, 'rtk')
  assert.ok(typeof state.target === 'string' && state.target !== '', 'the state must record the asset target')

  process.stdout.write(`ok: RTK ${entry.versionText} (${state.asset}, sha256 ${state.sha256.slice(0, 12)}...)\n`)
  process.stdout.write(`ok: rewrite -> ${rewrite.command}\n`)
  process.stdout.write(`ok: gain -> ${(gain.daily ?? []).length} day rows\n`)
} finally {
  manager?.dispose()
  await rm(home, { recursive: true, force: true })
}
