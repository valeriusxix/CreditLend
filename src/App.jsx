import Navbar from './components/Navbar.jsx'
import Hero from './components/Hero.jsx'
import Footer from './components/Footer.jsx'
import AppView from './components/AppView.jsx'
import DocsView from './components/DocsView.jsx'
import WalletModal from './components/WalletModal.jsx'
import { useRoute } from './hooks/useRoute.js'
import { useTheme } from './hooks/useTheme.js'
import { useWallet } from './hooks/useWallet.js'
import './styles/app.css'

function App() {
  const route = useRoute()
  const { theme, toggle } = useTheme()
  const wallet = useWallet()

  return (
    <>
      <Navbar inApp={route.page !== 'home'} wallet={wallet} theme={theme} onToggleTheme={toggle} />
      <main className={`page page--${route.page}`}>
        {route.page === 'home' && <Hero />}
        {route.page === 'app' && <AppView route={route} wallet={wallet} />}
        {route.page === 'docs' && <DocsView section={route.section} />}
      </main>
      <Footer />
      <WalletModal wallet={wallet} />
    </>
  )
}

export default App
