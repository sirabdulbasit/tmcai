import './ui.css';
import Avatar from './Avatar';

/**
 * TopBar — top horizontal strip inside Canvas. Composed of Title + optional
 * Search + right-side controls (tenant, user menu, notifications).
 *
 * For multi-tenant SaaS awareness, use <TopBarTenant>ClientNumber</TopBarTenant>
 * alongside <TopBarUser>.
 */
export default function TopBar({ children, className = '' }) {
  return <header className={`ui-topbar ${className}`}>{children}</header>;
}

export function TopBarTitle({ children, className = '' }) {
  return <h2 className={`ui-topbar-title ${className}`}>{children}</h2>;
}

export function TopBarSearch({ placeholder = 'Search…', value, onChange, className = '' }) {
  return (
    <div className={`ui-topbar-search ${className}`}>
      <svg className="ui-topbar-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input className="ui-input" placeholder={placeholder} value={value} onChange={onChange} />
    </div>
  );
}

export function TopBarUser({ name, initials, accent = false, onClick, className = '' }) {
  return (
    <button type="button" className={`ui-topbar-user ${className}`} onClick={onClick}>
      <Avatar size="sm" accent={accent}>{initials}</Avatar>
      {name && <span className="ui-topbar-user-name">{name}</span>}
    </button>
  );
}

export function TopBarTenant({ children, className = '' }) {
  return <span className={`ui-topbar-tenant ${className}`}>{children}</span>;
}
