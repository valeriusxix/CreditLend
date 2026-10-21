// Daily review: an LLM (through the Orbio gateway) reads a snapshot of the market, writes a short report
// and recommends one of the rate settings on the RateController menu. The LLM only ADVISES. Plain code
// below decides whether a proposal is allowed, and the RateController contract enforces the rest
// (approved menu only, 6-hour public delay, one switch per 24 hours, guardian can cancel).
import Anthropic from '@anthropic-ai/sdk'

export const LABELS = ['lower', 'normal', 'higher']
const DECISIONS = new Set([...LABELS, 'keep'])

const pct = (wad) => `${(Number(wad) / 1e16).toFixed(2)}%`
const credit = (atoms) => `${(Number(atoms) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 0 })} CREDIT`

/// Labels the menu's models lower / normal / higher by base rate. Needs exactly three models.
export function labelModels(models) {
  if (models.length !== 3) return null
  const sorted = [...models].sort((a, b) => (a.base < b.base ? -1 : a.base > b.base ? 1 : 0))
  return Object.fromEntries(sorted.map((m, i) => [LABELS[i], m]))
}

export function labelOf(labels, address) {
  return LABELS.find((l) => labels[l].address.toLowerCase() === address.toLowerCase()) ?? null
}

export const SYSTEM_PROMPT = `You are the rate-setting assistant for CreditLend, a fully collateralized $CREDIT lending market on Robinhood Chain.
Lenders deposit $CREDIT; borrowers post USDG collateral and borrow $CREDIT. Borrowing is capped per account and in total because the $CREDIT order book is thin.

Once a day you receive a market snapshot. You may recommend switching between three pre-approved interest-rate settings:
- "lower": cheaper borrowing. Use when utilization has stayed low (well under 50%) for days and borrowing demand needs encouraging.
- "normal": the default.
- "higher": better lender yield. Use when utilization has stayed high (above ~80%) so lenders may be unable to withdraw, or lender deposits are needed.
Or "keep" the current setting. Prefer "keep" unless the evidence is sustained, not a single reading. A switch is announced 6 hours ahead and at most one can happen per 24 hours, so avoid flip-flopping.
Utilization near the borrow cap is caused by the cap, not by rates; raising rates does not help that.

Reply with ONLY a JSON object, no other text:
{"decision": "lower" | "normal" | "higher" | "keep", "reason": "<one or two sentences>", "report": "<a short plain-English daily report for the project owner, under 150 words>"}`

export function buildSnapshot({ market, currentLabel, utilizationHistory, bookRows, oracle, rateState, now }) {
  const lines = [
    `Time: ${new Date(now * 1000).toISOString()}`,
    `Current rate setting: ${currentLabel ?? 'unknown (not on the menu)'}`,
    `Utilization now: ${pct(market.utilization)}; borrow APR ${pct(market.borrowRatePerYear)}; lender APR ${pct(market.supplyRatePerYear)}`,
    `Lender cash: ${credit(market.cash)}; total borrowed: ${credit(market.totalBorrows)} of a ${credit(market.maxTotalBorrows)} cap; reserves ${credit(market.totalReserves)}`,
    `Utilization samples over the last day (oldest first): ${utilizationHistory.length ? utilizationHistory.map((u) => pct(u)).join(', ') : 'none yet'}`,
    `$CREDIT recorded price: $${(Number(oracle.recordedPrice) / 1e18).toFixed(4)}; oracle fresh: ${oracle.fresh}`,
    `Liquidator margin by size: ${bookRows.length ? bookRows.map((r) => `${credit(r.size)} ${r.marginBps == null ? 'unfillable' : (r.marginBps / 100).toFixed(1) + '%'}`).join('; ') : 'not measured yet'}`,
    `Pending rate switch: ${rateState.pending.model === '0x0000000000000000000000000000000000000000' ? 'none' : rateState.pending.model}`,
  ]
  return lines.join('\n')
}

/// Strict parse of the model's reply. Anything malformed returns null, which means "do nothing".
export function parseRecommendation(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  if (!DECISIONS.has(obj.decision)) return null
  if (typeof obj.reason !== 'string' || obj.reason.length > 2000) return null
  if (typeof obj.report !== 'string' || obj.report.length > 4000) return null
  return { decision: obj.decision, reason: obj.reason, report: obj.report }
}

/// Deterministic rules applied to the LLM's recommendation before anything is sent on-chain.
export function decideProposal({ recommendation, labels, currentLabel, rateState, agentAddress, now, enabled }) {
  const none = (why) => ({ action: 'none', why })
  if (!recommendation) return none('no valid recommendation')
  const target = recommendation.decision
  if (target === 'keep' || target === currentLabel) return none('keep the current setting')
  if (!labels) return none('the rate menu does not have exactly three models')
  if (currentLabel == null) return none('the current model is not on the menu (set directly by the timelock)')
  if (Math.abs(LABELS.indexOf(target) - LABELS.indexOf(currentLabel)) !== 1) return none(`only one step at a time (${currentLabel} -> ${target} skipped)`)

  const p = rateState.pending
  if (p.model !== '0x0000000000000000000000000000000000000000' && now <= p.executableAt + rateState.gracePeriod) return none('a switch is already pending')
  if (rateState.lastExecutedAt !== 0 && now < rateState.lastExecutedAt + rateState.cooldown) return none('cooldown after the last switch is still running')
  if (!agentAddress || rateState.agent.toLowerCase() !== agentAddress.toLowerCase()) return none('this wallet is not the RateController agent')
  if (!enabled) return none(`would propose "${target}", but RATE_PROPOSALS_ENABLED is off`)
  return { action: 'propose', model: labels[target].address, target }
}

/// Default LLM call through the Orbio gateway (Anthropic Messages format at ANTHROPIC_BASE_URL). Orbio names
/// models "anthropic/claude-opus-5.5" (see GET https://api.orbio.so/api/v1/models). The Orbio key is sent as
/// both x-api-key and a Bearer token, since the gateway documents Bearer for its own tools. Every call is
/// paid in CREDIT from the Orbio balance.
export function orbioCompleter({ apiKey, baseURL, model }) {
  const client = new Anthropic({ apiKey, authToken: apiKey, baseURL, maxRetries: 2 })
  return async (system, user) => {
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
    })
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
    return { text, stopReason: response.stop_reason }
  }
}

export async function runReview({ complete, snapshot }) {
  const { text, stopReason } = await complete(SYSTEM_PROMPT, snapshot)
  if (stopReason === 'refusal' || stopReason === 'max_tokens') return null
  return parseRecommendation(text)
}
