import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import poolAbi from '../abi/CreditLendPool.json'
import AmountField from './AmountField.jsx'
import Button from './Button.jsx'
import TxNotice from './TxNotice.jsx'
import { useTx } from '../hooks/useTx.js'
import { publicClient } from '../lib/wallet.js'
import { loadBorrowers, loadPositions, loadAccount } from '../lib/reads.js'
import { liquidationPreview } from '../lib/market.js'
import { fmtAmount, fmtHealth, fmtUsd, healthBand, parseAmount, shortAddress, toInputString, WAD } from '../lib/format.js'

/// Every open position, riskiest first, with a liquidate form for those below health 1.
function LiquidatePanel({ market, wallet, walletAccount, refresh }) {
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [selected, setSelected] = useState(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    loadBorrowers(publicClient, market.pool)
      .then((borrowers) => loadPositions(publicClient, market, borrowers))
      .then((r) => { if (alive) { setRows(r); setError(null) } })
      .catch((err) => { if (alive) setError(err?.shortMessage ?? err?.message ?? String(err)) })
    return () => { alive = false }
    // market changes every refresh; reload the list only on demand or when the pool changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.pool, tick])

  const reload = useCallback(() => { setTick((t) => t + 1); refresh() }, [refresh])
  const liquidatable = rows?.filter((r) => r.healthFactor < WAD) ?? []

  return (
    <section className="card" aria-label="Liquidations">
      <header className="card__head">
        <div>
          <h2>Liquidations</h2>
          <p className="card__sub">
            Anyone may repay part of a position whose health factor is below 1 and receive its collateral plus a bonus. This keeps lenders whole.
          </p>
        </div>
        <button type="button" className="icon-button" aria-label="Refresh the list" onClick={reload}><RefreshCw size={17} /></button>
      </header>

      {error && <p className="field-error">Could not load positions: {error}</p>}
      {!rows && !error && <p className="muted">Loading positions…</p>}
      {rows && rows.length === 0 && <p className="muted">Nobody is borrowing yet.</p>}
      {rows && rows.length > 0 && (
        <>
          <p className="muted">{rows.length} open position{rows.length === 1 ? '' : 's'}, {liquidatable.length} can be liquidated now.</p>
          <table className="positions-table">
            <thead><tr><th>Borrower</th><th>Debt</th><th>Health</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.address} className={selected === r.address ? 'is-selected' : ''}>
                  <td><a href={`#app/account/${r.address}`}>{shortAddress(r.address)}</a></td>
                  <td>{fmtAmount(r.debt, market.credit.decimals)} {market.credit.symbol}</td>
                  <td><span className={`hf hf--${healthBand(r.healthFactor)}`}>{fmtHealth(r.healthFactor)}</span></td>
                  <td>
                    {r.healthFactor < WAD
                      ? <Button className="small-button" onClick={() => setSelected(r.address)}>Liquidate</Button>
                      : <span className="muted">Healthy</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {selected && (
        <LiquidateForm key={selected} market={market} borrower={selected} wallet={wallet} walletAccount={walletAccount} onDone={reload} onClose={() => setSelected(null)} />
      )}
    </section>
  )
}

/// Liquidate one borrower: pick the collateral to receive and how much of the debt to repay.
export function LiquidateForm({ market, borrower, wallet, walletAccount, onDone, onClose }) {
  const c = market.credit
  const [position, setPosition] = useState(null)
  const [assetAddress, setAssetAddress] = useState(null)
  const [text, setText] = useState('')
  const tx = useTx({ provider: wallet.provider, account: wallet.account, onDone: () => { setText(''); onDone?.() } })

  useEffect(() => {
    let alive = true
    loadAccount(publicClient, market, borrower).then((p) => {
      if (!alive) return
      setPosition(p)
      // Default to the collateral the borrower holds most of (by value).
      const best = [...market.assets].filter((a) => a.price != null && (p.collateral[a.address] ?? 0n) > 0n)
        .sort((a, b) => (value(b, p) > value(a, p) ? 1 : -1))[0]
      setAssetAddress((cur) => cur ?? best?.address ?? market.assets[0]?.address)
    })
    return () => { alive = false }
  }, [market, borrower, tx.status.state])

  if (!position) return <p className="muted">Loading the position…</p>
  const asset = market.assets.find((a) => a.address === assetAddress)
  const available = asset ? position.collateral[asset.address] ?? 0n : 0n
  const parsed = text === '' ? null : parseAmount(text, c.decimals)
  const preview = asset ? liquidationPreview({ market, debt: position.debt, hf: position.healthFactor, asset, available, repayAmount: parsed?.value ?? null }) : null
  const balance = walletAccount?.walletCredit ?? 0n

  let reason = parsed?.error ?? null
  if (position.healthFactor >= WAD) reason = 'This position is healthy now, so it cannot be liquidated.'
  else if (!asset || asset.price == null) reason = 'This collateral has no price right now; pick another.'
  else if (available === 0n) reason = `This borrower has no ${asset.symbol} deposited; pick another collateral.`
  else if (market.settlementPrice == null) reason = 'The $CREDIT price is unavailable right now.'
  else if (preview.offer > balance && wallet.account) reason = `You need ${fmtAmount(preview.offer, c.decimals)} ${c.symbol} in your wallet to repay this; you hold ${fmtAmount(balance, c.decimals)}.`

  const submit = () => tx.run({
    // Approve exactly the offer: the pool pulls at most that (often a little less).
    approve: { token: c.address, spender: market.pool, amount: preview.offer, label: c.symbol },
    call: { address: market.pool, abi: poolAbi, functionName: 'liquidate', args: [borrower, asset.address, preview.offer, preview.minSeized] },
    success: `Liquidated: you repaid about ${fmtAmount(preview.repaid, c.decimals)} ${c.symbol} and received about ${fmtAmount(preview.seized, asset.decimals)} ${asset.symbol}.`,
  })

  return (
    <div className="liquidate-form" aria-label={`Liquidate ${borrower}`}>
      <div className="liquidate-form__head">
        <h3>Liquidate {shortAddress(borrower)}</h3>
        {onClose && <button type="button" className="muted-link" onClick={onClose}>Close</button>}
      </div>
      <p className="form-note subtle">
        Health {fmtHealth(position.healthFactor)} · debt {fmtAmount(position.debt, c.decimals, 4)} {c.symbol}. You may repay up to {fmtAmount(preview?.cap ?? 0n, c.decimals, 4)} {c.symbol} now
        {position.healthFactor < 95n * 10n ** 16n ? ' (all of it, because health is below 0.95).' : ' (half the debt; all of it once health is below 0.95).'}
      </p>
      {market.assets.length > 1 && (
        <label className="select-field">
          <span>Collateral to receive</span>
          <select value={assetAddress ?? ''} onChange={(e) => setAssetAddress(e.target.value)}>
            {market.assets.map((a) => <option key={a.address} value={a.address}>{a.symbol} ({fmtAmount(position.collateral[a.address] ?? 0n, a.decimals)} deposited)</option>)}
          </select>
        </label>
      )}
      <AmountField
        label={`${c.symbol} to repay`}
        value={text}
        onChange={setText}
        symbol={c.symbol}
        balanceLabel="Your wallet"
        balanceText={wallet.account ? fmtAmount(balance, c.decimals, 4) : null}
        onMax={preview?.cap ? () => setText(toInputString(preview.cap, c.decimals)) : null}
        error={parsed?.error}
      />
      {preview && preview.seized > 0n && (
        <div className="preview-box">
          <div className="preview-row"><span>You repay</span><span>{fmtAmount(preview.repaid, c.decimals, 4)} {c.symbol}</span></div>
          <div className="preview-row"><span>You receive</span><span data-testid="liq-seize">{fmtAmount(preview.seized, asset.decimals, 4)} {asset.symbol} ({fmtUsd((preview.seized * asset.price) / 10n ** BigInt(asset.decimals))})</span></div>
          <div className="preview-row"><span>Includes bonus</span><span>{asset.liqBonusBps / 100}%</span></div>
          <div className="preview-row subtle"><span>Fails if less than</span><span>{fmtAmount(preview.minSeized, asset.decimals, 4)} {asset.symbol}</span></div>
        </div>
      )}
      {!wallet.account || wallet.wrongNetwork
        ? <Button className="action-button" onClick={wallet.account ? wallet.switchNetwork : wallet.connect}>{wallet.account ? 'Switch to Robinhood Chain' : 'Connect wallet'}</Button>
        : <Button className="action-button" onClick={submit} disabled={Boolean(reason) || tx.busy || !preview?.seized}>{tx.busy ? 'Waiting for wallet…' : 'Liquidate'}</Button>}
      {reason && <p className="form-note">{reason}</p>}
      <TxNotice status={tx.status} />
    </div>
  )
}

const value = (a, p) => ((p.collateral[a.address] ?? 0n) * a.price) / 10n ** BigInt(a.decimals)

export default LiquidatePanel
