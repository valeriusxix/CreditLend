import { test } from 'node:test'
import assert from 'node:assert/strict'
import { labelModels, labelOf, parseRecommendation, decideProposal, runReview, buildSnapshot } from '../src/review.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const AGENT = '0x000000000000000000000000000000000000A6e7'
const m = (address, base) => ({ address, base, slope1: 0n, slope2: 0n, kink: 0n })
const models = [m('0x0000000000000000000000000000000000000003', 4n), m('0x0000000000000000000000000000000000000001', 1n), m('0x0000000000000000000000000000000000000002', 2n)]
const labels = labelModels(models)
const rateState = { models, agent: AGENT, pending: { model: ZERO, executableAt: 0 }, lastExecutedAt: 0, cooldown: 86_400, gracePeriod: 86_400 }
const rec = (decision) => ({ decision, reason: 'r', report: 'ok' })
const base = { labels, currentLabel: 'normal', rateState, agentAddress: AGENT, now: 1_000_000, enabled: true }

test('models are labelled by base rate', () => {
  assert.equal(labels.lower.address, models[1].address)
  assert.equal(labels.normal.address, models[2].address)
  assert.equal(labels.higher.address, models[0].address)
  assert.equal(labelOf(labels, models[0].address.toLowerCase()), 'higher')
  assert.equal(labelModels(models.slice(0, 2)), null)
})

test('parse: accepts the exact JSON shape, even wrapped in text', () => {
  assert.deepEqual(parseRecommendation('Sure:\n{"decision":"higher","reason":"util 85% for days","report":"busy"}'), { decision: 'higher', reason: 'util 85% for days', report: 'busy' })
})

test('parse: anything malformed means no action', () => {
  for (const bad of [
    '',
    'raise rates',
    '{"decision":"maximum","reason":"x","report":"y"}',
    '{"decision":"higher","reason":"x"}',
    '{"decision":"higher","reason":1,"report":"y"}',
    '{"decision":"higher", "reason": "x", "report": "y"',
    '["higher"]',
    `{"decision":"higher","reason":"x","report":"${'y'.repeat(5000)}"}`,
  ]) {
    assert.equal(parseRecommendation(bad), null, bad.slice(0, 40))
  }
})

test('decide: one step from the current setting is proposed', () => {
  assert.deepEqual(decideProposal({ ...base, recommendation: rec('higher') }), { action: 'propose', model: labels.higher.address, target: 'higher' })
})

test('decide: keep, same, invalid or two-step jumps do nothing', () => {
  assert.equal(decideProposal({ ...base, recommendation: null }).action, 'none')
  assert.equal(decideProposal({ ...base, recommendation: rec('keep') }).action, 'none')
  assert.equal(decideProposal({ ...base, recommendation: rec('normal') }).action, 'none')
  const jump = decideProposal({ ...base, currentLabel: 'lower', recommendation: rec('higher') })
  assert.equal(jump.action, 'none')
  assert.match(jump.why, /one step/)
})

test('decide: pending switch, cooldown, wrong wallet or switched off do nothing', () => {
  const pending = { ...rateState, pending: { model: labels.lower.address, executableAt: base.now + 100 } }
  assert.match(decideProposal({ ...base, rateState: pending, recommendation: rec('higher') }).why, /pending/)
  const expired = { ...rateState, pending: { model: labels.lower.address, executableAt: base.now - 90_000 } }
  assert.equal(decideProposal({ ...base, rateState: expired, recommendation: rec('higher') }).action, 'propose')
  const cooling = { ...rateState, lastExecutedAt: base.now - 3600 }
  assert.match(decideProposal({ ...base, rateState: cooling, recommendation: rec('higher') }).why, /cooldown/)
  assert.match(decideProposal({ ...base, agentAddress: '0x0000000000000000000000000000000000000009', recommendation: rec('higher') }).why, /not the RateController agent/)
  assert.match(decideProposal({ ...base, enabled: false, recommendation: rec('higher') }).why, /RATE_PROPOSALS_ENABLED is off/)
  assert.match(decideProposal({ ...base, currentLabel: null, recommendation: rec('higher') }).why, /not on the menu/)
})

test('runReview: a refusal or truncated answer is ignored', async () => {
  const good = '{"decision":"keep","reason":"x","report":"y"}'
  assert.equal((await runReview({ complete: async () => ({ text: good, stopReason: 'end_turn' }), snapshot: 's' })).decision, 'keep')
  assert.equal(await runReview({ complete: async () => ({ text: good, stopReason: 'refusal' }), snapshot: 's' }), null)
  assert.equal(await runReview({ complete: async () => ({ text: good, stopReason: 'max_tokens' }), snapshot: 's' }), null)
})

test('snapshot is plain text the model can read', () => {
  const market = { utilization: 5n * 10n ** 17n, borrowRatePerYear: 9n * 10n ** 16n, supplyRatePerYear: 4n * 10n ** 16n, cash: 10_000_000_000n, totalBorrows: 10_000_000_000n, maxTotalBorrows: 50_000_000_000n, totalReserves: 0n }
  const s = buildSnapshot({ market, currentLabel: 'normal', utilizationHistory: [4n * 10n ** 17n], bookRows: [{ size: 5_000_000_000n, marginBps: 500 }], oracle: { recordedPrice: 55n * 10n ** 16n, fresh: true }, rateState, now: 0 })
  assert.match(s, /Utilization now: 50\.00%/)
  assert.match(s, /Current rate setting: normal/)
  assert.match(s, /5,000 CREDIT 5\.0%/)
})

test('decide: a recent (even cancelled) proposal blocks a new one until the contract allows it', () => {
  const recent = { ...rateState, nextProposalAllowed: base.now + 3600 }
  assert.match(decideProposal({ ...base, rateState: recent, recommendation: rec('higher') }).why, /last proposal/)
  const over = { ...rateState, nextProposalAllowed: base.now }
  assert.equal(decideProposal({ ...base, rateState: over, recommendation: rec('higher') }).action, 'propose')
})
