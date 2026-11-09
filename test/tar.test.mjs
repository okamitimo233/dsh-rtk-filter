import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'

import { extractFromTarGz, TarError } from '../lib/tar.js'
import { tarBuffer, tarGz } from './helpers.mjs'

test('extracts the requested regular files', () => {
  const archive = tarGz([
    { name: 'rtk', data: 'binary', mode: 0o755 },
    { name: 'LICENSE', data: 'Apache-2.0' },
    { name: 'LICENSE-ENGINE', data: 'BUSL-1.1' },
  ])
  const files = extractFromTarGz(archive, ['rtk', 'LICENSE'])
  assert.equal(files.get('rtk').toString(), 'binary')
  assert.equal(files.get('LICENSE').toString(), 'Apache-2.0')
  assert.equal(files.has('LICENSE-ENGINE'), false)
})

test('returns an empty map when a wanted file is absent', () => {
  const archive = tarGz([{ name: 'LICENSE', data: 'text' }])
  assert.equal(extractFromTarGz(archive, ['rtk']).size, 0)
})

test('reads ustar prefix paths', () => {
  const archive = tarGz([{ name: 'rtk', prefix: 'deep', data: 'binary' }])
  assert.equal(extractFromTarGz(archive, ['deep/rtk']).get('deep/rtk').toString(), 'binary')
})

test('rejects absolute and escaping paths', () => {
  assert.throws(
    () => extractFromTarGz(tarGz([{ name: '../rtk', data: 'binary' }]), ['rtk']),
    (error) => error instanceof TarError && error.code === 'TRAVERSAL',
  )
  assert.throws(
    () => extractFromTarGz(tarGz([{ name: '/rtk', data: 'binary' }]), ['rtk']),
    (error) => error instanceof TarError && error.code === 'TRAVERSAL',
  )
})

test('rejects a non-regular entry with a wanted name', () => {
  assert.throws(
    () => extractFromTarGz(tarGz([{ name: 'rtk', type: '2', data: '' }]), ['rtk']),
    (error) => error instanceof TarError && error.code === 'TYPE',
  )
})

test('rejects duplicate wanted entries', () => {
  assert.throws(
    () => extractFromTarGz(tarGz([
      { name: 'rtk', data: 'one' },
      { name: 'rtk', data: 'two' },
    ]), ['rtk']),
    (error) => error instanceof TarError && error.code === 'DUPLICATE',
  )
})

test('rejects declared sizes past the archive end', () => {
  const raw = tarBuffer([{ name: 'rtk', declaredSize: 100, data: 'abc' }])
  const truncated = raw.subarray(0, 512 + 3)
  assert.throws(
    () => extractFromTarGz(gzipSync(truncated), ['rtk']),
    (error) => error instanceof TarError && error.code === 'TRUNCATED',
  )
})

test('rejects a corrupted header checksum', () => {
  const raw = tarBuffer([{ name: 'rtk', data: 'binary' }])
  raw[10] = 'x'.charCodeAt(0)
  assert.throws(
    () => extractFromTarGz(gzipSync(raw), ['rtk']),
    (error) => error instanceof TarError && error.code === 'CHECKSUM',
  )
})

test('rejects a wanted file above the configured cap', () => {
  const archive = tarGz([{ name: 'rtk', data: 'too large' }])
  assert.throws(
    () => extractFromTarGz(archive, ['rtk'], { maxFileBytes: 2 }),
    (error) => error instanceof TarError && error.code === 'TOO_LARGE',
  )
})

test('skips PAX metadata records', () => {
  const archive = tarGz([
    { name: 'PaxHeaders/rtk', type: 'x', data: 'path=rtk\n' },
    { name: 'rtk', data: 'binary' },
  ])
  assert.equal(extractFromTarGz(archive, ['rtk']).get('rtk').toString(), 'binary')
})

test('rejects a non-gzip payload', () => {
  assert.throws(
    () => extractFromTarGz(Buffer.from('not gzip'), ['rtk']),
    (error) => error instanceof TarError && error.code === 'GZIP',
  )
})
