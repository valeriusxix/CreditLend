import { ChevronDown } from 'lucide-react'

const links = [
  { label: 'Markets', href: '#markets', dropdown: true },
  { label: 'Agent', href: '#agent', dropdown: true },
  { label: 'Governance', href: '#governance' },
]

function NavLinks({ className = '', onNavigate }) {
  return (
    <nav className={`nav-links ${className}`} aria-label="Main navigation">
      {links.map(({ label, href, dropdown }) => (
        <a key={label} className="nav-link" href={href} onClick={onNavigate}>
          {label}
          {dropdown && <ChevronDown aria-hidden="true" size={14} />}
        </a>
      ))}
    </nav>
  )
}

export default NavLinks
