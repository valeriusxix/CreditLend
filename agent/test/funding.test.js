import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planClaim, ethRunwayDays, walletProblem, fetchGatewayBalance, fundingReport, ORBIO_KEY_URL } from '../src/funding.js'
import { Keeper } from '../src/keeper.js'
import { WAD } from '../src/risk.js'

const C = 10n ** 6n // one CREDIT, or one dollar in micro-dollars
const GWEI = 10n ** 9n
const ETH = 10n ** 18n
const ZERO = '0x0000000000000000000000000000000000000000'
const AGENT = '0x000000000000000000000000000000000000A6e7'
const OWNER = '0x00000000000000000000000000000000000000C0'
const OTHER = '0x0000000000000000000000000000000000000Bad'
const TOKEN = '0x000000000000000000000000000000000000700c'
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'

// ------------------------------------------------------------------------------------- pure rules

test('claim: nothing below the minimum; as tokens by default', () => {
  assert.equal(planClaim({ owed: C / 2n, minClaim: C, activateEnabled: true, gatewayMicroUsd: 0n, floorMicroUsd: 20n * C }).claim, false)
  assert.deepEqual(planClaim({ owed: 5n * C, minClaim: C, activateEnabled: false, gatewayMicroUsd: 0n, floorMicroUsd: 20n * C }), { claim: true, activate: false })
})

test('claim: into API balance only when switched on AND the balance is known to be low', () => {
  const on = { owed: 5n * C, minClaim: C, activateEnabled: true, floorMicroUsd: 20n * C }
  assert.equal(planClaim({ ...on, gatewayMicroUsd: 3n * C }).activate, true)
  assert.equal(planClaim({ ...on, gatewayMicroUsd: 50n * C }).activate, false)
  assert.equal(planClaim({ ...on, gatewayMicroUsd: null }).activate, false, 'unknown balance: keep the tokens')
})

test('ETH runway: 0.01 ETH at 0.02 gwei lasts about 55 days', () => {
  assert.equal(ethRunwayDays({ balanceWei: ETH / 100n, gasPriceWei: GWEI / 50n }), 55.5)
  assert.equal(ethRunwayDays({ balanceWei: ETH, gasPriceWei: 0n }), null)
})

test('wallet: the launchpad must pay the agent wallet', () => {
  assert.match(walletProblem({ agentWallet: ZERO, owner: OWNER, agentAddress: AGENT }), /no agent wallet.*setAgentWallet/)
  assert.match(walletProblem({ agentWallet: OTHER, owner: OWNER, agentAddress: AGENT }), /not to the agent's wallet/)
  assert.equal(walletProblem({ agentWallet: AGENT.toLowerCase(), owner: OWNER, agentAddress: AGENT }), null)
  assert.equal(walletProblem({ agentWallet: ZERO, owner: OWNER, agentAddress: null }), null, 'read-only mode claims nothing')
})

test('API balance: reads micro-dollars, and failures never leak the key', async () => {
  let seen
  const ok = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ balance: { available_micro_usd: 4_681_360_000 } }) } }
  assert.deepEqual(await fetchGatewayBalance({ apiKey: 'sk-secret', fetchFn: ok }), { ok: true, availableMicroUsd: 4_681_360_000n })
  assert.equal(seen.url, ORBIO_KEY_URL)
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-secret')

  assert.deepEqual(await fetchGatewayBalance({ apiKey: 'sk-secret', fetchFn: async () => ({ ok: false, status: 401 }) }), { ok: false, status: 401 })
  assert.equal((await fetchGatewayBalance({ apiKey: 'sk-secret', fetchFn: async () => ({ ok: true, json: async () => ({}) }) })).ok, false)
  const thrown = await fetchGatewayBalance({ apiKey: 'sk-secret', fetchFn: async () => { throw new TypeError('fetch failed for sk-secret') } })
  assert.deepEqual(thrown, { ok: false, status: 'TypeError' })
})

test('report: plain sentences with the numbers', () => {
  const text = fundingReport({ agentId: 2077n, owed: 2n * C, stakeWei: 1500n * ETH, income: { creditMinted: 21_520_000n, gatewayUsdg: 7n * C, stakingClaimed: 0n }, creditBalance: 30n * C, gateway: { ok: true, availableMicroUsd: 12n * C }, runwayDays: 40, claimed: null })
  assert.match(text, /agent #2077/)
  assert.match(text, /21\.52 CREDIT from trading fees/)
  assert.match(text, /\$7 of API balance/)
  assert.match(text, /1,500 ORBIO staked/)
  assert.match(text, /about 40 days of ETH/)
})

// --------------------------------------------------------------------------------- keeper wiring

/// Just enough chain for a keeper tick (no borrowers, no rate controller) plus the launchpad.
function fakeChain(overrides = {}) {
  const state = {
    time: 1_000_000,
    agentId: 2077n,
    record: { token: TOKEN, owner: OWNER, agentWallet: AGENT, stakeWei: 1500n * ETH },
    owed: 3n * C,
    ethBalance: ETH / 100n,
    gasPrice: GWEI / 50n,
    ...overrides,
  }
  const writes = []
  return {
    state,
    writes,
    address: 'address' in overrides ? overrides.address : AGENT,
    referenceSize: 5_000n * C,
    init: async () => {},
    blocksPerHour: async () => 14_400n,
    now: async () => ({ time: state.time, number: BigInt(state.time) }),
    oracleState: async () => ({ lastReadingTime: state.time, fresh: true, recordedPrice: WAD / 2n, minInterval: 300 }),
    simulateUpdate: async () => ({ ok: false, errorName: 'TooSoon', error: '' }),
    readingsSince: async () => [],
    borrowersSince: async () => [],
    market: async () => ({ utilization: 0n, maxDebtPerAccount: 20_000n * C, minDebt: 10n * C }),
    quote: async (n) => ({ creditOut: n, usdgSpent: n / 2n, feeAtoms: 0n, fills: 1n, reason: 4 }),
    collateralAssets: async () => [{ asset: USDG, decimals: 6, bonusBps: 500, price: WAD }],
    settlementPrice: async () => WAD / 2n,
    balanceOf: async () => 30n * C,
    agentIdOf: async (t) => (t === TOKEN ? state.agentId : 0n),
    launchpadAgent: async () => state.record,
    creditOwed: async () => state.owed,
    claimCredit: async (id, activate) => { writes.push(['claim', id, activate]); state.owed = 0n; return { hash: '0xc' } },
    ethBalance: async () => state.ethBalance,
    gasPrice: async () => state.gasPrice,
    launchpadIncome: async () => ({ creditMinted: 21_520_000n, gatewayUsdg: 7n * C, stakingClaimed: 0n }),
  }
}

function setup({ chain = fakeChain(), config = {}, balance = 50n * C } = {}) {
  const alerts = []
  const alerter = { send: async (a) => { alerts.push(a); return true } }
  const log = { info: () => {}, warn: () => {} }
  const keeper = new Keeper({ chain, alerter, log, config: { usdg: USDG, credit: 'CREDIT', rateController: null, agentToken: TOKEN, fundingActivate: false, fundingMinClaim: C, gatewayFloor: 20n * C, orbioApiKey: 'sk-secret', ...config } })
  keeper.fetch = async () => ({ ok: true, json: async () => ({ balance: { available_micro_usd: String(balance) } }) })
  return { keeper, chain, alerts }
}

test('daily: claims staking rewards as tokens and reports income, once a day', async () => {
  const { keeper, chain, alerts } = setup()
  await keeper.init()
  await keeper.tick()
  assert.deepEqual(chain.writes, [['claim', 2077n, false]])
  const report = alerts.find((a) => a.key.startsWith('funding-'))
  assert.match(report.text, /Claimed 3 CREDIT as tokens/)
  assert.ok(!alerts.some((a) => a.level !== 'info'), 'nothing to worry about')

  chain.state.owed = 3n * C
  chain.state.time += 3_600
  await keeper.tick()
  assert.equal(chain.writes.length, 1, 'not again within the day')
  chain.state.time += 23 * 3_600
  await keeper.tick()
  assert.equal(chain.writes.length, 2)
})

test('without AGENT_TOKEN_ADDRESS the launchpad is never touched', async () => {
  const chain = fakeChain()
  chain.agentIdOf = async () => { throw new Error('must not be called') }
  const { keeper, alerts } = setup({ chain, config: { agentToken: null } })
  await keeper.init()
  await keeper.tick()
  assert.equal(chain.writes.length, 0)
  assert.equal(alerts.length, 0)
})

test('a launchpad record that pays someone else is critical, and nothing is claimed', async () => {
  for (const agentWallet of [ZERO, OTHER]) {
    const { keeper, chain, alerts } = setup({ chain: fakeChain({ record: { token: TOKEN, owner: OWNER, agentWallet, stakeWei: 0n } }) })
    await keeper.init()
    await keeper.tick()
    assert.equal(chain.writes.length, 0)
    assert.ok(alerts.some((a) => a.key === 'launchpad-wallet' && a.level === 'critical'))
  }
})

test('a token that is not on the launchpad is reported, not guessed', async () => {
  const { keeper, chain, alerts } = setup({ config: { agentToken: OTHER } })
  await keeper.init()
  await keeper.tick()
  assert.equal(chain.writes.length, 0)
  assert.ok(alerts.some((a) => a.key === 'launchpad-unknown'))
})

test('low API balance: warns; claims into it only when FUNDING_ACTIVATE is on', async () => {
  const off = setup({ balance: 5n * C })
  await off.keeper.init()
  await off.keeper.tick()
  assert.ok(off.alerts.some((a) => a.key === 'gateway-low'))
  assert.deepEqual(off.chain.writes, [['claim', 2077n, false]])

  const on = setup({ balance: 5n * C, config: { fundingActivate: true } })
  await on.keeper.init()
  await on.keeper.tick()
  assert.deepEqual(on.chain.writes, [['claim', 2077n, true]])
})

test('ETH for gas running out is critical', async () => {
  const { keeper, alerts } = setup({ chain: fakeChain({ ethBalance: ETH / 1000n }) })
  await keeper.init()
  await keeper.tick()
  const eth = alerts.find((a) => a.key === 'eth-low')
  assert.equal(eth.level, 'critical')
  assert.match(eth.text, /about 5\.5 days/)
})

test('a failed claim is an alert, and the report still arrives', async () => {
  const chain = fakeChain()
  chain.claimCredit = async () => { throw new Error('NothingToClaim()') }
  const { keeper, alerts } = setup({ chain })
  await keeper.init()
  await keeper.tick()
  assert.ok(alerts.some((a) => a.key === 'launchpad-claim-failed'))
  assert.ok(alerts.some((a) => a.key.startsWith('funding-')))
})

test('no alert or log ever contains the Orbio key', async () => {
  const { keeper, alerts } = setup({ balance: 1n })
  keeper.fetch = async () => { throw new Error('boom sk-secret') }
  await keeper.init()
  await keeper.tick()
  assert.ok(alerts.length > 0)
  assert.ok(alerts.every((a) => !a.text.includes('sk-secret')))
})
