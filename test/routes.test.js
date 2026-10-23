// Clean URLs (no "#"): which page each address shows, and old "#..." links redirecting to their path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRoute, legacyHashPath } from '../src/lib/routes.js'

test('clean paths pick the page and section', () => {
  assert.deepEqual(parseRoute('/'), { page: 'home', section: '' })
  assert.deepEqual(parseRoute('/app'), { page: 'app', section: 'overview', extra: '' })
  assert.deepEqual(parseRoute('/app/borrow'), { page: 'app', section: 'borrow', extra: '' })
  assert.deepEqual(parseRoute('/app/liquidate'), { page: 'app', section: 'liquidate', extra: '' })
  assert.deepEqual(parseRoute('/app/account/0xabc'), { page: 'app', section: 'account', extra: '0xabc' })
  assert.deepEqual(parseRoute('/docs'), { page: 'docs', section: 'overview' })
  assert.deepEqual(parseRoute('/docs/agent'), { page: 'docs', section: 'agent' })
  assert.deepEqual(parseRoute('/no-such-page'), { page: 'home', section: 'no-such-page' })
})

test('old "#app" links are sent to their clean path; anything else is left alone', () => {
  assert.equal(legacyHashPath('#app'), '/app')
  assert.equal(legacyHashPath('#app/borrow'), '/app/borrow')
  assert.equal(legacyHashPath('#/docs/agent'), '/docs/agent')
  assert.equal(legacyHashPath('#top'), null)
  assert.equal(legacyHashPath(''), null)
  assert.equal(legacyHashPath('app'), null)
})
