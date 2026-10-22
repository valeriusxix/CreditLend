// Browser-wallet connection (MetaMask, Rabby, Coinbase Wallet...) through the standard EIP-1193
// `window.ethereum`. Reads never need the wallet; it only signs transactions.
import { createPublicClient, createWalletClient, custom, http, getAddress, numberToHex } from 'viem'
import { robinhood, RPC_URL, EXPLORER_URL } from './config.js'

export const publicClient = createPublicClient({ chain: robinhood, transport: http(RPC_URL, { batch: true }), batch: { multicall: true } })

/// The injected wallet, if any. In local development only, VITE_DEV_RPC (an anvil node, whose test
/// accounts are unlocked) can stand in for one; that code is stripped from production builds.
export async function getProvider() {
  if (import.meta.env.DEV && import.meta.env.VITE_DEV_RPC) {
    const { devProvider } = await import('./devProvider.js')
    return devProvider(import.meta.env.VITE_DEV_RPC)
  }
  return typeof window !== 'undefined' ? window.ethereum ?? null : null
}

export const ROBINHOOD_HEX_ID = numberToHex(robinhood.id) // 0x1237

/// Ask the wallet to switch to Robinhood Chain, adding it first if the wallet doesn't know it.
export async function switchToRobinhood(provider) {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ROBINHOOD_HEX_ID }] })
  } catch (err) {
    if (err?.code !== 4902 && !/unrecognized|not been added|unknown chain/i.test(err?.message ?? '')) throw err
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: ROBINHOOD_HEX_ID,
        chainName: robinhood.name,
        nativeCurrency: robinhood.nativeCurrency,
        rpcUrls: robinhood.rpcUrls.default.http,
        blockExplorerUrls: [EXPLORER_URL],
      }],
    })
  }
}

export function walletClientFor(provider, account) {
  return createWalletClient({ chain: robinhood, transport: custom(provider), account: getAddress(account) })
}

/// Simulate (so a doomed transaction never reaches the wallet), send, and wait for it to be mined.
export async function sendTx({ provider, account, address, abi, functionName, args }) {
  const { request } = await publicClient.simulateContract({ address, abi, functionName, args, account })
  // Every pool action first adds the interest earned since the last one, which writes storage only
  // if time has passed. Gas is estimated at the latest block, so a transaction landing a second later
  // can need ~20-40k more gas than estimated and run out (seen on a fork test). Pad the limit: only gas
  // actually used is paid for.
  const estimate = await publicClient.estimateContractGas(request)
  const hash = await walletClientFor(provider, account).writeContract({ ...request, gas: estimate + (estimate * 3n) / 10n + 50_000n })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`The transaction failed on-chain (${hash}).`)
  return hash
}
