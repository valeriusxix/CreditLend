function Button({ children, variant = 'primary', href, className = '', onClick, type = 'button', disabled = false }) {
  // With an href it is a link (as before); without one it is a real button that can be disabled.
  if (href !== undefined) {
    return (
      <a className={`button button--${variant} ${className}`} href={href} onClick={onClick}>
        {children}
      </a>
    )
  }
  return (
    <button className={`button button--${variant} ${className}`} type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export default Button
