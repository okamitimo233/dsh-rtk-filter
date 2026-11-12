import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { abortError } from '../lib/proc.js'
import { interpretRewrite, probeRtk, rewriteCommand } from '../lib/rewrite.js'

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

const slowRtk = fake('slow-rtk', 'sleep 2')
const stderrRtk = fake('stderr-rtk', "echo 'warning: no version yet' >&2; exit 0")
const silentRtk = fake('silent-rtk', 'exit 0')

const notExecutable = join(dir, 'not-executable')
writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n')

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

/** Synthesize the execFile error shape for an exit code. */
function exited(code) {
  return Object.assign(new Error(`Command failed: rtk rewrite`), { code })
}

test('interpretRewrite maps exit 0 and 3 to a trimmed rewrite', () => {
  assert.deepEqual(interpretRewrite({ stdout: '  rtk git status \n' }), {
    kind: 'rewrite',
    command: 'rtk git status',
  })
  assert.deepEqual(interpretRewrite({ error: exited(3), stdout: 'rtk ask-me\n' }), {
    kind: 'rewrite',
    command: 'rtk ask-me',
  })
})

test('interpretRewrite fails open on an empty or whitespace rewrite', () => {
  assert.deepEqual(interpretRewrite({ stdout: '   \n' }), {
    kind: 'pass',
    reason: 'rtk returned an empty rewrite',
  })
  assert.deepEqual(interpretRewrite({ error: exited(3), stdout: '\n' }), {
    kind: 'pass',
    reason: 'rtk returned an empty rewrite',
  })
})

test('interpretRewrite passes exit 1 even when rtk printed text', () => {
  assert.deepEqual(interpretRewrite({ error: exited(1), stdout: 'ignored', stderr: 'detail' }), {
    kind: 'pass',
    reason: 'no RTK rewrite',
  })
})

test('interpretRewrite denies exit 2 preferring stdout, then stderr, then the default', () => {
  assert.deepEqual(
    interpretRewrite({ error: exited(2), stdout: 'blocked by a deny rule\n', stderr: 'detail' }),
    { kind: 'deny', reason: 'blocked by a deny rule' },
  )
  assert.deepEqual(
    interpretRewrite({ error: exited(2), stdout: '', stderr: 'pipeline detail\n' }),
    { kind: 'deny', reason: 'pipeline detail' },
  )
  assert.deepEqual(interpretRewrite({ error: exited(2) }), {
    kind: 'deny',
    reason: 'denied by an RTK deny or pipeline rule',
  })
})

test('interpretRewrite fails open on an unexpected exit code', () => {
  assert.deepEqual(interpretRewrite({ error: exited(7) }), {
    kind: 'pass',
    reason: 'unexpected rtk rewrite exit 7',
  })
})

test('interpretRewrite fails open when the binary is missing', () => {
  const error = Object.assign(new Error('spawn rtk ENOENT'), { code: 'ENOENT' })
  assert.deepEqual(interpretRewrite({ binary: '/managed/rtk', error }), {
    kind: 'pass',
    reason: 'RTK binary "/managed/rtk" was not found',
  })
})

test('interpretRewrite fails open when the child was killed', () => {
  const error = Object.assign(new Error('Command failed: rtk rewrite'), { killed: true })
  assert.deepEqual(interpretRewrite({ error }), {
    kind: 'pass',
    reason: 'rtk rewrite failed: Command failed: rtk rewrite',
  })
})

test('interpretRewrite fails open on a non-numeric spawn error code', () => {
  const error = Object.assign(new Error('stdout maxBuffer exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  })
  assert.deepEqual(interpretRewrite({ error }), {
    kind: 'pass',
    reason: 'rtk rewrite failed: stdout maxBuffer exceeded',
  })
})

test('interpretRewrite rethrows both abort shapes', () => {
  const isAbort = (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR'
  assert.throws(() => interpretRewrite({ error: abortError('rtk rewrite aborted') }), isAbort)
  assert.throws(
    () => interpretRewrite({ error: Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }) }),
    isAbort,
  )
})

test('interpretRewrite defaults an absent result to an empty rewrite', () => {
  assert.deepEqual(interpretRewrite(), {
    kind: 'pass',
    reason: 'rtk returned an empty rewrite',
  })
})

test('rewriteCommand passes a blank command without spawning rtk', async () => {
  const missing = join(dir, 'never-spawned')
  const outcome = { kind: 'pass', reason: 'empty command' }
  assert.deepEqual(await rewriteCommand({ binary: missing, command: '   ' }), outcome)
  assert.deepEqual(await rewriteCommand({ binary: missing, command: undefined }), outcome)
  assert.deepEqual(await rewriteCommand({ binary: missing, command: 42 }), outcome)
})

test('probe reports a binary that cannot be executed', async () => {
  const probe = await probeRtk({ binary: notExecutable })
  assert.equal(probe.ok, false)
  assert.match(probe.reason, /could not be run/)
})

test('probe reports a versionless answer with diagnostics and accepts a silent one', async () => {
  const diagnosed = await probeRtk({ binary: stderrRtk })
  assert.equal(diagnosed.ok, false)
  assert.match(diagnosed.reason, /did not report a version/)

  const silent = await probeRtk({ binary: silentRtk })
  assert.deepEqual(silent, { ok: true, version: null })
})

test('an aborted probe leaves the plugin inert', async () => {
  const controller = new AbortController()
  const pending = probeRtk({ binary: slowRtk, timeoutMs: 5000, signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    const probe = await pending
    assert.equal(probe.ok, false)
    assert.match(probe.reason, /aborted/)
  } finally {
    clearTimeout(timer)
  }
})
