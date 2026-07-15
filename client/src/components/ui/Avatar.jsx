import './ui.css';

/**
 * Avatar — user or brand circle. Sizes: sm, md (default), lg.
 * `accent` variant uses the brand gradient (assistant / app).
 */
export default function Avatar({
  size = 'md',
  accent = false,
  src,
  alt = '',
  children,
  className = '',
}) {
  const classes = [
    'ui-avatar',
    size !== 'md' && `ui-avatar-${size}`,
    accent && 'ui-avatar-accent',
    className,
  ].filter(Boolean).join(' ');
  if (src) {
    return <img className={classes} src={src} alt={alt} />;
  }
  return <span className={classes}>{children}</span>;
}
