import { test } from 'node:test'
import assert from 'node:assert/strict'

import { abortError, describeError, isAbortError, runProcess } from '../lib/proc.js'

test('isAbortError accepts both cancellation shapes and nothing else', () => {
  assert.equal(isAbortError(undefined), false)
  assert.equal(isAbortError(null), false)
  assert.equal(isAbortError({}), false)
  assert.equal(isAbortError({ name: 'AbortError' }), true)
  assert.equal(isAbortError({ code: 'ABORT_ERR' }), true)
  assert.equal(isAbortError({ name: 'Error', code: 'ENOENT' }), false)
})

test('abortError builds the canonical cancellation error', () => {
  const defaulted = abortError('cancelled')
  assert.equal(defaulted.name, 'AbortError')
  assert.equal(defaulted.code, 'ABORT_ERR')
  assert.equal(defaulted.message, 'cancelled')

  const coded = abortError('tool call aborted', 'ABORTED')
  assert.equal(coded.code, 'ABORTED')
})

test('describeError renders non-Error values', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.equal(describeError('boom'), 'boom')
  assert.equal(describeError(42), '42')
})

test('runProcess collects a completed child', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'])
  assert.equal(result.error, undefined)
  assert.equal(result.stdout, 'out')
  assert.equal(result.stderr, 'err')
})

test('runProcess reports a non-string encoding as empty streams', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("out")'], { encoding: 'buffer' })
  assert.equal(result.error, undefined)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})
