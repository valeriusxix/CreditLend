import { useEffect, useRef, useState } from 'react'
import { ArrowLeftRight, Copy, ExternalLink, LogOut, Wallet } from 'lucide-react'
import Button from './Button.jsx'
import { shortAddress } from '../lib/format.js'
import { explorerAddress } from '../lib/config.js'

/// Connect (opens the wallet picker) / switch network / the connected address with a small menu.
function ConnectButton({ wallet, className = '' }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!menuOpen) return undefined
    const close = (e) => { if (!ref.current?.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menuOpen])

  if (!wallet.account) {
    return (
      <Button className={`nav-cta ${className}`} onClick={wallet.connect} disabled={wallet.connecting}>
        <Wallet aria-hidden="true" size={15} /> {wallet.connecting ? 'Connecting…' : 'Connect wallet'}
      </Button>
    )
  }
  if (wallet.wrongNetwork) {
    return (
      <Button className={`nav-cta button--warn ${className}`} onClick={wallet.switchNetwork}>
        Switch to Robinhood Chain
      </Button>
    )
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(wallet.account)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard blocked: nothing to do
    }
  }
  const run = (fn) => () => { setMenuOpen(false); fn() }

  return (
    <div className={`wallet-menu-wrap ${className}`} ref={ref}>
      <Button variant="secondary" className="nav-cta wallet-chip" onClick={() => setMenuOpen((o) => !o)}>
        {wallet.walletIcon ? <img className="wallet-chip__icon" src={wallet.walletIcon} alt="" width="18" height="18" /> : <span className="wallet-dot" aria-hidden="true" />}
        {shortAddress(wallet.account)}
      </Button>
      {menuOpen && (
        <div className="nav-menu wallet-menu" role="menu">
          <p className="wallet-menu__who">Connected with {wallet.walletName}</p>
          <button type="button" role="menuitem" onClick={copy}><Copy size={15} /> {copied ? 'Copied' : 'Copy address'}</button>
          <a role="menuitem" href={explorerAddress(wallet.account)} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}><ExternalLink size={15} /> View on explorer</a>
          <button type="button" role="menuitem" onClick={run(wallet.connect)}><ArrowLeftRight size={15} /> Switch wallet</button>
          <button type="button" role="menuitem" onClick={run(wallet.disconnect)}><LogOut size={15} /> Disconnect</button>
        </div>
      )}
    </div>
  )
}

export default ConnectButton
