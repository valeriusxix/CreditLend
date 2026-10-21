import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAD, maxRepayable, computeSeize, classifyHealth, quoteCostPerCredit, liquidatorMarginBps, diffBps } from '../src/risk.js'

const C = 10n ** 6n // one CREDIT / one USDG
const usd = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n // WAD from a decimal

test('maxRepayable mirrors the pool: 50% close factor, 100% below HF 0.95 or at dust', () => {
  assert.equal(maxRepayable(1000n * C, WAD, 10n * C), 0n)
  assert.equal(maxRepayable(1000n * C, usd(0.97), 10n * C), 500n * C)
  assert.equal(maxRepayable(1000n * C, usd(0.94), 10n * C), 1000n * C)
  assert.equal(maxRepayable(10n * C, usd(0.99), 10n * C), 10n * C)
})

test('computeSeize: 10,000 CREDIT at $0.55 with a 5% bonus seizes 5,775 USDG', () => {
  const r = computeSeize({ repayAmount: 10_000n * C, debtPrice: usd(0.55), debtDecimals: 6, collateralPrice: WAD, collateralDecimals: 6, bonusBps: 500, availableCollateral: 100_000n * C })
  assert.deepEqual(r, { repaid: 10_000n * C, seized: 5_775n * C })
})

test('computeSeize: not enough collateral seizes all of it and scales the repayment down (rounded up)', () => {
  const r = computeSeize({ repayAmount: 10_000n * C, debtPrice: WAD, debtDecimals: 6, collateralPrice: WAD, collateralDecimals: 6, bonusBps: 500, availableCollateral: 2_100n * C })
  assert.equal(r.seized, 2_100n * C)
  assert.equal(r.repaid, 2_000n * C) // 2,100 / 1.05
})

test('classifyHealth bands', () => {
  assert.equal(classifyHealth(usd(0.99)), 'liquidatable')
  assert.equal(classifyHealth(usd(1.05)), 'at-risk')
  assert.equal(classifyHealth(usd(1.2)), 'healthy')
})

test('quote cost per CREDIT includes the fee, and an unfilled quote has no price', () => {
  const q = { creditOut: 5_000n * C, usdgSpent: 2_500n * C, feeAtoms: 50n * C, fills: 3n, reason: 4 }
  assert.equal(quoteCostPerCredit(q, 5_000n * C), usd(0.51))
  assert.equal(quoteCostPerCredit({ ...q, reason: 1 }, 5_000n * C), null)
  assert.equal(quoteCostPerCredit(q, 6_000n * C), null)
})

test('liquidator margin: settlement $0.55 + 5% bonus vs cost $0.55 is +5%; vs $0.60 is negative', () => {
  assert.equal(liquidatorMarginBps(usd(0.55), 500, usd(0.55)), 500)
  assert.ok(liquidatorMarginBps(usd(0.55), 500, usd(0.6)) < 0)
  assert.equal(liquidatorMarginBps(usd(0.55), 500, null), null)
})

test('diffBps', () => {
  assert.equal(diffBps(usd(0.97), usd(1)), 300)
  assert.equal(diffBps(usd(1.03), usd(1)), 300)
})
