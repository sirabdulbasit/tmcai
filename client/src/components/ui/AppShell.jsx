import './ui.css';

/**
 * AppShell — the grid that holds rail (left) + canvas (right).
 * Page layout:  <AppShell><Rail>…</Rail><Canvas><TopBar/><Page>…</Page></Canvas></AppShell>
 */
export default function AppShell({ children, className = '' }) {
  return <div className={`ui-app ${className}`}>{children}</div>;
}

export function Canvas({ children, className = '' }) {
  return <div className={`ui-canvas ${className}`}>{children}</div>;
}
export function Page({ children, className = '' }) {
  return <main className={`ui-page ${className}`}>{children}</main>;
}
export function PageTitle({ children, className = '' }) {
  return <h1 className={`ui-page-title ${className}`}>{children}</h1>;
}
export function PageSub({ children, className = '' }) {
  return <p className={`ui-page-sub ${className}`}>{children}</p>;
}
