import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keeper } from '../src/keeper.js'
import { WAD } from '../src/risk.js'

const C = 10n ** 6n
const usd = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n
const ZERO = '0x0000000000000000000000000000000000000000'
const AGENT = '0x000000000000000000000000000000000000A6e7'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const B1 = '0x00000000000000000000000000000000000000b1'
const M = ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003']

/// An in-memory stand-in for ChainAdapter. Tests tweak `state` and inspect `writes`.
function fakeChain(overrides = {}) {
  const state = {
    time: 1_000_000,
    block: 5_000n,
    lastReadingTime: 1_000_000 - 3_600,
    fresh: true,
    recordedPrice: usd(0.55),
    bookPrice: usd(0.55),
    borrowers: [],
    accounts: {},
    readings: [],
    simulate: { ok: true, status: 'Accepted', recordedPrice: usd(0.55) },
    rate: { models: [{ address: M[0], base: 1n }, { address: M[1], base: 2n }, { address: M[2], base: 4n }], agent: AGENT, pending: { model: ZERO, executableAt: 0 }, lastExecutedAt: 0, cooldown: 86_400, gracePeriod: 86_400 },
    market: { cash: 50_000n * C, totalBorrows: 10_000n * C, totalReserves: 0n, utilization: usd(0.2), borrowRatePerYear: usd(0.05), supplyRatePerYear: usd(0.01), maxDebtPerAccount: 20_000n * C, maxTotalBorrows: 50_000n * C, minDebt: 10n * C, interestRateModel: M[1] },
    ...overrides,
  }
  const writes = []
  const chain = {
    state,
    writes,
    address: 'address' in overrides ? overrides.address : AGENT,
    referenceSize: 5_000n * C,
    init: async () => {},
    blocksPerHour: async () => 14_400n,
    now: async () => ({ time: state.time, number: state.block + BigInt(state.time - 1_000_000) }),
    oracleState: async () => ({ lastReadingTime: state.lastReadingTime, fresh: state.fresh, recordedPrice: state.recordedPrice, minInterval: 300 }),
    simulateUpdate: async () => state.simulate,
    sendUpdate: async () => { writes.push(['update']); state.lastReadingTime = state.time; return { hash: '0xu' } },
    readingsSince: async () => { const r = state.readings; state.readings = []; return r },
    borrowersSince: async () => state.borrowers,
    accountData: async (b) => state.accounts[b],
    market: async () => state.market,
    collateralAssets: async () => [{ asset: USDG, decimals: 6, bonusBps: 500, price: WAD }],
    settlementPrice: async () => state.recordedPrice,
    collateralOf: async () => 20_000n * C,
    quote: async (n) => ({ creditOut: n, usdgSpent: (n * state.bookPrice) / WAD, feeAtoms: 0n, fills: 1n, reason: 4 }),
    feeBps: async () => 200,
    balanceOf: async (token) => (token === USDG ? 10_000n * C : 0n),
    ensureAllowance: async (t, s) => writes.push(['approve', t, s]),
    buyCredit: async (i, o) => { writes.push(['buy', i, o]); return { hash: '0xb' } },
    liquidate: async (b) => { writes.push(['liquidate', b]); return { hash: '0xl' } },
    rateState: async () => state.rate,
    proposeRateModel: async (m) => { writes.push(['propose', m]); return { hash: '0xp' } },
    executeRateSwitch: async () => { writes.push(['execute']); return { hash: '0xe' } },
  }
  return chain
}

function setup({ chain = fakeChain(), config = {}, complete = null } = {}) {
  const alerts = []
  const alerter = { send: async (a) => { alerts.push(a); return true } }
  const log = { info: () => {}, warn: () => {} }
  const keeper = new Keeper({ chain, alerter, log, complete, config: { usdg: USDG, credit: 'CREDIT', exchange: 'EX', pool: 'POOL', rateController: 'RC', liquidatorEnabled: false, rateProposalsEnabled: false, minProfitBps: 100, ...config } })
  return { keeper, chain, alerts }
}

test('calm market: one reading, then hourly', async () => {
  const { keeper, chain } = setup()
  await keeper.init()
  const r = await keeper.tick()
  assert.equal(r.mode, 'slow')
  assert.deepEqual(chain.writes, [['update']])

  chain.state.time += 600 // 10 minutes later: not due
  await keeper.tick()
  assert.equal(chain.writes.length, 1)

  chain.state.time += 3_000 // an hour after the first reading
  await keeper.tick()
  assert.equal(chain.writes.length, 2)
})

test('a reading by someone else switches to every 5 minutes', async () => {
  const { keeper, chain } = setup()
  await keeper.init()
  await keeper.tick()
  chain.state.time += 300
  chain.state.readings = [{ time: chain.state.time - 10, status: 'Accepted', rawPrice: usd(0.55), recordedPrice: usd(0.55), foreign: true }]
  chain.state.lastReadingTime = chain.state.time - 10 // too soon right now
  let r = await keeper.tick()
  assert.equal(r.mode, 'fast')
  assert.equal(chain.writes.length, 1, 'waits for the oracle minimum spacing')

  chain.state.time += 300
  r = await keeper.tick()
  assert.equal(chain.writes.length, 2)
})

test('a reading that would revert is not sent (no gas wasted)', async () => {
  const chain = fakeChain({ simulate: { ok: false, error: 'TooSoon(1000300)' } })
  const { keeper, alerts } = setup({ chain })
  await keeper.init()
  await keeper.tick()
  assert.equal(chain.writes.length, 0)
  assert.equal(alerts.length, 0)
})

test('a failing reading alerts and retries in 5 minutes', async () => {
  const chain = fakeChain({ simulate: { ok: false, error: 'execution reverted: paused' } })
  const { keeper, alerts } = setup({ chain })
  await keeper.init()
  await keeper.tick()
  assert.equal(alerts[0].key, 'reading-sim-failed')
  chain.state.simulate = { ok: true, status: 'Accepted' }
  chain.state.time += 300
  const r = await keeper.tick()
  assert.equal(r.mode, 'fast')
  assert.deepEqual(chain.writes, [['update']])
})

test('read-only mode (no wallet) monitors but never sends transactions', async () => {
  const chain = fakeChain({ address: null, borrowers: [B1], accounts: { [B1]: { debt: 10_000n * C, healthFactor: usd(0.9) } } })
  const { keeper, alerts } = setup({ chain })
  await keeper.init()
  await keeper.tick()
  assert.equal(chain.writes.length, 0)
  assert.ok(alerts.some((a) => a.key === `liquidatable-${B1}` && a.level === 'critical'))
})

test('positions near liquidation alert and speed up readings', async () => {
  const chain = fakeChain({ borrowers: [B1], accounts: { [B1]: { debt: 10_000n * C, healthFactor: usd(1.05) } } })
  const { keeper, alerts } = setup({ chain })
  await keeper.init()
  const r = await keeper.tick()
  assert.equal(r.mode, 'fast')
  assert.ok(alerts.some((a) => a.key === `at-risk-${B1}`))
})

test('auto-liquidation buys CREDIT and liquidates when enabled and profitable', async () => {
  const chain = fakeChain({ bookPrice: usd(0.53), borrowers: [B1], accounts: { [B1]: { debt: 20_000n * C, healthFactor: usd(0.97) } } })
  const { keeper, alerts } = setup({ chain, config: { liquidatorEnabled: true } })
  await keeper.init()
  await keeper.tick()
  const kinds = chain.writes.map((w) => w[0])
  assert.deepEqual(kinds.slice(0, 4), ['approve', 'buy', 'approve', 'liquidate'])
  assert.ok(alerts.some((a) => /Liquidated/.test(a.text)))
})

test('stale oracle raises a critical alert', async () => {
  const { keeper, alerts } = setup({ chain: fakeChain({ fresh: false }) })
  await keeper.init()
  await keeper.tick()
  assert.ok(alerts.some((a) => a.key === 'oracle-stale' && a.level === 'critical'))
})

test('hourly book check warns when the book is too thin for the caps', async () => {
  const { keeper, alerts } = setup({ chain: fakeChain({ bookPrice: usd(0.6), recordedPrice: usd(0.55) }) })
  await keeper.init()
  await keeper.tick()
  assert.ok(alerts.some((a) => a.key === 'book-thin-half'))
})

test('a pending rate switch is executed once its delay is over', async () => {
  const chain = fakeChain()
  chain.state.rate = { ...chain.state.rate, pending: { model: M[2], executableAt: chain.state.time + 100 } }
  const { keeper } = setup({ chain })
  await keeper.init()
  await keeper.tick()
  assert.ok(!chain.writes.some((w) => w[0] === 'execute'))
  chain.state.time += 100
  await keeper.tick()
  assert.ok(chain.writes.some((w) => w[0] === 'execute'))
})

test('daily review proposes only when enabled, and only once a day', async () => {
  let calls = 0
  const complete = async () => { calls++; return { text: '{"decision":"higher","reason":"utilization high for days","report":"Busy day."}', stopReason: 'end_turn' } }

  const off = setup({ complete })
  await off.keeper.init()
  await off.keeper.tick()
  assert.ok(!off.chain.writes.some((w) => w[0] === 'propose'))
  assert.ok(off.alerts.some((a) => /RATE_PROPOSALS_ENABLED is off/.test(a.text)))

  const on = setup({ complete, config: { rateProposalsEnabled: true } })
  await on.keeper.init()
  await on.keeper.tick()
  assert.deepEqual(on.chain.writes.filter((w) => w[0] === 'propose'), [['propose', M[2]]])
  on.chain.state.time += 3_600
  await on.keeper.tick()
  assert.equal(calls, 2, 'one review per keeper per day')
})

test('a broken LLM answer never proposes', async () => {
  const { keeper, chain, alerts } = setup({ complete: async () => ({ text: 'Raise the rates to 500%!', stopReason: 'end_turn' }), config: { rateProposalsEnabled: true } })
  await keeper.init()
  await keeper.tick()
  assert.ok(!chain.writes.some((w) => w[0] === 'propose'))
  assert.ok(alerts.some((a) => /no usable answer/.test(a.text)))
})
