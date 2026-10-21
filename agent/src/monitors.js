// Pure checks over data the keeper has already read. Each returns { rows/facts, alerts: [{ key, level, text }] }.
import { liquidatorMarginBps, quoteCostPerCredit, diffBps } from './risk.js'

export const MIN_TYPICAL_MARGIN_BPS = 200 // a half-close of a capped position should still earn >= 2%
export const FOREIGN_LOW_BPS = 500 // a reading 5%+ below the live book
export const RECORDED_BELOW_LIVE_BPS = 300

const fmtUsd = (wad) => (wad == null ? 'n/a' : `$${(Number(wad) / 1e18).toFixed(4)}`)
const fmtCredit = (atoms) => `${(Number(atoms) / 1e6).toLocaleString('en-US')} CREDIT`

/// Liquidator margin by liquidation size on the live book, compared with the borrow caps.
/// `quotes` is [{ size, quote }] as returned by getQuoteForCredit.
export function bookDepthCheck({ quotes, settlementPrice, bonusBps, maxDebtPerAccount }) {
  const rows = quotes.map(({ size, quote }) => {
    const cost = quoteCostPerCredit(quote, size)
    return { size, costPerCredit: cost, marginBps: liquidatorMarginBps(settlementPrice, bonusBps, cost) }
  })
  const alerts = []
  const at = (size) => rows.find((r) => r.size === size)
  const half = at(maxDebtPerAccount / 2n)
  const full = at(maxDebtPerAccount)

  for (const r of rows) {
    if (r.costPerCredit == null && r.size <= maxDebtPerAccount) {
      alerts.push({ key: `book-incomplete-${r.size}`, level: 'warn', text: `Order book can't supply ${fmtCredit(r.size)} in one purchase. Liquidations that large would fail; consider lowering the per-account cap.` })
    }
  }
  if (half && half.marginBps != null && half.marginBps < MIN_TYPICAL_MARGIN_BPS) {
    alerts.push({ key: 'book-thin-half', level: 'warn', text: `A typical liquidation (${fmtCredit(half.size)}) now earns only ${(half.marginBps / 100).toFixed(1)}%. Liquidators may stop; consider lowering borrow caps.` })
  }
  if (full && full.marginBps != null && full.marginBps < 0) {
    alerts.push({ key: 'book-thin-full', level: 'warn', text: `Fully liquidating a capped position (${fmtCredit(full.size)}) now LOSES ${(-full.marginBps / 100).toFixed(1)}%.` })
  }
  return { rows, alerts }
}

/// Signs that someone is dragging the recorded price down with fake low readings.
/// `readings` are recent ReadingTaken events: { time, status, rawPrice, recordedPrice, foreign }.
export function manipulationCheck({ now, readings, livePrice, recordedPrice }) {
  const alerts = []
  const lastHour = readings.filter((r) => r.time >= now - 3600)
  const foreignLow = lastHour.filter((r) => r.foreign && livePrice != null && r.rawPrice < livePrice && diffBps(r.rawPrice, livePrice) >= FOREIGN_LOW_BPS)
  const divergent = lastHour.filter((r) => r.status === 'RejectedDivergent')

  if (foreignLow.length >= 2) {
    alerts.push({ key: 'drag-down', level: 'critical', text: `Possible price manipulation: ${foreignLow.length} readings by others in the last hour were 5%+ below the live book (${fmtUsd(livePrice)}). The agent is reading every 5 minutes; if this continues, consider pausing borrows.` })
  }
  if (divergent.length >= 3) {
    alerts.push({ key: 'many-divergent', level: 'warn', text: `${divergent.length} readings were rejected as divergent in the last hour. Either the market is jumping or someone is spoofing the book.` })
  }
  if (livePrice != null && recordedPrice != null && recordedPrice < livePrice && diffBps(recordedPrice, livePrice) >= RECORDED_BELOW_LIVE_BPS) {
    alerts.push({ key: 'recorded-below-live', level: 'warn', text: `Recorded $CREDIT price ${fmtUsd(recordedPrice)} is below the live book ${fmtUsd(livePrice)}: liquidators are paid less than the CREDIT costs them, so liquidations may stall until honest readings bring it back up.` })
  }
  return { foreignLow: foreignLow.length, divergent: divergent.length, alerts }
}
