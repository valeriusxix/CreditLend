import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

const links = [
  {
    label: 'Markets',
    href: '#app',
    dropdown: [
      { label: 'Lend & borrow', href: '#app' },
      { label: 'Liquidations', href: '#app/liquidate' },
      { label: 'How lending works', href: '#docs/lending' },
    ],
  },
  {
    label: 'Agent',
    href: '#docs/agent',
    dropdown: [
      { label: 'What the agent does', href: '#docs/agent' },
      { label: 'Rate settings & limits', href: '#docs/governance' },
    ],
  },
  { label: 'Governance', href: '#docs/governance' },
]

function NavLinks({ className = '', onNavigate, stacked = false }) {
  const [open, setOpen] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(null) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(null) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const navigate = () => { setOpen(null); onNavigate?.() }

  return (
    <nav ref={ref} className={`nav-links ${className}`} aria-label="Main navigation">
      {links.map(({ label, href, dropdown }) => {
        if (!dropdown) return <a key={label} className="nav-link" href={href} onClick={navigate}>{label}</a>
        // On the mobile menu the sub-links are listed in full; on desktop they open on click.
        if (stacked) {
          return dropdown.map((item) => <a key={item.href + item.label} className="nav-link" href={item.href} onClick={navigate}>{item.label}</a>)
        }
        return (
          <div key={label} className="nav-dropdown">
            <button type="button" className="nav-link" aria-expanded={open === label} aria-haspopup="true" onClick={() => setOpen(open === label ? null : label)}>
              {label}
              <ChevronDown aria-hidden="true" size={14} className={open === label ? 'is-flipped' : ''} />
            </button>
            {open === label && (
              <div className="nav-menu">
                {dropdown.map((item) => <a key={item.label} href={item.href} onClick={navigate}>{item.label}</a>)}
              </div>
            )}
          </div>
        )
      })}
    </nav>
  )
}

export default NavLinks
