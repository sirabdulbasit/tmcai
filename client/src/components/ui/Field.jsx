import './ui.css';

/**
 * Field — wraps a labelled input. Use with Input / Textarea / Select.
 *
 *   <Field label="Email"><Input type="email" value={v} onChange={...} /></Field>
 */
export default function Field({ label, children, className = '', helper }) {
  return (
    <div className={`ui-field ${className}`}>
      {label && <label className="ui-label">{label}</label>}
      {children}
      {helper && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>{helper}</div>}
    </div>
  );
}

export function Input({ size, className = '', ...rest }) {
  const cls = ['ui-input', size === 'sm' && 'ui-input-sm', className].filter(Boolean).join(' ');
  return <input className={cls} {...rest} />;
}
export function Textarea({ className = '', ...rest }) {
  return <textarea className={`ui-textarea ${className}`} {...rest} />;
}
export function Select({ className = '', children, ...rest }) {
  return <select className={`ui-select ${className}`} {...rest}>{children}</select>;
}
