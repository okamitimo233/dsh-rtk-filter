import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { probeRtk, rewriteCommand } from '../lib/rewrite.js'

const dir = mkdtempSync(join(tmpdir(), 'rtk-dsh-rewrite-'))

after(() => rmSync(dir, { recursive: true, force: true }))

function fake(name, body) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const rtk = fake('rtk', `case "$1" in
  --version) printf '%s\\n' 'rtk 0.49.0'; exit 0 ;;
  rewrite)
    case "$2" in
      pass-me) exit 1 ;;
      deny-me) printf '%s' 'blocked by a deny rule'; exit 2 ;;
      ask-me) printf 'rtk %s' "$2"; exit 3 ;;
      timeout-me) sleep 2 ;;
      weird-me) exit 7 ;;
      *) printf 'rtk %s' "$2"; exit 0 ;;
    esac ;;
  *) exit 9 ;;
esac`)

const oldRtk = fake('old-rtk', `case "$1" in
  --version) printf '%s\\n' 'rtk 0.22.0'; exit 0 ;;
  *) exit 9 ;;
esac`)

test('probe accepts a supported rtk', async () => {
  const probe = await probeRtk({ binary: rtk })
  assert.equal(probe.ok, true)
  assert.equal(probe.version.minor, 49)
})

test('probe rejects a missing binary', async () => {
  const probe = await probeRtk({ binary: join(dir, 'does-not-exist') })
  assert.equal(probe.ok, false)
  assert.match(probe.reason, /was not found/)
})

test('probe rejects an rtk without rtk rewrite', async () => {
  const probe = await probeRtk({ binary: oldRtk })
  assert.equal(probe.ok, false)
  assert.match(probe.reason, /too old/)
})

test('exit 0 returns the rewrite', async () => {
  const outcome = await rewriteCommand({ binary: rtk, command: 'git status', cwd: dir })
  assert.deepEqual(outcome, { kind: 'rewrite', command: 'rtk git status' })
})

test('exit 3 returns the rewrite without prompting', async () => {
  const outcome = await rewriteCommand({ binary: rtk, command: 'ask-me' })
  assert.deepEqual(outcome, { kind: 'rewrite', command: 'rtk ask-me' })
})

test('exit 1 passes the command through', async () => {
  const outcome = await rewriteCommand({ binary: rtk, command: 'pass-me' })
  assert.equal(outcome.kind, 'pass')
})

test('exit 2 denies with the rtk message', async () => {
  const outcome = await rewriteCommand({ binary: rtk, command: 'deny-me' })
  assert.deepEqual(outcome, { kind: 'deny', reason: 'blocked by a deny rule' })
})

test('unexpected exit passes the command through', async () => {
  const outcome = await rewriteCommand({ binary: rtk, command: 'weird-me' })
  assert.equal(outcome.kind, 'pass')
  assert.match(outcome.reason, /unexpected/)
})

test('a missing binary fails open', async () => {
  const outcome = await rewriteCommand({ binary: join(dir, 'missing-rtk'), command: 'git status' })
  assert.equal(outcome.kind, 'pass')
  assert.match(outcome.reason, /was not found/)
})

test('a rewrite timeout fails open', async () => {
  const outcome = await rewriteCommand({ binary: rtk, command: 'timeout-me', timeoutMs: 100 })
  assert.equal(outcome.kind, 'pass')
  assert.match(outcome.reason, /rtk rewrite failed/)
})

test('an abort rejects with AbortError', async () => {
  const controller = new AbortController()
  const pending = rewriteCommand({
    binary: rtk,
    command: 'timeout-me',
    timeoutMs: 5000,
    signal: controller.signal,
  })
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await assert.rejects(pending, (error) => error instanceof Error && error.name === 'AbortError')
  } finally {
    clearTimeout(timer)
  }
})
