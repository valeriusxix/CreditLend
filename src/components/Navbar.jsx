import { useState } from 'react'
import { Menu, Moon, Search, X } from 'lucide-react'
import creditLendLogo from '../assets/creditlend.png'
import Button from './Button.jsx'
import NavLinks from './NavLinks.jsx'

function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)

  return (
    <header className="site-header">
      <div className="navbar">
        <a className="brand" href="#top" aria-label="CreditLend home">
          <span className="brand-mark" aria-hidden="true">
            <img src={creditLendLogo} alt="" />
          </span>
          <span>CreditLend</span>
        </a>

        <NavLinks className="navbar-center" />

        <div className="navbar-actions">
          <button className="icon-button" type="button" aria-label="Search">
            <Search size={19} strokeWidth={1.8} />
          </button>
          <button className="icon-button theme-button" type="button" aria-label="Dark theme">
            <Moon size={18} fill="currentColor" strokeWidth={1.5} />
          </button>
          <a className="docs-link" href="#docs">Docs</a>
          <Button className="nav-cta" href="#app">Launch App <span aria-hidden="true">↗</span></Button>
          <button
            className="icon-button menu-toggle"
            type="button"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-navigation"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="mobile-navigation" id="mobile-navigation">
          <NavLinks onNavigate={closeMenu} />
          <a className="mobile-docs" href="#docs" onClick={closeMenu}>Docs</a>
          <Button href="#app" onClick={closeMenu}>Launch App <span aria-hidden="true">↗</span></Button>
        </div>
      )}
    </header>
  )
}

export default Navbar
