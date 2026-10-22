// Settings come from VITE_* variables (a root .env.local, or the hosting provider's settings).
// Only VITE_-prefixed variables reach the browser, and nothing secret may ever be one.
import { defineChain, getAddress, isAddress } from 'viem'

const env = import.meta.env

const ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com'

export const EXPLORER_URL = env.VITE_EXPLORER_URL || 'https://robin.etherscan.io'

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_RPC] } },
  blockExplorers: { default: { name: 'Robinhood Chain Explorer', url: EXPLORER_URL } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

// Reads go here; the wallet is only used to send transactions.
export const RPC_URL = env.VITE_RPC_URL || ROBINHOOD_RPC

function optionalAddress(value) {
  if (!value) return null
  return isAddress(value, { strict: false }) ? getAddress(value) : null
}

// The CreditLendPool address printed by contracts/script/Deploy.s.sol. Everything else (the
// CollateralManager, $CREDIT, the collateral list) is read from the pool itself.
export const POOL_ADDRESS = optionalAddress(env.VITE_POOL_ADDRESS)
export const POOL_ADDRESS_INVALID = Boolean(env.VITE_POOL_ADDRESS) && !POOL_ADDRESS
// Block the pool was deployed in: where the liquidation page starts looking for borrowers.
export const POOL_DEPLOY_BLOCK = BigInt(env.VITE_POOL_DEPLOY_BLOCK || '0')

export const explorerAddress = (address) => `${EXPLORER_URL}/address/${address}`
export const explorerTx = (hash) => `${EXPLORER_URL}/tx/${hash}`
