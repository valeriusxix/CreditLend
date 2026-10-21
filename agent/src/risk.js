// Pure liquidation and margin math. Everything is bigint; prices are WAD (1e18 = $1).
// maxRepayable and computeSeize mirror contracts/src/libraries/LiquidationLogic.sol exactly, so the
// agent sizes a liquidation the same way the pool will.

export const WAD = 10n ** 18n
export const BPS = 10_000n
export const FULL_LIQUIDATION_HF = 95n * 10n ** 16n // 0.95
export const CLOSE_FACTOR_BPS = 5_000n

const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)
const mulDiv = (a, b, d, ceil = false) => (ceil ? ceilDiv(a * b, d) : (a * b) / d)

export function toValue(amount, priceWad, decimals, ceil = false) {
  return mulDiv(amount, priceWad, 10n ** BigInt(decimals), ceil)
}

export function toAmount(value, priceWad, decimals, ceil = false) {
  return mulDiv(value, 10n ** BigInt(decimals), priceWad, ceil)
}

export function maxRepayable(debt, hf, dustDebt) {
  if (hf >= WAD) return 0n
  if (hf < FULL_LIQUIDATION_HF || debt <= dustDebt) return debt
  return (debt * CLOSE_FACTOR_BPS) / BPS
}

export function computeSeize({ repayAmount, debtPrice, debtDecimals, collateralPrice, collateralDecimals, bonusBps, availableCollateral }) {
  const repayValue = toValue(repayAmount, debtPrice, debtDecimals)
  const seizeValue = (repayValue * (BPS + BigInt(bonusBps))) / BPS
  let seized = toAmount(seizeValue, collateralPrice, collateralDecimals)
  if (seized <= availableCollateral) return { repaid: repayAmount, seized }

  seized = availableCollateral
  const availableValue = toValue(seized, collateralPrice, collateralDecimals, true)
  const fairRepayValue = mulDiv(availableValue, BPS, BPS + BigInt(bonusBps), true)
  let repaid = toAmount(fairRepayValue, debtPrice, debtDecimals, true)
  if (repaid > repayAmount) repaid = repayAmount
  return { repaid, seized }
}

/// Health bands the agent reacts to.
export const HF_WARN = 110n * 10n ** 16n // 1.10: alert and read prices every 5 minutes

export function classifyHealth(hf) {
  if (hf < WAD) return 'liquidatable'
  if (hf < HF_WARN) return 'at-risk'
  return 'healthy'
}

/// All-in USDG cost per CREDIT (WAD) of a quote, fee included. Returns null if the book can't fill it.
export function quoteCostPerCredit(quote, wantCredit) {
  if (quote.reason !== 4 || quote.creditOut < wantCredit || quote.creditOut === 0n) return null
  return ceilDiv((quote.usdgSpent + quote.feeAtoms) * WAD, quote.creditOut)
}

/// A liquidator's margin, in bps, for repaying CREDIT bought at `costPerCredit`:
/// they receive collateral worth settlementPrice * (1 + bonus) per CREDIT repaid.
/// Can be negative. Returns null if the cost is unknown.
export function liquidatorMarginBps(settlementPrice, bonusBps, costPerCredit) {
  if (costPerCredit == null || costPerCredit === 0n) return null
  const received = (settlementPrice * (BPS + BigInt(bonusBps))) / BPS
  return Number(((received - costPerCredit) * BPS) / costPerCredit)
}

/// Relative difference |a - b| / b in bps.
export function diffBps(a, b) {
  if (b === 0n) return Number.MAX_SAFE_INTEGER
  const d = a > b ? a - b : b - a
  return Number((d * BPS) / b)
}
