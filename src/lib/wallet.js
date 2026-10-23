// Browser-wallet connection (MetaMask, Rabby, Coinbase Wallet...) through the standard EIP-1193
// `window.ethereum`. Reads never need the wallet; it only signs transactions.
import { createWalletClient, custom, getAddress, numberToHex } from 'viem'
import { robinhood, RPC_URLS, EXPLORER_URL } from './config.js'
import { makePublicClient } from './rpc.js'

export const publicClient = makePublicClient(robinhood, RPC_URLS)

/// In local development only (VITE_DEV_RPC = an anvil node), an extra "Local test account" wallet
/// that uses anvil's unlocked test accounts. Stripped from production builds.
export async function devWallet() {
  if (!(import.meta.env.DEV && import.meta.env.VITE_DEV_RPC)) return null
  const { devProvider } = await import('./devProvider.js')
  return { id: 'dev', name: 'Local test account', icon: null, provider: devProvider(import.meta.env.VITE_DEV_RPC) }
}

/// On a local test copy, reads come from the copy but a real wallet would send to the real chain,
/// where these contract addresses mean nothing (or something else). Never let that happen.
export function assertCanSend(provider) {
  if (import.meta.env.DEV && import.meta.env.VITE_DEV_RPC && !provider?.isDevProvider) {
    throw new Error('This is a local test copy of the chain: real wallets can connect here but not send transactions. Use "Local test account", or the live site.')
  }
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
  assertCanSend(provider)
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
