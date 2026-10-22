import { useCallback, useEffect, useState } from 'react'
import { getAddress } from 'viem'
import { getProvider, switchToRobinhood } from '../lib/wallet.js'
import { robinhood } from '../lib/config.js'
import { friendlyError } from '../lib/errors.js'

const DISCONNECTED_KEY = 'creditlend.disconnected'

function remember(key, value) {
  try {
    if (value) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch {
    // private mode: nothing to remember
  }
}

function recalled(key) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/// The connected browser wallet: { provider, account, chainId, wrongNetwork, connect, disconnect, switchNetwork }.
export function useWallet() {
  const [provider, setProvider] = useState(null)
  const [account, setAccount] = useState(null)
  const [chainId, setChainId] = useState(null)
  const [status, setStatus] = useState('idle') // idle | connecting
  const [error, setError] = useState(null)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let alive = true
    let p = null
    const onAccounts = (accounts) => setAccount(accounts?.[0] ? getAddress(accounts[0]) : null)
    const onChain = (id) => setChainId(Number(id))
    getProvider().then(async (found) => {
      if (!alive) return
      p = found
      setProvider(found)
      if (found) {
        found.on?.('accountsChanged', onAccounts)
        found.on?.('chainChanged', onChain)
        try {
          // eth_accounts never prompts: it only reports a connection the user already approved.
          const [accounts, id] = await Promise.all([found.request({ method: 'eth_accounts' }), found.request({ method: 'eth_chainId' })])
          if (!alive) return
          setChainId(Number(id))
          if (!recalled(DISCONNECTED_KEY)) onAccounts(accounts)
        } catch {
          // a locked wallet: the user connects with the button
        }
      }
      setChecked(true)
    })
    return () => {
      alive = false
      p?.removeListener?.('accountsChanged', onAccounts)
      p?.removeListener?.('chainChanged', onChain)
    }
  }, [])

  const switchNetwork = useCallback(async () => {
    setError(null)
    try {
      await switchToRobinhood(provider)
      setChainId(Number(await provider.request({ method: 'eth_chainId' })))
    } catch (err) {
      setError(friendlyError(err))
    }
  }, [provider])

  const connect = useCallback(async () => {
    setError(null)
    if (!provider) {
      setError('No browser wallet found. Install MetaMask, Rabby or Coinbase Wallet, then reload this page.')
      return
    }
    setStatus('connecting')
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      remember(DISCONNECTED_KEY, false)
      setAccount(accounts?.[0] ? getAddress(accounts[0]) : null)
      const id = Number(await provider.request({ method: 'eth_chainId' }))
      setChainId(id)
      if (id !== robinhood.id) {
        await switchToRobinhood(provider)
        setChainId(Number(await provider.request({ method: 'eth_chainId' })))
      }
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setStatus('idle')
    }
  }, [provider])

  const disconnect = useCallback(() => {
    remember(DISCONNECTED_KEY, true)
    setAccount(null)
  }, [])

  return {
    provider,
    account,
    chainId,
    checked,
    connecting: status === 'connecting',
    wrongNetwork: Boolean(account) && chainId != null && chainId !== robinhood.id,
    error,
    clearError: () => setError(null),
    connect,
    disconnect,
    switchNetwork,
  }
}
