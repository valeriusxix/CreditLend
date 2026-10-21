import { ShieldCheck } from 'lucide-react'

function Badge({ children }) {
  return (
    <div className="badge">
      <ShieldCheck aria-hidden="true" size={16} strokeWidth={1.7} />
      <span>{children}</span>
    </div>
  )
}

export default Badge
