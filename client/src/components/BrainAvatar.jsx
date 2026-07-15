/**
 * BrainAvatar — persistent top-right "living brain" avatar.
 *
 * Purpose: the user should feel that Brain is always thinking for them —
 * not just when they open the Day Brief. This avatar lives above every
 * authenticated page and:
 *
 *   - Breathes quietly when idle (slow gradient pulse).
 *   - Pulses faster + spins its halo while Brain is actively working
 *     (within 2 minutes of a cognitive tick).
 *   - Shows a soft "new" badge when fresh observations or a new mind
 *     state have arrived since the last time the user looked.
 *   - Opens a compact side panel on click — current mind state, last 5
 *     observations, a "Rethink now" action.
 *
 * Self-contained: no new routes, no context, one file. Polls
 * /brief/cognitive every 60s with exponential backoff on failure.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';

const POLL_MS_BASE = 60_000;            // 60s steady-state poll
const ACTIVE_WINDOW_MS = 2 * 60_000;    // within 2 minutes of last tick = "thinking now"
const LAST_SEEN_KEY = 'myos:brain-avatar:last-seen';

// Status messages the avatar rotates through when it's in "thinking" mode.
// Any page can flag thinking-mode via window.dispatchEvent('brain:thinking:start' / ':end').
const THINKING_MESSAGES = [
  'Reading your inbox and chats…',
  'Checking your standing rules…',
  'Noticing what changed overnight…',
  'Catching up on threads that went quiet…',
  'Digesting your meetings…',
  'Finding what needs you today…',
  'Pulling it all together…',
];

export default function BrainAvatar() {
  const [open, setOpen] = useState(false);
  const [cog, setCog] = useState(null);       // { mindState, observations }
  const [lastFetch, setLastFetch] = useState(0);
  const [retryDelay, setRetryDelay] = useState(POLL_MS_BASE);
  const [rethinking, setRethinking] = useState(false);
  const pollRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get('/brief/cognitive');
      setCog(r.data ?? { mindState: null, observations: [] });
      setLastFetch(Date.now());
      setRetryDelay(POLL_MS_BASE);
    } catch {
      setRetryDelay((d) => Math.min(d * 2, 5 * 60_000));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(() => load(), retryDelay);
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [retryDelay, lastFetch, load]);

  // External "thinking" mode — any page can start/stop it by firing a
  // `brain:thinking:start` / `brain:thinking:end` event on window. Used by
  // Day Brief when its parallel loads are running so the avatar visually
  // becomes the source of the "Brain is thinking" feedback.
  const [externalThinking, setExternalThinking] = useState(false);
  useEffect(() => {
    const onStart = () => setExternalThinking(true);
    const onEnd   = () => setExternalThinking(false);
    window.addEventListener('brain:thinking:start', onStart);
    window.addEventListener('brain:thinking:end',   onEnd);
    return () => {
      window.removeEventListener('brain:thinking:start', onStart);
      window.removeEventListener('brain:thinking:end',   onEnd);
    };
  }, []);

  // Derive state: is Brain "thinking right now"?
  const latestTickIso = cog?.mindState?.updatedAt
    || (cog?.observations?.[0]?.lastUpdatedAt ?? null);
  const latestTickTs = latestTickIso ? Date.parse(latestTickIso) : null;
  const isActive = (latestTickTs != null && (Date.now() - latestTickTs) < ACTIVE_WINDOW_MS)
    || externalThinking;

  // Rotating message — only meaningful while in "thinking" mode (either a
  // recent cognitive tick or an external page-load event).
  const [msgIdx, setMsgIdx] = useState(0);
  useEffect(() => {
    if (!isActive) return undefined;
    const t = setInterval(() => setMsgIdx((i) => (i + 1) % THINKING_MESSAGES.length), 1800);
    return () => clearInterval(t);
  }, [isActive]);

  // Unread badge: show when observations or mindState updated since last time user opened the panel
  const [lastSeenTs, setLastSeenTs] = useState(() => {
    try { return Number(localStorage.getItem(LAST_SEEN_KEY) ?? 0); } catch { return 0; }
  });
  const hasNew = latestTickTs != null && latestTickTs > lastSeenTs;

  const obsCount = Array.isArray(cog?.observations) ? cog.observations.length : 0;

  const rethink = useCallback(async () => {
    setRethinking(true);
    try {
      await api.post('/brief/cognitive/run');
      // small delay then refetch so the new observations land
      setTimeout(() => load(), 1500);
    } catch { /* surfaced via banner */ }
    finally { setRethinking(false); }
  }, [load]);

  const togglePanel = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next) {
        const now = Date.now();
        setLastSeenTs(now);
        try { localStorage.setItem(LAST_SEEN_KEY, String(now)); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  // Close panel on Escape
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const mindBody = useMemo(() => {
    const raw = String(cog?.mindState?.body ?? '').trim();
    return raw
      .replace(/^#\s+Mind State\s*\n+/i, '')
      .replace(/^\*\*Updated:\*\*[^\n]*\n+/i, '')
      .trim();
  }, [cog?.mindState?.body]);

  const observations = Array.isArray(cog?.observations) ? cog.observations.slice(0, 5) : [];

  return (
    <>
      <style>{brainAvatarKeyframes}</style>

      {/* ── Avatar: circle when idle, pill when thinking ───────
           Idle orb sits at top:14 in the header margin. When it expands
           into the thinking pill, we drop it to top:70 so it clears the
           tenant badge + user menu on the top bar to its left. */}
      <button
        type="button"
        aria-label={isActive ? 'Nexeo is thinking — open panel' : 'Open Nexeo panel'}
        aria-live="polite"
        onClick={togglePanel}
        style={{
          position: 'fixed',
          top: isActive ? 70 : 14,
          right: 18,
          height: 48,
          // Smoothly morph between a round avatar and a ~420px pill.
          width: isActive ? 'min(420px, calc(100vw - 36px))' : 48,
          padding: 0,
          border: 'none',
          borderRadius: 24,
          cursor: 'pointer',
          background: isActive
            ? 'linear-gradient(120deg, rgba(99,102,241,0.22), rgba(168,85,247,0.18) 35%, rgba(236,72,153,0.18) 70%, rgba(14,165,233,0.22))'
            : 'transparent',
          backdropFilter: isActive ? 'blur(6px)' : 'none',
          WebkitBackdropFilter: isActive ? 'blur(6px)' : 'none',
          boxShadow: isActive ? '0 10px 30px rgba(0,0,0,0.35), 0 0 0 1px rgba(99,102,241,0.35)' : 'none',
          zIndex: 'var(--z-toast, 900)',
          outline: 'none',
          overflow: 'hidden',
          transition: 'width 260ms ease, top 260ms ease, background 260ms ease, box-shadow 260ms ease',
          display: 'flex', alignItems: 'center',
          flexDirection: 'row-reverse',  // orb stays anchored to the right edge
          gap: 10, paddingLeft: isActive ? 16 : 0, paddingRight: 0,
        }}
      >
        {/* Orb (always rendered on the right) */}
        <div style={{ position: 'relative', width: 48, height: 48, flexShrink: 0 }}>
          {/* Rainbow halo */}
          <div style={{
            position: 'absolute', inset: 0, borderRadius: '50%',
            background: 'conic-gradient(from 0deg, #6366f1, #a855f7, #ec4899, #0ea5e9, #6366f1)',
            animation: `brainAvatarSpin ${isActive ? '4s' : '14s'} linear infinite`,
            opacity: isActive ? 1 : 0.75,
            filter: 'blur(0.5px)',
          }} />
          {/* Inner core with pulse */}
          <div style={{
            position: 'absolute', inset: 4, borderRadius: '50%',
            background: 'radial-gradient(circle at 35% 35%, #eef2ff 0%, #a5b4fc 45%, #6366f1 85%)',
            animation: `brainAvatarPulse ${isActive ? '1.8s' : '3.6s'} ease-in-out infinite`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 16px rgba(99,102,241,0.35)',
          }}>
            <div style={{
              width: 16, height: 16, borderRadius: '50%',
              border: '2px solid rgba(255,255,255,0.85)',
              boxShadow: 'inset 0 0 4px rgba(99,102,241,0.5)',
              position: 'relative',
            }}>
              <div style={{
                position: 'absolute', top: -4, left: 4, width: 6, height: 6, borderRadius: '50%',
                background: '#fff', opacity: 0.85,
              }} />
            </div>
          </div>
          {/* New-observation badge — hidden while pill is expanded to avoid clipping */}
          {hasNew && !open && !isActive && (
            <div style={{
              position: 'absolute', top: -2, right: -2,
              width: 14, height: 14, borderRadius: '50%',
              background: '#ec4899',
              border: '2px solid var(--bg, #0b0b0f)',
              animation: 'brainAvatarBadge 1.8s ease-in-out infinite',
            }} />
          )}
        </div>

        {/* Pill content — only visible while thinking */}
        {isActive && (
          <div style={{
            flex: 1, minWidth: 0, textAlign: 'left',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
            height: '100%', paddingBlock: 6,
            animation: 'brainPillFadeIn 280ms ease-out',
          }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase',
              color: '#c7d2fe', lineHeight: 1,
            }}>
              <span style={{
                display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                background: '#a855f7',
                animation: 'brainAvatarPulse 1.2s ease-in-out infinite',
              }} />
              Nexeo is thinking
            </div>
            <div
              key={msgIdx}
              style={{
                fontSize: 13, fontWeight: 600,
                color: 'var(--text, #e5e7eb)',
                lineHeight: 1.2, marginTop: 3,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                animation: 'brainPillMsgSwap 1.8s ease-in-out',
              }}
            >
              {THINKING_MESSAGES[msgIdx]}
            </div>
            {/* Progress shimmer rail */}
            <div style={{
              marginTop: 5, height: 2, borderRadius: 1, overflow: 'hidden',
              background: 'rgba(255,255,255,0.08)',
            }}>
              <div style={{
                height: '100%',
                width: '45%',
                background: 'linear-gradient(90deg, transparent, #a855f7, #ec4899, transparent)',
                backgroundSize: '200% 100%',
                animation: 'brainPillShimmer 1.5s linear infinite',
              }} />
            </div>
          </div>
        )}
      </button>

      {/* ── Panel ───────────────────────────────────────────── */}
      {open && (
        <>
          {/* click-away */}
          <div
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed', inset: 0, zIndex: 'var(--z-toast, 899)',
              background: 'transparent',
            }}
          />
          <div
            role="dialog"
            aria-label="Brain panel"
            style={{
              position: 'fixed',
              top: isActive ? 126 : 70, right: 18, width: 380, maxWidth: 'calc(100vw - 36px)',
              maxHeight: 'calc(100vh - 90px)', overflow: 'auto',
              background: 'var(--bg-1, #111118)',
              border: '1px solid rgba(99,102,241,0.35)',
              borderRadius: 14,
              boxShadow: '0 18px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(99,102,241,0.08)',
              zIndex: 'var(--z-toast, 900)',
              animation: 'brainAvatarPanelIn 220ms ease-out',
            }}
          >
            <div style={{
              padding: '14px 16px 10px',
              borderBottom: '1px solid var(--border)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: isActive ? '#a855f7' : '#64748b',
                animation: isActive ? 'brainAvatarPulse 1.2s ease-in-out infinite' : 'none',
              }} />
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.14em',
                  color: '#c7d2fe',
                }}>
                  {isActive ? 'Nexeo is thinking' : 'Nexeo is listening'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {latestTickIso
                    ? `Last reflection ${timeSince(latestTickIso)} ago · ${obsCount} observation${obsCount === 1 ? '' : 's'}`
                    : 'No reflections yet — I\'ll start thinking soon.'}
                </div>
              </div>
              <button
                type="button"
                onClick={rethink}
                disabled={rethinking}
                style={{
                  padding: '6px 10px',
                  fontSize: 11, fontWeight: 600, letterSpacing: '.04em',
                  border: '1px solid rgba(99,102,241,0.45)',
                  borderRadius: 8,
                  background: 'rgba(99,102,241,0.12)',
                  color: '#c7d2fe',
                  cursor: rethinking ? 'wait' : 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {rethinking ? 'Re-thinking…' : 'Rethink'}
              </button>
            </div>

            <div style={{ padding: '14px 16px' }}>
              {mindBody ? (
                <div style={{
                  fontSize: 13, lineHeight: 1.55, color: 'var(--text, #e5e7eb)',
                  padding: '10px 12px', borderRadius: 10,
                  background: 'rgba(99,102,241,0.07)',
                  border: '1px solid rgba(99,102,241,0.16)',
                  marginBottom: 12,
                }}>
                  {mindBody}
                </div>
              ) : (
                <div style={{
                  fontSize: 13, color: 'var(--text-muted)', fontStyle: 'italic',
                  padding: '10px 12px', marginBottom: 12,
                }}>
                  I haven't formed a mind-state yet. Come back in a few minutes — I run every 30 min.
                </div>
              )}

              {observations.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Nothing has caught my attention in the last 24 hours.
                </div>
              ) : (
                <>
                  <div style={{
                    fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.12em',
                    color: 'var(--text-muted)', marginBottom: 6,
                  }}>
                    Recent observations
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {observations.map((o) => {
                      const c = urgencyColor(o.urgency ?? 0);
                      return (
                        <div key={o.id} style={{
                          display: 'flex', alignItems: 'flex-start', gap: 8,
                          padding: '8px 10px',
                          background: 'var(--bg-2)',
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                        }}>
                          <span style={{
                            flexShrink: 0, marginTop: 1,
                            width: 6, height: 6, borderRadius: '50%',
                            background: c.fg,
                          }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{
                              fontSize: 12, fontWeight: 600, color: 'var(--text)',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            }}>
                              {o.title}
                            </div>
                            {o.summary && (
                              <div style={{
                                fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4, marginTop: 2,
                                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                              }}>
                                {o.summary}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </>
  );
}

const brainAvatarKeyframes = `
  @keyframes brainAvatarSpin { to { transform: rotate(360deg); } }
  @keyframes brainAvatarPulse {
    0%, 100% { transform: scale(1);    box-shadow: 0 0 0 0 rgba(99,102,241,0.45), 0 4px 14px rgba(99,102,241,0.3); }
    50%      { transform: scale(1.06); box-shadow: 0 0 0 8px rgba(99,102,241,0.00), 0 4px 18px rgba(236,72,153,0.35); }
  }
  @keyframes brainAvatarBadge {
    0%, 100% { transform: scale(1);   opacity: 1; }
    50%      { transform: scale(1.2); opacity: 0.7; }
  }
  @keyframes brainAvatarPanelIn {
    from { opacity: 0; transform: translateY(-6px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0)    scale(1); }
  }
  @keyframes brainPillFadeIn {
    from { opacity: 0; transform: translateX(6px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  @keyframes brainPillMsgSwap {
    0%   { opacity: 0; transform: translateY(5px); }
    15%  { opacity: 1; transform: translateY(0); }
    85%  { opacity: 1; transform: translateY(0); }
    100% { opacity: 0; transform: translateY(-3px); }
  }
  @keyframes brainPillShimmer {
    0%   { background-position: -100% 0; }
    100% { background-position:  200% 0; }
  }
`;

function timeSince(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function urgencyColor(u) {
  if (u >= 0.6) return { bg: 'rgba(239,68,68,0.14)', fg: '#f87171' };
  if (u >= 0.4) return { bg: 'rgba(245,158,11,0.14)', fg: '#f59e0b' };
  return { bg: 'rgba(156,163,175,0.14)', fg: 'var(--text-muted)' };
}
