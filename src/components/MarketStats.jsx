import { fmtAmount, fmtPct, fmtUsd } from '../lib/format.js'

/// The market at a glance: how much is lent and borrowed, and at what rates.
function MarketStats({ market }) {
  const c = market.credit
  const stats = [
    { label: 'Total supplied', value: `${fmtAmount(market.totalAssets, c.decimals)} ${c.symbol}` },
    { label: 'Total borrowed', value: `${fmtAmount(market.totalBorrows, c.decimals)} ${c.symbol}` },
    { label: 'Available to borrow', value: `${fmtAmount(market.cash, c.decimals)} ${c.symbol}` },
    { label: 'Utilization', value: fmtPct(market.utilization), hint: 'Share of supplied $CREDIT that is borrowed' },
    { label: 'Lender APY', value: fmtPct(market.supplyRatePerYear), hint: 'Yearly rate lenders earn now', accent: true },
    { label: 'Borrow APR', value: fmtPct(market.borrowRatePerYear), hint: 'Yearly rate borrowers pay now' },
    { label: '$CREDIT price', value: fmtUsd(market.settlementPrice), hint: 'Market price used only to size liquidations; debt always counts at $1' },
  ]
  return (
    <section className="stats-grid" aria-label="Market overview">
      {stats.map((s) => (
        <div className={`stat ${s.accent ? 'stat--accent' : ''}`} key={s.label} title={s.hint}>
          <span className="stat__label">{s.label}</span>
          <span className="stat__value">{s.value}</span>
        </div>
      ))}
    </section>
  )
}

export default MarketStats
