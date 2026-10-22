// Wallet discovery (EIP-6963 announcements, with window.ethereum as the fallback). No browser needed:
// a bare EventTarget stands in for `window`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addWallet, legacyWallet, watchWallets, mobileWalletLinks } from '../src/lib/wallets.js'

const provider = (extra = {}) => ({ request: async () => null, ...extra })

function announce(target, info, p = provider()) {
  target.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: p }) }))
}

test('each wallet is listed once, in the order it announced itself', () => {
  let list = addWallet([], { id: 'io.metamask', name: 'MetaMask' })
  list = addWallet(list, { id: 'io.rabby', name: 'Rabby' })
  list = addWallet(list, { id: 'io.metamask', name: 'MetaMask' })
  assert.deepEqual(list.map((w) => w.name), ['MetaMask', 'Rabby'])
})

test('window.ethereum is offered only when no wallet announced itself, under its own name', () => {
  assert.equal(legacyWallet([{ id: 'x' }], provider()), null)
  assert.equal(legacyWallet([], undefined), null)
  assert.equal(legacyWallet([], provider({ isMetaMask: true })).name, 'MetaMask')
  assert.equal(legacyWallet([], provider({ isMetaMask: true, isRabby: true })).name, 'Rabby')
  assert.equal(legacyWallet([], provider()).name, 'Browser wallet')
})

test('installed wallets are discovered as they announce; junk announcements are ignored', async () => {
  const win = new EventTarget()
  globalThis.window = win
  let requested = 0
  win.addEventListener('eip6963:requestProvider', () => {
    requested++
    announce(win, { uuid: 'u1', rdns: 'io.metamask', name: 'MetaMask', icon: 'data:image/svg+xml,<svg/>' })
  })
  const seen = []
  const stop = watchWallets((list) => seen.push(list.map((w) => w.name)))
  announce(win, { uuid: 'u2', rdns: 'io.rabby', name: 'Rabby', icon: 'data:image/svg+xml,<svg/>' })
  announce(win, { uuid: 'u3', name: 'Broken' }, {}) // no request(): not a wallet
  announce(win, { uuid: 'u1', rdns: 'io.metamask', name: 'MetaMask' }) // repeated
  assert.equal(requested, 1, 'asks wallets to announce themselves once')
  assert.deepEqual(seen.at(-1), ['MetaMask', 'Rabby'])
  stop()
  delete globalThis.window
})

test('an old-style wallet (window.ethereum only) still appears after a short wait', async () => {
  const win = new EventTarget()
  win.ethereum = provider({ isMetaMask: true })
  globalThis.window = win
  const seen = []
  const stop = watchWallets((list) => seen.push(list.map((w) => w.name)))
  await new Promise((r) => setTimeout(r, 450))
  assert.deepEqual(seen.at(-1), ['MetaMask'])
  stop()
  delete globalThis.window
})

test('phones: links open this exact page inside the wallet app', () => {
  const [metamask, coinbase] = mobileWalletLinks('https://creditlend.app/#app/borrow')
  assert.equal(metamask.href, 'https://metamask.app.link/dapp/creditlend.app/#app/borrow')
  assert.equal(coinbase.href, 'https://go.cb-w.com/dapp?cb_url=https%3A%2F%2Fcreditlend.app%2F%23app%2Fborrow')
})
