/**
 * Minimal, defensive tar.gz reader for release archives.
 *
 * RTK ships `.tar.gz` assets containing a single executable (`rtk`) plus
 * license texts. Extracting with Node built-ins keeps the plugin free of
 * dependencies and of shell calls, and lets us reject unsafe archives before
 * any file is written.
 */

import { gunzipSync } from 'node:zlib'

import { describeError } from './proc.js'

const BLOCK = 512
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 1024

/** Failure while reading or validating an archive. */
export class TarError extends Error {
  /**
   * @param {string} code - stable category such as `CHECKSUM` or `TRAVERSAL`.
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'TarError'
    this.code = code
  }
}

function readString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

function parseOctal(buffer, start, length, label) {
  if ((buffer[start] & 0x80) !== 0) {
    throw new TarError('UNSUPPORTED', `${label} uses a base-256 number`)
  }
  const text = buffer.subarray(start, start + length).toString('latin1').replace(/\0.*$/, '').trim()
  if (text === '') return 0
  if (!/^[0-7]+$/.test(text)) {
    throw new TarError('FORMAT', `${label} is not an octal number`)
  }
  return Number.parseInt(text, 8)
}

function checksumOf(header) {
  let unsigned = 0
  let signed = 0
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index]
    unsigned += byte
    signed += byte > 0x7f ? byte - 0x100 : byte
  }
  return { unsigned, signed }
}

function verifyHeader(header, offset) {
  const expected = parseOctal(header, 148, 8, 'header checksum')
  const { unsigned, signed } = checksumOf(header)
  if (expected !== unsigned && expected !== signed) {
    throw new TarError('CHECKSUM', `tar header at byte ${offset} has an invalid checksum`)
  }
}

function normalizeEntryName(raw) {
  let name = raw
  while (name.startsWith('./')) name = name.slice(2)
  if (name === '') throw new TarError('FORMAT', 'tar entry has an empty name')
  if (name.startsWith('/')) throw new TarError('TRAVERSAL', `tar entry "${name}" is absolute`)
  if (name.split('/').includes('..')) {
    throw new TarError('TRAVERSAL', `tar entry "${name}" escapes the archive root`)
  }
  return name
}

function isZeroBlock(header) {
  for (let index = 0; index < BLOCK; index += 1) {
    if (header[index] !== 0) return false
  }
  return true
}

/**
 * Extract selected regular files from a gzipped tar archive.
 *
 * @param {Buffer | Uint8Array} archive - the complete `.tar.gz` bytes.
 * @param {string[]} names - file names to return, such as `['rtk', 'LICENSE']`.
 * @param {{ maxOutputBytes?: number, maxFileBytes?: number, maxEntries?: number }} [options]
 * @returns {Map<string, Buffer>} found files; the caller decides which are required.
 */
export function extractFromTarGz(archive, names, options = {}) {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES
  const maxEntries = options.maxEntries ?? MAX_ENTRIES
  const wanted = new Set(names)

  let data
  try {
    data = gunzipSync(archive, { maxOutputLength: maxOutputBytes })
  } catch (error) {
    if (error?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new TarError('TOO_LARGE', `archive expands beyond ${maxOutputBytes} bytes`)
    }
    throw new TarError('GZIP', `could not decompress the archive: ${describeError(error)}`)
  }

  const found = new Map()
  let offset = 0
  let entries = 0
  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break

    if (entries >= maxEntries) {
      throw new TarError('TOO_LARGE', `archive has more than ${maxEntries} entries`)
    }
    entries += 1

    verifyHeader(header, offset)
    const size = parseOctal(header, 124, 12, 'entry size')

    const nameField = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const name = normalizeEntryName(prefix === '' ? nameField : `${prefix}/${nameField}`)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])

    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > data.length) {
      throw new TarError('TRUNCATED', `tar entry "${name}" extends past the archive`)
    }
    const paddedEnd = dataStart + Math.ceil(size / BLOCK) * BLOCK

    if (type === 'L' || type === 'K') {
      throw new TarError('UNSUPPORTED', 'GNU long-name tar entries are not supported')
    }
    if (type === 'x' || type === 'g') {
      offset = paddedEnd
      continue
    }
    if (wanted.has(name)) {
      if (type !== '0' && type !== '\0') {
        throw new TarError('TYPE', `tar entry "${name}" is not a regular file`)
      }
      if (size > maxFileBytes) {
        throw new TarError('TOO_LARGE', `tar entry "${name}" is larger than ${maxFileBytes} bytes`)
      }
      if (found.has(name)) {
        throw new TarError('DUPLICATE', `tar archive contains "${name}" more than once`)
      }
      found.set(name, Buffer.from(data.subarray(dataStart, dataEnd)))
    }

    offset = paddedEnd
  }

  return found
}
