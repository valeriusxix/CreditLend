// Finds every wallet installed in this browser so the user can pick one.
// Modern extensions (MetaMask, Rabby, Coinbase Wallet, Phantom, Brave, OKX...) announce themselves
// through EIP-6963; an older one that only sets `window.ethereum` is offered as "Browser wallet".

/// Merges a wallet into the list: one entry per wallet, announcement order kept.
export function addWallet(list, wallet) {
  if (list.some((w) => w.id === wallet.id)) return list
  return [...list, wallet]
}

/// The legacy `window.ethereum`, only when no wallet announced itself (otherwise it is one of them).
export function legacyWallet(announced, ethereum) {
  if (announced.length > 0 || !ethereum) return null
  const name = ethereum.isRabby ? 'Rabby' : ethereum.isCoinbaseWallet ? 'Coinbase Wallet' : ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet'
  return { id: 'injected', name, icon: null, provider: ethereum }
}

/// Calls `onChange(list)` whenever the set of installed wallets changes. Returns a cleanup function.
export function watchWallets(onChange) {
  let announced = []
  const publish = () => {
    const legacy = legacyWallet(announced, window.ethereum)
    onChange(legacy ? [legacy] : announced)
  }
  const onAnnounce = (event) => {
    const { info, provider } = event.detail ?? {}
    if (!info?.uuid || !provider?.request) return
    announced = addWallet(announced, { id: info.rdns || info.uuid, name: info.name, icon: info.icon, provider })
    publish()
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  // Wallets answer within a few milliseconds; after that, fall back to window.ethereum if nobody did.
  const timer = setTimeout(publish, 400)
  return () => {
    clearTimeout(timer)
    window.removeEventListener('eip6963:announceProvider', onAnnounce)
  }
}

/// Links to open this page inside a mobile wallet's built-in browser (phones have no extensions).
export function mobileWalletLinks(href) {
  const url = new URL(href)
  const hostAndPath = `${url.host}${url.pathname}${url.search}${url.hash}`
  return [
    { name: 'MetaMask', href: `https://metamask.app.link/dapp/${hostAndPath}` },
    { name: 'Coinbase Wallet', href: `https://go.cb-w.com/dapp?cb_url=${encodeURIComponent(href)}` },
  ]
}

export const INSTALL_LINKS = [
  { name: 'MetaMask', href: 'https://metamask.io/download/' },
  { name: 'Rabby', href: 'https://rabby.io/' },
  { name: 'Coinbase Wallet', href: 'https://www.coinbase.com/wallet/downloads' },
]
