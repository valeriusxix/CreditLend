import { useEffect } from 'react'
import { ExternalLink, Loader2, Wallet, X } from 'lucide-react'
import { INSTALL_LINKS, mobileWalletLinks } from '../lib/wallets.js'

/// "Connect a wallet": every wallet installed in this browser, to pick one.
function WalletModal({ wallet }) {
  const { pickerOpen, closePicker } = wallet
  useEffect(() => {
    if (!pickerOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') closePicker() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickerOpen, closePicker])

  if (!pickerOpen) return null
  const phone = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

  return (
    <div className="search-backdrop" onClick={closePicker}>
      <div className="wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-modal-title" onClick={(e) => e.stopPropagation()}>
        <div className="wallet-modal__head">
          <h2 id="wallet-modal-title">Connect a wallet</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={closePicker}><X size={18} /></button>
        </div>

        {wallet.wallets.length > 0 ? (
          <>
            <p className="muted">Choose the wallet to use with CreditLend. It will ask you to approve the connection.</p>
            <ul className="wallet-list">
              {wallet.wallets.map((w) => (
                <li key={w.id}>
                  <button type="button" className="wallet-option" onClick={() => wallet.connectWith(w)} disabled={wallet.connecting}>
                    {w.icon ? <img src={w.icon} alt="" width="32" height="32" /> : <span className="wallet-option__fallback"><Wallet size={18} /></span>}
                    <span className="wallet-option__name">{w.name}</span>
                    {wallet.connectingId === w.id
                      ? <span className="wallet-option__state"><Loader2 size={15} className="spin" /> Check your wallet…</span>
                      : <span className="wallet-option__state">{w.id === 'dev' ? 'Test copy only' : 'Detected'}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="wallet-empty">
            {phone ? (
              <>
                <p className="muted">Phone browsers can&apos;t hold wallet extensions. Open this page inside your wallet app instead:</p>
                <div className="wallet-links">
                  {mobileWalletLinks(window.location.href).map((l) => <a key={l.name} className="button button--secondary" href={l.href}>Open in {l.name}</a>)}
                </div>
                <p className="muted">Using another wallet app? Open its built-in browser and visit this page.</p>
              </>
            ) : (
              <>
                <p className="muted">No wallet found in this browser. Install one, then reload this page:</p>
                <div className="wallet-links">
                  {INSTALL_LINKS.map((l) => <a key={l.name} className="button button--secondary" href={l.href} target="_blank" rel="noreferrer">{l.name} <ExternalLink size={14} aria-hidden="true" /></a>)}
                </div>
              </>
            )}
          </div>
        )}

        {wallet.pickerError && <p className="field-error" role="alert">{wallet.pickerError}</p>}
        <p className="wallet-modal__foot">CreditLend runs on Robinhood Chain. Your wallet will be asked to switch to it (or add it) after connecting. You only ever sign in your wallet; the site never sees your keys.</p>
      </div>
    </div>
  )
}

export default WalletModal
