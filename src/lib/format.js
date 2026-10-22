// Number helpers. Amounts are always bigint in token base units; nothing goes through floats
// except the final display string.
import { formatUnits, parseUnits } from 'viem'

export const WAD = 10n ** 18n
export const BPS = 10_000n
export const MAX_UINT = 2n ** 256n - 1n

/// "1234.5" → 1234500000n for 6 decimals. Returns { value } or { error } in plain English.
export function parseAmount(text, decimals) {
  const s = String(text ?? '').trim().replace(/,/g, '')
  if (s === '') return { error: 'Enter an amount' }
  if (!/^\d*\.?\d*$/.test(s) || s === '.') return { error: 'Enter a number, like 100 or 0.5' }
  const [, frac = ''] = s.split('.')
  if (frac.length > decimals) return { error: `At most ${decimals} decimal places` }
  const value = parseUnits(s, decimals)
  if (value === 0n) return { error: 'Enter more than zero' }
  return { value }
}

/// Token amount for display: 1234567.891 → "1,234,567.89".
export function fmtAmount(value, decimals, maxFraction = 2) {
  if (value == null) return '–'
  const [whole, frac = ''] = formatUnits(value, decimals).split('.')
  const grouped = BigInt(whole).toLocaleString('en-US')
  const cut = frac.slice(0, maxFraction).replace(/0+$/, '')
  if (cut) return `${grouped}.${cut}`
  if (value > 0n && whole === '0') return `<0.${'0'.repeat(maxFraction - 1)}1`
  return grouped
}

/// Exact amount for an input box (no grouping, no rounding).
export const toInputString = (value, decimals) => formatUnits(value, decimals)

/// WAD dollars → "$1,234.56".
export const fmtUsd = (wad) => (wad == null ? '–' : `$${fmtAmount(wad, 18)}`)

/// WAD fraction → "12.34%".
export function fmtPct(wad, digits = 2) {
  if (wad == null) return '–'
  return `${(Number((wad * 10n ** BigInt(digits + 2)) / WAD) / 10 ** digits).toFixed(digits)}%`
}

export const fmtBps = (bps) => `${(Number(bps) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`

/// Health factor: "No debt" for the contract's max value, otherwise two decimals ("∞"-like values capped).
export function fmtHealth(hf) {
  if (hf == null) return '–'
  if (hf === MAX_UINT) return 'No debt'
  if (hf >= 1000n * WAD) return '>1,000'
  return fmtAmount(hf, 18, 2)
}

export function healthBand(hf) {
  if (hf == null || hf === MAX_UINT) return 'none'
  if (hf < WAD) return 'liquidatable'
  if (hf < 110n * 10n ** 16n) return 'at-risk'
  if (hf < 150n * 10n ** 16n) return 'caution'
  return 'healthy'
}

export const shortAddress = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
