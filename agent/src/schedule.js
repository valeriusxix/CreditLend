// When to take the next oracle reading. Pure: all inputs are passed in.
//
// Hourly readings keep the price fresh (the oracle falls back to $1 after 2 hours without one) at about a
// tenth of the cost of reading every 5 minutes. But hourly is only safe while nothing is happening: with
// one honest reading an hour, someone posting fake low readings would own the other 11 slots. So the
// agent drops to every 5 minutes the moment ANY of these is true:
//   - someone other than the agent took a reading in the last hour (a contested oracle)
//   - a reading in the last hour was rejected (a confirming reading is needed 5 minutes later)
//   - the agent's own last reading attempt failed
//   - the oracle isn't fresh
//   - the recorded average is more than DIVERGENCE_TRIGGER_BPS away from the live book
//   - any position is close to liquidation

export const FAST_INTERVAL = 5 * 60
export const SLOW_INTERVAL = 60 * 60
export const DIVERGENCE_TRIGGER_BPS = 300 // 3%

export function readingMode(s) {
  const reasons = []
  if (s.foreignReadingsLastHour > 0) reasons.push(`${s.foreignReadingsLastHour} reading(s) by someone else in the last hour`)
  if (s.rejectedReadingsLastHour > 0) reasons.push(`${s.rejectedReadingsLastHour} rejected reading(s) in the last hour`)
  if (s.lastAttemptFailed) reasons.push('the last reading attempt failed')
  if (!s.oracleFresh) reasons.push('the oracle is stale')
  if (s.liveVsRecordedBps != null && s.liveVsRecordedBps > DIVERGENCE_TRIGGER_BPS) {
    reasons.push(`recorded price is ${(s.liveVsRecordedBps / 100).toFixed(1)}% away from the live book`)
  }
  if (s.atRiskPositions > 0) reasons.push(`${s.atRiskPositions} position(s) close to liquidation`)
  return { mode: reasons.length ? 'fast' : 'slow', interval: reasons.length ? FAST_INTERVAL : SLOW_INTERVAL, reasons }
}

/// Is a reading due now? `lastAttemptAt` is the agent's own last attempt; `chainLastReadingTime` is the
/// oracle's (anyone's) last reading; `minInterval` is the oracle's minimum spacing.
export function readingDue({ now, interval, lastAttemptAt, chainLastReadingTime, minInterval }) {
  if (now < chainLastReadingTime + minInterval) return false // the oracle would reject it as TooSoon
  return lastAttemptAt == null || now >= lastAttemptAt + interval
}
