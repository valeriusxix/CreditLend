import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readingMode, readingDue, FAST_INTERVAL, SLOW_INTERVAL } from '../src/schedule.js'
import { bookDepthCheck, manipulationCheck } from '../src/monitors.js'
import { WAD } from '../src/risk.js'

const C = 10n ** 6n
const usd = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n
const calm = { foreignReadingsLastHour: 0, rejectedReadingsLastHour: 0, lastAttemptFailed: false, oracleFresh: true, liveVsRecordedBps: 50, atRiskPositions: 0 }

// ------------------------------------------------------------------ schedule

test('calm market: hourly readings', () => {
  const m = readingMode(calm)
  assert.equal(m.mode, 'slow')
  assert.equal(m.interval, SLOW_INTERVAL)
})

for (const [name, change] of [
  ['someone else is taking readings', { foreignReadingsLastHour: 1 }],
  ['a reading was rejected', { rejectedReadingsLastHour: 1 }],
  ['the last attempt failed', { lastAttemptFailed: true }],
  ['the oracle is stale', { oracleFresh: false }],
  ['recorded price far from the live book', { liveVsRecordedBps: 301 }],
  ['a position is close to liquidation', { atRiskPositions: 1 }],
]) {
  test(`every 5 minutes when ${name}`, () => {
    const m = readingMode({ ...calm, ...change })
    assert.equal(m.mode, 'fast')
    assert.equal(m.interval, FAST_INTERVAL)
    assert.equal(m.reasons.length, 1)
  })
}

test('readingDue respects both the interval and the oracle minimum spacing', () => {
  const base = { now: 10_000, interval: 300, chainLastReadingTime: 9_000, minInterval: 300 }
  assert.equal(readingDue({ ...base, lastAttemptAt: null }), true)
  assert.equal(readingDue({ ...base, lastAttemptAt: 9_800 }), false)
  assert.equal(readingDue({ ...base, lastAttemptAt: 9_700 }), true)
  assert.equal(readingDue({ ...base, lastAttemptAt: null, chainLastReadingTime: 9_800 }), false, 'someone read 200s ago: TooSoon')
})

// ------------------------------------------------------------------ book depth

const quoteAt = (size, price, { reason = 4 } = {}) => ({ size, quote: { creditOut: size, usdgSpent: (size * usd(price)) / WAD, feeAtoms: 0n, fills: 1n, reason } })

test('book depth: healthy book raises no alerts', () => {
  const r = bookDepthCheck({ quotes: [quoteAt(10_000n * C, 0.55), quoteAt(20_000n * C, 0.56)], settlementPrice: usd(0.55), bonusBps: 500, maxDebtPerAccount: 20_000n * C })
  assert.equal(r.alerts.length, 0)
  assert.equal(r.rows[0].marginBps, 500)
})

test('book depth: thin book warns about typical and full liquidations', () => {
  const r = bookDepthCheck({ quotes: [quoteAt(10_000n * C, 0.57), quoteAt(20_000n * C, 0.6)], settlementPrice: usd(0.55), bonusBps: 500, maxDebtPerAccount: 20_000n * C })
  assert.deepEqual(r.alerts.map((a) => a.key).sort(), ['book-thin-full', 'book-thin-half'])
})

test('book depth: an unfillable size within the cap warns', () => {
  const r = bookDepthCheck({ quotes: [quoteAt(20_000n * C, 0.55, { reason: 1 })], settlementPrice: usd(0.55), bonusBps: 500, maxDebtPerAccount: 20_000n * C })
  assert.equal(r.alerts[0].key, `book-incomplete-${20_000n * C}`)
})

// ------------------------------------------------------------------ manipulation

const reading = (t, raw, foreign, status = 'Accepted') => ({ time: t, status, rawPrice: usd(raw), recordedPrice: usd(raw), foreign })

test('manipulation: repeated low readings by others raise a critical alert', () => {
  const now = 100_000
  const r = manipulationCheck({ now, readings: [reading(now - 600, 0.5, true), reading(now - 300, 0.49, true), reading(now - 100, 0.55, false)], livePrice: usd(0.55), recordedPrice: usd(0.55) })
  assert.equal(r.foreignLow, 2)
  assert.equal(r.alerts[0].key, 'drag-down')
  assert.equal(r.alerts[0].level, 'critical')
})

test('manipulation: honest foreign readings and old ones are ignored', () => {
  const now = 100_000
  const r = manipulationCheck({ now, readings: [reading(now - 600, 0.55, true), reading(now - 7200, 0.4, true), reading(now - 7000, 0.4, true)], livePrice: usd(0.55), recordedPrice: usd(0.55) })
  assert.equal(r.alerts.length, 0)
})

test('manipulation: recorded price well below the live book warns', () => {
  const r = manipulationCheck({ now: 1, readings: [], livePrice: usd(0.55), recordedPrice: usd(0.52) })
  assert.equal(r.alerts[0].key, 'recorded-below-live')
})

test('manipulation: many divergent rejections warn', () => {
  const now = 100_000
  const rs = [1, 2, 3].map((i) => reading(now - i * 300, 0.3, true, 'RejectedDivergent'))
  const r = manipulationCheck({ now, readings: rs, livePrice: null, recordedPrice: usd(0.55) })
  assert.ok(r.alerts.some((a) => a.key === 'many-divergent'))
})
