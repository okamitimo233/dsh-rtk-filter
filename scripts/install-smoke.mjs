/**
 * Real-network smoke test for the official RTK installer path.
 *
 * Unit tests mock both the download and the child process. This script runs
 * the same code path against upstream `install.sh` in a throwaway HOME and
 * RTK_INSTALL_DIR, then verifies that the installed absolute binary runs.
 *
 * It is intentionally manual (see .github/workflows/install-smoke.yml).
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installOfficialRtk } from '../lib/installer.js'
import { runProcess } from '../lib/proc.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-rtk-install-smoke-'))
try {
  const installDir = join(root, 'bin')
  const env = { ...process.env, HOME: root, RTK_INSTALL_DIR: installDir }
  const installed = await installOfficialRtk({ env, home: () => root })
  assert.equal(installed.installDir, installDir)
  assert.equal(installed.binary, join(installDir, 'rtk'))

  const probe = await runProcess(installed.binary, ['--version'], {
    env,
    timeout: 10_000,
  })
  assert.equal(
    probe.error,
    undefined,
    `rtk --version failed: ${probe.stderr.trim() || probe.error?.message || 'unknown error'}`,
  )
  assert.match(probe.stdout, /^rtk \d+\.\d+\.\d+/)
  console.log(`official installer smoke passed: ${probe.stdout.trim()} at ${installed.binary}`)
} finally {
  await rm(root, { recursive: true, force: true })
}
