import './ui.css';

/**
 * Button — primary UI action. Variants: primary, secondary, ghost, danger.
 * Sizes: xs, sm, md (default), lg. Use `icon` prop for icon-only buttons.
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  block = false,
  icon = false,
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'ui-btn',
    `ui-btn-${variant}`,
    size !== 'md' && `ui-btn-${size}`,
    block && 'ui-btn-block',
    icon && 'ui-btn-icon',
    className,
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
