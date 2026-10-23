import { ArrowDownRight, ArrowRight, Sparkles } from 'lucide-react'
import Badge from './Badge.jsx'
import Button from './Button.jsx'

function Hero() {
  return (
    <section className="hero" id="top">
      <div className="hero-orb hero-orb--left" aria-hidden="true" />
      <div className="hero-orb hero-orb--right" aria-hidden="true" />
      <div className="hero-content">
        <Badge>Overcollateralized · Agent-monitored</Badge>
        <h1>
          Lend with confidence.
          <br />
          <span>Borrow with safeguards.</span>
        </h1>
        <p className="hero-description">
          The $CREDIT money market on Robinhood Chain. Borrow against USDG, with
          health-factor liquidations and risk rules enforced on-chain.
        </p>
        <div className="hero-actions">
          <Button to="/app">Launch App <ArrowRight aria-hidden="true" size={16} /></Button>
          <Button variant="secondary" to="/docs">Read the Litepaper <ArrowDownRight aria-hidden="true" size={16} /></Button>
        </div>
        <div className="hero-footnote">
          <Sparkles aria-hidden="true" size={14} />
          <span>Agent-assisted markets. Deterministic on-chain protection.</span>
        </div>
      </div>
      <div className="hero-bottom-line" aria-hidden="true">
        <span>BUILT FOR ORBIO</span>
        <span className="bottom-dot" />
        <span>SETTLED ON ROBINHOOD CHAIN</span>
      </div>
    </section>
  )
}

export default Hero
