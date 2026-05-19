/**
 * StaleConnectorBanner — top-of-screen warning whenever a connector
 * (Gmail / Calendar / Drive / etc.) has gone stale, errored, or
 * crossed the 24h-since-last-sync threshold.
 *
 * Mounted in ProtectedRoute so it appears on every authenticated page.
 * Polls /profile/connector-health every 60s. Renders only when there
 * IS something stale — invisible otherwise.
 *
 * UX principle (per the trust-architecture discussion): loud, not
 * silent. Users should learn about lost data freshness immediately,
 * not via the next Day Brief 6 hours later.
 *
 * Dismissable for 1h via a snooze button (localStorage). Re-renders
 * automatically when snooze expires.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../services/api';

const POLL_INTERVAL_MS = 60_000;
const SNOOZE_MS = 60 * 60 * 1000; // 1 hour
const SNOOZE_KEY = 'staleConnectorBanner.snoozedUntil';

export default function StaleConnectorBanner() {
  const [stale, setStale] = useState([]);
  const [snoozedUntil, setSnoozedUntil] = useState(() => {
    const v = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return Number.isFinite(v) ? v : 0;
  });

  useEffect(() => {
    let alive = true;
    let timer = null;

    const tick = async () => {
      try {
        const r = await api.get('/profile/connector-health');
        if (!alive) return;
        setStale(Array.isArray(r.data?.stale) ? r.data.stale : []);
      } catch { /* silent — banner just stays hidden */ }
    };
    tick();
    timer = setInterval(tick, POLL_INTERVAL_MS);

    // Re-render at snooze expiry so the banner reappears automatically.
    let snoozeTimer = null;
    if (snoozedUntil > Date.now()) {
      snoozeTimer = setTimeout(() => setSnoozedUntil(0), snoozedUntil - Date.now());
    }

    return () => {
      alive = false;
      if (timer) clearInterval(timer);
      if (snoozeTimer) clearTimeout(snoozeTimer);
    };
  }, [snoozedUntil]);

  if (stale.length === 0) return null;
  if (snoozedUntil > Date.now()) return null;

  const snooze = () => {
    const until = Date.now() + SNOOZE_MS;
    localStorage.setItem(SNOOZE_KEY, String(until));
    setSnoozedUntil(until);
  };

  // Build a tight human description per connector.
  const fmt = (m) => {
    if (m === null) return 'never synced';
    if (m < 60) return `${m}m ago`;
    if (m < 1440) return `${Math.floor(m / 60)}h ago`;
    return `${Math.floor(m / 1440)}d ago`;
  };

  // OAuth Testing-mode signature: 3+ Google connectors stale at once.
  const googleSlugs = ['gmail', 'ct_gmail', 'google_calendar', 'ct_google_calendar', 'google_drive', 'ct_google_drive_personal', 'google_drive_personal'];
  const googleStaleCount = stale.filter((s) => googleSlugs.some((g) => s.slug.toLowerCase().includes(g.replace('ct_', '').replace('_personal', '')))).length;
  const isOAuthTestingPattern = googleStaleCount >= 2;

  return (
    <div style={{
      position: 'sticky',
      top: 0, left: 0, right: 0,
      zIndex: 1500,
      background: '#7f1d1d',
      borderBottom: '1px solid #b91c1c',
      color: '#fee2e2',
      padding: '10px 16px',
      fontSize: 13,
      lineHeight: 1.4,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 16 }}>⚠</span>
      <div style={{ flex: 1, minWidth: 200 }}>
        <strong>
          {stale.length === 1
            ? `${stale[0].name} not syncing`
            : `${stale.length} connectors not syncing`}
        </strong>{' '}
        <span style={{ color: '#fecaca' }}>
          {stale.slice(0, 4).map((s, i) => (
            <span key={s.id}>
              {i > 0 ? ', ' : ' — '}
              {s.name} ({fmt(s.ageMin)})
            </span>
          ))}
          {stale.length > 4 && <span>, +{stale.length - 4} more</span>}
        </span>
        {isOAuthTestingPattern && (
          <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 4 }}>
            All Google connectors stale together = OAuth Testing-mode 7-day expiry. One-time fix: switch consent screen to Internal in GCP.
          </div>
        )}
      </div>
      <Link to="/connectors" style={{
        background: '#fecaca',
        color: '#7f1d1d',
        padding: '6px 14px',
        borderRadius: 6,
        textDecoration: 'none',
        fontWeight: 600,
        fontSize: 12,
      }}>Reconnect</Link>
      <button onClick={snooze} style={{
        background: 'transparent',
        border: '1px solid #fca5a5',
        color: '#fecaca',
        padding: '6px 10px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 12,
      }}>Snooze 1h</button>
    </div>
  );
}
