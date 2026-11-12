import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  ReleaseError,
  assetName,
  checksumsUrl,
  downloadRelease,
  fetchLatestTag,
  latestReleaseUrl,
  parseChecksums,
  parseLatestTag,
  releaseDownloadUrl,
  supportedTarget,
} from '../lib/release.js'

function response({ url, body, status = 200, declaredLength } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { get: (name) => (name === 'content-length' && declaredLength !== undefined ? String(declaredLength) : null) },
    body: { cancel() {} },
    async arrayBuffer() {
      return body instanceof Uint8Array ? body : Buffer.from(body ?? '')
    },
  }
}

test('maps supported platforms and architectures', () => {
  assert.equal(supportedTarget('linux', 'x64'), 'x86_64-unknown-linux-musl')
  assert.equal(supportedTarget('linux', 'arm64'), 'aarch64-unknown-linux-musl')
  assert.equal(supportedTarget('darwin', 'x64'), 'x86_64-apple-darwin')
  assert.equal(supportedTarget('darwin', 'arm64'), 'aarch64-apple-darwin')
  assert.equal(supportedTarget('win32', 'x64'), undefined)
  assert.equal(supportedTarget('linux', 'ia32'), undefined)
})

test('builds edition-specific asset and release URLs', () => {
  assert.equal(assetName('rtk', 'x86_64-unknown-linux-musl'), 'rtk-x86_64-unknown-linux-musl.tar.gz')
  assert.equal(assetName('rtk-oss', 'aarch64-apple-darwin'), 'rtk-oss-aarch64-apple-darwin.tar.gz')
  assert.equal(
    releaseDownloadUrl('v1.2.0', 'rtk-x86_64-unknown-linux-musl.tar.gz'),
    'https://github.com/rtk-ai/rtk/releases/download/v1.2.0/rtk-x86_64-unknown-linux-musl.tar.gz',
  )
  assert.equal(checksumsUrl('v1.2.0'), 'https://github.com/rtk-ai/rtk/releases/download/v1.2.0/checksums.txt')
  assert.equal(latestReleaseUrl(), 'https://github.com/rtk-ai/rtk/releases/latest')
})

test('parses sha256sum-style checksum files', () => {
  const digest = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  const checksums = parseChecksums([
    `${digest}  rtk-x86_64-unknown-linux-musl.tar.gz`,
    `${other} *rtk-oss-aarch64-apple-darwin.tar.gz`,
    'not a checksum line',
  ].join('\n'))
  assert.equal(checksums.get('rtk-x86_64-unknown-linux-musl.tar.gz'), digest)
  assert.equal(checksums.get('rtk-oss-aarch64-apple-darwin.tar.gz'), other)
  assert.equal(checksums.size, 2)
})

test('parses the tag out of a latest-release redirect URL', () => {
  assert.equal(parseLatestTag('https://github.com/rtk-ai/rtk/releases/tag/v1.2.0'), 'v1.2.0')
  assert.equal(parseLatestTag('https://github.com/rtk-ai/rtk/releases/tag/v1.2.0/'), 'v1.2.0')
  assert.equal(parseLatestTag('https://github.com/rtk-ai/rtk/releases/latest'), undefined)
  assert.equal(parseLatestTag(undefined), undefined)
})

test('resolves the latest tag from the release redirect', async () => {
  const calls = []
  const tag = await fetchLatestTag({
    fetchImpl: async (url) => {
      calls.push(url)
      return response({ url: 'https://github.com/rtk-ai/rtk/releases/tag/v1.2.0' })
    },
  })
  assert.equal(tag, 'v1.2.0')
  assert.deepEqual(calls, [latestReleaseUrl()])
})

test('falls back to the GitHub API when the redirect does not name a tag', async () => {
  let count = 0
  const tag = await fetchLatestTag({
    fetchImpl: async () => {
      count += 1
      if (count === 1) return response({ url: 'https://github.com/rtk-ai/rtk/releases/latest' })
      return response({ body: JSON.stringify({ tag_name: 'v1.3.0' }) })
    },
  })
  assert.equal(tag, 'v1.3.0')
  assert.equal(count, 2)
})

test('reports when neither latest lookup works', async () => {
  await assert.rejects(
    fetchLatestTag({
      fetchImpl: async (url) => {
        if (url.endsWith('/latest')) return response({ status: 500 })
        return response({ status: 403, body: 'rate limited' })
      },
    }),
    (error) => error instanceof ReleaseError && error.code === 'LATEST',
  )
})

test('downloads and verifies a release archive', async () => {
  const archive = Buffer.from('fake archive bytes')
  const sha = createHash('sha256').update(archive).digest('hex')
  const asset = 'rtk-x86_64-unknown-linux-musl.tar.gz'
  const calls = []

  const release = await downloadRelease({
    tag: '1.2.0',
    target: 'x86_64-unknown-linux-musl',
    fetchImpl: async (url) => {
      calls.push(url)
      if (url.endsWith('/checksums.txt')) return response({ body: `${sha}  ${asset}\n` })
      return response({ body: archive })
    },
  })

  assert.equal(release.tag, 'v1.2.0')
  assert.equal(release.version, '1.2.0')
  assert.equal(release.asset, asset)
  assert.equal(release.sha256, sha)
  assert.equal(release.archive.toString(), 'fake archive bytes')
  assert.equal(calls.length, 2)
  assert.equal(calls[1], releaseDownloadUrl('v1.2.0', asset))
})

test('rejects an invalid tag before any request', async () => {
  let called = 0
  await assert.rejects(
    downloadRelease({
      tag: 'latest',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async () => {
        called += 1
        return response({})
      },
    }),
    (error) => error instanceof ReleaseError && error.code === 'TAG',
  )
  assert.equal(called, 0)
})

test('rejects an asset missing from checksums.txt', async () => {
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async () => response({ body: `${'a'.repeat(64)}  rtk-aarch64-apple-darwin.tar.gz\n` }),
    }),
    (error) => error instanceof ReleaseError && error.code === 'ASSET',
  )
})

test('rejects a checksum mismatch', async () => {
  const asset = 'rtk-x86_64-unknown-linux-musl.tar.gz'
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async (url) => {
        if (url.endsWith('/checksums.txt')) return response({ body: `${'a'.repeat(64)}  ${asset}\n` })
        return response({ body: 'different bytes' })
      },
    }),
    (error) => error instanceof ReleaseError && error.code === 'CHECKSUM',
  )
})

test('surfaces HTTP failures', async () => {
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async () => response({ status: 404 }),
    }),
    (error) => error instanceof ReleaseError && error.code === 'HTTP',
  )
})

test('refuses a declared archive larger than the cap', async () => {
  const asset = 'rtk-x86_64-unknown-linux-musl.tar.gz'
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async (url) => {
        if (url.endsWith('/checksums.txt')) return response({ body: `${'a'.repeat(64)}  ${asset}\n` })
        return response({ declaredLength: 200 * 1024 * 1024, body: Buffer.alloc(1) })
      },
    }),
    (error) => error instanceof ReleaseError && error.code === 'TOO_LARGE',
  )
})

test('rejects a malformed percent escape in the latest tag', () => {
  assert.equal(parseLatestTag('https://github.com/rtk-ai/rtk/releases/tag/%E0%A4%A'), undefined)
})

test('rethrows an aborted latest lookup untouched', async () => {
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
  await assert.rejects(
    fetchLatestTag({ fetchImpl: async () => { throw aborted } }),
    (error) => error === aborted,
  )
})

test('rethrows an aborted API fallback untouched', async () => {
  const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })
  let count = 0
  await assert.rejects(
    fetchLatestTag({
      fetchImpl: async () => {
        count += 1
        if (count === 1) return response({ url: 'https://github.com/rtk-ai/rtk/releases/latest' })
        throw aborted
      },
    }),
    (error) => error === aborted,
  )
})

test('reports a latest lookup that resolves no stable tag', async () => {
  let count = 0
  await assert.rejects(
    fetchLatestTag({
      fetchImpl: async () => {
        count += 1
        if (count === 1) return response({ url: 'https://github.com/rtk-ai/rtk/releases/latest' })
        return response({ body: JSON.stringify({ tag_name: 'nightly' }) })
      },
    }),
    (error) => error instanceof ReleaseError && error.code === 'LATEST',
  )
})

test('ignores a failure to cancel the redirect body', async () => {
  const tag = await fetchLatestTag({
    fetchImpl: async () => ({
      ok: true,
      url: 'https://github.com/rtk-ai/rtk/releases/tag/v1.2.0',
      body: { cancel() { throw new Error('already consumed') } },
    }),
  })
  assert.equal(tag, 'v1.2.0')
})

test('request signals accept a zero timeout and an external signal', async () => {
  const signals = []
  const tag = await fetchLatestTag({
    timeoutMs: 0,
    signal: new AbortController().signal,
    fetchImpl: async (url, options) => {
      signals.push(options.signal)
      return response({ url: 'https://github.com/rtk-ai/rtk/releases/tag/v1.2.0' })
    },
  })
  assert.equal(tag, 'v1.2.0')
  assert.equal(signals[0] instanceof AbortSignal, true)

  await fetchLatestTag({
    signal: null,
    fetchImpl: async () => response({ url: 'https://github.com/rtk-ai/rtk/releases/tag/v1.2.0' }),
  })
})

test('reports a Host without global fetch', async () => {
  await assert.rejects(
    fetchLatestTag({ fetchImpl: null }),
    (error) => error instanceof ReleaseError && error.code === 'LATEST',
  )
  await assert.rejects(
    downloadRelease({ tag: 'v1.2.0', target: 'x86_64-unknown-linux-musl', fetchImpl: null }),
    (error) => error instanceof ReleaseError && error.code === 'UNSUPPORTED',
  )
})

test('reports a request that returns no response object', async () => {
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async () => null,
    }),
    (error) => error instanceof ReleaseError && error.code === 'NETWORK',
  )
})

test('renders a non-numeric HTTP status as a generic error', async () => {
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async () => ({ ok: false }),
    }),
    (error) => error instanceof ReleaseError && error.code === 'HTTP' && /HTTP error/.test(error.message),
  )
})

test('reads responses without content-length headers', async () => {
  const archive = Buffer.from('archive')
  const sha = createHash('sha256').update(archive).digest('hex')
  const asset = 'rtk-x86_64-unknown-linux-musl.tar.gz'
  const release = await downloadRelease({
    tag: 'v1.2.0',
    target: 'x86_64-unknown-linux-musl',
    fetchImpl: async (url) => ({
      ok: true,
      arrayBuffer: async () => (url.endsWith('/checksums.txt') ? Buffer.from(`${sha}  ${asset}\n`) : archive),
    }),
  })
  assert.equal(release.sha256, sha)
})

test('reports a body that cannot be read', async () => {
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async () => ({
        ok: true,
        arrayBuffer: async () => { throw new Error('socket closed') },
      }),
    }),
    (error) => error instanceof ReleaseError && error.code === 'NETWORK',
  )
})

test('refuses a body larger than the cap when no length was declared', async () => {
  await assert.rejects(
    downloadRelease({
      tag: 'v1.2.0',
      target: 'x86_64-unknown-linux-musl',
      fetchImpl: async () => ({
        ok: true,
        arrayBuffer: async () => Buffer.alloc(1024 * 1024 + 1),
      }),
    }),
    (error) => error instanceof ReleaseError && error.code === 'TOO_LARGE',
  )
})

test('rejects an unknown edition and a missing target', async () => {
  await assert.rejects(
    downloadRelease({ tag: 'v1.2.0', edition: 'nope', target: 'x86_64-unknown-linux-musl' }),
    (error) => error instanceof ReleaseError && error.code === 'EDITION',
  )
  await assert.rejects(
    downloadRelease({ tag: 'v1.2.0', target: '' }),
    (error) => error instanceof ReleaseError && error.code === 'TARGET',
  )
})
