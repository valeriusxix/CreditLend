import { useCallback, useEffect, useState } from 'react'
import { publicClient } from '../lib/wallet.js'
import { loadMarket, loadAccount } from '../lib/reads.js'
import { POOL_ADDRESS } from '../lib/config.js'

const REFRESH_MS = 15_000

/// Live market data, plus the position of `address` (the connected wallet or a looked-up account).
/// Refreshes every 15 seconds and right after each transaction (`refresh`).
export function useMarket(address) {
  const [market, setMarket] = useState(null)
  const [account, setAccount] = useState(null)
  const [error, setError] = useState(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!POOL_ADDRESS) return undefined
    let alive = true
    const load = async () => {
      try {
        const m = await loadMarket(publicClient, POOL_ADDRESS)
        const a = address ? await loadAccount(publicClient, m, address) : null
        if (!alive) return
        setMarket(m)
        setAccount(a)
        setError(null)
      } catch (err) {
        if (alive) setError(err?.shortMessage ?? err?.message ?? String(err))
      }
    }
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [address, tick])

  // An account loaded for a different address must never be shown for this one.
  const current = account && address && account.address.toLowerCase() === address.toLowerCase() ? account : null
  return { market, account: current, error, loading: Boolean(POOL_ADDRESS) && !market && !error, refresh }
}
