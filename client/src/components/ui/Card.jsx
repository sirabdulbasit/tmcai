import './ui.css';

/**
 * Card — panel container. Sizes: sm, md (default), lg.
 * Compose with CardHeader / CardTitle / CardSub for consistent layout.
 */
export default function Card({ size = 'md', className = '', children, ...rest }) {
  const cls = ['ui-card', size !== 'md' && `ui-card-${size}`, className].filter(Boolean).join(' ');
  return <div className={cls} {...rest}>{children}</div>;
}

export function CardHeader({ children, className = '' }) {
  return <div className={`ui-card-header ${className}`}>{children}</div>;
}
export function CardTitle({ children, className = '' }) {
  return <h3 className={`ui-card-title ${className}`}>{children}</h3>;
}
export function CardSub({ children, className = '' }) {
  return <p className={`ui-card-sub ${className}`}>{children}</p>;
}
