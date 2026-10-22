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
    const onChange = (e) => {
      const next = parseRoute(window.location.hash)
      const previous = parseRoute(e?.oldURL ? new URL(e.oldURL).hash : '')
      setRoute(next)
      // Only a change of page scrolls; switching tabs within the app keeps your place (on a phone the
      // form sits below your position). The landing page's anchors (#top) exist only once it has
      // rendered, so scroll to them on the next frame.
      if (next.page === previous.page) return
      requestAnimationFrame(() => {
        const anchor = next.page === 'home' && next.section ? document.getElementById(next.section) : null
        if (anchor) anchor.scrollIntoView()
        else window.scrollTo({ top: 0 })
      })
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
