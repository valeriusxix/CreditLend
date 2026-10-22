// LOCAL DEVELOPMENT ONLY. A stand-in wallet that forwards requests to an anvil node, whose default
// test accounts are unlocked (no private key here or anywhere in the app). Loaded only when
// `import.meta.env.DEV` and VITE_DEV_RPC are both set, so production builds never include it.
export function devProvider(rpcUrl) {
  let id = 0
  const listeners = {}
  const call = async (method, params = []) => {
    const res = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    const body = await res.json()
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data })
    return body.result
  }
  // ?dev_account=N picks anvil's N-th test account (to play a borrower and a liquidator side by side).
  const index = Number(new URLSearchParams(window.location.search).get('dev_account') ?? 1)
  const accounts = async () => [(await call('eth_accounts'))[index]]
  // Like a real wallet: no account is shared until the user presses Connect.
  let connected = false
  return {
    isDevProvider: true,
    async request({ method, params }) {
      if (method === 'eth_requestAccounts') { connected = true; return accounts() }
      if (method === 'eth_accounts') return connected ? accounts() : []
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      return call(method, params)
    },
    on: (event, fn) => { (listeners[event] ??= []).push(fn) },
    removeListener: (event, fn) => { listeners[event] = (listeners[event] ?? []).filter((f) => f !== fn) },
  }
}
