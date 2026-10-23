import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { POOL_ADDRESS, explorerAddress } from '../lib/config.js'

const SECTIONS = [
  ['overview', 'How it works'],
  ['lending', 'Lending'],
  ['borrowing', 'Borrowing & health factor'],
  ['liquidations', 'Liquidations'],
  ['agent', 'The agent'],
  ['governance', 'Governance & safety'],
  ['risks', 'Risks'],
  ['contracts', 'Contracts'],
]

const TOKENS = [
  ['$CREDIT', '0xE33322DA1380e61E5Ae5DfB21e7f62924c73004C'],
  ['USDG', '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'],
  ['Orbio exchange ($CREDIT order book)', '0x6951fFd32630b05e06F50062AEA801625A58eBC0'],
]

/// Plain-English protocol docs (#docs, #docs/<section>).
function DocsView({ section }) {
  useEffect(() => {
    if (section && section !== 'overview') document.getElementById(`docs-${section}`)?.scrollIntoView({ block: 'start' })
  }, [section])

  return (
    <div className="docs-view" id="docs">
      <aside className="docs-nav" aria-label="Docs sections">
        {SECTIONS.map(([id, label]) => (
          <Link key={id} to={`/docs/${id}`} className={section === id ? 'is-active' : ''}>{label}</Link>
        ))}
      </aside>
      <article className="docs-body">
        <p className="eyebrow">Protocol docs</p>
        <h1>CreditLend</h1>

        <section id="docs-overview">
          <h2>How it works</h2>
          <p>
            CreditLend is a lending market for <strong>$CREDIT</strong>, Orbio&apos;s compute token, on Robinhood Chain. Lenders supply $CREDIT and earn interest.
            Borrowers lock collateral (USDG, a dollar stablecoin, at launch) and borrow $CREDIT against it. Every loan is backed by more collateral than it is worth.
          </p>
          <p>
            Borrowed $CREDIT is treated as <em>spent</em>: borrowers may use it for AI compute, sell it or send it anywhere. Lenders are protected by the collateral alone,
            which is why positions that fall below the safety line can be liquidated by anyone.
          </p>
        </section>

        <section id="docs-lending">
          <h2>Lending</h2>
          <p>
            Supplying $CREDIT gives you <strong>cCREDIT</strong>, a receipt token. Its value in $CREDIT rises as borrowers pay interest, so you withdraw more than you put in.
            The lender rate depends on how much of the pool is borrowed (utilization). 10% of interest is kept as a reserve that absorbs losses first.
          </p>
          <p>
            You can withdraw whenever the pool has free $CREDIT. Borrowing stops at 90% utilization so some is always free, but if the pool is fully lent you may have to wait for repayments.
          </p>
        </section>

        <section id="docs-borrowing">
          <h2>Borrowing & health factor</h2>
          <p>
            Each collateral has two percentages. You may <strong>borrow</strong> up to the first (70% of USDG&apos;s value at launch). Your position becomes <strong>liquidatable</strong> once your debt passes the second (80%).
            Debt always counts at $1 per $CREDIT, whatever its market price, which keeps borrowers on the safe side.
          </p>
          <p>
            Your <strong>health factor</strong> is (collateral value × liquidation percentage) ÷ debt. Above 1 you are safe; below 1 anyone may liquidate part of your position.
            It falls as interest adds to your debt, so repay or add collateral if it gets close to 1. The app shows your health factor before you confirm each action.
          </p>
          <p>Limits at launch: at least 10 $CREDIT per loan, at most 20,000 per account and 50,000 across the market. They are sized to how much $CREDIT the order book can supply to liquidators.</p>
        </section>

        <section id="docs-liquidations">
          <h2>Liquidations</h2>
          <p>
            When a health factor is below 1, anyone may repay up to half of that debt (all of it below 0.95) and receive the same value of collateral plus a <strong>5% bonus</strong>.
            The $CREDIT used is valued at its market price, capped at $1, so liquidators aren&apos;t overpaid when $CREDIT trades below $1.
            Liquidating, repaying and withdrawing can never be paused.
          </p>
          <p>The <Link to="/app/liquidate">Liquidate</Link> page lists every open position, riskiest first.</p>
        </section>

        <section id="docs-agent">
          <h2>The agent</h2>
          <p>
            An automated agent helps the market run well, but every safety rule lives in the contracts, so the market keeps working if it stops. It:
          </p>
          <ul>
            <li>records the $CREDIT market price for the price feed hourly, and every 5 minutes when anything looks unusual;</li>
            <li>watches every position, warns as they near liquidation, and can liquidate them itself;</li>
            <li>reviews the market daily and may propose a different interest-rate setting, but only one of three settings approved in advance, with 6 hours&apos; public notice, at most once a day, and the guardian can cancel it.</li>
          </ul>
        </section>

        <section id="docs-governance">
          <h2>Governance & safety</h2>
          <ul>
            <li><strong>Owner:</strong> a timelock. Every parameter change is public for 2 days before it takes effect.</li>
            <li><strong>Guardian:</strong> may only pause new lending, new borrowing and new collateral in an emergency, and cancel a pending rate switch. It cannot move funds or change settings.</li>
            <li><strong>Price feed:</strong> a time-weighted average of the live $CREDIT order book, with limits on how fast it may fall. It falls back to $1 if no reading arrives for 2 hours.</li>
          </ul>
        </section>

        <section id="docs-risks">
          <h2>Risks</h2>
          <ul>
            <li><strong>Thin $CREDIT liquidity:</strong> if the order book is shallow, liquidations may be slow or unprofitable. Caps and conservative percentages limit this.</li>
            <li><strong>Smart-contract risk:</strong> the contracts are tested but not yet audited.</li>
            <li><strong>Liquidity risk for lenders:</strong> while the pool is heavily borrowed, withdrawals may have to wait.</li>
            <li><strong>Liquidation risk for borrowers:</strong> interest keeps growing your debt; watch your health factor.</li>
            <li><strong>Token risk:</strong> $CREDIT and USDG are upgradeable tokens run by their issuers.</li>
          </ul>
        </section>

        <section id="docs-contracts">
          <h2>Contracts</h2>
          <ul className="address-list">
            <li><span>CreditLend pool</span>{POOL_ADDRESS ? <a href={explorerAddress(POOL_ADDRESS)} target="_blank" rel="noreferrer">{POOL_ADDRESS}</a> : <span className="muted">not deployed yet</span>}</li>
            {TOKENS.map(([label, address]) => (
              <li key={address}><span>{label}</span><a href={explorerAddress(address)} target="_blank" rel="noreferrer">{address}</a></li>
            ))}
          </ul>
        </section>
      </article>
    </div>
  )
}

export default DocsView
