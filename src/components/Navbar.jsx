import { useState } from 'react'
import { Menu, Moon, Search, Sun, X } from 'lucide-react'
import creditLendLogo from '../assets/creditlend.png'
import Button from './Button.jsx'
import ConnectButton from './ConnectButton.jsx'
import NavLinks from './NavLinks.jsx'
import SearchDialog from './SearchDialog.jsx'

function Navbar({ inApp = false, wallet, theme, onToggleTheme }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)
  // Inside the app the call to action is the wallet; on the landing page it opens the app.
  const cta = inApp
    ? <ConnectButton wallet={wallet} />
    : <Button className="nav-cta" href="#app">Launch App <span aria-hidden="true">↗</span></Button>

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
          <button className="icon-button" type="button" aria-label="Search" onClick={() => setSearchOpen(true)}>
            <Search size={19} strokeWidth={1.8} />
          </button>
          <button className="icon-button theme-button" type="button" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={onToggleTheme}>
            {theme === 'dark' ? <Moon size={18} fill="currentColor" strokeWidth={1.5} /> : <Sun size={18} strokeWidth={1.8} />}
          </button>
          <a className="docs-link" href="#docs">Docs</a>
          {cta}
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
          <NavLinks onNavigate={closeMenu} stacked />
          <a className="mobile-docs" href="#docs" onClick={closeMenu}>Docs</a>
          <button className="mobile-docs" type="button" onClick={() => { onToggleTheme(); closeMenu() }}>
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </button>
          {inApp ? <ConnectButton wallet={wallet} /> : <Button href="#app" onClick={closeMenu}>Launch App <span aria-hidden="true">↗</span></Button>}
        </div>
      )}

      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
    </header>
  )
}

export default Navbar
