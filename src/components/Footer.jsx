import { Link } from 'react-router-dom'
function Footer() {
  return (
    <footer className="site-footer">
      <span>CreditLend</span>
      <span>Markets are subject to protocol risk. Borrow responsibly.</span>
      <Link to="/docs">Protocol docs <span aria-hidden="true">↗</span></Link>
    </footer>
  )
}

export default Footer
