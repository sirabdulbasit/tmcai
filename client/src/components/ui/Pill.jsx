import './ui.css';

/**
 * Pill — small badge / tag. Variants match semantic colors + accent.
 */
export default function Pill({ variant, className = '', children, ...rest }) {
  const classes = [
    'ui-pill',
    variant && `ui-pill-${variant}`,
    className,
  ].filter(Boolean).join(' ');
  return <span className={classes} {...rest}>{children}</span>;
}
