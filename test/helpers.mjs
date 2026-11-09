/**
 * Shared test fixtures. Not collected as a test file (`*.test.mjs` only).
 */

import { gzipSync } from 'node:zlib'

const BLOCK = 512

function octal(value, length) {
  const text = value.toString(8)
  if (text.length > length - 1) throw new Error(`value ${value} does not fit in ${length} bytes`)
  return `${'0'.repeat(length - 1 - text.length)}${text}\0`
}

function header(entry, size) {
  const buffer = Buffer.alloc(BLOCK, 0)
  buffer.write(String(entry.name).slice(0, 100), 0, 'utf8')
  buffer.write(octal(entry.mode ?? 0o644, 8), 100, 'ascii')
  buffer.write(octal(0, 8), 108, 'ascii')
  buffer.write(octal(0, 8), 116, 'ascii')
  buffer.write(octal(size, 12), 124, 'ascii')
  buffer.write(octal(0, 12), 136, 'ascii')
  buffer.fill(0x20, 148, 156)
  buffer[156] = String(entry.type ?? '0').charCodeAt(0)
  buffer.write('ustar\0', 257, 'ascii')
  buffer.write('00', 263, 'ascii')
  if (entry.prefix !== undefined) buffer.write(String(entry.prefix).slice(0, 155), 345, 'utf8')

  let sum = 0
  for (const byte of buffer) sum += byte
  buffer.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return buffer
}

/** Build an uncompressed tar stream. `declaredSize` can deliberately lie. */
export function tarBuffer(entries) {
  const blocks = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '')
    const size = entry.declaredSize ?? data.length
    blocks.push(header(entry, size))
    blocks.push(data)
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK))
  return Buffer.concat(blocks)
}

/** Build a gzipped tar archive. */
export function tarGz(entries) {
  return gzipSync(tarBuffer(entries))
}

/** A fake `rtk` executable for sidecar tests. */
export function rtkScript(version = '1.2.0') {
  return `#!/bin/sh
case "$1" in
  --version) printf '%s\\n' 'rtk ${version}'; exit 0 ;;
  rewrite) printf '%s' 'rtk git status'; exit 3 ;;
  *) exit 0 ;;
esac
`
}
