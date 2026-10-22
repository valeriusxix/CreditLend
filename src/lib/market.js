// Previews that mirror the pool's own checks, so the app can say what will happen before the wallet
// asks for a signature. The contract re-checks everything; these only guide the user.
// Liquidation math is shared with the agent (agent/src/risk.js mirrors LiquidationLogic.sol).
import { maxRepayable, computeSeize } from '../../agent/src/risk.js'
import { WAD, BPS, MAX_UINT } from './format.js'

const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)

/// USD value (WAD) of debt: always at the $1 face value, rounded up, as the pool does.
export const debtValue = (debt, decimals) => ceilDiv(debt * WAD, 10n ** BigInt(decimals))

export const healthFactor = (liqValue, debtVal) => (debtVal === 0n ? MAX_UINT : (liqValue * WAD) / debtVal)

/// Borrow power and liquidation value of a collateral map { asset: amount }, as the pool computes them.
export function collateralValues(assets, balances) {
  let borrowPower = 0n
  let liqValue = 0n
  for (const a of assets) {
    const amount = balances[a.address] ?? 0n
    if (amount <= 0n || a.price == null) continue // unpriced collateral counts as zero
    const value = (amount * a.price) / 10n ** BigInt(a.decimals)
    borrowPower += (value * BigInt(a.ltvBps)) / BPS
    liqValue += (value * BigInt(a.liqThresholdBps)) / BPS
  }
  return { borrowPower, liqValue }
}

/// Health factor after a change to collateral and/or debt.
export function healthAfter({ market, account, asset = null, collateralDelta = 0n, debtDelta = 0n }) {
  const balances = { ...account.collateral }
  if (asset) balances[asset] = (balances[asset] ?? 0n) + collateralDelta
  if (asset && balances[asset] < 0n) balances[asset] = 0n
  const { liqValue } = collateralValues(market.assets, balances)
  const debt = account.debt + debtDelta > 0n ? account.debt + debtDelta : 0n
  return healthFactor(liqValue, debtValue(debt, market.credit.decimals))
}

/// The most $CREDIT this account can borrow now, the smallest borrow allowed, and what limits it.
export function borrowLimits(market, account) {
  const dec = market.credit.decimals
  const unit = 10n ** BigInt(dec)
  const room = account.borrowPower > account.debtValue ? account.borrowPower - account.debtValue : 0n
  const lenderAssets = market.totalAssets
  const utilRoom = (lenderAssets * market.maxUtilizationBps) / BPS
  const limits = [
    ['your collateral', (room * unit) / WAD],
    ['$CREDIT free in the pool', market.cash],
    ['the per-account debt cap', market.maxDebtPerAccount > account.debt ? market.maxDebtPerAccount - account.debt : 0n],
    ['the market-wide borrow cap', market.maxTotalBorrows > market.totalBorrows ? market.maxTotalBorrows - market.totalBorrows : 0n],
    ['the pool\'s liquidity buffer for lenders', utilRoom > market.totalBorrows ? utilRoom - market.totalBorrows : 0n],
  ]
  let [limitedBy, max] = limits[0]
  for (const [why, v] of limits) if (v < max) [limitedBy, max] = [why, v]
  // Interest keeps accruing between reading and sending; leave 0.05% of headroom on "Max".
  const safeMax = max - max / 2_000n
  const min = market.minDebt > account.debt ? market.minDebt - account.debt : 1n
  return { max: safeMax, min, limitedBy }
}

/// The most of one collateral asset that can be withdrawn while staying within the borrow limit.
export function collateralWithdrawMax(market, account, asset) {
  const balance = account.collateral[asset.address] ?? 0n
  if (account.debt === 0n || asset.price == null || asset.ltvBps === 0) return balance
  const room = account.borrowPower > account.debtValue ? account.borrowPower - account.debtValue : 0n
  const perUnitBp = asset.price * BigInt(asset.ltvBps)
  let max = (room * BPS * 10n ** BigInt(asset.decimals)) / perUnitBp
  max = max > 0n ? max - 1n : 0n // the pool rounds collateral value down
  return max < balance ? max : balance
}

/// Repaying "all" pulls the debt as of the transaction, a little more than read: approve a 0.01% buffer.
export const repayAllAllowance = (debt) => debt + debt / 10_000n + 1n

/// The pool refuses a repayment that turns a normal-sized debt into a leftover below minDebt (AUDIT.md L-2).
export function repayLeavesDust(debt, amount, minDebt) {
  const left = amount >= debt ? 0n : debt - amount
  return left > 0n && left < minDebt && debt >= minDebt
}

/// What a liquidation would repay and seize. `repayAmount` is what the liquidator offers.
export function liquidationPreview({ market, debt, hf, asset, available, repayAmount }) {
  const cap = maxRepayable(debt, hf, market.minDebt)
  if (cap === 0n || asset.price == null || available === 0n) return { cap, repaid: 0n, seized: 0n, minSeized: 0n }
  const offer = repayAmount == null || repayAmount > cap ? cap : repayAmount
  const { repaid, seized } = computeSeize({
    repayAmount: offer,
    debtPrice: market.settlementPrice,
    debtDecimals: market.credit.decimals,
    collateralPrice: asset.price,
    collateralDecimals: asset.decimals,
    bonusBps: asset.liqBonusBps,
    availableCollateral: available,
  })
  // 1% slippage guard: the oracle price may move a little before the transaction lands.
  return { cap, offer, repaid, seized, minSeized: (seized * 99n) / 100n }
}
