import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  compareVersions,
  formatVersion,
  isSupportedVersion,
  normalizeTag,
  parseRtkVersion,
  tagVersion,
} from '../lib/version.js'

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

test('compares versions numerically', () => {
  const version = (major, minor, patch) => ({ major, minor, patch })
  assert.equal(compareVersions(version(1, 2, 0), version(1, 1, 9)), 1)
  assert.equal(compareVersions(version(1, 2, 0), version(1, 2, 0)), 0)
  assert.equal(compareVersions(version(0, 9, 0), version(1, 0, 0)), -1)
  assert.equal(compareVersions(null, version(1, 0, 0)), 0)
})

test('rejects version-like objects with non-integer parts', () => {
  assert.equal(compareVersions({ major: 1.5, minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 }), 0)
  assert.equal(compareVersions({ major: '1', minor: 0, patch: 0 }, { major: 1, minor: 0, patch: 0 }), 0)
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

test('normalizes stable tags only', () => {
  assert.deepEqual(normalizeTag('1.2.0'), {
    tag: 'v1.2.0',
    text: '1.2.0',
    version: { major: 1, minor: 2, patch: 0 },
  })
  assert.equal(normalizeTag('v1.2.0').tag, 'v1.2.0')
  assert.equal(normalizeTag(' V1.2.0 ').tag, 'v1.2.0')
  assert.equal(normalizeTag('1.2'), null)
  assert.equal(normalizeTag('1.2.0-rc.1'), null)
  assert.equal(normalizeTag('latest'), null)
  assert.equal(normalizeTag(undefined), null)
})

test('extracts a version from a tag', () => {
  assert.deepEqual(tagVersion('v1.2.0'), { major: 1, minor: 2, patch: 0 })
  assert.equal(tagVersion('nope'), null)
})
