import { useCallback, useState } from 'react'
import erc20Abi from '../abi/ERC20.json'
import { publicClient, sendTx } from '../lib/wallet.js'
import { allowance } from '../lib/reads.js'
import { friendlyError, isUserRejection } from '../lib/errors.js'

/// Runs one user action as a series of wallet transactions (approval first if needed, then the
/// action), with a status line the UI can show:
/// { state: 'idle'|'busy'|'done'|'cancelled'|'error', text, hash }.
export function useTx({ provider, account, onDone }) {
  const [status, setStatus] = useState({ state: 'idle' })

  const run = useCallback(async ({ approve, call, success }) => {
    if (!provider || !account) return false
    try {
      if (approve) {
        const current = await allowance(publicClient, approve.token, account, approve.spender)
        if (current < approve.amount) {
          // Exactly the amount needed, never unlimited.
          setStatus({ state: 'busy', text: `Step 1 of 2: approve ${approve.label} in your wallet…` })
          await sendTx({ provider, account, address: approve.token, abi: erc20Abi, functionName: 'approve', args: [approve.spender, approve.amount] })
          setStatus({ state: 'busy', text: 'Step 2 of 2: confirm the transaction in your wallet…' })
        } else {
          setStatus({ state: 'busy', text: 'Confirm the transaction in your wallet…' })
        }
      } else {
        setStatus({ state: 'busy', text: 'Confirm the transaction in your wallet…' })
      }
      const hash = await sendTx({ provider, account, ...call })
      setStatus({ state: 'done', text: success, hash })
      onDone?.()
      return true
    } catch (err) {
      // A cancel in the wallet is not a failure: show it calmly.
      setStatus({ state: isUserRejection(err) ? 'cancelled' : 'error', text: friendlyError(err) })
      return false
    }
  }, [provider, account, onDone])

  return { status, busy: status.state === 'busy', run, reset: () => setStatus({ state: 'idle' }) }
}
