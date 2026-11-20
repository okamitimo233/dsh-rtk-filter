import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { abortError } from '../lib/proc.js'
import {
  DEFAULT_INSTALL_TIMEOUT_MS,
  MAX_INSTALL_SCRIPT_BYTES,
  OFFICIAL_INSTALL_URL,
  downloadInstallScript,
  installBinaryPath,
  installOfficialRtk,
} from '../lib/installer.js'

const SCRIPT = `#!/usr/bin/env sh\nREPO="rtk-ai/rtk"\nINSTALL_DIR="\${RTK_INSTALL_DIR:-$HOME/.local/bin}"\n`

function streamBody(chunks) {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      if (index === chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(new TextEncoder().encode(chunks[index]))
      index += 1
    },
  })
}

function response({ ok = true, status = 200, headers = {}, text = SCRIPT, body } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] },
    text: async () => text,
    ...(body === undefined ? {} : { body }),
  }
}

test('installBinaryPath trims, resolves, and falls back to ~/.local/bin', () => {
  assert.deepEqual(
    installBinaryPath({ env: { RTK_INSTALL_DIR: '  /opt/rtk-bin  ' }, home: () => '/home/fallback' }),
    { installDir: '/opt/rtk-bin', binary: '/opt/rtk-bin/rtk' },
  )
  assert.deepEqual(
    installBinaryPath({ env: { RTK_INSTALL_DIR: '   ' }, home: () => '/home/fallback' }),
    { installDir: '/home/fallback/.local/bin', binary: '/home/fallback/.local/bin/rtk' },
  )
  assert.deepEqual(
    installBinaryPath({ env: { RTK_INSTALL_DIR: 'relative/bin' }, home: () => '/home/fallback' }),
    { installDir: resolve('relative/bin'), binary: resolve('relative/bin/rtk') },
  )
  assert.deepEqual(
    installBinaryPath({ env: { RTK_INSTALL_DIR: 42 }, home: () => '/home/fallback' }),
    { installDir: '/home/fallback/.local/bin', binary: '/home/fallback/.local/bin/rtk' },
  )
})

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

test('downloadInstallScript reads a streamed body and flushes the decoder', async () => {
  const script = await downloadInstallScript({
    fetchImpl: async () => response({ body: streamBody([SCRIPT.slice(0, 20), SCRIPT.slice(20)]) }),
  })
  assert.equal(script, SCRIPT)
})

test('downloadInstallScript requires global fetch', async () => {
  await assert.rejects(downloadInstallScript({ fetchImpl: null }), /global fetch is unavailable/)
})

test('downloadInstallScript surfaces request and body-read failures', async () => {
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => { throw new Error('network down') } }),
    /network down/,
  )
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => { throw abortError('aborted') } }),
    (error) => error.name === 'AbortError' && /installer download/.test(error.message),
  )
  await assert.rejects(
    downloadInstallScript({
      fetchImpl: async () => response({
        body: new ReadableStream({
          start(controller) {
            controller.error(abortError('body aborted'))
          },
        }),
      }),
    }),
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
  await assert.rejects(
    downloadInstallScript({
      fetchImpl: async () => response({ body: streamBody(['x'.repeat(MAX_INSTALL_SCRIPT_BYTES + 1)]) }),
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
  await assert.rejects(
    downloadInstallScript({ fetchImpl: async () => response({ text: 'rtk-ai/rtk but no install path' }) }),
    /does not look official/,
  )
  await assert.rejects(
    downloadInstallScript({
      fetchImpl: async () => response({ body: { getReader: undefined }, text: 'rtk-ai/rtk but no install path' }),
    }),
    /does not look official/,
  )
})

test('installOfficialRtk runs the downloaded script with a normalized RTK_INSTALL_DIR', async () => {
  const calls = []
  const result = await installOfficialRtk({
    fetchImpl: async () => response(),
    env: { HOME: '/home/from-env', RTK_INSTALL_DIR: '  /opt/rtk-bin  ' },
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
  assert.deepEqual(calls[0].options.env, {
    HOME: '/home/from-env',
    RTK_INSTALL_DIR: '/opt/rtk-bin',
  })
  assert.ok(calls[0].options.signal instanceof AbortSignal)
})

test('installOfficialRtk defaults to ~/.local/bin and passes that exact path to the script', async () => {
  let options
  const result = await installOfficialRtk({
    fetchImpl: async () => response(),
    env: { RTK_INSTALL_DIR: '   ' },
    home: () => '/home/u',
    run: async (file, args, input) => {
      options = input
      return { stdout: '', stderr: '' }
    },
  })

  assert.deepEqual(result, { installDir: '/home/u/.local/bin', binary: '/home/u/.local/bin/rtk' })
  assert.equal(options.env.RTK_INSTALL_DIR, '/home/u/.local/bin')
  assert.ok(options.signal instanceof AbortSignal)
})

test('installOfficialRtk resolves a relative RTK_INSTALL_DIR consistently', async () => {
  let options
  const result = await installOfficialRtk({
    fetchImpl: async () => response(),
    env: { RTK_INSTALL_DIR: 'relative/bin' },
    run: async (file, args, input) => {
      options = input
      return { stdout: '', stderr: '' }
    },
  })

  assert.equal(result.installDir, resolve('relative/bin'))
  assert.equal(options.env.RTK_INSTALL_DIR, resolve('relative/bin'))
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
