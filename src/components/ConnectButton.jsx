import { LogOut, Wallet } from 'lucide-react'
import Button from './Button.jsx'
import { shortAddress } from '../lib/format.js'

/// Connect / switch network / connected address (click to disconnect).
function ConnectButton({ wallet, className = '' }) {
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
  return (
    <Button variant="secondary" className={`nav-cta wallet-chip ${className}`} onClick={wallet.disconnect}>
      <span className="wallet-dot" aria-hidden="true" />
      {shortAddress(wallet.account)}
      <LogOut aria-label="Disconnect" size={14} />
    </Button>
  )
}

export default ConnectButton
