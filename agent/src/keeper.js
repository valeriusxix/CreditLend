// The agent's main loop. `tick()` runs about once a minute and does whatever is due:
//   every tick    check every borrower's health; liquidate (if enabled); take an oracle reading when due
//   every hour    measure liquidator margins on the order book; sample utilization
//   every day     LLM review: report + rate recommendation (proposed only if allowed and enabled)
// It also executes a pending rate switch once its public delay is over (anyone may; it costs only gas).
import { WAD, classifyHealth, quoteCostPerCredit, diffBps } from './risk.js'
import { readingMode, readingDue } from './schedule.js'
import { bookDepthCheck, manipulationCheck } from './monitors.js'
import { planLiquidation, executeLiquidation } from './liquidator.js'
import { labelModels, labelOf, buildSnapshot, runReview, decideProposal } from './review.js'

const HOUR = 3600
const DAY = 24 * HOUR
const ZERO = '0x0000000000000000000000000000000000000000'
const UNLIMITED = 2n ** 255n

export class Keeper {
  constructor({ chain, alerter, config, complete = null, log = console }) {
    this.chain = chain
    this.alerter = alerter
    this.cfg = config
    this.complete = complete
    this.log = log

    this.borrowers = new Set()
    this.borrowerCursor = null
    this.readings = []
    this.readingCursor = null

    this.lastAttemptAt = null
    this.lastAttemptFailed = false
    this.mode = null
    this.lastBookCheckAt = null
    this.bookRows = []
    this.utilizationHistory = []
    this.lastReviewAt = null
  }

  async init() {
    await this.chain.init()
    const { number } = await this.chain.now()
    const perHour = await this.chain.blocksPerHour()
    this.borrowerCursor = BigInt(this.cfg.poolDeployBlock ?? 0)
    const lookback = number - perHour * 3n
    this.readingCursor = lookback > this.borrowerCursor ? lookback : this.borrowerCursor
  }

  async tick() {
    const { time: now, number } = await this.chain.now()
    await this._sync(number, now)

    const oracle = await this.chain.oracleState()
    const live = await this._livePrice()
    const recorded = oracle.recordedPrice
    const liveVsRecordedBps = live == null ? null : diffBps(recorded, live)

    const positions = await this._checkPositions()
    if (this.cfg.liquidatorEnabled && this.chain.address) await this._liquidate(positions.filter((p) => p.band === 'liquidatable'))

    // ---- oracle reading
    const lastHour = this.readings.filter((r) => r.time >= now - HOUR)
    const mode = readingMode({
      foreignReadingsLastHour: lastHour.filter((r) => r.foreign).length,
      rejectedReadingsLastHour: lastHour.filter((r) => r.status.startsWith('Rejected')).length,
      lastAttemptFailed: this.lastAttemptFailed,
      oracleFresh: oracle.fresh,
      liveVsRecordedBps,
      atRiskPositions: positions.filter((p) => p.band !== 'healthy').length,
    })
    if (this.mode !== mode.mode) {
      this.log.info(`oracle readings: every ${mode.interval / 60} minutes${mode.reasons.length ? ' because ' + mode.reasons.join('; ') : ''}`)
      this.mode = mode.mode
    }
    if (readingDue({ now, interval: mode.interval, lastAttemptAt: this.lastAttemptAt, chainLastReadingTime: oracle.lastReadingTime, minInterval: oracle.minInterval })) {
      await this._takeReading(now)
    }
    if (!oracle.fresh) {
      await this.alerter.send({ key: 'oracle-stale', level: 'critical', text: 'The $CREDIT oracle is stale: liquidations are priced at $1 until readings resume.' })
    }

    for (const a of manipulationCheck({ now, readings: this.readings, livePrice: live, recordedPrice: recorded }).alerts) await this.alerter.send(a)

    // ---- hourly
    if (this.lastBookCheckAt == null || now >= this.lastBookCheckAt + HOUR) {
      this.lastBookCheckAt = now
      await this._hourly()
    }

    // ---- rate switch
    await this._executePendingRateSwitch(now)
    if (this.complete && (this.lastReviewAt == null || now >= this.lastReviewAt + DAY)) {
      this.lastReviewAt = now
      await this._review(now, oracle)
    }

    return { now, mode: mode.mode, positions: positions.length }
  }

  // ------------------------------------------------------------------------------------------ sync

  async _sync(number, now) {
    if (number >= this.borrowerCursor) {
      for (const b of await this.chain.borrowersSince(this.borrowerCursor, number)) this.borrowers.add(b)
      this.borrowerCursor = number + 1n
    }
    if (number >= this.readingCursor) {
      this.readings.push(...(await this.chain.readingsSince(this.readingCursor, number)))
      this.readingCursor = number + 1n
    }
    this.readings = this.readings.filter((r) => r.time >= now - 3 * HOUR)
  }

  async _livePrice() {
    try {
      const size = this.chain.referenceSize
      const cost = quoteCostPerCredit(await this.chain.quote(size), size)
      return cost == null ? null : cost > WAD ? WAD : cost
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------------------------------- positions

  async _checkPositions() {
    const out = []
    for (const borrower of this.borrowers) {
      const { debt, healthFactor } = await this.chain.accountData(borrower)
      if (debt === 0n) continue
      const band = classifyHealth(healthFactor)
      out.push({ borrower, debt, healthFactor, band })
      const hf = (Number(healthFactor) / 1e18).toFixed(3)
      if (band === 'at-risk') {
        await this.alerter.send({ key: `at-risk-${borrower}`, level: 'warn', text: `Position ${borrower} is close to liquidation (health ${hf}).` })
      } else if (band === 'liquidatable' && !this.cfg.liquidatorEnabled) {
        await this.alerter.send({ key: `liquidatable-${borrower}`, level: 'critical', text: `Position ${borrower} can be liquidated (health ${hf}) and auto-liquidation is off.` })
      }
    }
    return out
  }

  async _liquidate(positions) {
    if (!positions.length) return
    const { usdg, credit, exchange, pool } = this.cfg
    const [assets, settlementPrice, feeBps, minDebt] = await Promise.all([
      this.chain.collateralAssets(),
      this.chain.settlementPrice(),
      this.chain.feeBps(),
      this.chain.market().then((m) => m.minDebt),
    ])
    for (const p of [...positions].sort((a, b) => (a.debt > b.debt ? -1 : 1))) {
      const [creditInventory, usdgBalance] = await Promise.all([this.chain.balanceOf(credit), this.chain.balanceOf(usdg)])
      const withBalances = await Promise.all(assets.map(async (a) => ({ ...a, available: await this.chain.collateralOf(p.borrower, a.asset) })))
      const result = await planLiquidation({
        borrower: p.borrower,
        debt: p.debt,
        healthFactor: p.healthFactor,
        minDebt,
        assets: withBalances,
        settlementPrice,
        creditInventory,
        usdgBalance,
        feeBps,
        minProfitBps: this.cfg.minProfitBps,
        quote: (n) => this.chain.quote(n),
      })
      if (result.skip) {
        this.log.info(`not liquidating ${p.borrower}: ${result.skip}`)
        if (result.underfunded) await this.alerter.send({ key: `liq-underfunded-${p.borrower}`, level: 'critical', text: `Can't liquidate ${p.borrower}: ${result.skip}. Top up the agent's USDG.` })
        else await this.alerter.send({ key: `liq-skipped-${p.borrower}`, level: 'warn', text: `Position ${p.borrower} is liquidatable but the agent is not liquidating it: ${result.skip}.` })
        continue
      }
      try {
        const hashes = await executeLiquidation(result.plan, this.chain, { usdg, credit, exchange, pool })
        await this.alerter.send({ key: `liquidated-${hashes.at(-1)}`, level: 'info', text: `Liquidated ${p.borrower}: repaid ${result.plan.repaid} CREDIT atoms, expected margin ${(result.plan.marginBps / 100).toFixed(2)}% (tx ${hashes.at(-1)}).` })
      } catch (err) {
        await this.alerter.send({ key: `liq-failed-${p.borrower}`, level: 'critical', text: `Liquidating ${p.borrower} failed: ${err?.shortMessage ?? err?.message ?? err}` })
      }
    }
  }

  // ----------------------------------------------------------------------------------------- oracle

  async _takeReading(now) {
    if (!this.chain.address) return // read-only mode: monitoring only
    this.lastAttemptAt = now
    const sim = await this.chain.simulateUpdate()
    if (!sim.ok) {
      if (/TooSoon/.test(sim.error)) return // someone else just read; try again next slot
      this.lastAttemptFailed = true
      await this.alerter.send({ key: 'reading-sim-failed', level: 'warn', text: `Oracle reading would fail: ${sim.error}` })
      return
    }
    try {
      const { hash } = await this.chain.sendUpdate()
      this.lastAttemptFailed = false
      this.log.info(`oracle reading ${sim.status} (tx ${hash})`)
    } catch (err) {
      this.lastAttemptFailed = true
      await this.alerter.send({ key: 'reading-failed', level: 'warn', text: `Oracle reading failed: ${err?.shortMessage ?? err?.message ?? err}. Retrying in 5 minutes.` })
    }
  }

  // ----------------------------------------------------------------------------------------- hourly

  async _hourly() {
    const market = await this.chain.market()
    this.utilizationHistory.push(market.utilization)
    if (this.utilizationHistory.length > 24) this.utilizationHistory.shift()

    const ref = this.chain.referenceSize
    const cap = market.maxDebtPerAccount >= UNLIMITED ? 20_000_000_000n : market.maxDebtPerAccount
    const sizes = [...new Set([ref, cap / 2n, cap])].filter((s) => s > 0n)
    const quotes = await Promise.all(sizes.map(async (size) => ({ size, quote: await this.chain.quote(size) })))
    const assets = await this.chain.collateralAssets()
    const usdg = assets.find((a) => a.asset.toLowerCase() === this.cfg.usdg.toLowerCase())
    const check = bookDepthCheck({ quotes, settlementPrice: await this.chain.settlementPrice(), bonusBps: usdg?.bonusBps ?? 500, maxDebtPerAccount: cap })
    this.bookRows = check.rows
    this.log.info(`liquidator margin by size: ${check.rows.map((r) => `${Number(r.size) / 1e6} CREDIT ${r.marginBps == null ? 'unfillable' : (r.marginBps / 100).toFixed(1) + '%'}`).join(', ')}`)
    for (const a of check.alerts) await this.alerter.send(a)
  }

  // ------------------------------------------------------------------------------------ rate switch

  async _executePendingRateSwitch(now) {
    if (!this.chain.address || !this.cfg.rateController) return
    const rs = await this.chain.rateState()
    if (rs.pending.model === ZERO || now < rs.pending.executableAt || now > rs.pending.executableAt + rs.gracePeriod) return
    try {
      const { hash } = await this.chain.executeRateSwitch()
      await this.alerter.send({ key: `rate-executed-${hash}`, level: 'info', text: `Rate switch to ${rs.pending.model} is now active (tx ${hash}).` })
    } catch (err) {
      this.log.warn(`executing the pending rate switch failed: ${err?.shortMessage ?? err?.message ?? err}`)
    }
  }

  async _review(now, oracle) {
    try {
      const [market, rateState] = await Promise.all([this.chain.market(), this.chain.rateState()])
      const labels = labelModels(rateState.models)
      const currentLabel = labels ? labelOf(labels, market.interestRateModel) : null
      const snapshot = buildSnapshot({ market, currentLabel, utilizationHistory: this.utilizationHistory, bookRows: this.bookRows, oracle, rateState, now })
      const recommendation = await runReview({ complete: this.complete, snapshot })
      const decision = decideProposal({ recommendation, labels, currentLabel, rateState, agentAddress: this.chain.address, now, enabled: this.cfg.rateProposalsEnabled })

      const report = recommendation ? `${recommendation.report}\nRecommendation: ${recommendation.decision} (${recommendation.reason})` : 'The AI review returned no usable answer; no action taken.'
      if (decision.action === 'propose') {
        const { hash } = await this.chain.proposeRateModel(decision.model)
        await this.alerter.send({ key: `review-${now}`, level: 'info', text: `${report}\nProposed switching to "${decision.target}" (tx ${hash}). It takes effect in 6 hours unless the guardian cancels.` })
      } else {
        await this.alerter.send({ key: `review-${now}`, level: 'info', text: `${report}\nNo rate change: ${decision.why}.` })
      }
    } catch (err) {
      await this.alerter.send({ key: 'review-failed', level: 'warn', text: `Daily review failed: ${err?.message ?? err}` })
    }
  }
}
