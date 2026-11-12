import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  aggregateGain,
  buildStatusPayload,
  dayKeys,
  normalizeDays,
  projectRuntime,
  readGainStatus,
  readRuntimeSafe,
  registerStatusRoute,
  resolveRequestRejection,
  runGain,
  STATUS_PATH,
} from '../lib/status.js'

const dir = mkdtempSync(join(tmpdir(), 'rtk-dsh-status-'))

after(() => rmSync(dir, { recursive: true, force: true }))

function fake(name, body) {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

const gainRtk = fake('rtk-gain', `printf '%s' '{"daily":[{"date":"2026-11-10","commands":2}]}'`)
const failRtk = fake('rtk-fail', "echo 'boom' >&2; exit 2")
const quietRtk = fake('rtk-quiet', 'exit 3')
const junkRtk = fake('rtk-junk', "printf '%s' 'not json'")
const slowRtk = fake('rtk-slow', 'sleep 2')

const NOW = new Date('2026-11-10T06:30:00.000Z')

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body
    },
  }
}

function captureRoute(overrides = {}) {
  const routes = []
  const calls = []
  registerStatusRoute({
    ctx: { get: () => undefined },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    getRuntime: () => ({ state: 'ready', version: '1.2.0', source: 'managed' }),
    getBinary: () => '/managed/rtk',
    readStatus: async (input) => {
      calls.push(input)
      return aggregateGain({ daily: [] }, { days: input.days, now: NOW })
    },
    now: () => NOW,
    ...overrides,
  })
  return { route: routes[0], calls }
}

test('normalizeDays bounds the chart window', () => {
  assert.equal(normalizeDays(undefined), 7)
  assert.equal(normalizeDays('30'), 30)
  assert.equal(normalizeDays('0'), 1)
  assert.equal(normalizeDays('999'), 90)
  assert.equal(normalizeDays('nope'), 7)
})

test('dayKeys returns an inclusive ascending UTC window', () => {
  assert.deepEqual(dayKeys(3, NOW), ['2026-11-08', '2026-11-09', '2026-11-10'])
})

test('aggregateGain fills missing days and recomputes the window summary', () => {
  const stats = aggregateGain({
    daily: [
      {
        date: '2026-11-08',
        commands: 2,
        input_tokens: 1000,
        output_tokens: 250,
        saved_tokens: 750,
      },
      {
        date: '2026-11-09',
        commands: 3,
        input_tokens: 2000,
        output_tokens: 500,
        saved_tokens: 1500,
      },
      {
        date: '2026-10-01',
        commands: 99,
        input_tokens: 9999,
        output_tokens: 0,
        saved_tokens: 9999,
      },
    ],
  }, { days: 3, now: NOW })

  assert.deepEqual(stats.range, { days: 3, from: '2026-11-08', to: '2026-11-10' })
  assert.equal(stats.daily.length, 3)
  assert.equal(stats.daily[0].calls, 2)
  assert.equal(stats.daily[1].savedTokens, 1500)
  assert.deepEqual(stats.daily[2], {
    date: '2026-11-10',
    calls: 0,
    savedTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    savingsPct: 0,
  })
  assert.deepEqual(stats.summary, {
    calls: 5,
    savedTokens: 2250,
    inputTokens: 3000,
    outputTokens: 750,
    savingsPct: 75,
    avgSavedPerCall: 450,
  })
})

test('aggregateGain coalesces duplicate same-day rows', () => {
  const stats = aggregateGain({
    daily: [
      { date: '2026-11-10', commands: 1, input_tokens: 100, output_tokens: 50, saved_tokens: 50 },
      { date: '2026-11-10', commands: 1, input_tokens: 100, output_tokens: 25, saved_tokens: 75 },
    ],
  }, { days: 1, now: NOW })
  assert.equal(stats.summary.calls, 2)
  assert.equal(stats.summary.savedTokens, 125)
  assert.equal(stats.daily[0].savingsPct, 62.5)
})

test('readGainStatus passes the binary through and folds the gain answer', async () => {
  let calledWith
  const stats = await readGainStatus({
    binary: '/managed/rtk',
    days: 7,
    now: NOW,
    run: async (input) => {
      calledWith = input
      return {
        daily: [{
          date: '2026-11-10',
          commands: 4,
          input_tokens: 400,
          output_tokens: 100,
          saved_tokens: 300,
        }],
      }
    },
  })

  assert.equal(calledWith.binary, '/managed/rtk')
  assert.equal(stats.range.days, 7)
  assert.equal(stats.summary.calls, 4)
  assert.equal(stats.summary.savedTokens, 300)
})

test('the status route answers JSON and marks HEAD as bodyless', async () => {
  const routes = []
  const webServer = {
    register(route) {
      routes.push(route)
      return () => {}
    },
  }
  const dispose = registerStatusRoute({
    ctx: { get: () => undefined },
    webServer,
    getRuntime: () => ({ state: 'ready', version: '1.2.0', source: 'managed' }),
    getBinary: () => '/managed/rtk',
    readStatus: async () => aggregateGain({ daily: [] }, { days: 7, now: NOW }),
    now: () => NOW,
  })

  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, STATUS_PATH)
  const getRes = response()
  await routes[0].handler({ method: 'GET', url: '/rtk-filter/status?days=7', headers: {} }, getRes)
  assert.equal(getRes.statusCode, 200)
  assert.match(getRes.headers['content-type'], /application\/json/)
  const payload = JSON.parse(getRes.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.runtime.state, 'ready')
  assert.equal(payload.daily.length, 7)
  assert.equal(payload.statsError, null)

  const headRes = response()
  await routes[0].handler({ method: 'HEAD', url: '/rtk-filter/status?days=30', headers: {} }, headRes)
  assert.equal(headRes.statusCode, 200)
  assert.equal(headRes.body, undefined)

  dispose()
})

test('the status route reports stats failure without losing runtime health', async () => {
  const routes = []
  registerStatusRoute({
    ctx: { get: () => undefined },
    webServer: { register(route) { routes.push(route); return () => {} } },
    getRuntime: () => ({ state: 'installing', version: null, source: null }),
    getBinary: () => undefined,
    readStatus: async () => { throw new Error('rtk gain failed') },
    now: () => NOW,
  })

  const res = response()
  await routes[0].handler({ method: 'GET', url: '/rtk-filter/status', headers: {} }, res)
  const payload = JSON.parse(res.body)
  assert.equal(payload.runtime.state, 'installing')
  assert.equal(payload.summary.calls, 0)
  assert.equal(payload.statsError, 'stats-unavailable')
})

test('the status route honors Connection rejection and method limits', async () => {
  const routes = []
  registerStatusRoute({
    ctx: { get: () => ({ requestRejection: () => 403 }) },
    webServer: { register(route) { routes.push(route); return () => {} } },
    getRuntime: () => ({ state: 'ready', version: '1.2.0', source: 'managed' }),
    getBinary: () => '/managed/rtk',
    readStatus: async () => aggregateGain({ daily: [] }, { days: 7, now: NOW }),
    now: () => NOW,
  })

  const denied = response()
  await routes[0].handler({ method: 'GET', url: '/rtk-filter/status', headers: {} }, denied)
  assert.equal(denied.statusCode, 403)

  const deniedAgain = response()
  const ctx = { get: () => ({ requestRejection: () => undefined }) }
  const route = routes[0]
  await registerStatusRoute({
    ctx,
    webServer: { register(registered) { route.handler = registered.handler; return () => {} } },
    getRuntime: () => ({ state: 'ready', version: '1.2.0', source: 'managed' }),
    getBinary: () => '/managed/rtk',
    readStatus: async () => aggregateGain({ daily: [] }, { days: 7, now: NOW }),
    now: () => NOW,
  })
  await route.handler({ method: 'POST', url: '/rtk-filter/status', headers: {} }, deniedAgain)
  assert.equal(deniedAgain.statusCode, 405)
  assert.equal(deniedAgain.headers.allow, 'GET, HEAD')
})

test('normalizeDays clamps negatives, decimals, and non-finite values', () => {
  assert.equal(normalizeDays(-5), 1)
  assert.equal(normalizeDays(7.9), 7)
  assert.equal(normalizeDays('7.9'), 7)
  assert.equal(normalizeDays(Infinity), 7)
  assert.equal(normalizeDays(''), 7)
  assert.equal(normalizeDays(null), 7)
  assert.equal(normalizeDays(90), 90)
})

test('dayKeys walks across month and year boundaries', () => {
  assert.deepEqual(dayKeys(4, new Date('2026-03-01T00:00:00.000Z')), [
    '2026-02-26',
    '2026-02-27',
    '2026-02-28',
    '2026-03-01',
  ])
  assert.deepEqual(dayKeys(2, new Date('2027-01-01T00:00:00.000Z')), ['2026-12-31', '2027-01-01'])
  assert.deepEqual(dayKeys(3, new Date('2028-03-01T00:00:00.000Z')), [
    '2028-02-28',
    '2028-02-29',
    '2028-03-01',
  ])
})

test('aggregateGain tolerates a malformed gain answer', () => {
  assert.equal(aggregateGain(undefined, { days: 2, now: NOW }).daily.length, 2)
  assert.equal(aggregateGain({ daily: 'nope' }, { days: 2, now: NOW }).summary.calls, 0)

  const stats = aggregateGain({
    daily: [
      null,
      42,
      { date: null, commands: 5 },
      { date: '2026-10-01', commands: 9 },
      { date: '2026-11-10', commands: 2.9, input_tokens: 10.9, output_tokens: '20', saved_tokens: -4 },
      { date: '2026-11-10', commands: 1, input_tokens: 100, output_tokens: 50, saved_tokens: 50 },
    ],
  }, { days: 1, now: NOW })

  assert.equal(stats.daily.length, 1)
  assert.equal(stats.daily[0].date, '2026-11-10')
  assert.equal(stats.daily[0].calls, 3)
  assert.equal(stats.daily[0].inputTokens, 110)
  assert.equal(stats.daily[0].outputTokens, 50)
  assert.equal(stats.daily[0].savedTokens, 50)
  assert.equal(stats.daily[0].savingsPct, (50 / 110) * 100)
})

test('aggregateGain defaults to a seven-day window ending today', () => {
  const stats = aggregateGain({ daily: [] })
  assert.equal(stats.range.days, 7)
  assert.equal(stats.daily.length, 7)
  assert.equal(stats.range.from, stats.daily[0].date)
  assert.equal(stats.range.to, stats.daily[6].date)
  assert.equal(stats.summary.avgSavedPerCall, 0)
})

test('buildStatusPayload shapes the wire body and normalizes statsError', () => {
  const stats = aggregateGain({
    daily: [{ date: '2026-11-10', commands: 2, input_tokens: 100, output_tokens: 25, saved_tokens: 75 }],
  }, { days: 2, now: NOW })
  const runtime = { state: 'ready', version: '1.2.0', source: 'managed' }
  const payload = buildStatusPayload({ runtime, stats, generatedAt: NOW })

  assert.deepEqual(payload, {
    ok: true,
    generatedAt: NOW.toISOString(),
    range: { days: 2, from: '2026-11-09', to: '2026-11-10' },
    runtime,
    summary: stats.summary,
    daily: stats.daily,
    statsError: null,
  })
  assert.equal(buildStatusPayload({ runtime, stats, statsError: undefined, generatedAt: NOW }).statsError, null)
  assert.equal(
    buildStatusPayload({ runtime, stats, statsError: 'stats-unavailable', generatedAt: NOW }).statsError,
    'stats-unavailable',
  )
})

test('readRuntimeSafe falls back when the provider throws', () => {
  const ready = { state: 'ready', version: '1.2.0', source: 'managed' }
  assert.deepEqual(readRuntimeSafe(() => ready), ready)
  assert.deepEqual(readRuntimeSafe(() => { throw new Error('runtime down') }), {
    state: 'unavailable',
    version: null,
    source: null,
  })
})

test('projectRuntime maps manager state to the page badge', () => {
  assert.deepEqual(projectRuntime({ available: true, canWrap: true, version: '1.2.0', source: 'managed' }), {
    state: 'ready',
    version: '1.2.0',
    source: 'managed',
  })
  assert.deepEqual(projectRuntime({ available: true }), {
    state: 'ready',
    version: null,
    source: null,
  })
  assert.deepEqual(projectRuntime({ available: false, canWrap: true, version: '1.2.0', source: 'managed' }), {
    state: 'installing',
    version: null,
    source: null,
  })
  assert.deepEqual(projectRuntime({ available: false, canWrap: false }), {
    state: 'unavailable',
    version: null,
    source: null,
  })
  assert.deepEqual(projectRuntime(), {
    state: 'unavailable',
    version: null,
    source: null,
  })
})

test('resolveRequestRejection honors the Connection trust fence', () => {
  assert.equal(resolveRequestRejection(undefined, {}), undefined)
  assert.equal(resolveRequestRejection({ get: () => undefined }, {}), undefined)
  assert.equal(resolveRequestRejection({ get: () => ({ requestRejection: () => 403 }) }, {}), 403)
  assert.equal(resolveRequestRejection({ get: () => ({ requestRejection: () => 401 }) }, {}), 401)
  assert.equal(resolveRequestRejection({ get: () => ({ requestRejection: () => undefined }) }, {}), undefined)
  assert.equal(resolveRequestRejection({ get() { throw new Error('no connection') } }, {}), 403)
})

test('runGain parses the gain answer', async () => {
  assert.deepEqual(await runGain({ binary: gainRtk }), {
    daily: [{ date: '2026-11-10', commands: 2 }],
  })
})

test('runGain rejects an empty binary and a spawn failure', async () => {
  await assert.rejects(runGain({ binary: '' }), /RTK binary is not ready/)
  await assert.rejects(runGain({ binary: join(dir, 'missing-rtk') }), /rtk gain failed: /)
})

test('runGain reports stderr, a bare failure, and invalid JSON', async () => {
  await assert.rejects(runGain({ binary: failRtk }), /rtk gain failed: boom/)
  await assert.rejects(runGain({ binary: quietRtk }), /rtk gain failed: /)
  await assert.rejects(runGain({ binary: junkRtk }), /rtk gain returned invalid JSON/)
})

test('an aborted gain read rejects with AbortError', async () => {
  const controller = new AbortController()
  const pending = runGain({ binary: slowRtk, timeoutMs: 5000, signal: controller.signal })
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await assert.rejects(pending, (error) => error instanceof Error && error.name === 'AbortError')
  } finally {
    clearTimeout(timer)
  }
})

test('readGainStatus propagates a reader failure', async () => {
  await assert.rejects(
    readGainStatus({
      binary: '/managed/rtk',
      run: async () => { throw new Error('rtk gain failed') },
    }),
    /rtk gain failed/,
  )
})

test('the status route clamps the days query parameter', async () => {
  const { route, calls } = captureRoute()
  const cases = [
    ['/rtk-filter/status', 7],
    ['/rtk-filter/status?days=30', 30],
    ['/rtk-filter/status?days=999', 90],
    ['/rtk-filter/status?days=0', 1],
    ['/rtk-filter/status?days=-5', 1],
    ['/rtk-filter/status?days=abc', 7],
  ]
  for (const [url, expected] of cases) {
    const res = response()
    await route.handler({ method: 'GET', url, headers: {} }, res)
    assert.equal(res.statusCode, 200, url)
    const payload = JSON.parse(res.body)
    assert.equal(payload.range.days, expected, url)
    assert.equal(payload.range.to, '2026-11-10', url)
    const call = calls[calls.length - 1]
    assert.equal(call.days, expected, url)
    assert.equal(call.now, NOW, url)
    assert.equal(call.binary, '/managed/rtk', url)
  }
})

test('the status route sets cache and sniffing headers on GET and HEAD', async () => {
  const { route } = captureRoute()

  const getRes = response()
  await route.handler({ method: 'GET', url: '/rtk-filter/status', headers: {} }, getRes)
  assert.equal(getRes.headers['cache-control'], 'no-store')
  assert.equal(getRes.headers['x-content-type-options'], 'nosniff')
  assert.match(getRes.headers['content-type'], /application\/json/)
  assert.equal(typeof getRes.body, 'string')

  const headRes = response()
  await route.handler({ method: 'HEAD', url: '/rtk-filter/status', headers: {} }, headRes)
  assert.equal(headRes.statusCode, 200)
  assert.equal(headRes.body, undefined)
  assert.match(headRes.headers['content-type'], /application\/json/)
  assert.equal(headRes.headers['cache-control'], 'no-store')
})

test('the status route rejects non-GET methods before reading stats', async () => {
  const { route, calls } = captureRoute()
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = response()
    await route.handler({ method, url: '/rtk-filter/status', headers: {} }, res)
    assert.equal(res.statusCode, 405, method)
    assert.equal(res.headers.allow, 'GET, HEAD', method)
    assert.equal(res.body, undefined, method)
  }
  assert.equal(calls.length, 0)
})

test('the status route rejects the request when the Connection lookup throws', async () => {
  const { route, calls } = captureRoute({
    ctx: { get() { throw new Error('connection is not composed') } },
  })
  const res = response()
  await route.handler({ method: 'GET', url: '/rtk-filter/status?days=7', headers: {} }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body, undefined)
  assert.equal(calls.length, 0)
})

test('the status route degrades to an empty window and warns once', async () => {
  const warnings = []
  const { route } = captureRoute({
    ctx: { get: () => undefined, logger: { warn(message) { warnings.push(message) } } },
    readStatus: async () => { throw new Error('rtk history is locked') },
  })
  const res = response()
  await route.handler({ method: 'GET', url: '/rtk-filter/status?days=30', headers: {} }, res)

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.runtime.state, 'ready')
  assert.equal(payload.statsError, 'stats-unavailable')
  assert.equal(payload.range.days, 30)
  assert.equal(payload.daily.length, 30)
  assert.equal(payload.summary.calls, 0)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /\[rtk\] status read failed: rtk history is locked/)
})

test('a throwing logger and runtime provider cannot fail the status resource', async () => {
  const { route } = captureRoute({
    ctx: { get: () => undefined, logger: { warn() { throw new Error('logger down') } } },
    getRuntime: () => { throw new Error('runtime down') },
    readStatus: async () => { throw new Error('rtk gain failed') },
  })
  const res = response()
  await route.handler({ method: 'GET', url: '/rtk-filter/status', headers: {} }, res)

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.deepEqual(payload.runtime, { state: 'unavailable', version: null, source: null })
  assert.equal(payload.statsError, 'stats-unavailable')
})

test('the status route works without a Connection service or a URL', async () => {
  const { route, calls } = captureRoute({ ctx: undefined, getBinary: () => undefined })
  const res = response()
  await route.handler({ method: 'GET', headers: {} }, res)

  assert.equal(res.statusCode, 200)
  const payload = JSON.parse(res.body)
  assert.equal(payload.range.days, 7)
  assert.equal(payload.statsError, null)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].binary, undefined)
})
