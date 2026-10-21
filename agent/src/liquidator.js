// Optional auto-liquidation (LIQUIDATOR_ENABLED=true). The agent's wallet holds a float of USDG. For an
// unhealthy position it buys the needed $CREDIT on the Orbio book, repays part of the debt and receives
// the borrower's collateral plus the 5% bonus.
//
// It only goes ahead if the collateral it receives is worth at least (all-in purchase cost) x (1 + min
// profit). That floor is also passed to the pool as `minSeized`, so the chain itself refuses a liquidation
// that would lose money, even if prices move between planning and execution.
import { WAD, BPS, maxRepayable, computeSeize, toValue, toAmount } from './risk.js'
import { TARGET_REACHED } from './abis.js'

const USDG_DECIMALS = 6
const CREDIT_DECIMALS = 6
const BUY_SLACK_BPS = 50n // spend up to 0.5% over the quote, in case the book moves a little
const ceilDiv = (a, b) => (a === 0n ? 0n : (a - 1n) / b + 1n)

/// Works out the most profitable liquidation of `borrower`, or explains why there is none.
/// `assets`: [{ asset, decimals, bonusBps, price, available }] for this borrower.
export async function planLiquidation({ borrower, debt, healthFactor, minDebt, assets, settlementPrice, creditInventory, usdgBalance, feeBps, minProfitBps, quote }) {
  const maxRepay = maxRepayable(debt, healthFactor, minDebt)
  if (maxRepay === 0n) return { skip: 'position is healthy' }

  let best = null
  for (const a of assets) {
    if (a.price == null || a.price === 0n || a.available === 0n) continue
    const { repaid, seized } = computeSeize({
      repayAmount: maxRepay,
      debtPrice: settlementPrice,
      debtDecimals: CREDIT_DECIMALS,
      collateralPrice: a.price,
      collateralDecimals: a.decimals,
      bonusBps: a.bonusBps,
      availableCollateral: a.available,
    })
    if (repaid === 0n || seized === 0n) continue
    const seizedValue = toValue(seized, a.price, a.decimals)
    if (!best || seizedValue > best.seizedValue) best = { ...a, repaid, seized, seizedValue }
  }
  if (!best) return { skip: 'no priceable collateral to seize' }

  const fromInventory = creditInventory < best.repaid ? creditInventory : best.repaid
  const needCredit = best.repaid - fromInventory
  let usdgIn = 0n
  let usdgCost = 0n
  if (needCredit > 0n) {
    const q = await quote(needCredit)
    if (q.reason !== TARGET_REACHED || q.creditOut < needCredit) return { skip: `order book can't supply ${needCredit} CREDIT atoms` }
    usdgIn = ceilDiv(q.usdgSpent * (BPS + BUY_SLACK_BPS), BPS)
    usdgCost = usdgIn + ceilDiv(usdgIn * BigInt(feeBps), BPS)
  }

  // Cost basis in USD (WAD): USDG at $1, inventory CREDIT at the settlement price.
  const cost = toValue(usdgCost, WAD, USDG_DECIMALS, true) + toValue(fromInventory, settlementPrice, CREDIT_DECIMALS, true)
  const required = ceilDiv(cost * (BPS + BigInt(minProfitBps)), BPS)
  const minSeized = toAmount(required, best.price, best.decimals, true)
  const marginBps = cost === 0n ? null : Number(((best.seizedValue - cost) * BPS) / cost)

  if (best.seized < minSeized) return { skip: `not profitable enough (margin ${marginBps == null ? 'n/a' : (marginBps / 100).toFixed(2) + '%'}, need ${minProfitBps / 100}%)`, marginBps }
  if (usdgCost > usdgBalance) return { skip: `USDG float too small: need ${usdgCost} atoms, have ${usdgBalance}`, underfunded: true, marginBps }

  return {
    plan: { borrower, asset: best.asset, repaid: best.repaid, seized: best.seized, minSeized, needCredit, usdgIn, usdgCost, marginBps },
  }
}

/// Executes a plan: buy CREDIT if needed, then liquidate. Returns the transaction hashes.
export async function executeLiquidation(plan, chain, { usdg, credit, exchange, pool }) {
  const hashes = []
  if (plan.needCredit > 0n) {
    await chain.ensureAllowance(usdg, exchange, plan.usdgCost)
    hashes.push((await chain.buyCredit(plan.usdgIn, plan.needCredit)).hash)
  }
  await chain.ensureAllowance(credit, pool, plan.repaid)
  hashes.push((await chain.liquidate(plan.borrower, plan.asset, plan.repaid, plan.minSeized)).hash)
  return hashes
}
