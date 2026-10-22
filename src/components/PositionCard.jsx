import { Gauge } from 'lucide-react'
import { fmtAmount, fmtHealth, fmtUsd, healthBand, fmtBps, WAD, MAX_UINT } from '../lib/format.js'
import { explorerAddress } from '../lib/config.js'

const BAND_TEXT = {
  none: 'No debt: nothing can be liquidated.',
  healthy: 'Healthy.',
  caution: 'Fine, but keep an eye on it.',
  'at-risk': 'Close to liquidation. Repay some debt or add collateral.',
  liquidatable: 'Below 1: anyone can liquidate part of this position now.',
}

/// How full the gauge is: health 1.0 at 20% (the marker), 2.0 and above full.
function gaugePercent(hf) {
  if (hf === MAX_UINT) return 100
  const x = Number((hf * 100n) / WAD) / 100
  return Math.max(2, Math.min(100, ((x - 0.75) / 1.25) * 100))
}

/// One account's position, with the health factor front and centre.
function PositionCard({ market, account, title = 'Your position', readOnly = false }) {
  const c = market.credit
  const band = healthBand(account.healthFactor)
  const usedPct = account.borrowPower === 0n ? 0n : (account.debtValue * 10_000n) / account.borrowPower
  return (
    <section className="card position-card" aria-label={title}>
      <header className="card__head">
        <h2>{title}</h2>
        {readOnly && <a className="muted-link" href={explorerAddress(account.address)} target="_blank" rel="noreferrer">{account.address.slice(0, 10)}… ↗</a>}
      </header>

      <div className={`health health--${band}`}>
        <div className="health__label"><Gauge aria-hidden="true" size={16} /> Health factor</div>
        <div className="health__value" data-testid="health-factor">{fmtHealth(account.healthFactor)}</div>
        <div className="health__bar" aria-hidden="true">
          <span className="health__marker" style={{ left: '20%' }} />
          <span className="health__fill" style={{ width: `${gaugePercent(account.healthFactor)}%` }} />
        </div>
        <p className="health__text">{BAND_TEXT[band]}</p>
      </div>

      <dl className="figures">
        <div><dt>Debt</dt><dd data-testid="debt">{fmtAmount(account.debt, c.decimals, 4)} {c.symbol}</dd></div>
        <div><dt>Borrow limit used</dt><dd>{account.debt === 0n ? '0%' : fmtBps(usedPct)}</dd></div>
        <div><dt>Collateral value</dt><dd>{fmtUsd(sumCollateralValue(market, account))}</dd></div>
        <div><dt>Borrow limit</dt><dd>{fmtUsd(account.borrowPower)}</dd></div>
        <div><dt>Supplied (lending)</dt><dd data-testid="supplied">{fmtAmount(account.lent, c.decimals, 4)} {c.symbol}</dd></div>
        {!readOnly && <div><dt>In your wallet</dt><dd>{fmtAmount(account.walletCredit, c.decimals)} {c.symbol}</dd></div>}
      </dl>

      <table className="collateral-table">
        <thead>
          <tr><th>Collateral</th><th>Deposited</th><th>Borrow at</th><th>Liquidated at</th></tr>
        </thead>
        <tbody>
          {market.assets.map((a) => (
            <tr key={a.address}>
              <td>{a.symbol}{a.price == null && <span className="tag tag--warn" title="No price right now: counts as zero">no price</span>}</td>
              <td data-testid={`collateral-${a.symbol}`}>{fmtAmount(account.collateral[a.address] ?? 0n, a.decimals)}</td>
              <td>{fmtBps(a.ltvBps)}</td>
              <td>{fmtBps(a.liqThresholdBps)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function sumCollateralValue(market, account) {
  let total = 0n
  for (const a of market.assets) {
    if (a.price == null) continue
    total += ((account.collateral[a.address] ?? 0n) * a.price) / 10n ** BigInt(a.decimals)
  }
  return total
}

export default PositionCard
