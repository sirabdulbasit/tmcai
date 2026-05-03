import './ui.css';

/**
 * Empty — standard empty-state panel.
 */
export default function Empty({ title, children, className = '' }) {
  return (
    <div className={`ui-empty ${className}`}>
      {title && <div className="ui-empty-title">{title}</div>}
      {children}
    </div>
  );
}
