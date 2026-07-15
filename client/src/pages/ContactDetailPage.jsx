/**
 * Contact detail — full canonical entity_person page rendered as
 * markdown plus the star rating widget. Brain reads this exact page on
 * every reasoning turn for this person, so what's shown here is what
 * Brain knows.
 */
import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../services/api';

// Same inline-toast pattern as ContactsPage. No browser dialogs.
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const notify = useCallback((kind, text) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts, { id, kind, text }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 6000);
  }, []);
  const dismiss = useCallback((id) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  return { toasts, notify, dismiss };
}

export default function ContactDetailPage() {
  const { id } = useParams();
  const [entity, setEntity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const { toasts, notify, dismiss } = useToasts();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/entity-catalog/${encodeURIComponent(id)}`);
      setEntity(res.data.entity);
    } catch (err) {
      setError(err.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const onSetStars = useCallback(async (stars) => {
    try {
      await api.patch(`/entity-catalog/${encodeURIComponent(id)}/stars`, { stars });
      await load();
    } catch (err) {
      notify('error', `Save failed: ${err.response?.data?.error ?? err.message}`);
    }
  }, [id, load, notify]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.post(`/entity-catalog/${encodeURIComponent(id)}/refresh`);
      await load();
      notify('ok', 'Refreshed from feed.');
    } catch (err) {
      notify('error', `Refresh failed: ${err.response?.data?.error ?? err.message}`);
    } finally {
      setRefreshing(false);
    }
  }, [id, load, notify]);

  if (loading) return <Centered>Loading…</Centered>;
  if (error) return <Centered>{error}</Centered>;
  if (!entity) return <Centered>Not found</Centered>;

  const meta = entity.metadata ?? {};
  const stars = (() => {
    const userStars = meta.user_stars ?? {};
    // We don't know our own userId from this response; show first non-zero
    // value (it'll be the requester's, since the route already verified ACL).
    const v = Object.values(userStars).find((n) => Number(n) > 0);
    return Math.max(0, Math.min(5, Math.floor(Number(v ?? 0))));
  })();

  return (
    <div style={{ padding: 'var(--s-6, 24px) var(--s-8, 32px)', maxWidth: 920 }}>
      <Link to="/contacts" style={{ color: 'var(--accent, #4fa9ff)', textDecoration: 'none', fontSize: 13 }}>
        ← Back to contacts
      </Link>

      <header style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl, 24px)' }}>{entity.title}</h1>
          <p style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 13, margin: '4px 0 0' }}>
            {meta.email ?? meta.phone ?? id}
            {meta.scope === 'tenant' && (
              <span style={{ marginLeft: 10, padding: '1px 8px', borderRadius: 999, background: 'rgba(79,169,255,0.15)', color: '#4fa9ff', fontSize: 11 }}>
                Tenant-shared
              </span>
            )}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <DetailStars value={stars} onChange={onSetStars} />
          <button onClick={onRefresh} disabled={refreshing} style={{
            background: refreshing ? 'var(--panel-2, #1b232d)' : 'var(--accent, #4fa9ff)',
            color: refreshing ? 'var(--text-muted, #98a0a8)' : '#0e1116',
            border: 0, borderRadius: 6, padding: '8px 14px', fontSize: 13,
            cursor: refreshing ? 'not-allowed' : 'pointer', fontWeight: 500,
          }}>
            {refreshing ? 'Refreshing…' : 'Refresh from feed'}
          </button>
        </div>
      </header>

      {/* Markdown body — Brain reads exactly this */}
      <article style={{
        marginTop: 24, padding: '20px 24px',
        background: 'var(--panel, #141a22)', border: '1px solid var(--border, #28323e)',
        borderRadius: 10, lineHeight: 1.6, fontSize: 14,
        whiteSpace: 'pre-wrap',
      }}>
        {entity.bodyMarkdown || '(No body — auto-enrich pending)'}
      </article>

      <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted, #98a0a8)' }}>
        Last updated by <strong>{entity.lastUpdatedBy ?? '—'}</strong> at {new Date(entity.lastUpdatedAt).toLocaleString()}
        {meta.last_enriched_at && (
          <> · Last enriched {new Date(meta.last_enriched_at).toLocaleString()}</>
        )}
      </div>

      <DetailToastStack toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function DetailToastStack({ toasts, onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 24, right: 24, zIndex: 90,
      display: 'flex', flexDirection: 'column', gap: 8,
      maxWidth: 'min(420px, calc(100vw - 48px))',
    }}>
      {toasts.map((t) => {
        const palette = {
          ok:    { bg: 'rgba(76,175,80,0.18)',  border: '#4caf50', fg: '#9bd9a0' },
          warn:  { bg: 'rgba(240,161,74,0.18)', border: '#f0a14a', fg: '#f4c594' },
          error: { bg: 'rgba(217,83,79,0.20)',  border: '#d9534f', fg: '#f0a3a0' },
        }[t.kind] ?? { bg: 'rgba(79,169,255,0.16)', border: '#4fa9ff', fg: '#a8d0fc' };
        return (
          <button
            key={t.id}
            onClick={() => onDismiss(t.id)}
            style={{
              background: palette.bg,
              border: `1px solid ${palette.border}`,
              color: palette.fg,
              padding: '10px 14px', borderRadius: 8,
              fontSize: 13, lineHeight: 1.4,
              textAlign: 'left', cursor: 'pointer',
              boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
            }}
            aria-live="polite"
          >
            {t.text}
          </button>
        );
      })}
    </div>
  );
}

function DetailStars({ value, onChange }) {
  const [hover, setHover] = useState(0);
  const display = hover || value;
  return (
    <div onMouseLeave={() => setHover(0)} style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
      <span style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 12, marginRight: 6 }}>Importance</span>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= display;
        return (
          <button
            key={n}
            onMouseEnter={() => setHover(n)}
            onClick={() => onChange(n === value ? 0 : n)}
            style={{
              background: 'transparent', border: 0, padding: 2, cursor: 'pointer',
              fontSize: 22, lineHeight: 1,
              color: filled ? '#f0a14a' : 'var(--border, #3a4452)',
              transition: 'transform 80ms',
              transform: hover === n ? 'scale(1.2)' : 'scale(1)',
            }}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
          >
            {filled ? '★' : '☆'}
          </button>
        );
      })}
      <span style={{ color: 'var(--text-muted, #98a0a8)', fontSize: 12, marginLeft: 6 }}>
        {value > 0 ? `${value}/5` : 'Unrated'}
      </span>
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{ padding: 64, textAlign: 'center', color: 'var(--text-muted, #98a0a8)' }}>{children}</div>
  );
}
