import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react'
import { explorerTx } from '../lib/config.js'

/// The status line under an action button.
function TxNotice({ status }) {
  if (!status || status.state === 'idle') return null
  const Icon = status.state === 'busy' ? Loader2 : status.state === 'done' ? CheckCircle2 : TriangleAlert
  return (
    <div className={`tx-notice tx-notice--${status.state}`} role={status.state === 'error' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" size={16} className={status.state === 'busy' ? 'spin' : ''} />
      <span>
        {status.text}
        {status.hash && (
          <>
            {' '}
            <a href={explorerTx(status.hash)} target="_blank" rel="noreferrer">View transaction ↗</a>
          </>
        )}
      </span>
    </div>
  )
}

export default TxNotice
