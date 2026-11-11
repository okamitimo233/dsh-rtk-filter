/**
 * Host-side status reader for the Settings → RTK page.
 *
 * The page deliberately reports RTK's own local tracking numbers instead of
 * re-counting calls in this plugin: RTK records every command it executes,
 * including the token estimate it compared against the wrapped command, and
 * `rtk gain` is the stable public reader for that database. Reading it on
 * demand keeps the numbers durable across Host restarts and useful on the
 * first page open (rather than starting from zero until the next bash call).
 *
 * The status route is a small same-origin JSON resource. It never exposes the
 * RTK binary path or command text; the page only needs the aggregate series,
 * the runtime health badge, and the user-selected range.
 */

import { abortError, describeError, isAbortError, runProcess } from './proc.js'

/** Exact HTTP path of the read-only status resource. */
export const STATUS_PATH = '/rtk-filter/status'

/** Default and maximum chart windows, in days. */
export const DEFAULT_STATUS_DAYS = 7
export const MAX_STATUS_DAYS = 90

const GAIN_TIMEOUT_MS = 5000
const GAIN_MAX_BUFFER = 4 * 1024 * 1024
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}

/** Convert a wire value into a bounded whole-day window. */
export function normalizeDays(value) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return DEFAULT_STATUS_DAYS
  return Math.min(MAX_STATUS_DAYS, Math.max(1, Math.trunc(parsed)))
}

/** UTC date key, matching the grouping key `rtk gain --daily` uses. */
export function dayKey(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * Build an inclusive list of UTC date keys ending on `now`'s UTC day.
 * @param {number} days - number of dates to produce.
 * @param {Date} now - clock used for the window end.
 * @returns {string[]} ascending date keys.
 */
export function dayKeys(days, now) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const keys = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end)
    date.setUTCDate(date.getUTCDate() - offset)
    keys.push(dayKey(date))
  }
  return keys
}

function count(value) {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function emptyDay(date) {
  return {
    date,
    calls: 0,
    savedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    savingsPct: 0,
  }
}

/**
 * Fold an `rtk gain --daily --format json` answer into the page's payload.
 *
 * RTK returns only days with activity. The chart is easier to read when every
 * day in the selected window is present, so missing dates become zero rows.
 * Summary values are recomputed from the same window instead of reusing RTK's
 * all-time summary.
 *
 * @param {unknown} gain - parsed gain JSON.
 * @param {{ days?: unknown, now?: Date }} options - selected window.
 * @returns {{
 *   range: { days: number, from: string, to: string },
 *   summary: { calls: number, savedTokens: number, inputTokens: number,
 *     outputTokens: number, savingsPct: number, avgSavedPerCall: number },
 *   daily: Array<{ date: string, calls: number, savedTokens: number,
 *     inputTokens: number, outputTokens: number, savingsPct: number }>
 * }}
 */
export function aggregateGain(gain, { days = DEFAULT_STATUS_DAYS, now = new Date() } = {}) {
  const windowDays = normalizeDays(days)
  const keys = dayKeys(windowDays, now)
  const byDate = new Map(keys.map((date) => [date, emptyDay(date)]))

  const rows = Array.isArray(gain?.daily) ? gain.daily : []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const date = typeof row.date === 'string' ? row.date.slice(0, 10) : ''
    const target = byDate.get(date)
    if (target === undefined) continue
    target.calls += count(row.commands)
    target.inputTokens += count(row.input_tokens)
    target.outputTokens += count(row.output_tokens)
    target.savedTokens += count(row.saved_tokens)
  }

  const daily = keys.map((date) => {
    const row = byDate.get(date)
    row.savingsPct = row.inputTokens > 0 ? (row.savedTokens / row.inputTokens) * 100 : 0
    return row
  })

  let calls = 0
  let savedTokens = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const row of daily) {
    calls += row.calls
    savedTokens += row.savedTokens
    inputTokens += row.inputTokens
    outputTokens += row.outputTokens
  }

  return {
    range: {
      days: windowDays,
      from: keys[0],
      to: keys[keys.length - 1],
    },
    summary: {
      calls,
      savedTokens,
      inputTokens,
      outputTokens,
      savingsPct: inputTokens > 0 ? (savedTokens / inputTokens) * 100 : 0,
      avgSavedPerCall: calls > 0 ? savedTokens / calls : 0,
    },
    daily,
  }
}

/** Run the managed RTK binary's public gain reader and parse its JSON answer. */
export async function runGain({ binary, timeoutMs = GAIN_TIMEOUT_MS, signal }) {
  if (typeof binary !== 'string' || binary.trim() === '') {
    throw new Error('RTK binary is not ready')
  }
  const { error, stdout, stderr } = await runProcess(
    binary,
    ['gain', '--daily', '--format', 'json'],
    {
      timeout: timeoutMs,
      maxBuffer: GAIN_MAX_BUFFER,
      ...(signal !== undefined ? { signal } : {}),
    },
  )
  if (error) {
    if (isAbortError(error)) throw abortError('RTK gain was aborted')
    const detail = stderr.trim()
    throw new Error(detail !== '' ? `rtk gain failed: ${detail}` : `rtk gain failed: ${error.message}`)
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error('rtk gain returned invalid JSON')
  }
}

/**
 * Read and fold one window's worth of RTK gain data.
 * @param {{ binary?: string, days?: unknown, now?: Date, run?: typeof runGain }} options
 * @returns {Promise<ReturnType<typeof aggregateGain>>}
 */
export async function readGainStatus({ binary, days = DEFAULT_STATUS_DAYS, now = new Date(), run = runGain } = {}) {
  const gain = await run({ binary })
  return aggregateGain(gain, { days, now })
}

/** Send one JSON answer without importing a framework into the Host entry. */
function sendJson(res, status, payload, headOnly = false) {
  res.statusCode = status
  for (const [name, value] of Object.entries(JSON_HEADERS)) res.setHeader(name, value)
  if (headOnly) {
    res.end()
    return
  }
  res.end(JSON.stringify(payload))
}

/**
 * Register the read-only status route.
 *
 * The returned disposer is owned by the caller's Cordis effect. The route is
 * fenced by `ctx.connection.requestRejection` when that service is composed;
 * without a Connection service (headless/embedded contexts) it still answers
 * only the aggregate payload, which contains no paths or command text.
 *
 * @param {object} options
 * @param {object} options.ctx - activation context, used only for the trust fence.
 * @param {{ register: Function }} options.webServer - HTTP route registry.
 * @param {() => object} options.getRuntime - current RTK health projection.
 * @param {() => string | undefined} options.getBinary - current managed binary.
 * @param {typeof readGainStatus} [options.readStatus] - injectable reader.
 * @param {() => Date} [options.now] - injectable clock.
 * @returns {() => void} route disposer.
 */
export function registerStatusRoute({
  ctx,
  webServer,
  getRuntime,
  getBinary,
  readStatus = readGainStatus,
  now = () => new Date(),
}) {
  return webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      let rejection
      try {
        rejection = ctx?.get?.('connection')?.requestRejection?.(req)
      } catch {
        rejection = 403
      }
      if (typeof rejection === 'number') {
        res.statusCode = rejection
        res.end()
        return
      }

      const headOnly = req.method === 'HEAD'
      if (req.method !== 'GET' && !headOnly) {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }

      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const days = normalizeDays(url.searchParams.get('days'))
      const generatedAt = now()
      let runtime
      try {
        runtime = getRuntime()
      } catch {
        runtime = { state: 'unavailable', version: null, source: null }
      }

      let stats
      let statsError
      try {
        stats = await readStatus({ binary: getBinary?.(), days, now: generatedAt })
      } catch (error) {
        stats = aggregateGain({ daily: [] }, { days, now: generatedAt })
        // Keep paths and command text on the Host: the browser only needs the
        // stable code to render its "history unavailable" notice.
        statsError = 'stats-unavailable'
        try {
          ctx?.logger?.warn?.(`[rtk] status read failed: ${describeError(error)}`)
        } catch {
          // Diagnostics never make the status resource fail.
        }
      }

      sendJson(
        res,
        200,
        {
          ok: true,
          generatedAt: generatedAt.toISOString(),
          range: stats.range,
          runtime,
          summary: stats.summary,
          daily: stats.daily,
          statsError: statsError ?? null,
        },
        headOnly,
      )
    },
  })
}
