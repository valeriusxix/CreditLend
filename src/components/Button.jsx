import { Link } from 'react-router-dom'

function Button({ children, variant = 'primary', to, href, className = '', onClick, type = 'button', disabled = false }) {
  const classes = `button button--${variant} ${className}`
  // `to` is a page inside the app (clean URL, no reload); `href` is an outside link; neither: a real button.
  if (to !== undefined) {
    return (
      <Link className={classes} to={to} onClick={onClick}>
        {children}
      </Link>
    )
  }
  if (href !== undefined) {
    return (
      <a className={classes} href={href} onClick={onClick}>
        {children}
      </a>
    )
  }
  return (
    <button className={classes} type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  )
}

export default Button
