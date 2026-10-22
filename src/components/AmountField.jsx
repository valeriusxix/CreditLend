import { useId } from 'react'

/// A number input with the token symbol, the available balance and a Max button.
function AmountField({ label, value, onChange, symbol, balanceLabel, balanceText, onMax, error, disabled }) {
  const id = useId()
  return (
    <div className="amount-field">
      <div className="amount-field__top">
        <label htmlFor={id}>{label}</label>
        {balanceText != null && (
          <span className="amount-field__balance">
            {balanceLabel}: {balanceText}
          </span>
        )}
      </div>
      <div className={`amount-field__box ${error ? 'has-error' : ''}`}>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <span className="amount-field__symbol">{symbol}</span>
        {onMax && (
          <button type="button" className="max-button" onClick={onMax} disabled={disabled}>
            Max
          </button>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

export default AmountField
