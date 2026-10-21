import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planLiquidation, executeLiquidation } from '../src/liquidator.js'
import { Alerter } from '../src/alerts.js'
import { WAD } from '../src/risk.js'

const C = 10n ** 6n
const usd = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
const quoteAt = (price) => async (n) => ({ creditOut: n, usdgSpent: (n * usd(price)) / WAD, feeAtoms: 0n, fills: 1n, reason: 4 })

// Borrower owes 20,000 CREDIT at HF 0.97 -> half (10,000) can be repaid; settlement price $0.55.
const base = {
  borrower: '0x00000000000000000000000000000000000000b0',
  debt: 20_000n * C,
  healthFactor: usd(0.97),
  minDebt: 10n * C,
  assets: [{ asset: USDG, decimals: 6, bonusBps: 500, price: WAD, available: 20_000n * C }],
  settlementPrice: usd(0.55),
  creditInventory: 0n,
  usdgBalance: 10_000n * C,
  feeBps: 200,
  minProfitBps: 100,
}

test('plans a profitable liquidation and sets the on-chain profit floor', async () => {
  // book at $0.53 + 0.5% slack + 2% fee ~ $0.5435 per CREDIT; receives $0.5775 -> ~6% margin
  const { plan } = await planLiquidation({ ...base, quote: quoteAt(0.53) })
  assert.equal(plan.repaid, 10_000n * C)
  assert.equal(plan.seized, 5_775n * C)
  assert.equal(plan.needCredit, 10_000n * C)
  assert.ok(plan.minSeized >= (plan.usdgCost * 101n) / 100n, 'minSeized covers cost + 1%')
  assert.ok(plan.minSeized <= plan.seized)
  assert.ok(plan.marginBps > 500 && plan.marginBps < 700, `margin ${plan.marginBps}`)
})

test('skips when the book is too expensive', async () => {
  const r = await planLiquidation({ ...base, quote: quoteAt(0.56) })
  assert.match(r.skip, /not profitable/)
})

test('skips when the book cannot fill the size', async () => {
  const r = await planLiquidation({ ...base, quote: async (n) => ({ creditOut: n / 2n, usdgSpent: 1n, feeAtoms: 0n, fills: 64n, reason: 3 }) })
  assert.match(r.skip, /can't supply/)
})

test('flags an underfunded USDG float', async () => {
  const r = await planLiquidation({ ...base, usdgBalance: 1_000n * C, quote: quoteAt(0.5) })
  assert.equal(r.underfunded, true)
})

test('uses CREDIT inventory first and only buys the rest', async () => {
  const { plan } = await planLiquidation({ ...base, creditInventory: 4_000n * C, quote: quoteAt(0.5) })
  assert.equal(plan.needCredit, 6_000n * C)
})

test('healthy or collateral-less positions are skipped', async () => {
  assert.match((await planLiquidation({ ...base, healthFactor: WAD, quote: quoteAt(0.5) })).skip, /healthy/)
  assert.match((await planLiquidation({ ...base, assets: [{ ...base.assets[0], price: null }], quote: quoteAt(0.5) })).skip, /no priceable/)
})

test('execution: approve + buy, then approve + liquidate with the planned floor', async () => {
  const calls = []
  const chain = {
    ensureAllowance: async (token, spender, amount) => calls.push(['approve', token, spender, amount]),
    buyCredit: async (usdgIn, minOut) => { calls.push(['buy', usdgIn, minOut]); return { hash: '0xb' } },
    liquidate: async (b, a, repay, minSeized) => { calls.push(['liquidate', b, a, repay, minSeized]); return { hash: '0xl' } },
  }
  const plan = { borrower: '0xb0', asset: USDG, repaid: 100n, seized: 60n, minSeized: 55n, needCredit: 100n, usdgIn: 50n, usdgCost: 51n }
  const hashes = await executeLiquidation(plan, chain, { usdg: 'U', credit: 'C', exchange: 'E', pool: 'P' })
  assert.deepEqual(hashes, ['0xb', '0xl'])
  assert.deepEqual(calls, [['approve', 'U', 'E', 51n], ['buy', 50n, 100n], ['approve', 'C', 'P', 100n], ['liquidate', '0xb0', USDG, 100n, 55n]])
})

// ------------------------------------------------------------------ alerts

const quietLog = () => { const lines = []; return { lines, info: (l) => lines.push(l), warn: (l) => lines.push(l) } }

test('alerts: logged, sent to webhook and Telegram, repeats suppressed for an hour', async () => {
  let now = 1_000
  const posts = []
  const log = quietLog()
  const a = new Alerter({ webhookUrl: 'https://hooks.example/secret', telegramBotToken: 'TOKEN', telegramChatId: '42', log, clock: () => now, fetchFn: async (url, init) => { posts.push([url, JSON.parse(init.body)]); return { ok: true } } })
  assert.equal(await a.send({ key: 'k', level: 'warn', text: 'hello' }), true)
  assert.equal(posts.length, 2)
  assert.equal(posts[0][1].content, '[CreditLend WARN] hello')
  assert.equal(posts[1][0], 'https://api.telegram.org/botTOKEN/sendMessage')
  assert.equal(posts[1][1].chat_id, '42')
  assert.equal(await a.send({ key: 'k', level: 'warn', text: 'hello' }), false)
  now += 3600
  assert.equal(await a.send({ key: 'k', level: 'warn', text: 'hello' }), true)
})

test('alerts: a delivery failure never throws and never logs the secret URL', async () => {
  const log = quietLog()
  const a = new Alerter({ webhookUrl: 'https://hooks.example/secret', log, fetchFn: async () => { throw new TypeError('network down at https://hooks.example/secret') } })
  await a.send({ key: 'k', text: 'x' })
  assert.ok(log.lines.some((l) => /delivery failed/.test(l)))
  assert.ok(!log.lines.some((l) => /secret/.test(l)))
})
