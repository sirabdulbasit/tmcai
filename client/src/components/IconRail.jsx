import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Left navigation rail.
 *
 * Each row uses `data-tip="..."` instead of native `title` so the styled
 * tooltip (see .rail-btn[data-tip]:hover::after in index.css) appears
 * instantly on hover, themed to match the app, and keyboard-focusable.
 *
 * `is-active` is set on the row whose route matches the current path —
 * gives a left accent bar + tinted background so users always see where
 * they are at a glance.
 */
export default function IconRail({ onNewChat, onToggleHistory }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();

  const isActive = (path) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname === path || location.pathname.startsWith(path + '/');
  };
  const cls = (path) => `rail-btn${isActive(path) ? ' is-active' : ''}`;

  return (
    <nav className="icon-rail">
      <button className="rail-btn" data-tip="New chat" onClick={onNewChat}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button className="rail-btn" data-tip="History" onClick={onToggleHistory}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" />
        </svg>
      </button>
      <button className="rail-btn" data-tip="Search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
        </svg>
      </button>
      <div className="rail-spacer" />
      <button className={cls('/day-brief')} data-tip="Day Brief" onClick={() => navigate('/day-brief')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="5" /><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      </button>
      <button className={cls('/open-items')} data-tip="Open Items" onClick={() => navigate('/open-items')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 12l2 2 4-4" />
        </svg>
      </button>
      <button className={cls('/brain')} data-tip="My Brain" onClick={() => navigate('/brain')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M12 2a8 8 0 018 8c0 3.5-2 6-4 7.5V20a2 2 0 01-2 2h-4a2 2 0 01-2-2v-2.5C6 16 4 13.5 4 10a8 8 0 018-8z" /><path d="M10 22h4" />
        </svg>
      </button>
      <button className={cls('/connectors')} data-tip="My Connectors" onClick={() => navigate('/connectors')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M4 12h4M16 12h4" /><circle cx="12" cy="12" r="4" /><path d="M12 4v4M12 16v4" />
        </svg>
      </button>
      <button className={cls('/contacts')} data-tip="Contacts" onClick={() => navigate('/contacts')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
          <circle cx="12" cy="7" r="4" />
          <path d="M16 11l1.5 1.5L20 9" strokeWidth="1.5" />
        </svg>
      </button>
      <button className={cls('/agents')} data-tip="My Team" onClick={() => navigate('/agents')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M12 2a4 4 0 014 4v1a4 4 0 01-8 0V6a4 4 0 014-4z" /><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="18" cy="8" r="2" /><circle cx="6" cy="8" r="2" />
        </svg>
      </button>
      <button className={cls('/schedules')} data-tip="Scheduled Reports" onClick={() => navigate('/schedules')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" />
        </svg>
      </button>
      {user?.isAdmin && (
        <button className={cls('/admin')} data-tip="Admin Panel" onClick={() => navigate('/admin')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4-4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" />
          </svg>
        </button>
      )}
      <button className={cls('/settings')} data-tip="Settings" onClick={() => navigate('/settings')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
        </svg>
      </button>
    </nav>
  );
}
