// Entry point: `npm start` runs forever (one tick a minute); `npm run once` runs a single tick.
import { loadConfig, describe } from './config.js'
import { ChainAdapter } from './chain.js'
import { Alerter } from './alerts.js'
import { Keeper } from './keeper.js'
import { orbioCompleter } from './review.js'

const cfg = loadConfig()
const chain = new ChainAdapter(cfg)
const alerter = new Alerter(cfg.alerts)
const keeper = new Keeper({ chain, alerter, config: cfg, complete: cfg.llm ? orbioCompleter(cfg.llm) : null })

console.info(`CreditLend agent starting | ${describe(cfg, chain.address)}`)
await keeper.init()

const once = process.argv.includes('--once')
let stopping = false
let failures = 0
process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })

while (!stopping) {
  try {
    const r = await keeper.tick()
    failures = 0
    console.info(`tick ok: ${r.positions} open position(s), readings ${r.mode === 'fast' ? 'every 5 min' : 'hourly'}`)
  } catch (err) {
    // A failed tick (RPC hiccup etc.) is retried next minute. Ten in a row means the agent is blind.
    console.error(`tick failed: ${err?.shortMessage ?? err?.message ?? err}`)
    if (++failures >= 10) await alerter.send({ key: 'agent-down', level: 'critical', text: `The agent has failed ${failures} checks in a row (last error: ${err?.shortMessage ?? err?.message ?? err}). Nobody is feeding the oracle or watching positions.` })
  }
  if (once) break
  await new Promise((r) => setTimeout(r, cfg.tickSeconds * 1000))
}
