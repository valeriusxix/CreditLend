// Which page an address shows. Clean paths (no "#"):
//   /app, /app/lend, /app/borrow, /app/liquidate, /app/account/0x...   the lending app
//   /docs, /docs/agent, /docs/governance ...                         the docs
//   anything else                                                     the landing page
// A leading "#" is also accepted, so old links like /#app still resolve (useRoute redirects them).
export function parseRoute(path) {
  const [page = '', section = '', extra = ''] = String(path ?? '').replace(/^#?\/?/, '').split('/')
  if (page === 'app') return { page: 'app', section: section || 'overview', extra }
  if (page === 'docs') return { page: 'docs', section: section || 'overview' }
  return { page: 'home', section: page }
}

/// The clean path for an old "#..." address, or null if it isn't one of the app's pages.
export function legacyHashPath(hash) {
  const route = parseRoute(hash)
  if (!String(hash ?? '').startsWith('#') || route.page === 'home') return null
  return '/' + String(hash).replace(/^#\/?/, '')
}
