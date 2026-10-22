import { isAddress, getAddress } from 'viem'
import { TriangleAlert } from 'lucide-react'
import ActionPanel from './ActionPanel.jsx'
import LiquidatePanel, { LiquidateForm } from './LiquidatePanel.jsx'
import MarketStats from './MarketStats.jsx'
import PositionCard from './PositionCard.jsx'
import { useMarket } from '../hooks/useMarket.js'
import { POOL_ADDRESS, POOL_ADDRESS_INVALID, explorerAddress } from '../lib/config.js'
import { WAD } from '../lib/format.js'

const ACTION_TABS = ['lend', 'collateral', 'borrow', 'repay']

/// The lending app (#app...). `route.section`: overview | lend | collateral | borrow | repay | liquidate | account.
function AppView({ route, wallet }) {
  const lookup = route.section === 'account' && isAddress(route.extra ?? '', { strict: false }) ? getAddress(route.extra) : null
  const viewing = lookup ?? wallet.account
  const { market, account, error, loading, refresh } = useMarket(viewing)
  // The connected wallet's own balances are needed to liquidate someone else's position.
  const own = useMarket(lookup && wallet.account ? wallet.account : null)
  const walletAccount = lookup ? own.account : account

  const section = route.section
  const tab = ACTION_TABS.includes(section) ? section : 'lend'

  return (
    <div className="app-view" id="app">
      <div className="app-head">
        <div>
          <p className="eyebrow">$CREDIT market · Robinhood Chain</p>
          <h1 className="app-title">{section === 'liquidate' ? 'Liquidations' : lookup ? 'Account lookup' : 'Lend & borrow'}</h1>
        </div>
        <nav className="app-tabs" aria-label="App sections">
          <a className={section !== 'liquidate' && !lookup ? 'is-active' : ''} href="#app">Lend & borrow</a>
          <a className={section === 'liquidate' ? 'is-active' : ''} href="#app/liquidate">Liquidate</a>
        </nav>
      </div>

      {!POOL_ADDRESS && <NotDeployed invalid={POOL_ADDRESS_INVALID} />}
      {POOL_ADDRESS && error && !market && <Notice tone="error">Could not reach Robinhood Chain: {error}. Retrying every 15 seconds.</Notice>}
      {loading && <p className="muted app-loading">Loading the market…</p>}
      {wallet.error && <Notice tone="error" onClose={wallet.clearError}>{wallet.error}</Notice>}
      {wallet.wrongNetwork && <Notice tone="warn">Your wallet is on another network. <button type="button" className="inline-link" onClick={wallet.switchNetwork}>Switch to Robinhood Chain</button></Notice>}

      {market && (
        <>
          <MarketStats market={market} />
          {Object.values(market.paused).some(Boolean) && (
            <Notice tone="warn">
              The guardian has paused {[market.paused.deposits && 'new lending', market.paused.borrows && 'new borrowing', market.paused.collateral && 'new collateral'].filter(Boolean).join(', ')}. Repaying, withdrawing and liquidating always work.
            </Notice>
          )}

          {section === 'liquidate' && <LiquidatePanel market={market} wallet={wallet} walletAccount={walletAccount} refresh={refresh} />}

          {lookup && (
            <div className="app-grid">
              {account ? <PositionCard market={market} account={account} title="Position" readOnly /> : <p className="muted">Loading the position…</p>}
              {account && account.healthFactor < WAD && (
                <section className="card"><LiquidateForm market={market} borrower={lookup} wallet={wallet} walletAccount={walletAccount} onDone={refresh} /></section>
              )}
              {account && account.healthFactor >= WAD && (
                <section className="card"><p className="muted">This position {account.debt === 0n ? 'has no debt' : 'is healthy'}, so it cannot be liquidated.</p></section>
              )}
            </div>
          )}

          {section !== 'liquidate' && !lookup && (
            <div className="app-grid">
              {account
                ? <PositionCard market={market} account={account} />
                : <ConnectPrompt wallet={wallet} />}
              <ActionPanel market={market} account={account} wallet={wallet} refresh={refresh} tab={tab} onTab={(t) => { window.location.hash = `app/${t}` }} />
            </div>
          )}

          <p className="contract-line">
            Pool contract <a href={explorerAddress(market.pool)} target="_blank" rel="noreferrer">{market.pool}</a>
          </p>
        </>
      )}
    </div>
  )
}

function ConnectPrompt({ wallet }) {
  return (
    <section className="card connect-prompt">
      <h2>Your position</h2>
      <p className="muted">Connect a wallet to see your health factor, collateral and debt. You can look at the market without one.</p>
      {!wallet.account && <button type="button" className="button button--primary" onClick={wallet.connect}>Connect wallet</button>}
      {wallet.account && !wallet.wrongNetwork && <p className="muted">Loading your position…</p>}
    </section>
  )
}

function Notice({ tone, children, onClose }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <TriangleAlert aria-hidden="true" size={16} />
      <span>{children}</span>
      {onClose && <button type="button" className="inline-link" onClick={onClose}>Dismiss</button>}
    </div>
  )
}

function NotDeployed({ invalid }) {
  return (
    <section className="card not-deployed">
      <h2>{invalid ? 'The pool address setting is not a valid address' : 'The market is not live yet'}</h2>
      <p className="muted">
        The CreditLend contracts have not been deployed to Robinhood Chain yet, or this site was not told where they are. Once they are deployed, set
        {' '}<code>VITE_POOL_ADDRESS</code> (the CreditLendPool address printed by the deploy script) and <code>VITE_POOL_DEPLOY_BLOCK</code> in the site&apos;s settings and rebuild.
      </p>
    </section>
  )
}

export default AppView
