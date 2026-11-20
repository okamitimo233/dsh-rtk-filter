import { test } from 'node:test'
import assert from 'node:assert/strict'

import { abortError } from '../lib/proc.js'
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  MAX_INSTALL_SCRIPT_BYTES,
  OFFICIAL_INSTALL_URL,
  downloadInstallScript,
  installOfficialRtk,
} from '../lib/installer.js'

const SCRIPT = `#!/usr/bin/env sh\nREPO="rtk-ai/rtk"\nINSTALL_DIR="\${RTK_INSTALL_DIR:-$HOME/.local/bin}"\n`

function response({ ok = true, status = 200, headers = {}, text = SCRIPT } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] },
    text: async () => text,
  }
}

test('downloadInstallScript fetches the official script', async () => {
  let request
  const script = await downloadInstallScript({
    fetchImpl: async (url, options) => {
      request = { url, options }
      return response({ headers: { 'content-length': '100' } })
    },
    timeoutMs: 5000,
  })

  assert.equal(script, SCRIPT)
  assert.equal(request.url, OFFICIAL_INSTALL_URL)
  assert.ok(request.options.signal instanceof AbortSignal)
})

test('downloadInstallScript requires global fetch', async () => {
  await assert.rejects(downloadInstallScript({ fetchImpl: null }), /global fetch is unavailable/)
})

test('downloadInstallScript surfaces request failures', async () => {
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => { throw new Error('network down') } }),
    /network down/,
  )
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => { throw abortError('aborted') } }),
    (error) => error.name === 'AbortError' && /installer download/.test(error.message),
  )
})

test('downloadInstallScript rejects non-success responses', async () => {
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => response({ ok: false, status: 503 }) }),
    /HTTP 503/,
  )
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => undefined }),
    /HTTP unknown/,
  )
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => null }),
    /HTTP unknown/,
  )
})

test('downloadInstallScript enforces the script size cap', async () => {
  await assert.rejects(
    downloadInstallScript({
      fetchImpl: async () => response({ headers: { 'content-length': String(MAX_INSTALL_SCRIPT_BYTES + 1) } }),
    }),
    /larger than expected/,
  )
  await assert.rejects(
    downloadInstallScript({
      fetchImpl: async () => response({ text: 'x'.repeat(MAX_INSTALL_SCRIPT_BYTES + 1) }),
    }),
    /larger than expected/,
  )
})

test('downloadInstallScript validates the response body', async () => {
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => response({ text: { not: 'text' } }) }),
    /larger than expected/,
  )
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => response({ text: 'not the official script' }) }),
    /does not look official/,
  )
})

test('installOfficialRtk runs the downloaded script and uses RTK_INSTALL_DIR', async () => {
  const calls = []
  const result = await installOfficialRtk({
    fetchImpl: async () => response(),
    env: { RTK_INSTALL_DIR: '  /opt/rtk-bin  ' },
    home: () => '/home/fallback',
    signal: AbortSignal.abort(),
    run: async (file, args, options) => {
      calls.push({ file, args, options })
      return { stdout: 'installed', stderr: '' }
    },
  })

  assert.deepEqual(result, { installDir: '/opt/rtk-bin', binary: '/opt/rtk-bin/rtk' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, 'sh')
  assert.match(calls[0].args[0], /dsh-rtk-install-.*\/install\.sh$/)
  assert.equal(calls[0].options.timeout, DEFAULT_INSTALL_TIMEOUT_MS)
  assert.deepEqual(calls[0].options.env, { RTK_INSTALL_DIR: '  /opt/rtk-bin  ' })
  assert.ok(calls[0].options.signal instanceof AbortSignal)
})

test('installOfficialRtk defaults to ~/.local/bin and omits an absent signal', async () => {
  let options
  const result = await installOfficialRtk({
    fetchImpl: async () => response(),
    env: {},
    home: () => '/home/u',
    run: async (file, args, input) => {
      options = input
      return { stdout: '', stderr: '' }
    },
  })

  assert.deepEqual(result, { installDir: '/home/u/.local/bin', binary: '/home/u/.local/bin/rtk' })
  assert.equal(options.signal, undefined)
})

test('installOfficialRtk reports installer failures', async () => {
  await assert.rejects(
    installOfficialRtk({
      fetchImpl: async () => response(),
      env: {},
      run: async () => ({ error: new Error('exit 1'), stdout: '', stderr: 'checksum mismatch' }),
    }),
    /official RTK installer failed: checksum mismatch/,
  )
  await assert.rejects(
    installOfficialRtk({
      fetchImpl: async () => response(),
      env: {},
      run: async () => ({ error: new Error('exit 1'), stdout: '', stderr: '  ' }),
    }),
    /official RTK installer failed: exit 1/,
  )
  await assert.rejects(
    installOfficialRtk({
      fetchImpl: async () => response(),
      env: {},
      run: async () => ({ error: abortError('aborted'), stdout: '', stderr: '' }),
    }),
    (error) => error.name === 'AbortError' && /installer was aborted/.test(error.message),
  )
  await assert.rejects(
    installOfficialRtk({
      fetchImpl: async () => response(),
      env: {},
      run: async () => { throw new Error('spawn failed') },
    }),
    /spawn failed/,
  )
})
