// Every read the app makes. Calls are batched through Multicall3 by the public client.
import poolAbi from '../abi/CreditLendPool.json'
import cmAbi from '../abi/CollateralManager.json'
import erc20Abi from '../abi/ERC20.json'
import { POOL_DEPLOY_BLOCK } from './config.js'
import { debtValue } from './market.js'

const read = (client, address, abi, functionName, args = []) => client.readContract({ address, abi, functionName, args })

async function tokenInfo(client, address) {
  const [symbol, decimals] = await Promise.all([read(client, address, erc20Abi, 'symbol'), read(client, address, erc20Abi, 'decimals')])
  return { address, symbol, decimals: Number(decimals) }
}

/// Everything about the market that is the same for every user.
export async function loadMarket(client, pool) {
  const p = (fn, args) => read(client, pool, poolAbi, fn, args)
  const [creditAddress, cm, shareDecimals] = await Promise.all([p('asset'), p('collateralManager'), p('decimals')])
  const names = ['cash', 'totalBorrows', 'totalReserves', 'totalAssets', 'totalSupply', 'utilization', 'borrowRatePerYear', 'supplyRatePerYear', 'maxDebtPerAccount', 'maxTotalBorrows', 'maxUtilizationBps', 'minDebt', 'reserveFactorBps', 'depositsPaused', 'borrowsPaused', 'collateralDepositsPaused', 'owner', 'guardian', 'interestRateModel', 'rateController']
  const values = await Promise.all(names.map((n) => p(n)))
  const m = Object.fromEntries(names.map((n, i) => [n, values[i]]))

  const [credit, listed, settlementPrice] = await Promise.all([
    tokenInfo(client, creditAddress),
    read(client, cm, cmAbi, 'getListedAssets'),
    read(client, cm, cmAbi, 'getDebtSettlementPrice').catch(() => null),
  ])
  const assets = await Promise.all(listed.map(async (address) => {
    const [info, cfg, price, total] = await Promise.all([
      tokenInfo(client, address),
      read(client, cm, cmAbi, 'getAssetConfig', [address]),
      read(client, cm, cmAbi, 'getPrice', [address]).catch(() => null), // unpriceable: counts as zero
      p('totalCollateral', [address]),
    ])
    return { ...info, listed: cfg.listed, depositsEnabled: cfg.depositsEnabled, ltvBps: Number(cfg.ltvBps), liqThresholdBps: Number(cfg.liqThresholdBps), liqBonusBps: Number(cfg.liqBonusBps), supplyCap: cfg.supplyCap, price, totalCollateral: total }
  }))

  return {
    pool,
    collateralManager: cm,
    credit,
    shareDecimals: Number(shareDecimals),
    ...m,
    settlementPrice,
    assets,
    paused: { deposits: m.depositsPaused, borrows: m.borrowsPaused, collateral: m.collateralDepositsPaused },
  }
}

/// One account's position: lending, collateral, debt and wallet balances.
export async function loadAccount(client, market, address) {
  const p = (fn, args) => read(client, market.pool, poolAbi, fn, args)
  const [data, shares, maxWithdraw, maxRedeem, walletCredit, walletEth] = await Promise.all([
    p('getAccountData', [address]),
    p('balanceOf', [address]),
    p('maxWithdraw', [address]),
    p('maxRedeem', [address]),
    read(client, market.credit.address, erc20Abi, 'balanceOf', [address]),
    client.getBalance({ address }),
  ])
  const [borrowPower, liqValue, debt, debtVal, healthFactor] = data
  const lent = shares === 0n ? 0n : await p('convertToAssets', [shares])
  const collateral = {}
  const wallet = {}
  await Promise.all(market.assets.map(async (a) => {
    const [deposited, held] = await Promise.all([p('collateralOf', [address, a.address]), read(client, a.address, erc20Abi, 'balanceOf', [address])])
    collateral[a.address] = deposited
    wallet[a.address] = held
  }))
  return { address, borrowPower, liqValue, debt, debtValue: debtVal ?? debtValue(debt, market.credit.decimals), healthFactor, shares, lent, maxWithdraw, maxRedeem, walletCredit, walletEth, collateral, wallet }
}

// eth_getLogs on this RPC accepts at most ~10M blocks per call; stay well under it.
const LOG_CHUNK = 5_000_000n
const borrowedEvent = poolAbi.find((x) => x.type === 'event' && x.name === 'Borrowed')

/// Everyone who has ever borrowed from the pool (from its Borrowed events).
export async function loadBorrowers(client, pool, fromBlock = POOL_DEPLOY_BLOCK) {
  const latest = await client.getBlockNumber()
  const found = new Set()
  for (let from = fromBlock; from <= latest; from += LOG_CHUNK) {
    const to = from + LOG_CHUNK - 1n < latest ? from + LOG_CHUNK - 1n : latest
    const logs = await client.getLogs({ address: pool, event: borrowedEvent, fromBlock: from, toBlock: to })
    for (const l of logs) found.add(l.args.borrower)
  }
  return [...found]
}

/// Debt and health of many accounts at once (for the liquidation list).
export async function loadPositions(client, market, borrowers) {
  const rows = await Promise.all(borrowers.map(async (address) => {
    const [, , debt, , healthFactor] = await read(client, market.pool, poolAbi, 'getAccountData', [address])
    return { address, debt, healthFactor }
  }))
  return rows.filter((r) => r.debt > 0n).sort((a, b) => (a.healthFactor < b.healthFactor ? -1 : 1))
}

export async function allowance(client, token, owner, spender) {
  return read(client, token, erc20Abi, 'allowance', [owner, spender])
}
