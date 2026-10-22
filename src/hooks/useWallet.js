import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAddress } from 'viem'
import { devWallet, switchToRobinhood } from '../lib/wallet.js'
import { watchWallets } from '../lib/wallets.js'
import { robinhood } from '../lib/config.js'
import { friendlyError, isUserRejection } from '../lib/errors.js'

const WALLET_KEY = 'creditlend.wallet' // which wallet the user last connected (its id), to reconnect on reload

function stored() {
  try {
    return localStorage.getItem(WALLET_KEY)
  } catch {
    return null
  }
}

function store(id) {
  try {
    if (id) localStorage.setItem(WALLET_KEY, id)
    else localStorage.removeItem(WALLET_KEY)
  } catch {
    // private mode: the user reconnects after a reload
  }
}

const firstAccount = (accounts) => (accounts?.[0] ? getAddress(accounts[0]) : null)

/// The installed wallets, the one the user picked, and its account and network.
export function useWallet() {
  const [detected, setDetected] = useState([])
  const [dev, setDev] = useState(null)
  const [active, setActive] = useState(null) // { id, name, icon, provider }
  const [account, setAccount] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [connectingId, setConnectingId] = useState(null)
  const [pickerError, setPickerError] = useState(null)
  const [error, setError] = useState(null)
  const restoreTried = useRef(false)

  const wallets = useMemo(() => (dev ? [dev, ...detected] : detected), [dev, detected])

  // Find installed wallets (they announce themselves; more can appear later).
  useEffect(() => watchWallets(setDetected), [])
  useEffect(() => {
    let alive = true
    devWallet().then((w) => { if (alive) setDev(w) })
    return () => { alive = false }
  }, [])

  // Reconnect silently to the wallet used last time, if it still shares an account with this site.
  useEffect(() => {
    const id = stored()
    const wallet = wallets.find((w) => w.id === id)
    if (restoreTried.current || !wallet) return
    restoreTried.current = true
    Promise.all([wallet.provider.request({ method: 'eth_accounts' }), wallet.provider.request({ method: 'eth_chainId' })])
      .then(([accounts, id_]) => {
        const a = firstAccount(accounts)
        if (!a) return
        setActive(wallet)
        setAccount(a)
        setChainId(Number(id_))
      })
      .catch(() => {})
  }, [wallets])

  // Follow account and network changes made in the wallet itself.
  useEffect(() => {
    const p = active?.provider
    if (!p?.on) return undefined
    const onAccounts = (accounts) => {
      const a = firstAccount(accounts)
      setAccount(a)
      if (!a) { setActive(null); store(null) } // locked or disconnected from the wallet's side
    }
    const onChain = (id) => setChainId(Number(id))
    p.on('accountsChanged', onAccounts)
    p.on('chainChanged', onChain)
    return () => {
      p.removeListener?.('accountsChanged', onAccounts)
      p.removeListener?.('chainChanged', onChain)
    }
  }, [active])

  const connectWith = useCallback(async (wallet) => {
    setPickerError(null)
    setError(null)
    setConnectingId(wallet.id)
    try {
      const a = firstAccount(await wallet.provider.request({ method: 'eth_requestAccounts' }))
      if (!a) throw new Error(`${wallet.name} did not share an account.`)
      setActive(wallet)
      setAccount(a)
      store(wallet.id)
      setPickerOpen(false)
      const id = Number(await wallet.provider.request({ method: 'eth_chainId' }))
      setChainId(id)
      if (id !== robinhood.id) {
        try {
          await switchToRobinhood(wallet.provider)
          setChainId(Number(await wallet.provider.request({ method: 'eth_chainId' })))
        } catch (err) {
          // Connected, but still on another network: the app shows a "Switch" button.
          if (!isUserRejection(err)) setError(friendlyError(err))
        }
      }
    } catch (err) {
      setPickerError(isUserRejection(err) ? `You cancelled the request in ${wallet.name}.` : friendlyError(err))
    } finally {
      setConnectingId(null)
    }
  }, [])

  const disconnect = useCallback(() => {
    // Also ask the wallet to forget this site where supported (MetaMask), so "Connect" asks again.
    active?.provider?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }).catch(() => {})
    store(null)
    setActive(null)
    setAccount(null)
  }, [active])

  const switchNetwork = useCallback(async () => {
    setError(null)
    try {
      await switchToRobinhood(active.provider)
      setChainId(Number(await active.provider.request({ method: 'eth_chainId' })))
    } catch (err) {
      setError(friendlyError(err))
    }
  }, [active])

  return {
    wallets,
    provider: active?.provider ?? null,
    walletName: active?.name ?? null,
    walletIcon: active?.icon ?? null,
    account,
    chainId,
    wrongNetwork: Boolean(account) && chainId != null && chainId !== robinhood.id,
    // Every "Connect wallet" button opens the picker.
    connect: () => { setPickerError(null); setPickerOpen(true) },
    connecting: connectingId != null,
    connectingId,
    pickerOpen,
    pickerError,
    closePicker: () => setPickerOpen(false),
    connectWith,
    disconnect,
    switchNetwork,
    error,
    clearError: () => setError(null),
  }
}
