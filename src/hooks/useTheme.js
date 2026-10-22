import { useEffect, useState } from 'react'

const KEY = 'creditlend.theme'

function initialTheme() {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    // storage blocked: fall through
  }
  return 'dark' // the design's default
}

/// Light/dark theme, remembered per browser. Sets <html data-theme="...">.
export function useTheme() {
  const [theme, setTheme] = useState(initialTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      // not remembered; still applied
    }
  }, [theme])
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) }
}
