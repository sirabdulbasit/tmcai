import './ui.css';

/**
 * Dot — status indicator (8px). status: up | degraded | down | muted.
 */
export default function Dot({ status = 'up', className = '', ...rest }) {
  return <span className={`ui-dot ui-dot-${status} ${className}`} {...rest} />;
}
