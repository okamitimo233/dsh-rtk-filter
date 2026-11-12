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

const BLOCK = 512

/** Rewrite header bytes 148..155 with a checksum that matches `header`. */
function repairChecksum(header, { signed = false } = {}) {
  header.fill(0x20, 148, 156)
  let sum = 0
  for (const byte of header) sum += signed && byte > 0x7f ? byte - 0x100 : byte
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
}

test('rejects a base-256 numeric header field', () => {
  const raw = tarBuffer([{ name: 'rtk', data: 'x' }])
  raw[124] = 0x80
  repairChecksum(raw.subarray(0, BLOCK))
  assert.throws(
    () => extractFromTarGz(gzipSync(raw), ['rtk']),
    (error) => error instanceof TarError && error.code === 'UNSUPPORTED',
  )
})

test('rejects a non-octal numeric header field', () => {
  const raw = tarBuffer([{ name: 'rtk', data: 'x' }])
  raw.write('abc\0', 124, 'ascii')
  repairChecksum(raw.subarray(0, BLOCK))
  assert.throws(
    () => extractFromTarGz(gzipSync(raw), ['rtk']),
    (error) => error instanceof TarError && error.code === 'FORMAT',
  )
})

test('treats an empty numeric field as zero', () => {
  const raw = tarBuffer([{ name: 'rtk', data: '' }])
  raw.fill(0, 124, 136)
  repairChecksum(raw.subarray(0, BLOCK))
  const files = extractFromTarGz(gzipSync(raw), ['rtk'])
  assert.equal(files.get('rtk').length, 0)
})

test('accepts a signed header checksum', () => {
  const name = `${'a'.repeat(90)}é`
  const raw = tarBuffer([{ name, data: 'binary' }])
  repairChecksum(raw.subarray(0, BLOCK), { signed: true })
  assert.equal(extractFromTarGz(gzipSync(raw), [name]).get(name).toString(), 'binary')
})

test('reads a name field without a NUL terminator', () => {
  const name = 'a'.repeat(100)
  const archive = tarGz([{ name, data: 'binary' }])
  assert.equal(extractFromTarGz(archive, [name]).get(name).toString(), 'binary')
})

test('strips leading ./ from entry names', () => {
  const archive = tarGz([{ name: './rtk', data: 'binary' }])
  assert.equal(extractFromTarGz(archive, ['rtk']).get('rtk').toString(), 'binary')
})

test('rejects an entry with an empty name', () => {
  assert.throws(
    () => extractFromTarGz(tarGz([{ name: '', data: 'x' }]), ['rtk']),
    (error) => error instanceof TarError && error.code === 'FORMAT',
  )
})

test('treats a NUL type byte as a regular file', () => {
  const archive = tarGz([{ name: 'rtk', type: '\0', data: 'binary' }])
  assert.equal(extractFromTarGz(archive, ['rtk']).get('rtk').toString(), 'binary')
})

test('rejects GNU long-name entries', () => {
  assert.throws(
    () => extractFromTarGz(tarGz([{ name: 'longname', type: 'L', data: 'x' }]), ['rtk']),
    (error) => error instanceof TarError && error.code === 'UNSUPPORTED',
  )
})

test('rejects an archive with too many entries', () => {
  const archive = tarGz([
    { name: 'a', data: '1' },
    { name: 'b', data: '2' },
  ])
  assert.throws(
    () => extractFromTarGz(archive, ['a'], { maxEntries: 1 }),
    (error) => error instanceof TarError && error.code === 'TOO_LARGE',
  )
})

test('rejects an archive that expands beyond the output cap', () => {
  const archive = tarGz([{ name: 'rtk', data: 'x'.repeat(100_000) }])
  assert.throws(
    () => extractFromTarGz(archive, ['rtk'], { maxOutputBytes: 128 }),
    (error) => error instanceof TarError && error.code === 'TOO_LARGE',
  )
})
