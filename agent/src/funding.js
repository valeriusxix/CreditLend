// Launchpad funding (spec §4.2, §7). Once the owner has launched the agent's token on the Orbio agent
// launchpad, the token's creator fees are split by Orbio's vault (checked on-chain 2026-10-22):
//   50%  staked as $ORBIO for the agent; earns CREDIT that the agent must CLAIM (this module does that)
//   30%  sold for USDG and minted to the agent wallet as CREDIT (arrives by itself)
//   10%  sold for USDG and credited as Orbio API balance for the agent wallet (arrives by itself)
//   10%  Orbio treasury
// None of it pays for gas, which is ETH, so this module also warns before the agent's ETH runs out.
// Plain functions only; the keeper does the reads and writes.

export const ORBIO_KEY_URL = 'https://api.orbio.so/api/v1/key'
// Gas the agent uses in a day, with room to spare: hourly oracle readings are 24 × ~179,000 gas; this
// doubles that for busy days (readings every 5 minutes, claims, rate switches).
export const GAS_PER_DAY = 9_000_000n
export const ETH_WARN_DAYS = 14

/// The Orbio account's spendable API balance, in micro-dollars (1 CREDIT = $1 = 1,000,000). Never logs
/// or returns the key. `{ ok: false, status }` on any failure: the caller carries on without it.
export async function fetchGatewayBalance({ apiKey, fetchFn = globalThis.fetch }) {
  try {
    const res = await fetchFn(ORBIO_KEY_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!res.ok) return { ok: false, status: res.status }
    const body = await res.json()
    const available = body?.balance?.available_micro_usd
    if (available == null || !/^\d+$/.test(String(available))) return { ok: false, status: 'unexpected answer' }
    return { ok: true, availableMicroUsd: BigInt(available) }
  } catch (err) {
    return { ok: false, status: err?.name ?? 'network error' }
  }
}

/// Whether to claim the staking rewards now, and in which form.
/// As tokens by default: CREDIT tokens are liquidation stock and can still be turned into API balance
/// later. Straight into API balance (fee-free through the vault, but irreversible) only when the owner
/// switched it on AND the balance is known to be below the floor.
export function planClaim({ owed, minClaim, activateEnabled, gatewayMicroUsd, floorMicroUsd }) {
  if (owed < minClaim) return { claim: false, why: `only ${fmtCredit(owed)} CREDIT waiting (minimum ${fmtCredit(minClaim)})` }
  const activate = Boolean(activateEnabled) && gatewayMicroUsd != null && gatewayMicroUsd < floorMicroUsd
  return { claim: true, activate }
}

/// Days of gas left at today's gas price; null if the price reads as zero.
export function ethRunwayDays({ balanceWei, gasPriceWei, gasPerDay = GAS_PER_DAY }) {
  const perDay = gasPriceWei * gasPerDay
  if (perDay === 0n) return null
  return Number((balanceWei * 10n) / perDay) / 10
}

/// Problems with the launchpad record that stop the agent from being funded.
export function walletProblem({ agentWallet, owner, agentAddress }) {
  const zero = /^0x0{40}$/i
  if (!agentAddress) return null // read-only mode: nothing to claim with anyway
  if (zero.test(agentWallet)) return `the launchpad has no agent wallet for this token, so its CREDIT and API balance go to the owner wallet ${owner} and the agent can't claim. The owner can fix it with setAgentWallet on the Orbio vault.`
  if (agentWallet.toLowerCase() !== agentAddress.toLowerCase()) return `the launchpad sends this token's CREDIT to ${agentWallet}, not to the agent's wallet ${agentAddress}, so the agent can't claim. The owner can fix it with setAgentWallet on the Orbio vault.`
  return null
}

/// The daily funding line (sent as an info alert).
export function fundingReport({ agentId, owed, stakeWei, income, creditBalance, gateway, runwayDays, claimed }) {
  const lines = [
    `Launchpad funding (agent #${agentId}), last 30 days: ${fmtCredit(income.creditMinted)} CREDIT from trading fees, $${fmtCredit(income.gatewayUsdg)} of API balance, ${fmtCredit(income.stakingClaimed)} CREDIT of staking rewards claimed.`,
    `Now: ${fmtCredit(owed)} CREDIT of staking rewards waiting, ${fmtWei(stakeWei)} ORBIO staked, ${fmtCredit(creditBalance)} CREDIT in the agent wallet, ` +
      `${gateway?.ok ? `$${fmtCredit(gateway.availableMicroUsd)} Orbio API balance` : 'Orbio API balance unknown'}, ` +
      `${runwayDays == null ? 'ETH runway unknown' : `about ${runwayDays} days of ETH for gas`}.`,
  ]
  if (claimed) lines.push(`Claimed ${fmtCredit(claimed.amount)} CREDIT ${claimed.activate ? 'into API balance' : 'as tokens'} (tx ${claimed.hash}).`)
  return lines.join('\n')
}

// CREDIT and USDG have 6 decimals; micro-dollars are the same unit.
export function fmtCredit(atoms) {
  return (Number(atoms) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function fmtWei(wei) {
  return (Number(wei / 10n ** 14n) / 1e4).toLocaleString('en-US', { maximumFractionDigits: 2 })
}
