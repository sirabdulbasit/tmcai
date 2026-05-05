/**
 * DayBriefPage v4 — Brain's home screen.
 *
 * Brain is both Advisor/Secretary (inside the decision loop) and Knowledge
 * Center (ad-hoc Q&A). The Day Brief is where both surfaces converge:
 *
 *   Volume strip       — live channel counters
 *   Brief              — what Brain handled alone (autonomous actions)
 *   My Attention       — where Brain asks you to decide (grouped by channel)
 *   Open Items         — active work tracker with Brain suggestions
 *   Noticed / Rules    — patterns Brain wants to promote into rules
 *   Ask Brain          — natural-language query bar (Knowledge Center entry)
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import { Button, Card, Pill, Empty } from '../components/ui';
import { Icon } from '../components/ui/Icon';
import DelegateePicker from '../components/DelegateePicker';
import FeedbackButtons from '../components/FeedbackButtons';

// ─── Toast system ────────────────────────────────────────────
// Non-blocking page-level notifications. Cards call onNotify(message, kind)
// and the message slides into the bottom-right corner, auto-dismissing after
// ~4 seconds. kind='success'|'error'|'info' drives color.
function useToasts() {
  const [toasts, setToasts] = useState([]);
  const counterRef = useRef(0);
  const notify = useCallback((message, kind = 'info') => {
    const id = ++counterRef.current;
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 4200);
  }, []);
  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);
  return { toasts, notify, dismiss };
}

function ToastStack({ toasts, onDismiss }) {
  if (toasts.length === 0) return null;
  return (
    <div
      style={{
        position: 'fixed', bottom: 'var(--s-6)', right: 'var(--s-6)',
        zIndex: 'var(--z-toast, 500)', display: 'flex',
        flexDirection: 'column', gap: 'var(--s-2)', pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            pointerEvents: 'auto',
            minWidth: 260, maxWidth: 420,
            padding: '10px 14px',
            borderRadius: 'var(--r-md)',
            background:
              t.kind === 'success' ? 'var(--success-dim, rgba(74,222,128,0.16))' :
              t.kind === 'error'   ? 'var(--danger-dim, rgba(239,68,68,0.16))' :
              'var(--bg-2)',
            border: '1px solid ' + (
              t.kind === 'success' ? 'var(--success, #4ade80)' :
              t.kind === 'error'   ? 'var(--danger, #ef4444)' :
              'var(--border)'
            ),
            color: 'var(--text)',
            fontSize: 'var(--fs-sm)',
            boxShadow: 'var(--shadow-lg)',
            animation: 'myos-toast-slide-in 0.24s ease-out',
            display: 'flex', alignItems: 'flex-start', gap: 'var(--s-2)',
          }}
        >
          <div style={{ flex: 1, lineHeight: 1.4 }}>{t.message}</div>
          <button
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
            style={{ background: 'transparent', border: 0, color: 'var(--text-dim)', cursor: 'pointer', padding: 0 }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <style>{`@keyframes myos-toast-slide-in { from { transform: translateX(20px); opacity: 0 } to { transform: translateX(0); opacity: 1 } }`}</style>
    </div>
  );
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const mins = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
/**
 * Format a meeting start time as a forward-looking pointer: "in 3d",
 * "tomorrow 14:00", "Fri 4 May 16:00". Used on attention cards instead
 * of timeAgo() so a calendar invite for a meeting two weeks away doesn't
 * read as "1h ago" (i.e. ingestion time).
 */
function meetingWhen(startStr) {
  if (!startStr) return '';
  const start = new Date(startStr);
  if (Number.isNaN(start.getTime())) return '';
  const diffMs = start.getTime() - Date.now();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
  const hh = String(start.getHours()).padStart(2, '0');
  const mm = String(start.getMinutes()).padStart(2, '0');
  if (diffMs < 0) {
    const dAgo = Math.abs(diffDays);
    return dAgo === 0 ? `today ${hh}:${mm}` : `${dAgo}d ago`;
  }
  if (diffDays === 0) return `today ${hh}:${mm}`;
  if (diffDays === 1) return `tomorrow ${hh}:${mm}`;
  if (diffDays < 7) return `in ${diffDays}d · ${hh}:${mm}`;
  const dayName = start.toLocaleDateString(undefined, { weekday: 'short' });
  const monthDay = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${dayName} ${monthDay} · ${hh}:${mm}`;
}
function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
function actionLabel(a) {
  return ({
    draft_reply: 'Draft reply',
    delegate: 'Delegate',
    add_open_item: 'Add to Open Items',
    ignore: 'Ignore',
    schedule_meeting: 'Schedule meeting',
    acknowledge: 'Acknowledge',
  })[a] ?? a;
}
function channelIcon(itemType) {
  return ({ email: 'mail', whatsapp: 'message-circle', task: 'check-square', meeting: 'calendar' })[itemType] ?? 'inbox';
}

/** Channel colour for the little source-logo badge on each attention card. */
function channelColor(itemType) {
  return ({
    email: { bg: 'rgba(234, 67, 53, 0.15)', fg: '#ea4335' },        // Gmail red
    whatsapp: { bg: 'rgba(37, 211, 102, 0.15)', fg: '#25d366' },    // WhatsApp green
    meeting: { bg: 'rgba(66, 133, 244, 0.15)', fg: '#4285f4' },     // Calendar blue
    task: { bg: 'rgba(251, 188, 4, 0.15)', fg: '#fbbc04' },         // Tasks amber
  })[itemType] ?? { bg: 'rgba(136, 136, 136, 0.15)', fg: '#888' };
}

function channelLabel(itemType) {
  return ({ email: 'Gmail', whatsapp: 'WhatsApp', meeting: 'Calendar', task: 'Tasks' })[itemType] ?? 'Feed';
}

/** Human date/time for a meeting card: "Fri 24 Apr · 3:00–4:00 PM" or
 *  "Thu 24 – Fri 25 Apr · All day". Returns empty string on bad input. */
function formatMeetingTime(meeting) {
  if (!meeting) return '';
  const { start, end, isAllDay } = meeting;
  if (!start) return '';
  const s = new Date(start);
  const e = end ? new Date(end) : null;
  const dateOpts = { weekday: 'short', day: 'numeric', month: 'short' };
  const timeOpts = { hour: 'numeric', minute: '2-digit' };
  const sDate = s.toLocaleDateString('en-GB', dateOpts);
  const eDate = e ? e.toLocaleDateString('en-GB', dateOpts) : null;
  if (isAllDay) {
    if (!eDate || sDate === eDate) return `${sDate} · all day`;
    return `${sDate} → ${eDate} · all day`;
  }
  const sTime = s.toLocaleTimeString('en-US', timeOpts);
  const eTime = e ? e.toLocaleTimeString('en-US', timeOpts) : '';
  if (!e || sDate === eDate) return `${sDate} · ${sTime}${eTime ? ` – ${eTime}` : ''}`;
  return `${sDate} ${sTime} → ${eDate} ${eTime}`;
}

function formatTimeRange(startISO, endISO) {
  try {
    const s = new Date(startISO);
    const e = new Date(endISO);
    const sT = s.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const eT = e.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const sDate = s.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    return `${sDate} ${sT}–${eT}`;
  } catch { return ''; }
}

/**
 * Brain-voice onboarding banner. Renders only when the user is missing
 * standard-feed connectors. Speaks as Brain ("I can't see your email yet")
 * so a new MD feels guided, not lost.
 */
function ConnectorGapBanner({ gaps, onConnect }) {
  if (!gaps || !gaps.gaps || gaps.gaps.length === 0) return null;
  const required = gaps.gaps.filter((g) => g.required);
  const optional = gaps.gaps.filter((g) => !g.required);
  const title = !gaps.hasAnyFeed
    ? "Let's get you set up."
    : `I'm missing ${required.length} feed${required.length === 1 ? '' : 's'}.`;
  const sub = !gaps.hasAnyFeed
    ? "I can't see your inbox, calendar or messages yet. Connect the feeds below and I'll start working."
    : 'Connect these so I can give you a full picture.';
  return (
    <div
      style={{
        background: 'linear-gradient(90deg, rgba(204,107,74,0.12), rgba(204,107,74,0.04))',
        border: '1px solid rgba(204,107,74,0.35)',
        borderRadius: 12,
        padding: 'var(--s-4)',
        marginBottom: 'var(--s-5)',
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'flex-start' }}>
        <div style={{ fontSize: 22, lineHeight: 1 }}>🧠</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 600, color: 'var(--text)' }}>{title}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 2 }}>{sub}</div>

          {required.length > 0 && (
            <div style={{ marginTop: 'var(--s-3)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              {required.map((g) => (
                <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s-3)', padding: 'var(--s-2) var(--s-3)', background: 'rgba(255,255,255,0.03)', borderRadius: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{g.label}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', marginTop: 2 }}>{g.why}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', marginTop: 4 }}>
                      Options: {g.options.map((o) => o.name).join(' · ')}
                    </div>
                  </div>
                  <Button variant="primary" size="sm" onClick={() => onConnect(g.options[0]?.slug)}>
                    Connect
                  </Button>
                </div>
              ))}
            </div>
          )}

          {optional.length > 0 && (
            <details style={{ marginTop: 'var(--s-3)' }}>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                Optional ({optional.length}) — {optional.map((g) => g.label).join(', ')}
              </summary>
              <div style={{ marginTop: 'var(--s-2)', display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
                {optional.map((g) => (
                  <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s-3)', padding: 'var(--s-2) var(--s-3)', background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)' }}>{g.label}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', marginTop: 2 }}>{g.why}</div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => onConnect(g.options[0]?.slug)}>
                      Connect
                    </Button>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DayBriefPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [volume, setVolume] = useState(null);
  const [attention, setAttention] = useState([]);
  const [brainActions, setBrainActions] = useState([]);
  const [openItems, setOpenItems] = useState([]);
  const [promotions, setPromotions] = useState([]);
  const [patterns, setPatterns] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [gaps, setGaps] = useState(null); // { gaps: [...], hasAnyFeed: bool }
  const [radar, setRadar] = useState(null); // { flags, summary, generatedAt, …}
  const [radarRunning, setRadarRunning] = useState(false);
  // Brain Cognitive Engine output — mind state + surfaced observations.
  const [cognitive, setCognitive] = useState({ mindState: null, observations: [] });
  // Standing instructions — the 6th layer. Rules Brain must respect.
  // Two scopes: 'client' (tenant-wide, admin-only) and 'user' (personal).
  const [instructions, setInstructions] = useState([]);
  const [isInstructionAdmin, setIsInstructionAdmin] = useState(false);
  // "What Brain learned this week" rollup — feedback summary + criticality
  // calibration state + Brain's own self-recommendations.
  const [learned, setLearned] = useState(null);
  const [loading, setLoading] = useState(true);
  const { toasts, notify, dismiss } = useToasts();

  // Shared loader. `fullSync` triggers a Gmail+Calendar pull first so very
  // recently arrived emails land in feed before we paint the Brief.
  // While loading, fire brain:thinking:start/end so the top-right avatar
  // expands into its "thinking" pill — the user sees Brain working from
  // a single focal point, not a separate banner.
  const load = useCallback(async (fullSync = false) => {
    setLoading(true);
    window.dispatchEvent(new CustomEvent('brain:thinking:start'));
    try {
      if (fullSync) {
        try { await api.post('/brief/sync-now'); } catch { /* non-fatal */ }
      }
      const [brief, atten, brain, ds, ins, gap, cog, instr, learned, radarLatest] = await Promise.all([
        api.post('/steering/brief', { userId: user?.id, style: 'morning' }).then((r) => r.data.brief ?? r.data).catch(() => null),
        api.get('/brief/attention?limit=50').then((r) => r.data.items ?? []).catch(() => []),
        api.get('/brief/brain-actions').then((r) => r.data.actions ?? []).catch(() => []),
        api.get('/brief/drafts').then((r) => r.data.drafts ?? []).catch(() => []),
        api.get('/brief/insights').then((r) => r.data.insights ?? []).catch(() => []),
        api.get('/brief/connector-gaps').then((r) => r.data).catch(() => null),
        api.get('/brief/cognitive').then((r) => r.data ?? { mindState: null, observations: [] }).catch(() => ({ mindState: null, observations: [] })),
        api.get('/brain/instructions').then((r) => ({ list: r.data.instructions ?? [], isAdmin: !!r.data.isAdmin })).catch(() => ({ list: [], isAdmin: false })),
        api.get('/brain/learned').then((r) => r.data ?? null).catch(() => null),
        api.get('/risk-radar/latest').then((r) => r.data?.doc ?? null).catch(() => null),
      ]);
      setVolume(brief?.volume ?? null);
      setOpenItems(brief?.topOpenItems ?? []);
      setPromotions(brief?.rulePromotions ?? []);
      setPatterns(ins.length > 0 ? ins : (brief?.patterns ?? []));
      setAttention(atten);
      setBrainActions(brain);
      setDrafts(ds);
      setGaps(gap);
      setCognitive(cog);
      setInstructions(instr.list);
      setIsInstructionAdmin(instr.isAdmin);
      setLearned(learned);
      setRadar(radarLatest);
    } finally {
      setLoading(false);
      window.dispatchEvent(new CustomEvent('brain:thinking:end'));
    }
  }, [user?.id]);

  useEffect(() => { if (user?.id) load(); }, [user?.id, load]);

  const displayName = (user?.name && user.name.trim()) || 'there';
  const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  // Flat, date-sorted attention list. Order:
  //   1. Critical items (known high-value entities) — always on top
  //   2. Regular items — newest first
  //   3. Noise (bulk/newsletter/auto) — bottom, collapsed by default
  const { critical: attentionCritical, regular: attentionRegular, noise: attentionNoise } = useMemo(() => {
    const byTime = [...attention].sort((a, b) =>
      new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
    );
    return {
      critical: byTime.filter((x) => x.critical && !x.noise),
      regular: byTime.filter((x) => !x.critical && !x.noise),
      noise: byTime.filter((x) => x.noise),
    };
  }, [attention]);

  // Drafts keyed by feedEventId — lets each AttentionCard render its own
  // pending drafts inline below. Orphan drafts (no matching attention card,
  // e.g. the original event was auto-dismissed but the draft is still waiting)
  // fall back to a small "Other drafts" section below.
  const { draftsByFeedEventId, orphanDrafts } = useMemo(() => {
    const byEvent = new Map();
    const attentionIds = new Set(attention.map((a) => a.feedEventId));
    const orphans = [];
    for (const d of drafts) {
      if (d.feedEventId && attentionIds.has(d.feedEventId)) {
        if (!byEvent.has(d.feedEventId)) byEvent.set(d.feedEventId, []);
        byEvent.get(d.feedEventId).push(d);
      } else {
        orphans.push(d);
      }
    }
    return { draftsByFeedEventId: byEvent, orphanDrafts: orphans };
  }, [drafts, attention]);

  const emailsUnread = volume?.emailsHandled ?? 0;
  const emailsRecv = volume?.emailsReceivedToday ?? 0;
  const tasksOpen = volume?.tasksOpen ?? 0;
  const tasksDue = volume?.tasksDueToday ?? 0;
  const meetings = volume?.meetingsToday ?? 0;
  const autonomyPct = brainActions.length > 0 && attention.length > 0
    ? Math.round((brainActions.length / (brainActions.length + attention.length)) * 100)
    : null;

  return (
    // Outer scroll container. The app's global CSS sets html/body/#root to
    // overflow:hidden so the IconRail can stay fixed; pages that own their
    // own scroll need to declare it explicitly. Without this, the Day Brief
    // gets clipped at the viewport bottom and the user can't reach Brief /
    // Cognitive / Patterns / Setup sections.
    <div style={{ height: '100%', overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
    <div style={{ padding: 'var(--s-6) var(--s-8)', maxWidth: 1400, paddingBottom: 80 }}>

      {/* Thinking feedback is now delivered by the top-right BrainAvatar
          pill (see brain:thinking:start/end events fired by `load()`). */}

      {/* ── Header ──────────────────────────────────────────── */}
      <header style={{ marginBottom: 'var(--s-6)' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)' }}>
          {dateStr} · {timeStr} {user?.city ? `· ${user.city}` : ''}
        </div>
        <h1 style={{ margin: '4px 0 4px', fontSize: 'var(--fs-3xl)' }}>
          {getGreeting()}, {displayName}.
        </h1>
        <p style={{ color: 'var(--text-muted)', margin: 0, fontSize: 'var(--fs-sm)' }}>
          Here's what I handled, what needs you, and what I'm watching.
        </p>
        <div style={{ marginTop: 'var(--s-3)', display: 'flex', gap: 'var(--s-2)', alignItems: 'center' }}>
          <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading}>
            <Icon name="refresh" size={14} className={loading ? 'spin' : undefined} />
            {loading ? 'Thinking…' : 'Sync'}
          </Button>
        </div>
      </header>

      {/* ── Connector gaps (Brain-voice onboarding) ─────────── */}
      <ConnectorGapBanner
        gaps={gaps}
        onConnect={(slug) => navigate(`/connectors?highlight=${encodeURIComponent(slug || '')}`)}
      />

      {/* ── Volume strip ────────────────────────────────────── */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: 'var(--s-3)', marginBottom: 'var(--s-6)' }}>
        <MiniStat icon="mail"           label="Emails unread"   big={emailsUnread}        sub={emailsRecv > 0 ? `${emailsRecv} today · live` : 'live'} />
        <MiniStat
          icon="message-circle"
          label="WhatsApp today"
          big={volume?.whatsappHandled ?? 0}
          sub={
            (volume?.whatsappHandled ?? 0) > 0
              ? `${volume?.whatsappNeedYou ?? 0} need you`
              : 'via Brain connector'
          }
        />
        <MiniStat icon="check-square"   label="Tasks"          big={tasksOpen}           sub={tasksDue > 0 ? `${tasksDue} due today` : 'open items'} />
        <MiniStat icon="calendar"       label="Meetings today" big={meetings}            sub={meetings > 0 ? 'in your calendar' : 'nothing scheduled'} />
        {autonomyPct !== null && (
          <MiniStat icon="zap" label="Autonomy" big={`${autonomyPct}%`} sub="handled for you" highlight />
        )}
      </section>

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {/* ═══════════════════════════════════════════════════════════
          ZONE 1 — TODAY  (urgent, action-needed)
          Status snapshot already above (Volume strip).
          Risk Radar → My Attention → Rule promotions
          ═══════════════════════════════════════════════════════════ */}
      <ZoneHeader label="Today" sub="What's at risk and what needs you right now." />

      <RiskRadarPanel
        radar={radar}
        running={radarRunning}
        onRunNow={async () => {
          setRadarRunning(true);
          try {
            const r = await api.post('/risk-radar/run-now');
            setRadar({
              ...(radar ?? {}),
              flags: r.data?.result?.flags ?? [],
              summary: r.data?.result?.summary ?? '',
              narrative: r.data?.result?.narrative ?? null,
              flagCount: r.data?.result?.flagCount ?? 0,
              highSeverityCount: r.data?.result?.highSeverityCount ?? 0,
              generatedAt: new Date().toISOString(),
            });
          } catch (e) {
            notify({ kind: 'error', text: `Radar run failed: ${e.response?.data?.error ?? e.message}` });
          } finally {
            setRadarRunning(false);
          }
        }}
      />

      {/* ── My Attention — moved into Zone 1 since this IS the queue ── */}
      <Section
        id="my-attention"
        title={`My Attention ${attention.length > 0 ? `(${attention.length})` : ''}`}
        sub="I wasn't sure — pick one and I'll learn"
        icon="help-circle"
        defaultOpen={true}
        help={(
          <div>
            <strong>What this is.</strong> Inbound items Brain wasn't confident enough to handle on its own — emails, WhatsApp messages, calendar invites, etc. — grouped by criticality.<br /><br />
            <strong>How it works.</strong> Critical items (red) are the criticality engine's top concerns; regular items are middle-band; low-priority noise (newsletters, automated notifications) is collapsed at the bottom. Click any item to choose <em>Reply / Delegate / Add to Open Items / Ignore</em>.<br /><br />
            <strong>How it helps.</strong> Brain learns from every click. After enough confirmations on a pattern, the next matching item ends up in <em>Brief</em> instead of here. The fewer items here over time, the more Brain is taking off your plate.<br /><br />
            <strong>Make it more useful for you:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li><em>Be consistent</em> — same action on the same pattern teaches Brain fastest. Inconsistent picks slow learning.</li>
              <li><em>Star senders in Contacts</em> — 4★ and 5★ senders' items always surface here, never get auto-archived.</li>
              <li><em>Use "Add to Open Items"</em> for things you want to track but not act on now — they leave Attention and live in Action Center.</li>
              <li><em>Hide a pattern</em> ("Hide" button on cards) when an item type is genuinely noise for you — Brain stops surfacing it.</li>
              <li><strong>Example:</strong> Faisal emails about a vendor renewal. You click <em>Delegate to Asad</em>. Two more times same week. Brain promotes a rule. Next renewal email lands in <em>Brief</em> already delegated.</li>
            </ul>
          </div>
        )}
      >
        {attention.length === 0 ? (
          <Empty title="All clear">Inbox, chat, calendar queue is empty.</Empty>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            {attentionCritical.length > 0 && (
              <>
                <div style={{ fontSize: 'var(--fs-xs)', color: '#ef4444', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.5px', marginTop: 'var(--s-2)' }}>
                  🔴 Critical · {attentionCritical.length}
                </div>
                {attentionCritical.map((item) => (
                  <AttentionCard key={item.feedEventId} item={item} onDecided={load} notify={notify} drafts={draftsByFeedEventId.get(item.feedEventId) || []} />
                ))}
              </>
            )}
            {attentionRegular.map((item) => (
              <AttentionCard key={item.feedEventId} item={item} onDecided={load} notify={notify} drafts={draftsByFeedEventId.get(item.feedEventId) || []} />
            ))}
            {attentionNoise.length > 0 && (
              <details style={{ marginTop: 'var(--s-3)' }}>
                <summary style={{ cursor: 'pointer', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', padding: 'var(--s-2) 0' }}>
                  Low priority · {attentionNoise.length} (newsletters, notifications)
                </summary>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)', marginTop: 'var(--s-2)' }}>
                  {attentionNoise.map((item) => (
                    <AttentionCard key={item.feedEventId} item={item} onDecided={load} notify={notify} drafts={draftsByFeedEventId.get(item.feedEventId) || []} />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </Section>

      {/* Rule promotions — only when something's ready to be promoted */}
      {promotions.length > 0 && (
        <Section
          id="rule-promotions"
          title="Ready to handle on my own"
          sub="Patterns I've seen enough to act on — approve to let me run them."
          icon="zap"
          help={(
            <div>
              <strong>What this is.</strong> Patterns Brain noticed in your behaviour (e.g. "always delegate Raazia's emails to Asad") that have crossed the confidence threshold and are ready to be promoted to autonomous handling.<br /><br />
              <strong>How it works.</strong> Brain watches your decisions. When you've taken the same action on the same pattern enough times, it proposes a rule. Click <em>Approve</em> to let Brain run it automatically next time.<br /><br />
              <strong>How it helps.</strong> Routine work gets automated only after you confirm — no rules invented behind your back. You manage existing rules under <em>My Rules</em> in the rail.<br /><br />
              <strong>Make it more useful for you:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li><em>Review the example items</em> before approving — they show exactly what would have been auto-handled.</li>
                <li><em>Reject patterns you don't want</em> — they go away and Brain stops proposing them.</li>
                <li><em>Approved rules promote to "DRAFT" mode first</em> in My Rules — promote to AUTO once you've watched them in dry-run.</li>
                <li><strong>Example:</strong> Brain proposes "auto-archive newsletters from substack.com". Reject if you want to keep skimming them; approve if you don't read them.</li>
              </ul>
            </div>
          )}
        >
          {promotions.map((r) => <RulePromotionCard key={r.id} rule={r} onAction={load} />)}
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════════
          ZONE 2 — BRAIN'S ACTIVITY  (what happened, what Brain saw)
          Brief → Other drafts → Brain Noticing → Noticed overnight
          ═══════════════════════════════════════════════════════════ */}
      <ZoneHeader label="Brain's activity" sub="What I handled, what I'm watching, what I noticed." />

      <Section
        id="brief"
        title="Brief"
        sub={brainActions.length > 0 ? `${brainActions.length} actions I took for you` : 'What I handled without you'}
        icon="check-circle"
        help={(
          <div>
            <strong>What this is.</strong> A summary of actions Brain took for you autonomously since your last sign-in — drafts saved, items archived, follow-ups scheduled, replies sent (when within your auto-action rules).<br /><br />
            <strong>How it works.</strong> Each click you make on My Attention teaches Brain. When a pattern hits your learning threshold (Settings → Learning threshold), Brain starts handling matching items on its own and lists each one here so you can audit it.<br /><br />
            <strong>How it helps.</strong> You see exactly what Brain did — no surprises. Click any row to override or undo.<br /><br />
            <strong>Make it more useful for you:</strong>
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li><em>Approve rule promotions</em> when they show up — that's how Brain moves work from <em>My Attention</em> into <em>Brief</em>.</li>
              <li><em>Lower your learning threshold</em> in Settings → Learning if Brain is too cautious; raise it if Brain is acting too aggressively.</li>
              <li><em>Click 👎</em> on any auto-action you didn't want — Brain demotes that pattern.</li>
              <li><strong>Example:</strong> You delegate Raazia's emails to Asad three times in a row. Brain shows a rule promotion ("delegate Raazia → Asad"). You approve. Next time her email arrives, Brain delegates automatically and you see the action listed here under <em>Brief</em> — not <em>My Attention</em>.</li>
            </ul>
          </div>
        )}
      >
        {brainActions.length === 0 ? (
          <Empty title="Nothing autonomous yet">
            I'll learn from your clicks below. Once a pattern hits your threshold (Settings → Learning threshold), I'll start handling it on my own and list it here.
          </Empty>
        ) : (
          <GroupedByType actions={brainActions} onOverride={load} notify={notify} />
        )}
      </Section>

      {/* Drafts now render inline under the AttentionCard that produced
          them. This small section only surfaces orphans — drafts whose
          original feed event has already dropped off your Attention list. */}
      {orphanDrafts.length > 0 && (
        <Section
          id="other-drafts"
          title={`Other drafts (${orphanDrafts.length})`}
          sub="Drafts whose original message is no longer in My Attention."
          icon="edit"
          help={(
            <div>
              <strong>What this is.</strong> Drafts Brain wrote that no longer have a live Attention card — usually because the source email/message rolled off your queue.<br /><br />
              <strong>How it helps.</strong> Nothing Brain prepared gets lost. Review, send, or discard each one.<br /><br />
              <strong>Make it more useful for you:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li><em>Reject with a reason</em> when a draft isn't useful — Brain learns what NOT to draft for similar messages.</li>
                <li><em>Edit + send in one pass</em> — don't let drafts pile up; older drafts have stale context.</li>
                <li><strong>Example:</strong> Brain drafted a one-line "thanks!" reply you didn't need. Reject with reason "too short". Brain stops drafting one-liners for that sender.</li>
              </ul>
            </div>
          )}
        >
          {orphanDrafts.map((d) => <DraftCard key={d.id} draft={d} onAction={load} notify={notify} />)}
        </Section>
      )}

      {/* Brain's running mind + observations */}
      <BrainCognitiveSection cognitive={cognitive} onRerun={load} notify={notify} />

      {/* "Noticed overnight" — patterns Brain spotted */}
      {patterns.length > 0 && (
        <Section
          id="noticed-overnight"
          title="Noticed overnight"
          sub="Patterns you might want to act on"
          icon="trending-up"
          help={(
            <div>
              <strong>What this is.</strong> Patterns Brain spotted across your feed since yesterday — recurring senders, topics gaining momentum, anomalies (e.g. "Faisal usually replies in 4h, hasn't in 36").<br /><br />
              <strong>How it works.</strong> The pattern-analysis job (weekly) and Brain Cognitive Engine surface candidate observations. They don't auto-act; they're prompts for you to consider.<br /><br />
              <strong>How it helps.</strong> Forward-looking awareness. Insights you don't act on quietly fade; ones you click on become signal Brain uses to prioritise future surfaces.<br /><br />
              <strong>Make it more useful for you:</strong>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                <li><em>Click on insights you find useful</em> — Brain raises that pattern's priority next time.</li>
                <li><em>Dismiss noise</em> — Brain stops surfacing similar observations.</li>
                <li><em>Add a standing instruction</em> for any insight you want to formalise into a rule (e.g. "alert me on Faisal silence &gt; 24h").</li>
                <li><strong>Example:</strong> Insight: <em>"3 emails about pricing this week, all unanswered."</em> Click → opens the cluster of items. Add a standing instruction "Alert me on any pricing email" so Brain flags them critical from now on.</li>
              </ul>
            </div>
          )}
        >
          {patterns.map((p, i) => <InsightCard key={p.id ?? i} insight={p} onAction={load} />)}
        </Section>
      )}

      {/* ═══════════════════════════════════════════════════════════
          ZONE 3 — SETUP & REFLECTION  (less-frequent)
          Ask Brain → Standing Instructions → What Brain Learned
          ═══════════════════════════════════════════════════════════ */}
      <ZoneHeader label="Setup & reflection" sub="Ask, configure, and review what Brain has learned." />

      {/* Ask Brain — chat affordance, primary input */}
      <AskBrain />

      <StandingInstructionsSection
        instructions={instructions}
        isAdmin={isInstructionAdmin}
        onChange={load}
        notify={notify}
      />

      <BrainLearnedSection learned={learned} />
    </div>
    </div>
  );
}

/**
 * ZoneHeader — small uppercase label that visually separates groups
 * of sections on Day Brief. Light typography so it doesn't compete
 * with the section titles below it.
 */
/**
 * CriticalityReasons — collapsible "Why X?" pill that explains how the
 * criticality engine landed on this band. Reasons come from the engine's
 * fused signals (timePressure, impact, relationshipRisk, cascade,
 * patternAnomaly) plus star-floor and superpower notes.
 *
 * Closed by default to avoid card-bloat. Click to expand.
 */
function CriticalityReasons({ criticality }) {
  const [open, setOpen] = useState(false);
  const reasons = (criticality.reasons || []).filter(Boolean);
  if (reasons.length === 0) return null;
  const composite = typeof criticality.composite === 'number'
    ? `${Math.round(criticality.composite * 100)}/100`
    : null;
  const bandColor = criticality.band === 'critical' ? '#ef4444'
    : criticality.band === 'high' ? '#f59e0b'
    : '#94a3b8';
  return (
    <div style={{ marginTop: 6 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          background: 'transparent', border: `1px solid ${bandColor}40`,
          color: bandColor, padding: '2px 8px', fontSize: 11,
          borderRadius: 4, cursor: 'pointer', display: 'inline-flex',
          alignItems: 'center', gap: 4,
        }}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} Why {criticality.band}?{composite ? ` · score ${composite}` : ''}
      </button>
      {open && (
        <div style={{
          marginTop: 6, padding: '8px 10px',
          background: 'var(--bg-2)', borderLeft: `2px solid ${bandColor}`,
          borderRadius: 4, fontSize: 12, color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {reasons.map((r, i) => (
              <li key={i} style={{ marginBottom: 2 }}>{r}</li>
            ))}
          </ul>
          {criticality.dimensions && (
            <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border)', display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11 }}>
              <span title="how time-sensitive this is">⏱ time {fmtDim(criticality.dimensions.timePressure)}</span>
              <span title="size of the consequences">💥 impact {fmtDim(criticality.dimensions.impact)}</span>
              <span title="who's on the hook with this sender">🤝 relationship {fmtDim(criticality.dimensions.relationshipRisk)}</span>
              <span title="downstream knock-on effects">🔗 cascade {fmtDim(criticality.dimensions.cascade)}</span>
              <span title="unusual vs this sender's normal pattern">📊 anomaly {fmtDim(criticality.dimensions.patternAnomaly)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function fmtDim(v) {
  if (typeof v !== 'number') return '—';
  return `${Math.round(v * 100)}%`;
}

function ZoneHeader({ label, sub }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 'var(--s-2)',
      margin: 'var(--s-6) 0 var(--s-3)',
      paddingBottom: 4,
      borderBottom: '1px solid var(--border)',
    }}>
      <span style={{
        fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em',
        color: 'var(--text-muted)', fontWeight: 600,
      }}>{label}</span>
      {sub && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)', opacity: 0.7 }}>· {sub}</span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Shared visual primitives
// ─────────────────────────────────────────────────────────────

/**
 * Section — collapsible panel with optional inline help.
 *
 * Props:
 *   id           — stable string used as a localStorage key so each
 *                  user's open/closed preference persists across reloads.
 *                  When omitted, state is per-mount only.
 *   title, sub   — header text (uppercase title + dim sub).
 *   icon         — optional Icon name shown left of the title.
 *   help         — inline panel content explaining "what is this?".
 *                  React node or string. Toggled by the "?" button.
 *   defaultOpen  — initial open state when no localStorage value.
 *                  Defaults to true.
 *   right        — optional right-aligned slot in the header (button, badge).
 *   children     — body shown when open.
 *
 * Per the no-dialogs rule: help renders as an inline expandable panel,
 * never alert/confirm/prompt.
 */
function Section({ id, title, sub, icon, help, defaultOpen = false, right, children }) {
  // v2 prefix: a one-time reset of the previously-saved per-user open state
  // when the policy changed to "all collapsed by default except My
  // Attention". Older daybrief.section.<id> keys are silently abandoned;
  // future toggles persist on the v2 key.
  const storageKey = id ? `daybrief.section.v2.${id}` : null;
  const [open, setOpen] = useState(() => {
    if (!storageKey) return defaultOpen;
    try {
      const v = localStorage.getItem(storageKey);
      return v === null ? defaultOpen : v === 'open';
    } catch { return defaultOpen; }
  });
  const [showHelp, setShowHelp] = useState(false);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (storageKey) { try { localStorage.setItem(storageKey, next ? 'open' : 'closed'); } catch { /* ignore */ } }
      return next;
    });
  };

  return (
    <section style={{ marginBottom: 'var(--s-8)' }}>
      <div
        onClick={toggle}
        role="button"
        aria-expanded={open}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        }}
        className={`dbp-section-header ${open ? 'is-open' : 'is-closed'}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          cursor: 'pointer', userSelect: 'none',
          padding: '10px 14px',
          marginLeft: -14, marginRight: -14,
          borderRadius: 'var(--border-radius-md, 8px)',
          border: '1px solid var(--border)',
          background: open ? 'transparent' : 'var(--panel, #141a22)',
          transition: 'background 140ms, border-color 140ms',
        }}
      >
        <span
          aria-hidden
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, flexShrink: 0,
            borderRadius: 6,
            background: 'var(--bg-2, rgba(255,255,255,0.04))',
            border: '1px solid var(--border)',
            color: 'var(--accent)',
            transform: open ? 'rotate(0)' : 'rotate(-90deg)',
            transition: 'transform 180ms',
          }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none"
               stroke="currentColor" strokeWidth="3"
               strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
        {icon && <Icon name={icon} size={14} color="var(--accent)" />}
        <h3 style={{
          fontSize: 'var(--fs-md)', textTransform: 'uppercase', letterSpacing: '.5px',
          color: 'var(--accent)', margin: 0,
        }}>{title}</h3>
        {help && (
          <button
            onClick={(e) => { e.stopPropagation(); setShowHelp((s) => !s); }}
            aria-label="What is this?"
            title={showHelp ? 'Hide explanation' : 'What is this?'}
            style={{
              background: showHelp ? 'var(--accent)' : 'transparent',
              border: '1px solid var(--border)',
              color: showHelp ? '#0e1116' : 'var(--text-muted)',
              borderRadius: '50%', width: 18, height: 18,
              fontSize: 11, lineHeight: '16px', padding: 0,
              cursor: 'pointer', fontWeight: 600,
              marginLeft: 4,
            }}
          >?</button>
        )}
        {right && (
          <span
            style={{ marginLeft: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >{right}</span>
        )}
      </div>
      {sub && (
        <p style={{
          color: 'var(--text-muted)', fontSize: 'var(--fs-sm)',
          margin: '2px 0 var(--s-3)', paddingLeft: 18,
        }}>{sub}</p>
      )}
      {showHelp && (
        <div style={{
          background: 'var(--panel-2, #1b232d)',
          borderLeft: '3px solid var(--accent)',
          borderRadius: 'var(--border-radius-md, 6px)',
          padding: 'var(--s-3) var(--s-4)',
          margin: '4px 0 var(--s-3)',
          fontSize: 'var(--fs-sm)', lineHeight: 1.55,
          color: 'var(--text-secondary, var(--text))',
        }}>{help}</div>
      )}
      {open && <div>{children}</div>}
    </section>
  );
}

/**
 * Risk Radar — daily forward-looking flags. Sits high on Day Brief
 * so the user sees "what to worry about today" before scrolling into
 * Brief / Drafts / Attention. Empty state explains the system; loaded
 * state shows up to 8 ranked flags with severity dots and source chip.
 */
function RiskRadarPanel({ radar, running, onRunNow }) {
  const flags = Array.isArray(radar?.flags) ? radar.flags : [];
  const highCount = radar?.highSeverityCount ?? 0;
  const generatedAt = radar?.generatedAt ? new Date(radar.generatedAt) : null;
  const isStale = generatedAt && Date.now() - generatedAt.getTime() > 18 * 60 * 60 * 1000;
  const [showTune, setShowTune] = useState(false);

  return (
    <Section
      id="risk-radar"
      title="Risk Radar"
      sub={radar
        ? (highCount > 0
            ? `${highCount} high-severity flag${highCount === 1 ? '' : 's'}${flags.length > highCount ? ` · ${flags.length - highCount} other${flags.length - highCount === 1 ? '' : 's'}` : ''}${isStale ? ' · last run >18h ago' : ''}`
            : flags.length > 0
              ? `${flags.length} flag${flags.length === 1 ? '' : 's'} surfaced${isStale ? ' · last run >18h ago' : ''}`
              : 'Nothing flagged today.')
        : 'Forward-looking risks across feed, deals, and tone.'}
      icon="alert-triangle"
      help={(
        <div>
          <strong>What this is.</strong> A daily scan of <em>resting</em> state — things already in your system that are silently aging in dangerous ways: escalation emails, frustrated VIPs, unresolved high-priority items, delayed projects, stale deals, imminent deadlines.<br /><br />
          <strong>How it works.</strong> Runs automatically each morning at 08:15. Now <strong>rules-driven</strong>: every flag comes from a Risk Radar rule that has a predicate against a data source (inbound mail · open items · wiki / CRM pages). 8 system rules ship with MyOS; you add your own under <em>My Rules → Risk Radar</em>.<br /><br />
          <strong>How it helps.</strong> The radar catches what didn't happen — escalations, stagnation, broken commitments. Each flag links back to its source so you can act in one click.<br /><br />
          <strong>Make it more useful for you:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li><em>Open <strong>My Rules → Risk Radar</strong></em> — see every rule firing on your radar, plus the 8 system rules you can disable per user.</li>
            <li><em>Add your own rule</em> with <strong>+ Add rule</strong>. Three sources to scan:
              <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
                <li><strong>Inbox</strong> (<code>feed_event</code>) — escalation keywords, negative sentiment from a VIP, urgency above threshold</li>
                <li><strong>Open items</strong> — high-priority work unresolved past N days, items overdue, items in WAITING_INFO too long</li>
                <li><strong>Wiki / CRM</strong> — projects past deadline, opportunities stagnant in stage, contradicted pages</li>
              </ul>
            </li>
            <li><em>Star contacts who matter</em> — rules referencing <code>importance_stars</code> get sharper signal (e.g. "VIP negative sentiment" only fires for ★3+).</li>
            <li><em>Disable system rules</em> you don't want — each system rule has a "Disable for me" button under My Rules.</li>
            <li><strong>Example user rule:</strong> "Alert me on any email mentioning 'lawsuit' or 'breach' from anyone" — predicate <code>{`{ subject: matches "(lawsuit|breach)" OR body_preview matches ... }`}</code>, severity high, lookback 48h.</li>
            <li><strong>Example user rule:</strong> "Project X overdue by &gt; 3 days" — source wiki_page, predicate <code>{`{ title contains "Project X", deadline_overrun_days >= 3 }`}</code>.</li>
          </ul>
        </div>
      )}
    >
      {!radar ? (
        <div style={panelEmptyStyle}>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>
            Brain hasn't run the radar yet today. It runs automatically each morning at 08:15;
            you can also run it now.
          </p>
          <button onClick={onRunNow} disabled={running} style={miniBtnStyle(running)}>
            {running ? 'Running…' : 'Run radar now'}
          </button>
        </div>
      ) : flags.length === 0 ? (
        <div style={panelEmptyStyle}>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>
            Nothing flagged. Open items moving on schedule, no tone shifts, no stale deals.
          </p>
          <button onClick={onRunNow} disabled={running} style={miniBtnStyle(running)}>
            {running ? 'Running…' : 'Re-run radar'}
          </button>
        </div>
      ) : (
        <>
          {radar.narrative && (
            <p style={{
              margin: '0 0 var(--s-3) 0', padding: 'var(--s-3)',
              background: 'rgba(240,161,74,0.07)',
              border: '1px solid rgba(240,161,74,0.25)',
              borderRadius: 'var(--border-radius-md)',
              fontSize: 'var(--fs-sm)', lineHeight: 1.5,
            }}>{radar.narrative}</p>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {flags.slice(0, 8).map((f) => (
              <RiskFlagRow key={f.id} flag={f} />
            ))}
          </ul>
          {flags.length > 8 && (
            <div style={{ fontSize: 'var(--fs-xs, 11px)', color: 'var(--text-muted)', marginTop: 8, textAlign: 'right' }}>
              +{flags.length - 8} more flagged
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <span style={{ fontSize: 'var(--fs-xs, 11px)', color: 'var(--text-muted)' }}>
              {generatedAt ? `Last run ${fmtRelTime(generatedAt)}` : ''}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => setShowTune((s) => !s)} style={miniBtnStyle(false, 'subtle')}>
                {showTune ? 'Hide tuning' : 'Tune radar'}
              </button>
              <button onClick={onRunNow} disabled={running} style={miniBtnStyle(running, 'subtle')}>
                {running ? 'Running…' : 'Re-run'}
              </button>
            </div>
          </div>
          {showTune && <RadarTuningPanel onSaved={onRunNow} />}
        </>
      )}
    </Section>
  );
}

/**
 * Inline tuning panel — gives the user direct levers over what fires
 * on the radar. Sliders + toggles + an exclude-list, all save to
 * /risk-radar/config and re-run the radar so changes are visible
 * immediately (instead of waiting for tomorrow's 08:15 PKT cron).
 *
 * Per the no-dialogs rule: errors render inline in this panel via a
 * tiny banner, not alert/confirm.
 */
function RadarTuningPanel({ onSaved }) {
  const [config, setConfig] = useState(null);
  const [defaults, setDefaults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [excludeInput, setExcludeInput] = useState('');
  const [error, setError] = useState(null);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get('/risk-radar/config');
        if (!cancelled) {
          setConfig(r.data?.config ?? null);
          setDefaults(r.data?.defaults ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.error ?? err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <div style={tunePanelStyle}>Loading…</div>;
  }
  if (!config) {
    return <div style={tunePanelStyle}>{error ?? 'Could not load config.'}</div>;
  }

  const updateSignal = (key, patch) => setConfig((c) => ({
    ...c, signals: { ...c.signals, [key]: { ...c.signals[key], ...patch } },
  }));
  const setExcludeSenders = (next) => setConfig((c) => ({
    ...c, excludeSenders: { emails: next.emails ?? [], domains: next.domains ?? [] },
  }));

  const addExcludes = () => {
    const raw = excludeInput.trim();
    if (!raw) return;
    const tokens = raw.split(/[,\s]+/).map((t) => t.toLowerCase().trim()).filter(Boolean);
    const emails = new Set(config.excludeSenders?.emails ?? []);
    const domains = new Set(config.excludeSenders?.domains ?? []);
    for (const t of tokens) {
      if (!t) continue;
      if (t.startsWith('@')) domains.add(t.slice(1));
      else if (t.includes('@')) emails.add(t);
      else domains.add(t);
    }
    setExcludeSenders({ emails: [...emails], domains: [...domains] });
    setExcludeInput('');
  };
  const removeExclude = (kind, value) => {
    const cur = config.excludeSenders ?? { emails: [], domains: [] };
    setExcludeSenders({
      emails: kind === 'email' ? cur.emails.filter((e) => e !== value) : cur.emails,
      domains: kind === 'domain' ? cur.domains.filter((d) => d !== value) : cur.domains,
    });
  };

  const save = async () => {
    setSaving(true); setError(null); setSavedFlash(false);
    let stage = 'patch';
    try {
      await api.patch('/risk-radar/config', config);
      // Then auto re-run so the new filters apply immediately.
      // Awaited so the user sees a single continuous "Saving → Re-running"
      // indicator instead of a flash that disappears before the radar
      // doc actually updates.
      stage = 'rerun';
      if (onSaved) {
        const maybe = onSaved();
        if (maybe && typeof maybe.then === 'function') await maybe;
      }
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2400);
    } catch (err) {
      const detail = err.response?.data?.error ?? err.message;
      setError(stage === 'patch' ? `Save failed: ${detail}` : `Saved, but re-run failed: ${detail}`);
    } finally { setSaving(false); }
  };

  const reset = () => { if (defaults) setConfig(JSON.parse(JSON.stringify(defaults))); };

  const s = config.signals;

  return (
    <div style={tunePanelStyle}>
      {error && (
        <div style={{ background: 'rgba(217,83,79,0.15)', border: '1px solid #d9534f', color: '#f0a3a0', padding: 8, borderRadius: 4, marginBottom: 10, fontSize: 12 }}>
          {error}
        </div>
      )}

      <SignalToggle label="Stagnant criticality" enabled={s.stagnant_criticality.enabled}
        onToggle={(v) => updateSignal('stagnant_criticality', { enabled: v })}
        help="High-priority items still open" >
        <NumStepper label="min priority" value={Math.round((s.stagnant_criticality.min_score ?? 0.6) * 10)} min={3} max={10}
          onChange={(v) => updateSignal('stagnant_criticality', { min_score: v / 10 })} suffix="/10" />
        <NumStepper label="within last" value={s.stagnant_criticality.max_age_days ?? 7} min={1} max={30}
          onChange={(v) => updateSignal('stagnant_criticality', { max_age_days: v })} suffix=" days" />
      </SignalToggle>

      <SignalToggle label="Aging items (decay)" enabled={s.decay.enabled}
        onToggle={(v) => updateSignal('decay', { enabled: v })}
        help="Items past your typical resolution time">
        <NumStepper label="multiplier" value={s.decay.age_multiplier ?? 1.5} min={1} max={5} step={0.5}
          onChange={(v) => updateSignal('decay', { age_multiplier: v })} suffix="× median" />
      </SignalToggle>

      <SignalToggle label="Sender silence" enabled={s.silence.enabled}
        onToggle={(v) => updateSignal('silence', { enabled: v })}
        help="People gone quieter than usual">
        <NumStepper label="trigger at" value={s.silence.silence_multiplier ?? 3} min={2} max={10}
          onChange={(v) => updateSignal('silence', { silence_multiplier: v })} suffix="× typical window" />
      </SignalToggle>

      <SignalToggle label="Imminence" enabled={s.imminence.enabled}
        onToggle={(v) => updateSignal('imminence', { enabled: v })}
        help="Open items / instructions / meetings due soon">
        <NumStepper label="horizon" value={s.imminence.hours_ahead ?? 48} min={6} max={168} step={6}
          onChange={(v) => updateSignal('imminence', { hours_ahead: v })} suffix=" hours" />
      </SignalToggle>

      <SignalToggle label="CRM stagnation" enabled={s.crm_stagnation.enabled}
        onToggle={(v) => updateSignal('crm_stagnation', { enabled: v })}
        help="Odoo deals not updated">
        <NumStepper label="stagnant after" value={s.crm_stagnation.stagnant_days ?? 14} min={3} max={60}
          onChange={(v) => updateSignal('crm_stagnation', { stagnant_days: v })} suffix=" days" />
      </SignalToggle>

      <SignalToggle label="Tone shift" enabled={s.tone_shift.enabled}
        onToggle={(v) => updateSignal('tone_shift', { enabled: v })}
        help="Senders sounding more negative than usual">
        <NumStepper label="min negative msgs" value={s.tone_shift.min_negative_count ?? 2} min={1} max={10}
          onChange={(v) => updateSignal('tone_shift', { min_negative_count: v })} suffix="" />
        <NumStepper label="lookback" value={s.tone_shift.lookback_days ?? 7} min={3} max={30}
          onChange={(v) => updateSignal('tone_shift', { lookback_days: v })} suffix=" days" />
      </SignalToggle>

      <SignalToggle label="Contradicted wiki pages" enabled={s.contradicted_pages.enabled}
        onToggle={(v) => updateSignal('contradicted_pages', { enabled: v })}
        help="Wiki pages flagged contradicted/stale" />

      <SignalToggle label="Custom keywords" enabled={s.custom_keywords.enabled}
        onToggle={(v) => updateSignal('custom_keywords', { enabled: v })}
        help="Watch any inbound containing these words">
        <KeywordList
          keywords={s.custom_keywords.keywords ?? []}
          onChange={(kws) => updateSignal('custom_keywords', { keywords: kws })}
        />
      </SignalToggle>

      {/* Exclude list */}
      <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-2, rgba(255,255,255,0.03))', borderRadius: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
          Senders to skip in silence + tone-shift
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
          Add specific emails (<code>vendor@x.com</code>) or whole domains (<code>@x.com</code>). Add multiple separated by space or comma.
        </div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <input
            value={excludeInput}
            onChange={(e) => setExcludeInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExcludes(); } }}
            placeholder="@google.com  haseeb@tmcltd.ai  …"
            style={{
              flex: 1, background: 'var(--panel-2, #1b232d)', color: 'var(--text)',
              border: '1px solid var(--border)', borderRadius: 4,
              padding: '6px 8px', fontSize: 12,
            }}
          />
          <button onClick={addExcludes} style={miniBtnStyle(false, 'subtle')}>Add</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {(config.excludeSenders?.domains ?? []).map((d) => (
            <ExcludeChip key={`d:${d}`} label={`@${d}`} onRemove={() => removeExclude('domain', d)} />
          ))}
          {(config.excludeSenders?.emails ?? []).map((e) => (
            <ExcludeChip key={`e:${e}`} label={e} onRemove={() => removeExclude('email', e)} />
          ))}
          {(config.excludeSenders?.domains ?? []).length === 0 && (config.excludeSenders?.emails ?? []).length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(none — system noise filter still applies for no-reply / bot domains)</span>
          )}
        </div>
      </div>

      {/* Save / reset row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
        <button onClick={reset} style={miniBtnStyle(false, 'subtle')}>Reset to defaults</button>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {savedFlash && (
            <span style={{ fontSize: 12, color: '#5fbe61' }}>
              ✓ Saved + radar re-run — flag list updated
            </span>
          )}
          <button onClick={save} disabled={saving} style={miniBtnStyle(saving)}>
            {saving ? 'Saving + re-running…' : 'Save & re-run'}
          </button>
        </div>
      </div>
    </div>
  );
}

const tunePanelStyle = {
  marginTop: 14,
  padding: '14px 16px',
  background: 'var(--panel-2, #1b232d)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 13,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

function SignalToggle({ label, help, enabled, onToggle, children }) {
  return (
    <div style={{
      padding: '10px 12px',
      borderRadius: 6,
      background: enabled ? 'rgba(79,169,255,0.06)' : 'rgba(255,255,255,0.02)',
      border: `1px solid ${enabled ? 'rgba(79,169,255,0.25)' : 'var(--border)'}`,
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onToggle(e.target.checked)}
          style={{ accentColor: 'var(--accent, #4fa9ff)' }}
        />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</span>
        {help && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {help}</span>}
      </label>
      {enabled && children && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8, paddingLeft: 26 }}>
          {children}
        </div>
      )}
    </div>
  );
}

function NumStepper({ label, value, min, max, step = 1, onChange, suffix = '' }) {
  const dec = () => onChange(Math.max(min, +(Number(value) - step).toFixed(2)));
  const inc = () => onChange(Math.min(max, +(Number(value) + step).toFixed(2)));
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <button onClick={dec} style={stepBtnStyle}>−</button>
      <span style={{ minWidth: 32, textAlign: 'center', color: 'var(--text)' }}>{value}{suffix}</span>
      <button onClick={inc} style={stepBtnStyle}>+</button>
    </div>
  );
}

const stepBtnStyle = {
  background: 'var(--panel-2, #1b232d)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  borderRadius: 4,
  width: 22, height: 22,
  fontSize: 13, lineHeight: 1,
  cursor: 'pointer',
  padding: 0,
};

function KeywordList({ keywords, onChange }) {
  const [input, setInput] = useState('');
  const add = () => {
    const t = input.trim().toLowerCase();
    if (!t || keywords.includes(t)) { setInput(''); return; }
    onChange([...keywords, t]);
    setInput('');
  };
  const remove = (k) => onChange(keywords.filter((x) => x !== k));
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder="lawsuit, EXIM, pricing…"
          style={{
            flex: 1, background: 'var(--panel-2, #1b232d)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 4,
            padding: '4px 8px', fontSize: 11,
          }}
        />
        <button onClick={add} style={stepBtnStyle}>+</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {keywords.map((k) => (
          <ExcludeChip key={k} label={k} onRemove={() => remove(k)} />
        ))}
      </div>
    </div>
  );
}

function ExcludeChip({ label, onRemove }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 4px 2px 8px', borderRadius: 999,
      background: 'var(--panel-2, #1b232d)',
      border: '1px solid var(--border)',
      color: 'var(--text)', fontSize: 11,
    }}>
      {label}
      <button onClick={onRemove} aria-label="Remove" style={{
        background: 'transparent', border: 0, color: 'var(--text-muted)',
        cursor: 'pointer', padding: '0 4px', fontSize: 12, lineHeight: 1,
      }}>×</button>
    </span>
  );
}

/**
 * Single Risk Radar flag row with severity stripe, Brain's recommendation,
 * and one-click actions mapped to the signal type. The actions navigate
 * to the right surface (Open Items, Wiki page, etc.) or fire a quick
 * snooze/dismiss API. v16-style "what should I do?" affordance.
 */
function RiskFlagRow({ flag }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const actions = buildFlagActions(flag);

  const fireAction = async (a) => {
    if (busy) return;
    if (a.kind === 'navigate') {
      navigate(a.target);
      return;
    }
    if (a.kind === 'snooze' || a.kind === 'close' || a.kind === 'dismiss') {
      setBusy(true);
      try {
        if (a.kind === 'snooze') {
          // Snooze the linked open item (3 days). Tolerant fail — if the
          // item id isn't an open_item, the request is a no-op locally.
          const oi = (flag.sourceRefs || []).find((r) => r.kind === 'open_item');
          if (oi) {
            await api.post(`/open-items/${oi.id}/snooze`, { hours: 72 }).catch(() => {});
          }
        } else if (a.kind === 'close') {
          const oi = (flag.sourceRefs || []).find((r) => r.kind === 'open_item');
          if (oi) {
            await api.post(`/open-items/${oi.id}/status`, { status: 'CLOSED' }).catch(() => {});
          }
        }
        setDismissed(true);
      } finally { setBusy(false); }
    }
  };

  return (
    <li style={{
      display: 'flex', gap: 10, alignItems: 'flex-start',
      padding: '10px 12px',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${severityColor(flag.severity)}`,
      borderRadius: 'var(--border-radius-md)',
      background: 'var(--panel)',
    }}>
      <SeverityDot severity={flag.severity} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 500, color: 'var(--text)' }}>{flag.title}</div>
        <div style={{ fontSize: 'var(--fs-xs, 11px)', color: 'var(--text-muted)', marginTop: 2 }}>{flag.reason}</div>
        {flag.suggestedAction && (
          <div style={{
            fontSize: 'var(--fs-xs, 11px)', marginTop: 6,
            padding: '4px 8px', display: 'inline-block',
            background: 'rgba(240,161,74,0.10)',
            border: '1px solid rgba(240,161,74,0.3)',
            borderRadius: 4, color: 'var(--accent, #f0a14a)',
          }}>
            <strong>Brain suggests →</strong> {flag.suggestedAction}
          </div>
        )}
        {actions.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {actions.map((a, i) => (
              <button
                key={i}
                onClick={() => fireAction(a)}
                disabled={busy}
                style={{
                  background: a.primary ? 'var(--accent)' : 'transparent',
                  color: a.primary ? '#0e1116' : 'var(--accent)',
                  border: a.primary ? '1px solid var(--accent)' : '1px solid var(--border)',
                  borderRadius: 6, padding: '4px 10px',
                  fontSize: 12, fontWeight: 500,
                  cursor: busy ? 'wait' : 'pointer',
                  opacity: busy ? 0.6 : 1,
                  transition: 'background 120ms, border-color 120ms',
                }}
                title={a.title || ''}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <SignalChip signal={flag.signal} />
    </li>
  );
}

/**
 * Map a flag's signal + sourceRefs to a list of one-click actions.
 * Each action is `{ label, kind, target?, primary? }`. Actions are
 * deliberately conservative: navigate to the right place, or fire a
 * lightweight API (snooze 3 days / mark closed). Anything heavier
 * (drafting a reply, escalating) stays as a navigation away from
 * Day Brief into the proper surface.
 */
function buildFlagActions(f) {
  const oi = (f.sourceRefs || []).find((r) => r.kind === 'open_item');
  const wiki = (f.sourceRefs || []).find((r) => r.kind === 'wiki_page');
  const sender = (f.sourceRefs || []).find((r) => r.kind === 'sender');
  const event = (f.sourceRefs || []).find((r) => r.kind === 'feed_event');

  const out = [];
  switch (f.signal) {
    case 'stagnant_criticality':
      if (oi) out.push({ label: 'Open item', kind: 'navigate', target: `/?tab=center`, primary: true });
      out.push({ label: 'Snooze 3 days', kind: 'snooze' });
      out.push({ label: 'Mark done', kind: 'close' });
      break;
    case 'decay':
      if (oi) out.push({ label: 'Open item', kind: 'navigate', target: `/?tab=center`, primary: true });
      out.push({ label: 'Snooze 3 days', kind: 'snooze' });
      out.push({ label: 'Mark done', kind: 'close' });
      break;
    case 'silence':
      if (sender) out.push({ label: `View ${sender.id}`, kind: 'navigate', target: `/?tab=contacts`, primary: true });
      out.push({ label: 'Dismiss', kind: 'dismiss' });
      break;
    case 'imminence':
      if (oi) out.push({ label: 'Open item', kind: 'navigate', target: `/?tab=center`, primary: true });
      else if (event) out.push({ label: 'Open event', kind: 'navigate', target: `/?tab=center`, primary: true });
      out.push({ label: 'Snooze 1 day', kind: 'snooze' });
      break;
    case 'crm_stagnation':
      if (wiki) out.push({ label: 'Open deal', kind: 'navigate', target: `/?tab=wiki`, primary: true });
      out.push({ label: 'Dismiss', kind: 'dismiss' });
      break;
    case 'contradicted_pages':
      if (wiki) out.push({ label: 'Open page', kind: 'navigate', target: `/?tab=wiki`, primary: true });
      out.push({ label: 'Dismiss', kind: 'dismiss' });
      break;
    case 'tone_shift':
      if (sender) out.push({ label: `View ${sender.id}`, kind: 'navigate', target: `/?tab=contacts`, primary: true });
      out.push({ label: 'Dismiss', kind: 'dismiss' });
      break;
    case 'custom_keywords':
      if (event) out.push({ label: 'Open in Attention', kind: 'navigate', target: `/?tab=brief`, primary: true });
      out.push({ label: 'Dismiss', kind: 'dismiss' });
      break;
    default:
      out.push({ label: 'Dismiss', kind: 'dismiss' });
  }
  return out;
}

function severityColor(sev) {
  if (sev === 'high') return '#d9534f';
  if (sev === 'medium') return '#f0a14a';
  return '#888780';
}

function SeverityDot({ severity }) {
  return (
    <span style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
      background: severityColor(severity), marginTop: 6, flexShrink: 0,
    }} />
  );
}

function SignalChip({ signal }) {
  const labels = {
    stagnant_criticality: 'stagnant',
    decay: 'aging',
    silence: 'silence',
    imminence: 'imminent',
    crm_stagnation: 'deal',
    contradicted_pages: 'wiki',
    custom_keywords: 'watchlist',
    tone_shift: 'tone',
  };
  return (
    <span style={{
      fontSize: 10, padding: '2px 8px', borderRadius: 999,
      background: 'var(--panel-2)', color: 'var(--text-muted)',
      whiteSpace: 'nowrap', alignSelf: 'flex-start', marginTop: 2,
      textTransform: 'lowercase', letterSpacing: '.3px',
    }}>{labels[signal] ?? signal}</span>
  );
}

const panelEmptyStyle = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  gap: 12, padding: 'var(--s-3)',
  border: '1px dashed var(--border)', borderRadius: 'var(--border-radius-md)',
};

function miniBtnStyle(disabled, variant = 'primary') {
  if (variant === 'subtle') {
    return {
      background: 'transparent', color: 'var(--accent)',
      border: '1px solid var(--border)', borderRadius: 6,
      padding: '4px 10px', fontSize: 12,
      cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    };
  }
  return {
    background: disabled ? 'var(--panel-2)' : 'var(--accent)',
    color: disabled ? 'var(--text-muted)' : '#0e1116',
    border: 0, borderRadius: 6, padding: '6px 12px', fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 500,
    flexShrink: 0,
  };
}

function fmtRelTime(d) {
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleString();
}

function MiniStat({ icon, label, big, sub, highlight }) {
  return (
    <Card
      size="sm"
      style={{
        padding: 'var(--s-3)',
        background: highlight ? 'var(--accent-dim)' : undefined,
        borderColor: highlight ? 'var(--accent)' : undefined,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
        {icon && <Icon name={icon} size={12} color="var(--text-dim)" />}
      </div>
      <div style={{ fontSize: 'var(--fs-2xl)', fontWeight: 'var(--fw-semibold)', marginTop: 2, color: highlight ? 'var(--accent)' : 'var(--text)' }}>{big}</div>
      {sub && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>}
    </Card>
  );
}

function AskBrain() {
  const [q, setQ] = useState('');
  const [answer, setAnswer] = useState(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    if (!q.trim()) return;
    setBusy(true); setAnswer(null);
    try {
      const { data } = await api.post('/brain/ask', { question: q });
      setAnswer(data?.answer ?? 'Brain Q&A is not wired yet. Your question was: ' + q);
    } catch (e) {
      // Not-yet-built endpoint: show graceful placeholder so UX is visible.
      setAnswer(`Brain Q&A is still being wired up. I'll answer "${q}" once /brain/ask is deployed.`);
    } finally { setBusy(false); }
  };

  return (
    <Card style={{ marginBottom: 'var(--s-6)', padding: 'var(--s-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', marginBottom: 'var(--s-2)' }}>
        <Icon name="search" size={14} color="var(--accent)" />
        <span style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)' }}>Ask Brain</span>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>· natural-language query</span>
      </div>
      <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && ask()}
          placeholder='e.g. "Who should handle the new UAE proposal?" or "What did we decide about Acme last March?"'
          style={{
            flex: 1,
            padding: '10px 12px',
            background: 'var(--bg-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            color: 'var(--text)',
            fontSize: 'var(--fs-sm)',
          }}
        />
        <Button variant="primary" size="sm" onClick={ask} disabled={busy || !q.trim()}>
          {busy ? '…' : 'Ask'}
        </Button>
      </div>
      {answer && (
        <div style={{ marginTop: 'var(--s-3)', padding: 'var(--s-3)', background: 'var(--bg-2)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', whiteSpace: 'pre-wrap' }}>
          {answer}
        </div>
      )}
    </Card>
  );
}

function GroupedByType({ actions, onOverride, notify }) {
  // Group autonomous actions by their high-level type bucket
  const groups = useMemo(() => {
    const g = {};
    for (const a of actions) {
      const key =
        (a.actionType || '').includes('ignore') || (a.actionType || '').includes('archive') ? 'Archived' :
        (a.actionType || '').includes('reply') ? 'Replied' :
        (a.actionType || '').includes('delegate') ? 'Delegated' :
        (a.actionType || '').includes('open_item') ? 'Added to Open Items' :
        (a.actionType || '').includes('acknowledge') ? 'Acknowledged' :
        'Other';
      (g[key] ?? (g[key] = [])).push(a);
    }
    return g;
  }, [actions]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
      {Object.entries(groups).map(([label, rows]) => (
        <Card key={label} size="sm">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 'var(--s-2)' }}>
            <div style={{ fontWeight: 'var(--fw-medium)' }}>{label}</div>
            <Pill variant="success">{rows.length}</Pill>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {rows.slice(0, 8).map((r) => <BrainActionRow key={r.id} action={r} onOverride={onOverride} notify={notify} />)}
            {rows.length > 8 && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>+ {rows.length - 8} more</div>}
          </div>
        </Card>
      ))}
    </div>
  );
}

// Map Brain's autonomous actionType → the replacement value it represents.
// The "Fix" chooser shows every option EXCEPT what Brain already did.
const BRAIN_ACTION_TO_REPLACEMENT = {
  ignore_email:             'ignore',
  add_open_item:            'add_open_item',
  acknowledge:              'acknowledge',
  delegate_forward:         'delegate',
  draft_reply:              'draft_reply',
  schedule_meeting_queued:  'schedule_meeting',
};

// Full alternatives menu. Each entry: { id, label, needsInput? }
const ALL_FIX_OPTIONS = [
  { id: 'draft_reply',      label: '✎ Reply instead' },
  { id: 'delegate',         label: '→ Delegate instead', needsDelegatee: true },
  { id: 'add_open_item',    label: '+ Open Item instead' },
  { id: 'ignore',           label: '✗ Ignore instead' },
  { id: 'acknowledge',      label: '👁 Acknowledge instead' },
  { id: 'schedule_meeting', label: '📅 Schedule instead' },
];

function BrainActionRow({ action, onOverride, notify }) {
  const [fixOpen, setFixOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Reason-note flow: when MD picks an override action, we stash it and
  // show an inline textarea instead of a blocking browser prompt. MD
  // types the teaching note, clicks Save, and the override fires.
  const [pendingOpt, setPendingOpt] = useState(null); // { id, label, extra }
  const [reasonNote, setReasonNote] = useState('');
  const [applyToSimilar, setApplyToSimilar] = useState(true);
  const input = action.input ?? {};
  const subj = input.subject || input.title || input.to || action.actionType;
  const brainDid = BRAIN_ACTION_TO_REPLACEMENT[action.actionType];

  const fixOptions = ALL_FIX_OPTIONS.filter((o) => o.id !== brainDid);

  const onFixClick = (opt) => {
    if (opt.needsDelegatee) { setPickerOpen(true); return; }
    // Queue the option and prefill a reasonable default the MD can edit
    setPendingOpt({ ...opt, extra: {} });
    setReasonNote(`Should have been ${opt.id.replace('_', ' ')}`);
  };

  const confirmFix = async () => {
    if (!pendingOpt) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/brief/brain-actions/${action.id}/override`, {
        replacementAction: pendingOpt.id,
        reason: reasonNote,
        applyToSimilar,
        ...(pendingOpt.extra || {}),
      });
      notify?.(data.message ?? 'Noted.', 'success');
      onOverride?.();
    } catch (e) {
      notify?.(e?.response?.data?.error ?? 'Failed to override', 'error');
    } finally {
      setBusy(false);
      setPendingOpt(null);
      setReasonNote('');
      setFixOpen(false);
      setPickerOpen(false);
    }
  };

  const cancelFix = () => {
    setPendingOpt(null);
    setReasonNote('');
  };

  return (
    <div style={{
      fontSize: 'var(--fs-sm)', color: 'var(--text-muted)',
      padding: '4px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          · {String(subj).slice(0, 90)}
          <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>— {timeAgo(action.at)}</span>
        </div>
        <FeedbackButtons
          subjectType="brain_action"
          subjectId={String(action.id)}
          context={{ actionType: action.actionType, subject: subj, brainDid }}
          compact
        />
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setFixOpen((x) => !x)}>
          {fixOpen ? 'Cancel' : 'Fix'}
        </Button>
      </div>
      {fixOpen && (
        <div style={{ marginTop: 6, padding: 8, background: 'var(--bg-2)', borderRadius: 'var(--r-sm)' }}>
          {pendingOpt ? (
            <>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
                Fixing to <strong>{pendingOpt.label}</strong>. Why was Brain wrong? (Your note trains Brain.)
              </div>
              <textarea
                autoFocus
                value={reasonNote}
                onChange={(e) => setReasonNote(e.target.value)}
                rows={2}
                placeholder="e.g. This sender's invoices always go to Asad"
                style={{
                  width: '100%', padding: 'var(--s-2) var(--s-3)',
                  background: 'var(--bg-1)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)', color: 'var(--text)',
                  fontSize: 'var(--fs-sm)', fontFamily: 'inherit', lineHeight: 1.5,
                  resize: 'vertical', boxSizing: 'border-box',
                }}
              />
              <label style={{
                display: 'flex', alignItems: 'center', gap: 6,
                marginTop: 8, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)',
                cursor: 'pointer', userSelect: 'none',
              }}>
                <input
                  type="checkbox"
                  checked={applyToSimilar}
                  onChange={(e) => setApplyToSimilar(e.target.checked)}
                />
                Apply this fix to every similar item in BRIEF (same sender / pattern). Recommended.
              </label>
              <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
                <Button size="sm" variant="ghost" disabled={busy} onClick={cancelFix}>Cancel</Button>
                <Button size="sm" variant="primary" disabled={busy || !reasonNote.trim()} onClick={confirmFix}>
                  {busy ? 'Saving…' : 'Save & Apply'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
                Brain did: <strong>{action.actionType}</strong>. What should it have done?
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {fixOptions.map((opt) => (
                  <Button
                    key={opt.id}
                    size="sm" variant="secondary" disabled={busy}
                    onClick={() => onFixClick(opt)}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <DelegateePicker
        open={pickerOpen}
        context={{ itemType: 'email', archetype: 'reply_needed' }}
        onCancel={() => setPickerOpen(false)}
        onPick={(who) => {
          setPickerOpen(false);
          setPendingOpt({ id: 'delegate', label: `→ Delegate to ${who.name ?? who.email}`, extra: { delegatee: who } });
          setReasonNote(`Should have been delegated to ${who.name ?? who.email}`);
        }}
      />
    </div>
  );
}

function ChannelGroup({ channel, items, onDecided, notify }) {
  const channelLabel = ({
    email: 'Email', whatsapp: 'WhatsApp', task: 'Tasks', meeting: 'Calendar',
  })[channel] ?? channel;
  const [expanded, setExpanded] = useState(true);

  return (
    <div>
      <button
        onClick={() => setExpanded((x) => !x)}
        style={{
          background: 'transparent', border: 'none', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 'var(--s-2)',
          color: 'var(--text-muted)', padding: 0, marginBottom: 'var(--s-2)',
          fontSize: 'var(--fs-sm)', textTransform: 'uppercase', letterSpacing: '.5px',
        }}
      >
        <Icon name={channelIcon(channel)} size={12} />
        {channelLabel} · {items.length}
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {expanded && items.map((item) => <AttentionCard key={item.feedEventId} item={item} onDecided={onDecided} />)}
    </div>
  );
}

/**
 * SuggestedRulesRow — renders user-authored action rules (mode=SUGGEST)
 * that match this Attention item, as one-click "Apply rule X" buttons.
 *
 * Each click POSTs to /brief/attention/:feedEventId/apply-rule, which
 * fires the rule through the action handler registry. After success,
 * the card greys out (same UX as Brain Action accept).
 *
 * Conservative: shows up to 3 matching rules. Rules in DRAFT mode never
 * surface (they only log to tenant_log). AUTO rules already fired in
 * autonomousExecutor before triage produced this card, so they don't
 * appear here either.
 */
function SuggestedRulesRow({ feedEventId, rules, busy, setBusy, setActedAction, onDecided, notify }) {
  const [appliedRuleId, setAppliedRuleId] = useState(null);

  const apply = async (rule) => {
    if (busy) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/brief/attention/${feedEventId}/apply-rule`, { ruleId: rule.ruleId });
      if (data?.ok) {
        setAppliedRuleId(rule.ruleId);
        setActedAction?.(rule.actionType);
        notify?.(`Applied rule "${rule.name}"`, 'success');
        setTimeout(() => onDecided?.(), 600);
      } else {
        notify?.(data?.error ?? 'Rule apply failed', 'error');
      }
    } catch (err) {
      notify?.(err?.response?.data?.error ?? 'Rule apply failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      marginTop: 8,
      padding: '8px 10px',
      background: 'rgba(99,102,241,0.08)',
      border: '1px solid rgba(99,102,241,0.3)',
      borderRadius: 'var(--r-md)',
      display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: '#c7d2fe' }}>
        Your standing rule matches
      </div>
      {rules.slice(0, 3).map((r) => {
        const applied = appliedRuleId === r.ruleId;
        return (
          <div key={r.ruleId} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', fontWeight: 600 }}>
                {r.name}
              </div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                {r.actionType}
                {Array.isArray(r.matchedOn) && r.matchedOn.length > 0 && (
                  <> · matched {r.matchedOn.join(' · ')}</>
                )}
              </div>
            </div>
            <Button
              variant={applied ? 'secondary' : 'primary'}
              size="sm"
              disabled={busy || applied}
              onClick={() => apply(r)}
            >
              {applied ? 'Applied ✓' : 'Apply'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

function AttentionCard({ item, onDecided, notify, drafts = [] }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [score, setScore] = useState(null);
  const [actedAction, setActedAction] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Shown under the Delegate button when Brain has a suggested delegatee.
  // Gives MD explicit keep-or-change choice instead of committing on first
  // click. Only matters when Brain's confidence is below the autonomous
  // threshold (which is always the case when an item is in Attention).
  const [delegateConfirmOpen, setDelegateConfirmOpen] = useState(false);

  const decide = async (action, extra = {}) => {
    setBusy(true);
    try {
      const { data } = await api.post('/brief/decide', {
        feedEventId: item.feedEventId,
        itemType: item.itemType,
        archetype: item.archetype,
        senderDomain: item.senderDomain,
        action,
        wasBrainSuggestion: action === item.suggestedAction,
        subject: item.subject,
        ...extra,
      });
      setScore(data?.score ?? null);
      setActedAction(action);

      // Confirmation toast for delegation — show what actually happened
      if (action === 'delegate') {
        const who = extra?.delegatee?.name ?? extra?.delegatee?.email ?? 'delegatee';
        const bits = [];
        if (data?.forwarded === true) bits.push('email forwarded');
        else if (data?.forwarded === false) bits.push('forward failed — check Gmail connection');
        if (data?.delegateeOpenItemId) bits.push(`Open Item created on ${who}'s Action Center`);
        if (bits.length === 0) bits.push('logged — Brain will learn from this');
        notify?.(`Delegated to ${who}. ${bits.join(' · ')}`, data?.forwarded === false ? 'warning' : 'success');
      }

      setTimeout(() => onDecided?.(), 600);
    } catch (e) {
      notify?.(e?.response?.data?.error ?? 'Failed', 'error');
      setBusy(false);
    }
  };

  const hide = async () => {
    await api.post('/brief/hide', { dedupHash: item.dedupHash, reason: 'User hid pattern' });
    onDecided?.();
  };

  const suggested = item.suggestedAction;
  const delegateLabel = item.suggestedDelegateeName
    ? `→ Delegate to ${item.suggestedDelegateeName}`
    : '→ Delegate';

  return (
    <Card
      size="sm"
      style={{
        marginBottom: 'var(--s-2)',
        borderColor: actedAction ? 'var(--success)' : 'var(--border)',
        opacity: actedAction ? 0.5 : 1,
        transition: 'all 0.3s',
      }}
    >
      <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-start' }}>
        {/* Source-channel badge — visual tag for Gmail / WhatsApp / Calendar / Tasks */}
        {(() => {
          const c = channelColor(item.itemType);
          return (
            <div
              title={channelLabel(item.itemType)}
              style={{
                width: 28, height: 28, borderRadius: '50%',
                background: c.bg, color: c.fg,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0, marginTop: 2,
              }}
            >
              <Icon name={channelIcon(item.itemType)} size={14} />
            </div>
          );
        })()}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            {item.critical && <Pill variant="danger">🔴 critical</Pill>}
            {item.archetype && <Pill variant={item.archetype === 'review_risk' ? 'warning' : item.archetype === 'inform_only' ? undefined : 'info'}>{item.archetype.replace('_', ' ')}</Pill>}
            <strong style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 'var(--fs-sm)' }}>
              {(item.from ?? '').replace(/^"|"$/g, '').slice(0, 60)}
            </strong>
            {/*
              For meetings, show the MEETING START time, not when Brain
              ingested the calendar invite. For everything else, the
              relative time of receipt is the right reference.
            */}
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
              {item.itemType === 'meeting' && item.meeting?.start
                ? meetingWhen(item.meeting.start)
                : timeAgo(item.receivedAt)}
            </span>
            {/* Series collapse badge — shown when a recurring meeting was
                collapsed from N occurrences into this representative card. */}
            {item.seriesCount > 1 && (
              <Pill variant="info">↻ {item.seriesCount}-occurrence series</Pill>
            )}
          </div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', marginTop: 4 }}>
            {/* WhatsApp has no subject — show the message body inline.
                Email/meeting/task keep subject as the primary title. */}
            {item.itemType === 'whatsapp'
              ? (item.preview || item.subject || '(empty message)')
              : (item.subject || '(no subject)')}
          </div>
          {/* Meeting details + conflict badge. Only rendered for calendar
              items; nothing shows when meeting is absent. */}
          {item.itemType === 'meeting' && item.meeting && (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
                <span>📅 {formatMeetingTime(item.meeting)}</span>
                {item.meeting.location && <span>· 📍 {item.meeting.location.slice(0, 80)}</span>}
                {item.meeting.selfOrganized && <Pill variant="info">you organized</Pill>}
              </div>
              {item.meeting.conflicts && item.meeting.conflicts.length > 0 && (
                <div style={{
                  fontSize: 'var(--fs-xs)', color: '#ef4444',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.25)',
                  borderRadius: 6, padding: '6px 10px',
                  display: 'flex', flexDirection: 'column', gap: 2,
                }}>
                  <div><strong>⚠ Conflicts with:</strong></div>
                  {item.meeting.conflicts.map((c, i) => (
                    <div key={i} style={{ paddingLeft: 18, color: '#fca5a5' }}>
                      · {c.summary} ({formatTimeRange(c.start, c.end)})
                    </div>
                  ))}
                </div>
              )}
              {item.meeting.isFree === true && (
                <div style={{ fontSize: 'var(--fs-xs)', color: '#4ade80' }}>✓ You're free during this window</div>
              )}
            </div>
          )}
          {expanded && item.preview && (
            <div style={{
              fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 6,
              padding: 'var(--s-2)', background: 'var(--bg-2)',
              borderRadius: 'var(--r-sm)', whiteSpace: 'pre-wrap',
            }}>
              {item.preview}
            </div>
          )}
          {item.contextBrief && (
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
              🧠 {item.contextBrief}
            </div>
          )}
          {/* Why is this critical/high? — surfacing the criticality engine's
              own reasons so the user can see how Brain decided. Only renders
              when band is medium+ AND reasons exist. */}
          {item.criticality && Array.isArray(item.criticality.reasons) && item.criticality.reasons.length > 0
            && item.criticality.band !== 'low' && (
            <CriticalityReasons criticality={item.criticality} />
          )}
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 6, display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <span>Brain suggests: <strong style={{ color: 'var(--accent)' }}>{actionLabel(suggested)}</strong></span>
            <span>({Math.round((item.confidence ?? 0) * 100)}%)</span>
            <span>· {item.rationale}</span>
            {score !== null && <Pill variant="success">pattern score {score}</Pill>}
          </div>
          {/* User-defined SUGGEST rule matches — one-click apply. */}
          {Array.isArray(item.suggestedRules) && item.suggestedRules.length > 0 && (
            <SuggestedRulesRow
              feedEventId={item.feedEventId}
              rules={item.suggestedRules}
              busy={busy}
              setBusy={setBusy}
              setActedAction={setActedAction}
              onDecided={onDecided}
              notify={notify}
            />
          )}
        </div>
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-3)', flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" onClick={() => setExpanded((x) => !x)}>
          {expanded ? 'Hide' : 'Preview'}
        </Button>
        {/* Dynamic action buttons — if server sent context-aware actions,
            render those. Otherwise fall back to the static 4. */}
        {(item.actions && item.actions.length > 0 ? item.actions : buildAttentionOptions(item)).map((opt, optIdx) => {
          // Compose a stable unique key — the same opt.id can appear twice
          // (e.g. two delegate variants); index makes them distinct.
          const optKey = `${opt.id}-${optIdx}`;
          if (opt.id === 'delegate') {
            const hasPick = !!(item.suggestedDelegateeEmail || item.suggestedDelegateeUserId);
            return (
              <ActionButton
                key={optKey}
                active={opt.primary || suggested === opt.id}
                disabled={busy}
                onClick={() => {
                  if (hasPick) setDelegateConfirmOpen((x) => !x);
                  else setPickerOpen(true);
                }}
              >
                {opt.label || delegateLabel}
              </ActionButton>
            );
          }
          if (opt.id === 'delegate_to_known') {
            // One-click delegate to the historically-dominant delegatee
            return (
              <ActionButton
                key={optKey}
                active={opt.primary}
                disabled={busy}
                onClick={() => decide('delegate', { delegatee: opt.delegatee })}
              >
                {opt.label}
              </ActionButton>
            );
          }
          if (opt.id === 'link_to_existing') {
            return (
              <ActionButton
                key={optKey}
                active={opt.primary}
                disabled={busy}
                onClick={() => decide('add_open_item', { linkToOpenItemId: opt.openItemId })}
              >
                {opt.label}
              </ActionButton>
            );
          }
          if (opt.id === 'accept' || opt.id === 'decline') {
            return (
              <ActionButton
                key={optKey}
                active={opt.primary}
                disabled={busy}
                onClick={() => decide(opt.id === 'accept' ? 'acknowledge' : 'ignore', { calendarRsvp: opt.id })}
              >
                {opt.label}
              </ActionButton>
            );
          }
          if (opt.id === 'propose_alternative') {
            // Conflict-aware decline: Brain drafts a polite reply with 2–3
            // alternative free slots. Handled server-side as a 'draft_reply'
            // with a meeting-decline flavour.
            return (
              <ActionButton
                key={optKey}
                active={opt.primary}
                disabled={busy}
                onClick={() => decide('draft_reply', { calendarRsvp: 'propose_alternative', conflicts: item.meeting?.conflicts })}
              >
                {opt.label}
              </ActionButton>
            );
          }
          return (
            <ActionButton
              key={optKey}
              active={opt.primary || suggested === opt.id}
              disabled={busy}
              onClick={() => decide(opt.id)}
            >
              {opt.label}
            </ActionButton>
          );
        })}
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={hide}>Hide pattern</Button>
      </div>

      {/* Keep-or-change panel — shown when MD clicks Delegate and Brain has a pick */}
      {delegateConfirmOpen && (item.suggestedDelegateeEmail || item.suggestedDelegateeUserId) && (
        <div style={{
          marginTop: 'var(--s-3)', padding: 'var(--s-3)',
          background: 'var(--bg-2)', border: '1px solid var(--accent-dim)',
          borderRadius: 'var(--r-sm)',
        }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            Brain suggests <strong style={{ color: 'var(--accent)' }}>{item.suggestedDelegateeName ?? item.suggestedDelegateeEmail}</strong>
            {item.rationale && <> — {item.rationale.toLowerCase().replace(/^md chose this /, '')}</>}. Keep or pick someone else?
          </div>
          <div style={{ display: 'flex', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
            <Button
              variant="primary" size="sm" disabled={busy}
              onClick={() => {
                setDelegateConfirmOpen(false);
                decide('delegate', {
                  delegatee: {
                    email: item.suggestedDelegateeEmail,
                    name: item.suggestedDelegateeName,
                    userId: item.suggestedDelegateeUserId,
                  },
                });
              }}
            >
              Keep — send to {item.suggestedDelegateeName ?? 'them'}
            </Button>
            <Button
              variant="secondary" size="sm" disabled={busy}
              onClick={() => {
                setDelegateConfirmOpen(false);
                setPickerOpen(true);
              }}
            >
              Pick someone else
            </Button>
            <Button
              variant="ghost" size="sm" disabled={busy}
              onClick={() => setDelegateConfirmOpen(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      <DelegateePicker
        open={pickerOpen}
        context={{
          itemType: item.itemType,
          archetype: item.archetype,
          senderDomain: item.senderDomain,
        }}
        onCancel={() => setPickerOpen(false)}
        onPick={(who) => {
          setPickerOpen(false);
          decide('delegate', { delegatee: who });
        }}
      />

      {/* Inline drafts — any pending draft tied to this feed event lands
          right under its source card, so the MD reads → reviews → sends
          without scrolling away. */}
      {drafts.length > 0 && (
        <div style={{ marginTop: 'var(--s-3)', paddingTop: 'var(--s-3)', borderTop: '1px dashed var(--border)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 'var(--s-2)' }}>
            ✎ Draft{drafts.length > 1 ? 's' : ''} I wrote for you
          </div>
          {drafts.map((d) => <DraftCard key={d.id} draft={d} onAction={onDecided} notify={notify} />)}
        </div>
      )}
    </Card>
  );
}

// Build the action-button list for an attention item. Suggested action is
// always present; item-type-aware options (schedule for meetings, etc.) are
// added conditionally. Order: suggested first (rendered primary), alts follow.
function buildAttentionOptions(item) {
  const suggested = item.suggestedAction;
  const base = [
    { id: 'draft_reply',   label: '✎ Draft reply' },
    { id: 'delegate',      label: '→ Delegate' },
    { id: 'add_open_item', label: '+ Open Item' },
    { id: 'ignore',        label: '✗ Ignore' },
  ];
  if (item.itemType === 'meeting') {
    base.unshift({ id: 'schedule_meeting', label: '📅 Accept / Schedule' });
  }
  if (item.archetype === 'inform_only' || item.archetype === 'acknowledge') {
    base.push({ id: 'acknowledge', label: '👁 Acknowledge' });
  }
  // Suggested action first so it renders as primary
  return base.sort((a, b) => (a.id === suggested ? -1 : b.id === suggested ? 1 : 0));
}

function ActionButton({ active, disabled, onClick, children }) {
  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      size="sm"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function OpenItemRow({ item }) {
  return (
    <Card size="sm" style={{ marginBottom: 'var(--s-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--fw-medium)' }}>{item.title}</div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
            {item.type} · priority {item.priority ?? 'medium'} · {item.status}
          </div>
        </div>
        <Pill variant={item.priority === 'critical' || item.priority === 'high' ? 'warning' : undefined}>
          {(item.priority || 'medium').toUpperCase()}
        </Pill>
      </div>
    </Card>
  );
}

function DraftCard({ draft, onAction, notify }) {
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState({ subject: draft.subject ?? '', body: draft.body ?? '' });
  const [editing, setEditing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const isWhatsApp = draft.channel === 'whatsapp';

  const send = async () => {
    setBusy(true);
    try {
      const payload = editing ? { body: edit.body, ...(isWhatsApp ? {} : { subject: edit.subject, to: draft.to }) } : {};
      const r = await api.post(`/brief/drafts/${draft.id}/send`, payload);
      notify?.(isWhatsApp ? `WhatsApp sent to ${draft.to}` : `Email sent to ${draft.to}`, 'success');
      onAction?.();
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Send failed';
      notify?.(msg, 'error');
    } finally {
      setBusy(false);
    }
  };
  const openReject = () => { setRejecting(true); setRejectReason(''); };
  const cancelReject = () => { setRejecting(false); setRejectReason(''); };
  const confirmReject = async () => {
    setBusy(true);
    try {
      await api.post(`/brief/drafts/${draft.id}/reject`, { reason: rejectReason });
      notify?.('Draft rejected — Brain noted', 'info');
      onAction?.();
    } catch (err) {
      notify?.(err?.response?.data?.error || 'Reject failed', 'error');
    } finally {
      setBusy(false);
      setRejecting(false);
      setRejectReason('');
    }
  };

  const channelColor = isWhatsApp
    ? { bg: 'rgba(37, 211, 102, 0.15)', fg: '#25d366' }
    : { bg: 'rgba(234, 67, 53, 0.15)', fg: '#ea4335' };
  const channelIconName = isWhatsApp ? 'message-circle' : 'mail';
  const toLabel = isWhatsApp
    ? (draft.to || 'WhatsApp chat')
    : (draft.to || '—');

  return (
    <Card size="sm" style={{ marginBottom: 'var(--s-2)', borderColor: 'var(--accent)', background: 'rgba(204,107,74,0.04)' }}>
      <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{
          width: 24, height: 24, borderRadius: '50%',
          background: channelColor.bg, color: channelColor.fg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name={channelIconName} size={12} />
        </div>
        <Pill variant="accent">DRAFT</Pill>
        <strong style={{ fontSize: 'var(--fs-sm)' }}>To: {toLabel}</strong>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{timeAgo(draft.createdAt)}</span>
        {draft.provider && <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>· via {draft.provider}</span>}
      </div>
      {editing ? (
        <>
          {!isWhatsApp && (
            <input
              value={edit.subject}
              onChange={(e) => setEdit({ ...edit, subject: e.target.value })}
              placeholder="Subject"
              style={{ width: '100%', marginTop: 'var(--s-2)', padding: '6px 8px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}
            />
          )}
          <textarea
            value={edit.body}
            onChange={(e) => setEdit({ ...edit, body: e.target.value })}
            rows={isWhatsApp ? 4 : 8}
            style={{ width: '100%', marginTop: 'var(--s-2)', padding: 'var(--s-3) var(--s-4)', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', color: 'var(--text)', fontSize: 'var(--fs-base)', lineHeight: 1.6, resize: 'vertical', fontFamily: 'inherit' }}
          />
        </>
      ) : (
        <>
          {draft.subject && (
            <div style={{ fontSize: 'var(--fs-sm)', marginTop: 'var(--s-2)', fontWeight: 'var(--fw-medium)' }}>{draft.subject}</div>
          )}
          {/* Draft body is always visible — drafts exist to be reviewed.
              Readable font scale (fs-base), generous padding + line height. */}
          <div style={{
            marginTop: 'var(--s-2)',
            padding: 'var(--s-4)',
            background: 'var(--bg-1)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
            fontSize: 'var(--fs-base)',
            whiteSpace: 'pre-wrap',
            fontFamily: 'inherit',
            color: 'var(--text)',
            lineHeight: 1.6,
          }}>
            {draft.body || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>(empty draft — click Edit to write one)</span>}
          </div>
        </>
      )}
      {/* Inline reject flow — opens a small reason textarea right here
          instead of a browser prompt. MD can also just Cancel without
          entering a reason. */}
      {rejecting && (
        <div style={{
          marginTop: 'var(--s-3)', padding: 'var(--s-3)',
          background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
        }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            Why is this wrong? (Optional — helps Brain learn.)
          </div>
          <textarea
            autoFocus
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            placeholder="e.g. Tone was off, or I wanted to handle this myself"
            style={{
              width: '100%', padding: 'var(--s-2) var(--s-3)',
              background: 'var(--bg-1)', border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)', color: 'var(--text)',
              fontSize: 'var(--fs-sm)', fontFamily: 'inherit', lineHeight: 1.5,
              resize: 'vertical', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
            <Button size="sm" variant="ghost" disabled={busy} onClick={cancelReject}>Keep draft</Button>
            <Button size="sm" variant="danger" disabled={busy} onClick={confirmReject}>
              {busy ? 'Discarding…' : 'Discard draft'}
            </Button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-3)', flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" onClick={() => setEditing((e) => !e)}>{editing ? 'Done editing' : 'Edit'}</Button>
        <div style={{ flex: 1 }} />
        <Button variant="secondary" size="sm" disabled={busy || rejecting} onClick={openReject} title="Delete this draft — it will not be sent">Discard</Button>
        <Button variant="primary" size="sm" disabled={busy || rejecting} onClick={send}>{busy ? '…' : 'Send'}</Button>
      </div>
      <FeedbackButtons
        subjectType="draft"
        subjectId={String(draft.id)}
        context={{ channel: draft.channel, to: draft.to, subject: draft.subject, body: draft.body }}
        compact
      />
    </Card>
  );
}

function InsightCard({ insight, onAction }) {
  const [busy, setBusy] = useState(false);

  const createRule = async () => {
    setBusy(true);
    try { await api.post(`/brief/insights/${insight.id}/create-rule`); onAction?.(); }
    catch {} finally { setBusy(false); }
  };
  const dismiss = async () => {
    setBusy(true);
    try { await api.post(`/brief/insights/${insight.id}/dismiss`); onAction?.(); }
    catch {} finally { setBusy(false); }
  };

  return (
    <Card size="sm" style={{ marginBottom: 'var(--s-2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 'var(--s-3)', alignItems: 'center' }}>
        <div style={{ flex: 1, fontSize: 'var(--fs-sm)' }}>{insight.description ?? insight}</div>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          {insight.canCreateRule && (
            <Button variant="primary" size="sm" disabled={busy} onClick={createRule}>Yes, create rule</Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={dismiss}>Not now</Button>
        </div>
      </div>
    </Card>
  );
}

function RulePromotionCard({ rule, onAction }) {
  const [busy, setBusy] = useState(false);
  const activate = async () => {
    setBusy(true);
    try { await api.post(`/shadow/rules/${rule.id}/promote`, { targetMode: 'ACTIVE' }); onAction?.(); }
    catch {} finally { setBusy(false); }
  };
  const keep = async () => {
    setBusy(true);
    try { await api.post(`/shadow/rules/${rule.id}/keep-shadow`, {}); onAction?.(); }
    catch {} finally { setBusy(false); }
  };
  return (
    <Card size="sm" style={{ marginBottom: 'var(--s-2)', borderColor: 'var(--accent)', background: 'rgba(204,107,74,0.06)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--s-3)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 'var(--fw-semibold)' }}>{rule.name}</div>
          <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 2 }}>{rule.description}</div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
            Watched {rule.evidence ?? 0} times · {Math.round((rule.agreement ?? 0) * 100)}% consistent
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={keep}>Keep watching</Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={activate}>Activate</Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * StandingInstructionsSection — Day Brief quick-add affordance.
 *
 * The full management UI (list, pause, archive) lives in My Rules →
 * Standing Instructions. Day Brief keeps only the one-liner input so
 * the user can capture a rule in the moment without leaving the brief.
 * Active rule counts surface as a chip with a deep-link to manage.
 */
function StandingInstructionsSection({ instructions, isAdmin, onChange, notify }) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState(isAdmin ? 'client' : 'user');
  useEffect(() => { if (!isAdmin && scope === 'client') setScope('user'); }, [isAdmin, scope]);

  const save = async () => {
    const clean = text.trim();
    if (!clean) return;
    setSaving(true);
    try {
      const r = await api.post('/brain/instructions', { text: clean, scope });
      const kind = r.data?.structured?.kind ?? 'instruction';
      const sc = r.data?.scope ?? scope;
      notify?.(`Saved ${sc === 'client' ? 'tenant-wide' : 'personal'} ${kind.replace(/_/g, ' ')} — Brain will respect this from now on`, 'success');
      setText('');
      await onChange?.();
    } catch (err) {
      notify?.(err?.response?.data?.error ?? 'Could not save instruction', 'error');
    } finally {
      setSaving(false);
    }
  };

  const list = Array.isArray(instructions) ? instructions : [];
  const clientCount = list.filter((i) => i.scope === 'client').length;
  const userCount = list.filter((i) => i.scope !== 'client').length;
  const total = list.length;

  const placeholder = scope === 'client'
    ? `Set a tenant-wide rule… e.g. "All client emails must be acknowledged within 4 hours"`
    : `Tell Brain what to do… e.g. "Always delegate Raazia's emails to Asad"`;

  return (
    <Section
      id="standing-instructions"
      title="Standing instructions"
      sub="Capture a rule in the moment. Manage the full list in My Rules → Standing Instructions."
      icon="command"
      help={(
        <div>
          <strong>What this is.</strong> Explicit orders you've given Brain — "always delegate Raazia's emails to Asad", "alert me if anyone mentions EXIM", "follow up with Fahim if no reply by Thursday".<br /><br />
          <strong>How it works.</strong> Type the instruction in plain English. Brain parses it into a structured rule (subject + condition + action + due date) and respects it on every answer, triage decision, and autonomous action.<br /><br />
          <strong>How it helps.</strong> The 6th layer of MyOS. Brain never contradicts an active standing instruction — when its answer is shaped by one, it tells you which rule it applied.<br /><br />
          <strong>Where to manage.</strong> This box is the quick-add only. To list, pause, resume or archive existing rules, open <em>My Rules → Standing Instructions</em>.
        </div>
      )}
    >
      <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', marginBottom: 'var(--s-2)', flexWrap: 'wrap' }}>
        {isAdmin && (
          <div style={{ display: 'inline-flex', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 2 }}>
            <button
              type="button"
              onClick={() => setScope('client')}
              style={{
                padding: '6px 10px', fontSize: 'var(--fs-xs)', fontWeight: 600,
                border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                background: scope === 'client' ? 'var(--accent-soft, rgba(59,130,246,0.18))' : 'transparent',
                color: scope === 'client' ? '#60a5fa' : 'var(--text-muted)',
              }}
              title="Rule applies to every user in the tenant"
            >Client rule</button>
            <button
              type="button"
              onClick={() => setScope('user')}
              style={{
                padding: '6px 10px', fontSize: 'var(--fs-xs)', fontWeight: 600,
                border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                background: scope === 'user' ? 'rgba(34,197,94,0.18)' : 'transparent',
                color: scope === 'user' ? '#4ade80' : 'var(--text-muted)',
              }}
              title="Rule applies only to you"
            >My rule</button>
          </div>
        )}
        <input
          type="text" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !saving) save(); }}
          placeholder={placeholder}
          style={{
            flex: 1, minWidth: 260, padding: '10px 12px', fontSize: 'var(--fs-sm)',
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)', color: 'var(--text)',
          }}
          disabled={saving}
        />
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !text.trim()}>
          {saving ? 'Saving…' : (scope === 'client' ? 'Set tenant rule' : 'Tell Brain')}
        </Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
        {total > 0 ? (
          <>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              {total} active rule{total === 1 ? '' : 's'}
              {clientCount > 0 && ` · ${clientCount} tenant`}
              {userCount > 0 && ` · ${userCount} mine`}
            </span>
            <a
              href="/?tab=rules&subtab=standing"
              onClick={(e) => {
                e.preventDefault();
                const url = new URL(window.location.href);
                url.searchParams.set('tab', 'rules');
                url.searchParams.set('subtab', 'standing');
                window.location.assign(url.toString());
              }}
              style={{ fontSize: 'var(--fs-xs)', color: 'var(--accent)', textDecoration: 'none' }}
            >Manage in My Rules →</a>
          </>
        ) : (
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            No standing instructions yet — anything you type here becomes a rule Brain reads before every decision.
          </span>
        )}
      </div>
    </Section>
  );
}

/**
 * BrainLearnedSection — "what Brain learned from your 👍/👎 this week".
 * Surfaces feedback counts, criticality calibration state, recent
 * 👎 diagnoses (with hypothesis + likely fix), and Brain's own
 * self-recommendations. Only renders when there's something to show.
 */
function BrainLearnedSection({ learned }) {
  if (!learned) return null;
  const { feedback, diagnosesByCategory, recentDiagnoses, calibration, brainSuggests, windowDays } = learned;
  const upN = feedback?.up ?? 0;
  const downN = feedback?.down ?? 0;
  if (upN === 0 && downN === 0 && (recentDiagnoses?.length ?? 0) === 0 && (calibration?.sampleCount ?? 0) === 0) {
    return null;  // nothing learned yet — keep Day Brief uncluttered
  }

  return (
    <Section
      id="brain-learned"
      title="What Brain learned this week"
      sub={`Feedback rolled up over the last ${windowDays} day${windowDays === 1 ? '' : 's'}, calibration updates, and what Brain is adjusting.`}
      icon="zap"
      help={(
        <div>
          <strong>What this is.</strong> A weekly digest of your 👍 / 👎 feedback on Brain's outputs, plus the calibration changes Brain made in response — threshold shifts, dimension reweighting, retrieval tuning.<br /><br />
          <strong>How it works.</strong> Each thumbs-up or thumbs-down you give in chat or on a triage decision feeds the shadow-scoring service. Once enough samples accumulate, Brain adjusts its critical threshold per-user and surfaces the changes here so you see what's moving.<br /><br />
          <strong>How it helps.</strong> Brain becomes calibrated to <em>you</em> over time. The "what I'm adjusting" line is Brain's own commitment to do better next week.<br /><br />
          <strong>Make it more useful for you:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li><em>Click 👍 / 👎 more often</em> — even one tap per chat answer or triage decision compounds. More samples = sharper calibration.</li>
            <li><em>Read the diagnoses block</em> when 👎s pile up — Brain explains what it thinks went wrong; you can correct the diagnosis if it's misreading why you down-voted.</li>
            <li><em>Review weekly</em> — if "what I'm adjusting" doesn't match your intent, leave a 👎 with a comment so Brain re-calibrates the calibration.</li>
            <li><strong>Example:</strong> You 👎 three Brain answers about Fahim because they cited stale meeting notes. Brain logs "retrieval miss on stale data", and next week you see "extending freshness preference for Fahim queries to last 14 days".</li>
          </ul>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
        {/* Top counters */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <Pill style={{ background: 'rgba(34,197,94,0.15)', color: '#4ade80', borderColor: 'rgba(34,197,94,0.4)' }}>
            👍 {upN}
          </Pill>
          <Pill style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171', borderColor: 'rgba(239,68,68,0.4)' }}>
            👎 {downN}
          </Pill>
          {calibration?.sampleCount > 0 && (
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              Critical-band threshold calibrated to <strong>{Number(calibration.criticalThreshold).toFixed(2)}</strong> after {calibration.sampleCount} learning sample{calibration.sampleCount === 1 ? '' : 's'}.
            </span>
          )}
        </div>

        {/* Brain's self-recommendations */}
        {Array.isArray(brainSuggests) && brainSuggests.length > 0 && (
          <div style={{
            padding: '12px 14px',
            border: '1px solid rgba(99,102,241,0.35)',
            borderRadius: 'var(--r-md)',
            background: 'rgba(99,102,241,0.08)',
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: '#c7d2fe', marginBottom: 6 }}>
              What I'm adjusting
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-sm)', color: 'var(--text)', lineHeight: 1.55 }}>
              {brainSuggests.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}

        {/* Recent 👎 diagnoses */}
        {recentDiagnoses?.length > 0 && (
          <div>
            <div style={{
              fontSize: 'var(--fs-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.4px',
              color: 'var(--text-muted)', marginBottom: 6,
            }}>
              Recent 👎 diagnoses
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
              {recentDiagnoses.map((d) => (
                <div key={d.id} style={{
                  padding: '10px 12px', background: 'var(--bg-2)',
                  border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <Pill>{String(d.category).replace(/_/g, ' ')}</Pill>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      on {String(d.subjectType).replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)', lineHeight: 1.5 }}>
                    {d.hypothesis}
                  </div>
                  {d.likelyFix && (
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4, lineHeight: 1.5 }}>
                      <strong>Brain's fix:</strong> {d.likelyFix}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Categorical breakdown */}
        {diagnosesByCategory?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {diagnosesByCategory.map((c) => (
              <Pill key={c.category}>
                {String(c.category).replace(/_/g, ' ')} · {c.n}
              </Pill>
            ))}
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * BrainCognitiveSection — surfaces Brain's "thinking out loud":
 *   - Mind state:  one-paragraph "what's happening right now", updated every 30 min
 *   - Observations: 5 urgency-ranked things Brain noticed this cycle
 * "Rethink" button triggers an immediate cognitive tick.
 */
function BrainCognitiveSection({ cognitive, onRerun, notify }) {
  const [busy, setBusy] = useState(false);
  const mindBody = cognitive?.mindState?.body;
  const updated = cognitive?.mindState?.updatedAt;
  const obs = Array.isArray(cognitive?.observations) ? cognitive.observations : [];

  const displayBody = String(mindBody ?? '')
    .replace(/^#\s+Mind State\s*\n+/i, '')
    .replace(/^\*\*Updated:\*\*[^\n]*\n+/i, '')
    .trim();

  const rerun = async () => {
    setBusy(true);
    try {
      await api.post('/brief/cognitive/run');
      notify?.('Brain is re-thinking…', 'info');
      await onRerun?.();
    } catch (err) {
      notify?.(err?.response?.data?.error ?? 'Re-think failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  if (!displayBody && obs.length === 0) return null;

  const urgencyColor = (u) =>
    u >= 0.6 ? { bg: 'rgba(239,68,68,0.12)', fg: '#f87171' } :
    u >= 0.4 ? { bg: 'rgba(245,158,11,0.12)', fg: '#f59e0b' } :
               { bg: 'rgba(156,163,175,0.12)', fg: 'var(--text-muted)' };

  return (
    <Section
      id="brain-noticing"
      title="Brain is noticing"
      sub={updated ? `Re-thinks every 30 minutes · last ${timeAgo(updated)}` : 'Continuous awareness loop'}
      icon="eye"
      help={(
        <div>
          <strong>What this is.</strong> Brain's running mental state — a paragraph describing what Brain is currently watching, plus a short list of fresh observations it has formed since the last cycle.<br /><br />
          <strong>How it works.</strong> The cognitive worker re-runs every 30 minutes. It reads recent feed events, open items, and standing instructions, then produces a short narrative + observations. Click <em>Rethink now</em> to force an immediate cycle.<br /><br />
          <strong>How it helps.</strong> See the difference between what Brain <em>did</em> (Brief section) and what Brain is <em>thinking about</em> right now. Useful when you suspect Brain is missing something — the noticing block usually shows whether it's tracked.<br /><br />
          <strong>Make it more useful for you:</strong>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            <li><em>Click "Rethink now"</em> after large inbox events (long meeting, batch of emails) so Brain refreshes awareness right away.</li>
            <li><em>Add standing instructions</em> for things Brain should always notice — "watch for any email containing 'audit'" — and they show up here and in Risk Radar.</li>
            <li><em>If something important is missing</em>: it usually means the source isn't connected (no Gmail, no WhatsApp). Check Connectors.</li>
            <li><strong>Example:</strong> Brain notices <em>"Fahim mentioned SAP migration twice this week — no open item exists yet."</em> Click → opens the related messages → you decide to add an open item. Brain stops reminding once it's tracked.</li>
          </ul>
        </div>
      )}
      right={
        <Button size="sm" variant="ghost" disabled={busy} onClick={rerun}>
          {busy ? 'Re-thinking…' : 'Rethink now'}
        </Button>
      }
    >
      {displayBody && (
        <div style={{
          padding: 'var(--s-3) var(--s-4)', marginBottom: obs.length > 0 ? 'var(--s-3)' : 0,
          background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)', fontSize: 'var(--fs-md)',
          color: 'var(--text)', lineHeight: 1.55,
        }}>
          {displayBody}
        </div>
      )}
      {obs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
          {obs.slice(0, 5).map((o) => {
            const c = urgencyColor(o.urgency ?? 0);
            return (
              <div key={o.id} style={{
                padding: '10px 12px', background: 'var(--bg-2)',
                border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 10,
                    background: c.bg, color: c.fg,
                    fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px',
                    whiteSpace: 'nowrap', flexShrink: 0,
                  }}>
                    {(o.kind ?? 'note').replace(/_/g, ' ')}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text)' }}>
                      {o.title}
                    </div>
                    {o.summary && (
                      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>
                        {o.summary}
                      </div>
                    )}
                  </div>
                </div>
                {o.id && (
                  <FeedbackButtons
                    subjectType="observation"
                    subjectId={o.id}
                    context={{ kind: o.kind, title: o.title, summary: o.summary, urgency: o.urgency }}
                    compact
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
