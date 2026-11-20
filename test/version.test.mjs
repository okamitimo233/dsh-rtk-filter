import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatVersion, isSupportedVersion, parseRtkVersion } from '../lib/version.js'

test('parses the version out of rtk output', () => {
  assert.deepEqual(parseRtkVersion('rtk 1.2.0\n'), {
    major: 1,
    minor: 2,
    patch: 0,
    raw: 'rtk 1.2.0',
  })
  assert.deepEqual(parseRtkVersion('v0.49.0'), {
    major: 0,
    minor: 49,
    patch: 0,
    raw: 'v0.49.0',
  })
  assert.equal(parseRtkVersion('no version here'), null)
  assert.equal(parseRtkVersion(undefined), null)
})

test('rejects version-like objects with non-integer parts', () => {
  assert.equal(formatVersion({ major: 1, minor: Number.NaN, patch: 0 }), undefined)
  assert.equal(isSupportedVersion({ major: 1, minor: 0 }), false)
})

test('the rewrite protocol needs 0.23.0 or newer', () => {
  const version = (major, minor, patch) => ({ major, minor, patch })
  assert.equal(isSupportedVersion(version(0, 22, 0)), false)
  assert.equal(isSupportedVersion(version(0, 23, 0)), true)
  assert.equal(isSupportedVersion(version(0, 49, 0)), true)
  assert.equal(isSupportedVersion(version(1, 0, 0)), true)
  assert.equal(isSupportedVersion(null), false)
})

test('formats a version object', () => {
  assert.equal(formatVersion({ major: 1, minor: 2, patch: 3 }), '1.2.3')
  assert.equal(formatVersion(undefined), undefined)
})
