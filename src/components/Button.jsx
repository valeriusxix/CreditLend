function Button({ children, variant = 'primary', href = '#', className = '', onClick }) {
  return (
    <a className={`button button--${variant} ${className}`} href={href} onClick={onClick}>
      {children}
    </a>
  )
}

export default Button
