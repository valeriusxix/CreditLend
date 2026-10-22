import { useEffect, useState } from 'react'

/// The page is chosen by the part of the URL after "#":
///   #app, #app/lend, #app/borrow, #app/liquidate, #app/account/0x...   the lending app
///   #docs, #docs/agent, #docs/governance ...                          the docs
///   anything else                                                     the landing page
export function parseRoute(hash) {
  const [page = '', section = '', extra = ''] = hash.replace(/^#\/?/, '').split('/')
  if (page === 'app') return { page: 'app', section: section || 'overview', extra }
  if (page === 'docs') return { page: 'docs', section: section || 'overview' }
  return { page: 'home', section: page }
}

export function useHashRoute() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash))
  useEffect(() => {
    const onChange = () => {
      const next = parseRoute(window.location.hash)
      setRoute(next)
      // Page changes start at the top; in-page anchors on the landing page scroll by themselves.
      if (next.page !== 'home') window.scrollTo({ top: 0 })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
