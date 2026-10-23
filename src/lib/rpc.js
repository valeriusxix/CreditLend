// Which servers the app reads the chain from, and the read client that switches between them.
// Kept free of `import.meta.env` so it can be tested in plain Node.
import { createPublicClient, fallback, http } from 'viem'

export const ROBINHOOD_PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

const isLocal = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url)

/// The read servers in the order to try them: the main one, then any backups (comma-separated), then
/// Robinhood's public server as the last resort. Duplicates and non-http(s) entries are dropped. A local
/// test chain never falls back to the real one (their data would not match).
export function rpcUrls(primary, backups = '') {
  const list = [primary, ...String(backups).split(',')]
    .map((u) => (u ?? '').trim())
    .filter((u) => /^https?:\/\//i.test(u))
  if (list.length === 0) list.push(ROBINHOOD_PUBLIC_RPC)
  if (!isLocal(list[0])) list.push(ROBINHOOD_PUBLIC_RPC)
  return [...new Set(list)]
}

/// A read client that uses the first server that answers. If one fails (down, rate-limited,
/// unreachable), the next is tried for that same request, so visitors only see an error when all fail.
export function makePublicClient(chain, urls) {
  const transports = urls.map((url) => http(url, { batch: true, retryCount: 1, timeout: 10_000 }))
  return createPublicClient({
    chain,
    transport: transports.length > 1 ? fallback(transports, { retryCount: 1 }) : transports[0],
    batch: { multicall: true },
  })
}
