import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

import { awarenessText, shellOnlyNote } from '../lib/awareness.js'
import {
  acceptsPresetShell,
  composeAwareness,
  deriveShellProfile,
  describeShellProfile,
  withRtkPath,
} from '../lib/shell.js'

/** The persistent bash the `minimal` preset composes: only `command`. */
function persistentBash() {
  return {
    name: 'bash',
    description: 'Run commands in a bash shell',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  }
}

/** The one-shot bash a standard preset composes: `description` required. */
function standardBash() {
  return {
    name: 'bash',
    description: 'Execute a bash command',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        command: { type: 'string' },
        workdir: { type: 'string' },
      },
      required: ['description', 'command'],
    },
  }
}

test('derives the command-only profile of a persistent shell', () => {
  const profile = deriveShellProfile(persistentBash())
  assert.equal(profile.commandOnly, true)
  assert.deepEqual(profile.required, ['command'])
  assert.deepEqual(profile.properties, ['command'])
  assert.equal(profile.description, 'Run commands in a bash shell')
})

test('derives the standard profile of a one-shot shell', () => {
  const profile = deriveShellProfile(standardBash())
  assert.equal(profile.commandOnly, false)
  assert.deepEqual(profile.required, ['description', 'command'])
  assert.deepEqual(profile.properties, ['description', 'command', 'workdir'])
})

test('derives a custom profile for a shape this plugin does not know', () => {
  const empty = deriveShellProfile({ description: 'no parameters' })
  assert.equal(empty.commandOnly, false)
  assert.deepEqual(empty.required, [])
  assert.deepEqual(empty.properties, [])

  assert.equal(deriveShellProfile(undefined).commandOnly, false)

  const truncated = deriveShellProfile({ description: 'x'.repeat(100) })
  assert.equal(truncated.description.length, 40)
})

test('accepts the persistent shell for the minimal preset', () => {
  assert.equal(acceptsPresetShell(deriveShellProfile(persistentBash()), 'minimal'), true)
})

test('rejects a standard shell for the minimal preset', () => {
  assert.equal(acceptsPresetShell(deriveShellProfile(standardBash()), 'minimal'), false)
})

test('accepts any shape for a preset that has no policy', () => {
  const standard = deriveShellProfile(standardBash())
  assert.equal(acceptsPresetShell(standard, 'standard'), true)
  assert.equal(acceptsPresetShell(standard, 'ops-ptc'), true)
  assert.equal(acceptsPresetShell(standard, undefined), true)
  // Subset semantics: a definition that declares no fields is still accepted,
  // exactly as the pre-consolidation guard behaved.
  assert.equal(acceptsPresetShell(deriveShellProfile({}), 'minimal'), true)
})

test('describes a profile for logs', () => {
  assert.equal(
    describeShellProfile(deriveShellProfile(persistentBash())),
    'bash "Run commands in a bash shell" (command)',
  )
  assert.equal(
    describeShellProfile(deriveShellProfile(standardBash())),
    'bash "Execute a bash command" (description,command,workdir)',
  )
})

test('the PATH overlay leaves the command untouched without a prefix', () => {
  assert.equal(withRtkPath('echo hi', undefined), 'echo hi')
  assert.equal(withRtkPath('echo hi', ''), 'echo hi')
  assert.equal(withRtkPath('/usr/bin/rtk --version'), '/usr/bin/rtk --version')
})

test('the PATH overlay prepends the managed directory once and keeps the command', () => {
  assert.equal(
    withRtkPath('rtk git status', '/cache/rtk-filter/versions/rtk/1.2.0'),
    `__rtk_prefix='/cache/rtk-filter/versions/rtk/1.2.0'; case ":$PATH:" in *":$__rtk_prefix:"*) ;; *) export PATH="$__rtk_prefix:$PATH" ;; esac; rtk git status`,
  )
})

test('the PATH overlay quotes embedded single quotes', () => {
  assert.equal(
    withRtkPath('rtk gain', "/cache/it's-rtk"),
    `__rtk_prefix='/cache/it'\\''s-rtk'; case ":$PATH:" in *":$__rtk_prefix:"*) ;; *) export PATH="$__rtk_prefix:$PATH" ;; esac; rtk gain`,
  )
})

test('the PATH overlay keeps PATH stable when a persistent shell runs it twice', { skip: process.platform === 'win32' }, () => {
  const overlay = withRtkPath('', '/cache/rtk')
  const out = execFileSync('bash', ['-c', `${overlay}${overlay}printf '%s' "$PATH"`], { encoding: 'utf8' })
  const entries = out.split(':').filter((entry) => entry === '/cache/rtk')
  assert.equal(entries.length, 1)
})

test('composes the command-only caveat only for a command-only shell', () => {
  assert.equal(
    composeAwareness(deriveShellProfile(persistentBash())),
    `${awarenessText} ${shellOnlyNote}`,
  )
  assert.match(composeAwareness(deriveShellProfile(persistentBash())), /cd \/path/)

  assert.equal(composeAwareness(deriveShellProfile(standardBash())), awarenessText)
  assert.doesNotMatch(composeAwareness(deriveShellProfile(standardBash())), /cd \/path/)

  // The global section has no shell profile: it composes the base text.
  assert.equal(composeAwareness(), awarenessText)
  assert.equal(composeAwareness(undefined), awarenessText)
})
