import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  aggregateGain,
  dayKeys,
  normalizeDays,
  readGainStatus,
  registerStatusRoute,
  STATUS_PATH,
} from '../lib/status.js'

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
