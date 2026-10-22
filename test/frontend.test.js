// Pure frontend helpers: amount parsing, display, the previews that mirror the pool, error messages and
// routing. Run with `npm test` (no browser, no network).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult } from 'viem'
import { parseAmount, fmtAmount, fmtPct, fmtHealth, healthBand, WAD, MAX_UINT } from '../src/lib/format.js'
import { borrowLimits, collateralWithdrawMax, healthAfter, collateralValues, debtValue, liquidationPreview, repayAllAllowance, repayLeavesDust } from '../src/lib/market.js'
import { friendlyError, revertName, REVERT_MESSAGES } from '../src/lib/errors.js'
import { parseRoute } from '../src/hooks/useHashRoute.js'
import poolAbi from '../src/abi/CreditLendPool.json' with { type: 'json' }
import cmAbi from '../src/abi/CollateralManager.json' with { type: 'json' }

const C = 10n ** 6n // one CREDIT / one USDG
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const usdg = { address: USDG, symbol: 'USDG', decimals: 6, ltvBps: 7_000, liqThresholdBps: 8_000, liqBonusBps: 500, price: WAD }
const market = {
  credit: { decimals: 6, symbol: 'CREDIT' },
  assets: [usdg],
  cash: 40_000n * C,
  totalBorrows: 10_000n * C,
  totalAssets: 50_000n * C,
  maxUtilizationBps: 9_000n,
  maxDebtPerAccount: 20_000n * C,
  maxTotalBorrows: 50_000n * C,
  minDebt: 10n * C,
  settlementPrice: 55n * 10n ** 16n, // $0.55
}
function accountWith(collateral, debt) {
  const { borrowPower, liqValue } = collateralValues(market.assets, { [USDG]: collateral })
  const dv = debtValue(debt, 6)
  return { collateral: { [USDG]: collateral }, debt, borrowPower, liqValue, debtValue: dv, healthFactor: dv === 0n ? MAX_UINT : (liqValue * WAD) / dv }
}

// ------------------------------------------------------------------------------------- amounts

test('amounts: parsed exactly, with plain-English errors', () => {
  assert.deepEqual(parseAmount('1,234.5', 6), { value: 1_234_500_000n })
  assert.deepEqual(parseAmount('.5', 6), { value: 500_000n })
  assert.match(parseAmount('', 6).error, /Enter an amount/)
  assert.match(parseAmount('abc', 6).error, /Enter a number/)
  assert.match(parseAmount('0', 6).error, /more than zero/)
  assert.match(parseAmount('1.1234567', 6).error, /6 decimal places/)
  assert.match(parseAmount('-5', 6).error, /Enter a number/)
})

test('display: grouping, tiny amounts, percentages and health', () => {
  assert.equal(fmtAmount(1_234_567_891_000n, 6), '1,234,567.89')
  assert.equal(fmtAmount(1n, 6), '<0.01')
  assert.equal(fmtAmount(0n, 6), '0')
  assert.equal(fmtPct(1234n * 10n ** 14n), '12.34%')
  assert.equal(fmtHealth(MAX_UINT), 'No debt')
  assert.equal(fmtHealth(1_234n * 10n ** 15n), '1.23')
  assert.equal(healthBand(99n * 10n ** 16n), 'liquidatable')
  assert.equal(healthBand(105n * 10n ** 16n), 'at-risk')
  assert.equal(healthBand(3n * WAD), 'healthy')
  assert.equal(healthBand(MAX_UINT), 'none')
})

// ------------------------------------------------------------------------------------ previews

test('borrow limit: 1,000 USDG at 70% lets you borrow ~700 CREDIT', () => {
  const l = borrowLimits(market, accountWith(1_000n * C, 0n))
  assert.equal(l.limitedBy, 'your collateral')
  assert.equal(l.max, 700n * C - (700n * C) / 2_000n) // 0.05% headroom for interest
  assert.equal(l.min, 10n * C, 'first loan must reach the 10 CREDIT minimum')
})

test('borrow limit: the smallest of collateral, cash, caps and the lender buffer wins', () => {
  const rich = accountWith(1_000_000n * C, 0n)
  assert.equal(borrowLimits(market, rich).limitedBy, 'the per-account debt cap')
  assert.equal(borrowLimits({ ...market, cash: 5_000n * C }, rich).limitedBy, '$CREDIT free in the pool')
  assert.equal(borrowLimits({ ...market, maxTotalBorrows: 12_000n * C }, rich).limitedBy, 'the market-wide borrow cap')
  // 90% of 50,000 = 45,000 may be borrowed; 10,000 already is.
  const buffer = borrowLimits({ ...market, maxDebtPerAccount: MAX_UINT, maxTotalBorrows: MAX_UINT, cash: 10n ** 12n }, rich)
  assert.equal(buffer.limitedBy, "the pool's liquidity buffer for lenders")
  assert.equal(buffer.max, 35_000n * C - (35_000n * C) / 2_000n)
})

test('health after: borrowing lowers it, collateral raises it, matching the pool formula', () => {
  const a = accountWith(1_000n * C, 500n * C) // liq value 800 / debt 500 = 1.6
  assert.equal(a.healthFactor, 16n * 10n ** 17n)
  assert.equal(healthAfter({ market, account: a, debtDelta: 300n * C }), WAD) // 800 / 800
  assert.equal(healthAfter({ market, account: a, asset: USDG, collateralDelta: 250n * C }), 2n * WAD) // 1000 / 500
  assert.equal(healthAfter({ market, account: a, debtDelta: -500n * C }), MAX_UINT)
})

test('collateral withdraw max keeps the position within its borrow limit', () => {
  const a = accountWith(1_000n * C, 350n * C) // needs 500 USDG at 70%
  const max = collateralWithdrawMax(market, a, usdg)
  assert.ok(max < 500n * C && max > 499n * C)
  assert.equal(collateralWithdrawMax(market, accountWith(1_000n * C, 0n), usdg), 1_000n * C, 'no debt: everything')
})

test('repay all approves a small buffer for interest that accrues before the transaction lands', () => {
  assert.equal(repayAllAllowance(1_000n * C), 1_000n * C + 100_000n + 1n)
})

test('liquidation preview matches LiquidationLogic: half the debt, 5% bonus at the market price', () => {
  const debt = 1_000n * C
  const hf = 98n * 10n ** 16n
  const p = liquidationPreview({ market, debt, hf, asset: usdg, available: 1_000n * C, repayAmount: null })
  assert.equal(p.cap, 500n * C)
  assert.equal(p.repaid, 500n * C)
  assert.equal(p.seized, 288_750_000n) // 500 × $0.55 × 1.05 = 288.75 USDG
  assert.equal(p.minSeized, (288_750_000n * 99n) / 100n)
  const all = liquidationPreview({ market, debt, hf: 90n * 10n ** 16n, asset: usdg, available: 1_000n * C, repayAmount: null })
  assert.equal(all.cap, debt, 'below 0.95 the whole debt may be repaid')
  const healthy = liquidationPreview({ market, debt, hf: WAD, asset: usdg, available: 1_000n * C, repayAmount: null })
  assert.equal(healthy.seized, 0n)
})

// -------------------------------------------------------------------------------------- errors

test('every custom error the pool and collateral manager can raise has a message', () => {
  const names = [...poolAbi, ...cmAbi].filter((x) => x.type === 'error').map((x) => x.name)
  const internal = /^(Ownable|ReentrancyGuard|SafeERC20|ERC20Invalid|ERC4626ExceededMaxMint|NotGuardianOrOwner|InvalidParameter|InvalidConfig|AlreadyListed|TooManyAssets|DebtAssetNotAllowed)/
  const missing = names.filter((n) => !internal.test(n) && !REVERT_MESSAGES[n])
  assert.deepEqual(missing, [])
})

test('errors: a contract revert becomes its plain-English message; a wallet cancel is calm', () => {
  const data = encodeErrorResult({ abi: poolAbi, errorName: 'DebtBelowMinimum' })
  const reverted = new BaseError('call reverted', { cause: new ContractFunctionRevertedError({ abi: poolAbi, data, functionName: 'borrow' }) })
  assert.equal(revertName(reverted), 'DebtBelowMinimum')
  assert.match(friendlyError(reverted), /minimum loan/)
  assert.match(friendlyError(new UserRejectedRequestError(new Error('User rejected'))), /cancelled/)
  assert.match(friendlyError({ code: 4001 }), /cancelled/)
  assert.match(friendlyError(new Error('insufficient funds for gas * price + value')), /ETH to pay for gas/)
})

// -------------------------------------------------------------------------------------- routing

test('routes: landing, app sections, account lookup and docs', () => {
  assert.deepEqual(parseRoute(''), { page: 'home', section: '' })
  assert.deepEqual(parseRoute('#top'), { page: 'home', section: 'top' })
  assert.deepEqual(parseRoute('#app'), { page: 'app', section: 'overview', extra: '' })
  assert.deepEqual(parseRoute('#app/borrow'), { page: 'app', section: 'borrow', extra: '' })
  assert.deepEqual(parseRoute('#app/account/0xabc'), { page: 'app', section: 'account', extra: '0xabc' })
  assert.deepEqual(parseRoute('#docs/agent'), { page: 'docs', section: 'agent' })
})

test('repay: the form refuses what the pool refuses (leaving dust below the minimum loan)', () => {
  assert.equal(repayLeavesDust(50n * C, 50n * C - 1n, 10n * C), true, '1 atom left')
  assert.equal(repayLeavesDust(50n * C, 45n * C, 10n * C), true, '5 CREDIT left')
  assert.equal(repayLeavesDust(50n * C, 40n * C, 10n * C), false, 'exactly the minimum left')
  assert.equal(repayLeavesDust(50n * C, 60n * C, 10n * C), false, 'everything repaid')
  assert.equal(repayLeavesDust(7n * C, 3n * C, 10n * C), false, 'already below the minimum: may pay down')
})
