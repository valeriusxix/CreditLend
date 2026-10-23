import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { isAddress, getAddress } from 'viem'
import { Search, X } from 'lucide-react'

const PAGES = [
  ['Lend & borrow', '/app'],
  ['Liquidations', '/app/liquidate'],
  ['Docs: health factor', '/docs/borrowing'],
  ['Docs: the agent', '/docs/agent'],
  ['Docs: governance', '/docs/governance'],
]

/// The navbar's search: paste any wallet address to see its position, or jump to a page.
function SearchDialog({ open, onClose }) {
  const [text, setText] = useState('')
  const [error, setError] = useState(null)
  const input = useRef(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return undefined
    input.current?.focus()
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const go = (path) => { navigate(path); setText(''); setError(null); onClose() }
  const submit = (e) => {
    e.preventDefault()
    const q = text.trim()
    if (isAddress(q, { strict: false })) return go(`/app/account/${getAddress(q)}`)
    const page = PAGES.find(([label]) => label.toLowerCase().includes(q.toLowerCase()))
    if (q && page) return go(page[1])
    setError('Paste a wallet address (0x…), or type a page name.')
  }

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-dialog" role="dialog" aria-modal="true" aria-label="Search" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit} className="search-form">
          <Search aria-hidden="true" size={18} />
          <input ref={input} value={text} onChange={(e) => { setText(e.target.value); setError(null) }} placeholder="Look up a wallet address (0x…) or a page" aria-label="Search" />
          <button type="button" className="icon-button" aria-label="Close search" onClick={onClose}><X size={18} /></button>
        </form>
        {error && <p className="field-error">{error}</p>}
        <ul className="search-pages">
          {PAGES.map(([label, path]) => (
            <li key={path}><Link to={path} onClick={onClose}>{label}</Link></li>
          ))}
        </ul>
      </div>
    </div>
  )
}

export default SearchDialog
