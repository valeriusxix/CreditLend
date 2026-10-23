import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { parseRoute, legacyHashPath } from '../lib/routes.js'

/// The current page from the clean URL path. Also:
///  - only a change of PAGE scrolls to the top; switching tabs inside the app keeps your place (on a
///    phone the form sits below your position);
///  - old "#app..." / "#docs..." links are redirected to their clean path.
export function useRoute() {
  const location = useLocation()
  const navigate = useNavigate()
  const route = parseRoute(location.pathname)
  const previousPage = useRef(route.page)

  useEffect(() => {
    const clean = legacyHashPath(location.hash)
    if (clean) navigate(clean + location.search, { replace: true })
  }, [location.hash, location.search, navigate])

  useEffect(() => {
    if (previousPage.current === route.page) return
    previousPage.current = route.page
    window.scrollTo({ top: 0 })
  }, [route.page])

  return route
}
