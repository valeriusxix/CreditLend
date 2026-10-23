// The read servers and the automatic switch to a backup when one fails. Uses two tiny local servers
// (one "down", one working); no internet needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { defineChain } from 'viem'
import { rpcUrls, makePublicClient, ROBINHOOD_PUBLIC_RPC } from '../src/lib/rpc.js'

const chain = defineChain({ id: 4663, name: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [ROBINHOOD_PUBLIC_RPC] } } })

/// A JSON-RPC server that answers eth_chainId / eth_blockNumber, or fails every request with `status`.
async function server({ status = 200 } = {}) {
  let hits = 0
  const answer = ({ id, method }) => ({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x1237' : '0x2a' })
  const s = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      hits++
      if (status !== 200) { res.writeHead(status); res.end('down'); return }
      const msg = JSON.parse(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(Array.isArray(msg) ? msg.map(answer) : answer(msg)))
    })
  })
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${s.address().port}`, hits: () => hits, close: () => new Promise((r) => s.close(r)) }
}

test('server list: main first, then backups, then Robinhood public; no duplicates or junk', () => {
  assert.deepEqual(rpcUrls('https://main.example', 'https://b1.example, https://b2.example'), ['https://main.example', 'https://b1.example', 'https://b2.example', ROBINHOOD_PUBLIC_RPC])
  assert.deepEqual(rpcUrls(ROBINHOOD_PUBLIC_RPC, ''), [ROBINHOOD_PUBLIC_RPC])
  assert.deepEqual(rpcUrls('https://main.example', ' ,ftp://x, javascript:alert(1)'), ['https://main.example', ROBINHOOD_PUBLIC_RPC])
  assert.deepEqual(rpcUrls('', undefined), [ROBINHOOD_PUBLIC_RPC])
})

test('a local test chain never falls back to the real chain', () => {
  assert.deepEqual(rpcUrls('http://127.0.0.1:8545', ''), ['http://127.0.0.1:8545'])
  assert.deepEqual(rpcUrls('http://localhost:8545', ''), ['http://localhost:8545'])
})

test('when the main server is down, reads are answered by the backup', async () => {
  const down = await server({ status: 503 })
  const up = await server()
  try {
    const client = makePublicClient(chain, [down.url, up.url])
    assert.equal(await client.getChainId(), 4663)
    assert.equal(await client.getBlockNumber(), 42n)
    assert.ok(down.hits() > 0, 'the main server was tried first')
    assert.ok(up.hits() > 0, 'the backup answered')
  } finally {
    await down.close()
    await up.close()
  }
})

test('only when every server fails does the read fail (the app then shows its retry message)', async () => {
  const a = await server({ status: 503 })
  const b = await server({ status: 429 })
  try {
    const client = makePublicClient(chain, [a.url, b.url])
    await assert.rejects(client.getBlockNumber())
  } finally {
    await a.close()
    await b.close()
  }
})
