/**
 * HealthCheckTab v4 — audience-aware.
 *
 * v3 made the page readable, but it still showed every operator-tracked
 * component to every user. The MD doesn't have terminal access to
 * `restart tmcai-agents` or sweep the wiki linter manually — surfacing
 * "Background workers are not running → Check pm2 logs" as a top-level
 * issue is noise.
 *
 * v4 splits the audience:
 *   - End user (default view)     → only USER-ACTIONABLE issues. Today
 *                                    that's just OAuth token expiry +
 *                                    connector-level errors. Operator
 *                                    items are summarised into one line:
 *                                    "Background systems: N tracked items.
 *                                    Engineers will handle these."
 *   - Admin (toggle / default isAdmin) → full diagnostics view from v3.
 *
 * The toggle is reachable for everyone in case the user wants to peek;
 * default depends on isAdmin.
 *
 * Each component is also now classified by audience in the translator
 * itself (`audience: 'user' | 'admin'`) so future additions self-route.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';
import { Button, Card, Pill, Dot } from '../ui';
import { Icon } from '../ui/Icon';

// ─── Component translator ────────────────────────────────────────────
// Maps each component name + detail string into:
//   headline — short user-facing line ("590 events stuck retrying")
//   meaning  — what this means for the user, in plain English
//   action   — concrete next step, or null when nothing to do
//
// The translator runs ONCE per render against the live API payload. It
// degrades gracefully to the raw detail when a name isn't recognized —
// new components get added here as they're introduced.
// Audience tag: 'user' = surface to end user; 'admin' = operator-only.
// User-facing items are issues YOU can act on (reconnect a connector,
// pick up a notification, etc.). Admin items require host access (pm2,
// SSH, DB), background self-heal jobs, or are pure telemetry.
function translateComponent(c) {
  const detail = c.detail ?? '';
  const status = c.status;
  const fallback = { headline: c.name, meaning: detail || `Status: ${status}`, action: null, audience: 'admin' };

  const num = (re) => {
    const m = detail.match(re);
    return m ? Number(m[1]) : null;
  };

  switch (c.name) {
    case 'postgres':
      return status === 'up'
        ? { headline: 'Database is responsive', meaning: 'Brain can read and write — your wiki, queue, and learnings are all reachable.', action: null, audience: 'admin' }
        : { headline: 'Brain is offline', meaning: 'The database is unreachable. Chat, Day Brief, and Open Items will all fail until engineers restore it.', action: 'Engineers have been alerted.', audience: 'user' };

    case 'redis':
      return status === 'up'
        ? { headline: 'Cache is responsive', meaning: 'Composer envelope cache + dedup gates are working.', action: null, audience: 'admin' }
        : { headline: 'Brain is slower than usual', meaning: 'The cache layer is down so every chat answer hits the database fresh. Brain still works — just slightly delayed.', action: 'Engineers have been alerted; nothing for you to do.', audience: 'user' };

    case 'kill_switch':
      return { headline: 'Kill switch is released', meaning: 'Brain is allowed to take actions on your behalf.', action: null, audience: 'admin' };

    case 'feed_adapters': {
      const n = num(/(\d+)/);
      return { headline: `${n ?? '?'} feed adapters registered`, meaning: 'Brain knows how to ingest gmail, calendar, WhatsApp, and other connectors.', action: null, audience: 'admin' };
    }

    case 'pubsub':
      return { headline: 'Event bus is configured', meaning: 'Inbox, calendar, and WhatsApp events flow through the background pipeline.', action: null, audience: 'admin' };

    case 'agent_worker':
      return status === 'up'
        ? { headline: 'Background workers are running', meaning: 'Producer sweep, followup nudges, expiry, and delegatee emails fire on schedule.', action: null, audience: 'admin' }
        : { headline: 'Brain may stop asking you questions', meaning: 'A background process that drives proactive prompts is down. You can still use Brain Chat normally — but follow-up nudges and "by when?" prompts are paused.', action: 'Engineers have been alerted; no terminal access needed on your end.', audience: 'user' };

    case 'gemini':
      return { headline: 'LLM provider configured', meaning: 'Gemini API key is present — Brain can plan retrieval, compose answers, and diagnose feedback.', action: null, audience: 'admin' };

    case 'handler_registry': {
      const n = num(/(\d+)/);
      return { headline: `${n ?? '?'} action handlers ready`, meaning: 'Every action Brain can take (delegate, send email, schedule, etc.) is wired up.', action: null, audience: 'admin' };
    }

    case 'wiki': {
      const total = num(/(\d+) pages/) ?? 0;
      const orphans = num(/(\d+) orphan/) ?? 0;
      const contradicted = num(/(\d+) contradict/) ?? 0;
      const stale = num(/(\d+) stale/) ?? 0;
      const orphanRatio = total > 0 ? orphans / total : 0;
      if (orphans > 50 && orphanRatio > 0.5) {
        return {
          headline: `${orphans} of ${total} wiki pages are orphans`,
          meaning: 'These pages exist but nothing links to them. Brain may miss them when answering related questions, so context can be incomplete.',
          action: 'The wiki linter cron reclassifies orphans hourly — they\'ll resolve over time. To force a sweep, click Refresh.',
          audience: 'admin',
        };
      }
      if (contradicted > 0) {
        return {
          headline: `${contradicted} contradicted wiki pages`,
          meaning: 'Two or more pages disagree about the same fact. Brain will flag the conflict in answers it gives you.',
          action: 'Open the Wiki and review the contradicted pages — pick which version is correct.',
          audience: 'user',
        };
      }
      if (stale > 0) {
        return {
          headline: `${stale} stale wiki pages`,
          meaning: 'Old pages no one has updated. Brain may use them but flags the staleness when citing.',
          action: 'No action — Brain handles staleness automatically.',
          audience: 'admin',
        };
      }
      return { headline: 'Wiki is healthy', meaning: `${total} active pages.`, action: null, audience: 'admin' };
    }

    case 'dlq_depth': {
      const n = num(/(\d+)/) ?? 0;
      if (n > 100) {
        return {
          headline: 'New emails / calendar events are stuck',
          meaning: `${n} events are queued and not being processed. Almost always caused by an expired Google OAuth token — Brain can't read your inbox until you reconnect.`,
          action: 'Open Connectors → click Reconnect on the affected user. Once the token is valid, the queue drains on its own.',
          audience: 'user',
        };
      }
      if (n > 0) {
        return {
          headline: `${n} events in retry queue`,
          meaning: 'A handful of events are being retried — usually transient API hiccups.',
          action: 'No action needed — Brain will retry until they succeed or move to permanent failure.',
          audience: 'admin',
        };
      }
      return { headline: 'No retry backlog', meaning: 'All ingest events are flowing through cleanly.', action: null, audience: 'admin' };
    }

    case 'notification_queue': {
      const n = num(/(\d+)/) ?? 0;
      return n > 0
        ? { headline: `${n} notifications queued`, meaning: 'Outbound notifications waiting to send.', action: null, audience: 'admin' }
        : { headline: 'Notification queue clear', meaning: 'No outbound messages waiting.', action: null, audience: 'admin' };
    }

    case 'scheduler': {
      const n = num(/(\d+)/) ?? 0;
      return { headline: `Scheduler: ${n} active tasks`, meaning: 'Cron-driven tasks running right now.', action: null, audience: 'admin' };
    }

    case 'token_refresh': {
      const n = num(/(\d+) user token/) ?? 0;
      const m = detail.match(/within (\w+)/);
      const window = m ? m[1] : 'soon';
      if (n > 0) {
        return {
          headline: `${n} of your connector${n === 1 ? '' : 's'} will lose access within ${window}`,
          meaning: 'When a connector token expires, Brain stops receiving new emails / calendar events from it until you reconnect. Google Testing-mode apps expire every 7 days.',
          action: 'Open Connectors → click Reconnect on the affected user before the timer runs out.',
          audience: 'user',
        };
      }
      return { headline: 'All your connectors are healthy', meaning: 'Every authorised connector has time before its token expires.', action: null, audience: 'user' };
    }

    case 'cache_hit_rate': {
      const m = detail.match(/([\d.]+)%/);
      const rate = m ? parseFloat(m[1]) : 0;
      if (rate < 50 && status !== 'up') {
        return {
          headline: `Cache warming up — ${rate.toFixed(0)}% hit rate`,
          meaning: 'Composer envelope cache is still being filled. Brain\'s answers may feel slightly slower for the next 5–10 minutes.',
          action: 'No action — resolves on its own.',
          audience: 'admin',
        };
      }
      return { headline: `Cache hit rate ${rate.toFixed(0)}%`, meaning: 'How often Brain reuses a cached envelope block (persona, capabilities, tenant log) instead of re-fetching.', action: null, audience: 'admin' };
    }

    default:
      return fallback;
  }
}

// ─── KPI translator ─────────────────────────────────────────────────
function kpiLabel(metricType) {
  const map = {
    match_rate_high:        'High-confidence matches',
    match_rate_medium:      'Medium-confidence matches',
    match_rate_low:         'Low-confidence matches',
    actions_failed:         'Actions failed',
    decisions_overridden:   'Decisions overridden',
    decisions_total:        'Decisions total',
    decisions_approved:     'Decisions approved',
    feed_events_ingested:   'Feed events ingested',
    open_items_new:         'New open items',
  };
  return map[metricType] ?? metricType.replace(/_/g, ' ');
}

// ─── Hero status ────────────────────────────────────────────────────
// In user view we count only USER-ACTIONABLE issues for the headline.
// Admin-only items appear as a quiet summary line ("Engineers tracking N
// background items") but don't drive the red/yellow/green pill.
function heroStatus(deep, userIssues, userWarnings, showFull) {
  if (!deep) return { label: 'Loading…', tone: 'neutral', summary: '' };
  if (showFull) {
    const { up, degraded, down, total } = deep.counts;
    if (down > 0) {
      return {
        label: `Brain has ${down} issue${down === 1 ? '' : 's'} to look at`,
        tone: 'danger',
        summary: `${up} healthy · ${degraded} warning${degraded === 1 ? '' : 's'} · ${down} issue${down === 1 ? '' : 's'}`,
      };
    }
    if (degraded > 0) {
      return {
        label: `Brain is mostly healthy — ${degraded} warning${degraded === 1 ? '' : 's'}`,
        tone: 'warning',
        summary: `${up} of ${total} components healthy`,
      };
    }
    return { label: 'Brain is running smoothly', tone: 'success', summary: `All ${total} components healthy` };
  }
  // User view: only user-actionable items drive severity.
  const userDown = userIssues.length;
  const userDeg = userWarnings.length;
  if (userDown > 0) {
    return {
      label: `${userDown} thing${userDown === 1 ? '' : 's'} need${userDown === 1 ? 's' : ''} your attention`,
      tone: 'danger',
      summary: 'Items below are yours to handle.',
    };
  }
  if (userDeg > 0) {
    return {
      label: `${userDeg} small thing${userDeg === 1 ? '' : 's'} to look at`,
      tone: 'warning',
      summary: 'Quick fixes — should take a minute each.',
    };
  }
  return { label: 'Brain is working smoothly for you', tone: 'success', summary: 'Nothing for you to do right now.' };
}

export default function HealthCheckTab() {
  const { user } = useAuth();
  const [deep, setDeep] = useState(null);
  const [dashboard, setDashboard] = useState([]);
  const [killSwitch, setKillSwitch] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showHealthy, setShowHealthy] = useState(false);
  // Default to user view for non-admins; admin view for admins. Either
  // can flip via the toggle below the hero.
  const [showFull, setShowFull] = useState(!!user?.isAdmin);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/health/deep');
      setDeep(data);
    } catch {
      setDeep({ overall: 'down', counts: { total: 0, up: 0, degraded: 0, down: 0 }, components: [] });
    }
    try { const { data } = await api.get('/steering/dashboard'); setDashboard(data.rows ?? []); } catch { setDashboard([]); }
    try { const { data } = await api.get('/safety/kill-switch/status'); setKillSwitch(data); } catch { setKillSwitch(null); }
    setLoading(false);
  };
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);

  const allComponents = (deep?.components ?? []).map((c) => ({ ...c, t: translateComponent(c) }));
  // In user view, hide admin-only components entirely. In full/admin
  // view, show everything.
  const components = showFull
    ? allComponents
    : allComponents.filter((c) => c.t.audience !== 'admin' || c.status !== 'up');
  // ↑ user view also retains DOWN/DEGRADED admin-only components but
  //   bundles them into the "Background systems" line below — they don't
  //   appear as actionable cards. Filter is therefore: keep
  //   user-audience always; admin-audience only kept here so the hero
  //   counter still reflects them.
  const userActionable = allComponents.filter((c) =>
    c.t.audience === 'user' && (c.status === 'down' || c.status === 'degraded')
  );
  const adminOnlyTracked = allComponents.filter((c) =>
    c.t.audience === 'admin' && (c.status === 'down' || c.status === 'degraded')
  );

  const issues   = (showFull ? components : userActionable).filter((c) => c.status === 'down');
  const warnings = (showFull ? components : userActionable).filter((c) => c.status === 'degraded');
  const healthy  = allComponents.filter((c) => c.status === 'up');
  const userViewIssues   = userActionable.filter((c) => c.status === 'down');
  const userViewWarnings = userActionable.filter((c) => c.status === 'degraded');
  const hero = heroStatus(deep, userViewIssues, userViewWarnings, showFull);

  const heroPill = ({ tone }) => {
    if (tone === 'success') return <Pill variant="success">All clear</Pill>;
    if (tone === 'warning') return <Pill variant="warning">Has warnings</Pill>;
    if (tone === 'danger')  return <Pill variant="danger">Has issues</Pill>;
    return <Pill>…</Pill>;
  };

  const dashboardActive = dashboard.some((r) => Number(r.current ?? 0) !== 0);

  return (
    <div style={{ padding: 'var(--s-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--s-4)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>Health Check</h1>
        <Button variant="secondary" size="sm" onClick={load}>
          <Icon name="refresh" size={14} /> Refresh
        </Button>
      </div>

      {/* hero — plain-English status */}
      <Card style={{ marginBottom: 'var(--s-5)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--s-4)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
              <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-semibold)' }}>{hero.label}</div>
              {heroPill(hero)}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 6 }}>
              {hero.summary}
              {deep && <> · last check {loading ? 'now' : '14s ago'}</>}
            </div>
            {/* Admin-tracked summary in user view: tells user that
                engineers are tracking N background items, but they
                aren't yours to fix. Reassures rather than alarms. */}
            {!showFull && adminOnlyTracked.length > 0 && (
              <div style={{
                marginTop: 'var(--s-3)', padding: '8px 12px',
                background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border)',
                borderRadius: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)',
                maxWidth: 480, lineHeight: 1.45,
              }}>
                <span style={{ marginRight: 6 }}>⚙</span>
                Engineers are tracking {adminOnlyTracked.length} background item{adminOnlyTracked.length === 1 ? '' : 's'} on the system itself
                {' '}(workers, queues, cache). Nothing for you to do — those resolve themselves or get handled by the engineering team.
              </div>
            )}
            {/* View toggle — anyone can flip; default is user-view for
                non-admins, admin-view for admins. */}
            <div style={{ marginTop: 'var(--s-3)', display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setShowFull(false)}
                style={tabBtn(!showFull)}
              >For me</button>
              <button
                type="button"
                onClick={() => setShowFull(true)}
                style={tabBtn(showFull)}
              >Full diagnostics</button>
            </div>
          </div>
          {killSwitch && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Kill switch</div>
              <div style={{ fontWeight: 'var(--fw-semibold)', marginTop: 4 }}>
                <Dot status={killSwitch.active ? 'down' : 'up'} /> {killSwitch.active ? 'ENGAGED' : 'Released'}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4, maxWidth: 220 }}>
                {killSwitch.active
                  ? (killSwitch.reason ?? 'Brain is paused from acting on your behalf.')
                  : 'Brain is allowed to act on your behalf.'}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Issues */}
      {issues.length > 0 && (
        <>
          <h2 style={{ margin: '0 0 var(--s-3)', fontSize: 'var(--fs-lg)', color: 'var(--danger)' }}>
            Issues to look at
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)', marginBottom: 'var(--s-5)' }}>
            {issues.map((c) => (
              <Card key={c.name} style={{ borderColor: 'rgba(239,68,68,0.4)' }}>
                <DiagnosticBlock c={c} tone="danger" />
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <>
          <h2 style={{ margin: '0 0 var(--s-3)', fontSize: 'var(--fs-lg)', color: 'var(--warning, #f59e0b)' }}>
            Warnings
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)', marginBottom: 'var(--s-5)' }}>
            {warnings.map((c) => (
              <Card key={c.name} style={{ borderColor: 'rgba(245,158,11,0.4)' }}>
                <DiagnosticBlock c={c} tone="warning" />
              </Card>
            ))}
          </div>
        </>
      )}

      {/* Healthy — collapsed by default */}
      {healthy.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowHealthy((v) => !v)}
            style={{
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
              color: 'var(--text-muted)', fontSize: 'var(--fs-sm)',
              display: 'flex', alignItems: 'center', gap: 6,
              marginBottom: showHealthy ? 'var(--s-3)' : 'var(--s-2)',
            }}
          >
            <Dot status="up" />
            {healthy.length} component{healthy.length === 1 ? '' : 's'} healthy
            <span style={{ marginLeft: 6 }}>{showHealthy ? '▾' : '▸'}</span>
          </button>
          {showHealthy && (
            <div className="ui-grid-auto" style={{ marginBottom: 'var(--s-5)' }}>
              {healthy.map((c) => (
                <Card key={c.name} size="sm">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--s-2)' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', fontWeight: 'var(--fw-medium)' }}>
                        <Dot status="up" />
                        {c.t.headline}
                      </div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', marginTop: 4 }}>
                        {c.t.meaning}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* KPIs */}
      <h2 style={{ margin: 'var(--s-6) 0 var(--s-3)', fontSize: 'var(--fs-lg)' }}>Today's activity</h2>
      <Card>
        {!dashboardActive ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-1) 0' }}>
            No activity processed yet today. Brain is watching for the first event — counters will populate as emails / calendar / WhatsApp arrive.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
            {dashboard.map((r) => (
              <div key={r.metricType} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-sm)', padding: 'var(--s-1) 0' }}>
                <span style={{ color: 'var(--text-muted)' }}>{kpiLabel(r.metricType)}</span>
                <span>
                  <strong>{r.current?.toFixed?.(2) ?? r.current}</strong>
                  {r.deltaPct !== null && r.deltaPct !== undefined && (
                    <span style={{ marginLeft: 'var(--s-2)', color: r.deltaPct >= 0 ? 'var(--success)' : 'var(--danger)', fontSize: 'var(--fs-xs)' }}>
                      {r.deltaPct >= 0 ? '+' : ''}{r.deltaPct.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Reusable diagnostic block ─────────────────────────────────────
// Renders one issue or warning with: dot + headline / meaning / action /
// raw technical detail (small, dim).
function DiagnosticBlock({ c, tone }) {
  const dotStatus = tone === 'danger' ? 'down' : tone === 'warning' ? 'degraded' : 'up';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-base)' }}>
        <Dot status={dotStatus} />
        {c.t.headline}
      </div>
      <div style={{ color: 'var(--text)', fontSize: 'var(--fs-sm)', lineHeight: 1.4 }}>
        <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>What this means:</span>
        {c.t.meaning}
      </div>
      {c.t.action && (
        <div style={{ color: 'var(--text)', fontSize: 'var(--fs-sm)', lineHeight: 1.4 }}>
          <span style={{ color: 'var(--text-muted)', marginRight: 6 }}>What to do:</span>
          {c.t.action}
        </div>
      )}
      <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-xs)', marginTop: 4 }}>
        <span style={{ fontFamily: 'monospace' }}>{c.name}</span> · {c.detail || c.status}
      </div>
    </div>
  );
}

// Pill-style toggle for For-me / Full-diagnostics view selector.
function tabBtn(active) {
  return {
    padding: '4px 12px',
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--accent, #cc6b4a)' : 'var(--border)'}`,
    background: active ? 'rgba(204,107,74,0.15)' : 'transparent',
    color: active ? 'var(--accent, #cc6b4a)' : 'var(--text-muted)',
    fontSize: 'var(--fs-xs)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 160ms ease',
  };
}
