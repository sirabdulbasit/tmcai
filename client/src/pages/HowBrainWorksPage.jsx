/**
 * HowBrainWorksPage — visual onboarding for new users.
 *
 * Five stacked sections, each pairs an inline SVG diagram with a plain-
 * English "What this is" + "What you can do" pair. Built so a brand-new
 * user can scroll once and understand:
 *
 *   1. What goes IN to Brain (connectors)
 *   2. How Brain understands what came in (wiki + scope + quality gate)
 *   3. Where Brain SHOWS UP for the user (4 surfaces)
 *   4. How Brain conversates with the user (sequential prompt queue,
 *      criticality routes the channel)
 *   5. How Brain LEARNS from feedback (👍/👎 → retry → overlay → re-ranker)
 *
 * Diagrams are pure SVG — no external assets, no canvas, no libraries.
 * Colors use the existing design tokens (var(--text), var(--accent),
 * etc.) so the page automatically follows light/dark theme changes.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

const COL = {
  bg: 'var(--bg-2)',
  border: 'var(--border)',
  text: 'var(--text)',
  muted: 'var(--text-muted)',
  dim: 'var(--text-dim)',
  accent: '#cc6b4a',
  accent2: '#a5b4fc',
  good: '#4ade80',
  warn: '#f59e0b',
  danger: '#ef4444',
  panel: 'rgba(255,255,255,0.03)',
};

export default function HowBrainWorksPage() {
  const navigate = useNavigate();
  // Live state — per-user + per-tenant annotations layered on top of
  // the generic skeleton. The shape of Brain is the same for everyone;
  // what differs is each user's connectors, overlay rules, and queue.
  const [live, setLive] = useState(null);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const out = { capabilities: null, overlay: [] };
      try { const r = await api.get('/health/deep'); out.health = r.data; } catch {}
      try { const r = await api.get('/brain/overlay'); out.overlay = r.data?.rules ?? []; } catch {}
      try { const r = await api.get('/me/capabilities'); out.capabilities = r.data; } catch {}
      if (!cancelled) setLive(out);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ height: '100vh', overflowY: 'auto', background: 'var(--bg-1)' }}>
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 28px 80px' }}>
        <Header onBack={() => navigate(-1)} />
        <Section1Inputs live={live} />
        <Section2Understanding live={live} />
        <Section3Surfaces live={live} />
        <Section4Conversation live={live} />
        <SectionStarCadence />
        <Section5Learning live={live} navigate={navigate} />
        <Section6SelfRebuild live={live} />
        <Footer onBack={() => navigate('/day-brief')} />
      </div>
    </div>
  );
}

// ─── Live annotation card — rendered inside section bodies ────────
// Tone: friendly status report ("Right now, on YOUR Brain: ..."). Renders
// nothing when live state hasn't loaded yet so the skeleton is always
// visible first. Always tinted with COL.accent2 to mark "this is YOUR
// reality, not the design".
function LiveAnnotation({ children, dim = false }) {
  if (!children) return null;
  return (
    <div style={{
      marginTop: 14, padding: '10px 14px',
      background: dim ? 'rgba(255,255,255,0.02)' : 'rgba(99,102,241,0.08)',
      border: `1px solid ${dim ? COL.border : 'rgba(99,102,241,0.3)'}`,
      borderRadius: 8, fontSize: 13, color: COL.text, lineHeight: 1.5,
    }}>
      <span style={{ fontWeight: 600, color: COL.accent2, marginRight: 8 }}>
        On your Brain right now:
      </span>
      {children}
    </div>
  );
}

// ─── Header ───────────────────────────────────────────────────────────
function Header({ onBack }) {
  return (
    <div style={{ marginBottom: 36 }}>
      <button
        type="button"
        onClick={onBack}
        style={{ background: 'transparent', border: '1px solid var(--border)', color: COL.muted,
          padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, marginBottom: 20 }}
      >← Back</button>
      <h1 style={{ margin: '0 0 8px', fontSize: 28, fontWeight: 700, color: COL.text }}>
        How Nexeo Works
      </h1>
      <p style={{ margin: 0, color: COL.muted, fontSize: 15, lineHeight: 1.55, maxWidth: 720 }}>
        A short visual walkthrough of what Brain is, how it makes sense of your day, where it shows up, how it talks to you, and how it learns from your feedback.
      </p>
    </div>
  );
}

// ─── Generic section card ────────────────────────────────────────────
function SectionCard({ number, title, lead, children, action }) {
  return (
    <section style={{
      background: COL.bg, border: `1px solid ${COL.border}`, borderRadius: 14,
      padding: '24px 28px', marginBottom: 20,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 14 }}>
        <div style={{
          width: 32, height: 32, borderRadius: '50%',
          background: 'rgba(204,107,74,0.18)', color: COL.accent,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontWeight: 700, fontSize: 14,
        }}>{number}</div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: COL.text }}>{title}</h2>
      </div>
      <div style={{ color: COL.muted, fontSize: 14, lineHeight: 1.55, marginBottom: 16, marginLeft: 46 }}>
        {lead}
      </div>
      <div style={{ marginLeft: 46 }}>
        {children}
      </div>
      {action && (
        <div style={{
          marginLeft: 46, marginTop: 18, padding: '10px 14px',
          background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.3)',
          borderRadius: 8, fontSize: 13, color: COL.text, lineHeight: 1.5,
        }}>
          <span style={{ fontWeight: 600, color: COL.accent2, marginRight: 8 }}>What you can do:</span>
          {action}
        </div>
      )}
    </section>
  );
}

// ─── Section 1 — Inputs ──────────────────────────────────────────────
function Section1Inputs({ live }) {
  // Pull connector state from the health-deep payload (which already
  // surfaces feed_adapters, token_refresh, dlq_depth) — those are
  // tenant-wide AND per-user signals together.
  const liveText = (() => {
    const caps = live?.capabilities;
    if (!caps) return null;
    const connected = (caps.userConnectors ?? []).filter((c) => c.status === 'connected').map((c) => c.slug);
    const failing = (caps.userConnectors ?? []).filter((c) => c.status !== 'connected').map((c) => c.slug);
    const f = caps.feedCounts30d ?? {};
    const feedBits = [];
    if (f.gmail) feedBits.push(`${f.gmail.toLocaleString()} emails`);
    if (f.gcal || f.calendar) feedBits.push(`${(f.gcal ?? f.calendar).toLocaleString()} calendar events`);
    if (f.whatsapp) feedBits.push(`${f.whatsapp.toLocaleString()} WhatsApp messages`);
    return (
      <>
        Connected: <strong>{connected.length ? connected.join(', ') : 'none'}</strong>
        {failing.length ? <> · Needs reconnect: <strong>{failing.join(', ')}</strong></> : ''}
        {feedBits.length ? <> · Last 30 days: {feedBits.join(', ')}</> : ''}
      </>
    );
  })();
  return (
    <SectionCard
      number="1"
      title="What goes in"
      lead="Brain ingests signals from the connectors you've authorised. Every email, calendar event, WhatsApp message, and shared document becomes raw material — but only the actionable bits ever reach your Action Center."
      action="Visit Connectors to see what's connected and reconnect any expired tokens."
    >
      <InputsDiagram />
      <LiveAnnotation>{liveText}</LiveAnnotation>
    </SectionCard>
  );
}

function InputsDiagram() {
  const sources = [
    { label: 'Gmail',     icon: '📧', y: 30 },
    { label: 'Calendar',  icon: '📅', y: 90 },
    { label: 'WhatsApp',  icon: '💬', y: 150 },
    { label: 'Drive',     icon: '📁', y: 210 },
  ];
  return (
    <svg viewBox="0 0 800 280" style={{ width: '100%', height: 'auto', maxHeight: 280 }}>
      <defs>
        <linearGradient id="flowGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={COL.accent} stopOpacity="0.1" />
          <stop offset="100%" stopColor={COL.accent} stopOpacity="0.6" />
        </linearGradient>
      </defs>
      {sources.map((s) => (
        <g key={s.label}>
          <rect x="20" y={s.y - 18} width="160" height="36" rx="8"
            fill={COL.panel} stroke={COL.border} />
          <text x="40" y={s.y + 5} fontSize="18">{s.icon}</text>
          <text x="68" y={s.y + 5} fontSize="14" fill={COL.text} fontWeight="500">{s.label}</text>
          <path d={`M 180 ${s.y} C 320 ${s.y}, 400 140, 540 140`}
            fill="none" stroke="url(#flowGrad)" strokeWidth="2" />
        </g>
      ))}
      {/* Brain node */}
      <g>
        <ellipse cx="620" cy="140" rx="80" ry="58" fill="rgba(204,107,74,0.10)" stroke={COL.accent} strokeWidth="2" />
        <text x="620" y="135" textAnchor="middle" fontSize="18" fill={COL.text} fontWeight="700">Nexeo</text>
        <text x="620" y="158" textAnchor="middle" fontSize="11" fill={COL.muted}>quality gate</text>
      </g>
      {/* Output beam */}
      <path d="M 700 140 L 780 140" stroke={COL.accent} strokeWidth="2" strokeDasharray="4 4" />
      <text x="745" y="125" fontSize="11" fill={COL.muted} textAnchor="middle">curated</text>
    </svg>
  );
}

// ─── Section 2 — Understanding (wiki + scope) ────────────────────────
function Section2Understanding({ live }) {
  const liveText = (() => {
    const w = live?.capabilities?.wikiStats;
    if (!w) return null;
    const bits = [];
    if (w.orgDocs) bits.push(`${w.orgDocs} org docs (tenant)`);
    if (w.projects) bits.push(`${w.projects} project pages`);
    if (w.policies) bits.push(`${w.policies} policy pages`);
    if (w.entities) bits.push(`${w.entities} contact pages`);
    if (w.senderHistories) bits.push(`${w.senderHistories} sender histories (yours)`);
    if (w.senderTopics) bits.push(`${w.senderTopics} sender-topic pages (yours)`);
    if (w.gaps) bits.push(`${w.gaps} known gaps`);
    return bits.length ? <>Brain has built {bits.join(', ')} for you so far.</> : null;
  })();
  return (
    <SectionCard
      number="2"
      title="How Brain understands"
      lead="Every signal is filtered by a quality gate (action verb / question / explicit deadline / reply-needed) and stored in Brain's two-layer wiki. Personal threads stay private to you; tenant facts are shared across your team."
      action="Visit My Brain → wiki to browse what Brain has learned, or My Rules → Learned Preferences to see directives Brain has picked up from your feedback."
    >
      <UnderstandingDiagram />
      <LiveAnnotation>{liveText}</LiveAnnotation>
    </SectionCard>
  );
}

function UnderstandingDiagram() {
  return (
    <svg viewBox="0 0 800 240" style={{ width: '100%', height: 'auto', maxHeight: 240 }}>
      {/* Raw signal */}
      <rect x="20" y="100" width="120" height="40" rx="8" fill={COL.panel} stroke={COL.border} />
      <text x="80" y="125" textAnchor="middle" fontSize="13" fill={COL.text}>Raw signal</text>

      <path d="M 140 120 L 220 120" stroke={COL.muted} strokeWidth="1.5" markerEnd="url(#arrowhead)" />

      {/* Quality gate */}
      <g>
        <polygon points="220,90 320,90 340,120 320,150 220,150 240,120"
          fill="rgba(245,158,11,0.10)" stroke={COL.warn} strokeWidth="1.5" />
        <text x="280" y="118" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">Quality</text>
        <text x="280" y="135" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">Gate</text>
      </g>

      {/* Two paths from gate */}
      <path d="M 340 120 L 420 60" stroke={COL.good} strokeWidth="1.5" markerEnd="url(#arrowhead)" />
      <text x="380" y="78" fontSize="11" fill={COL.good}>accepted</text>
      <path d="M 340 120 L 420 200" stroke={COL.danger} strokeWidth="1.5" strokeDasharray="3 3" markerEnd="url(#arrowhead)" />
      <text x="380" y="190" fontSize="11" fill={COL.danger}>rejected (FYI / noise)</text>

      {/* Two wikis */}
      <g>
        <rect x="430" y="20" width="170" height="64" rx="10"
          fill="rgba(74,222,128,0.08)" stroke={COL.good} strokeWidth="1.5" />
        <text x="515" y="44" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">User wiki</text>
        <text x="515" y="62" textAnchor="middle" fontSize="11" fill={COL.muted}>private to you</text>
        <text x="515" y="76" textAnchor="middle" fontSize="10" fill={COL.dim}>(threads, mind state, gaps)</text>
      </g>

      <path d="M 600 50 L 660 50" stroke={COL.muted} strokeWidth="1" markerEnd="url(#arrowhead)" />

      <g>
        <rect x="430" y="160" width="170" height="64" rx="10"
          fill="rgba(99,102,241,0.10)" stroke={COL.accent2} strokeWidth="1.5" />
        <text x="515" y="184" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">Tenant wiki</text>
        <text x="515" y="202" textAnchor="middle" fontSize="11" fill={COL.muted}>shared with team</text>
        <text x="515" y="216" textAnchor="middle" fontSize="10" fill={COL.dim}>(org docs, projects, decisions)</text>
      </g>

      <path d="M 600 190 L 660 190" stroke={COL.muted} strokeWidth="1" markerEnd="url(#arrowhead)" />

      {/* Discard bin */}
      <g opacity="0.5">
        <rect x="430" y="240" width="170" height="0" />
      </g>

      {/* Brain reads both */}
      <g>
        <rect x="660" y="100" width="120" height="40" rx="8"
          fill="rgba(204,107,74,0.10)" stroke={COL.accent} strokeWidth="1.5" />
        <text x="720" y="125" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">Brain reads</text>
      </g>
      <path d="M 600 50 C 640 50, 660 100, 660 110" fill="none" stroke={COL.muted} strokeWidth="1" />
      <path d="M 600 190 C 640 190, 660 140, 660 130" fill="none" stroke={COL.muted} strokeWidth="1" />

      <defs>
        <marker id="arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M 0 0 L 6 3 L 0 6 Z" fill={COL.muted} />
        </marker>
      </defs>
    </svg>
  );
}

// ─── Section 3 — Surfaces ────────────────────────────────────────────
function Section3Surfaces({ live }) {
  void live;
  const surfaces = [
    {
      icon: '☀',
      title: 'Day Brief',
      desc: 'Morning summary of what is on your plate today — top items, risks, and what changed overnight.',
      color: '#fbbf24',
    },
    {
      icon: '✓',
      title: 'Action Center',
      desc: 'Open Items list — every actionable thing Brain has captured. Status (NEW / DELEGATED / DONE), priority, owner, and Smart cleanup.',
      color: '#3b82f6',
    },
    {
      icon: '💬',
      title: 'Brain Chat',
      desc: 'Free-form conversation. Ask anything about your people, decisions, deals, projects. Cited from the wiki.',
      color: '#a855f7',
    },
    {
      icon: '📱',
      title: 'WhatsApp',
      desc: 'Proactive prompts (one at a time). Critical events → voicenote or voice call. Routine clarifications → text.',
      color: '#22c55e',
    },
  ];
  return (
    <SectionCard
      number="3"
      title="Where Brain shows up"
      lead="Brain is built around four user-facing surfaces. Each one shows different slices of the same wiki, tuned for the moment you're in."
      action="Day Brief is the home page. Action Center is the next step when you want the full list. Brain Chat is for free-form questions. WhatsApp is for when you're away from the screen."
    >
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 12,
      }}>
        {surfaces.map((s) => (
          <div key={s.title} style={{
            padding: 16, borderRadius: 12, border: `1px solid ${COL.border}`,
            background: COL.panel, position: 'relative',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: `${s.color}22`, color: s.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, marginBottom: 10,
            }}>{s.icon}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: COL.text, marginBottom: 6 }}>{s.title}</div>
            <div style={{ fontSize: 12, color: COL.muted, lineHeight: 1.45 }}>{s.desc}</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── Section 4 — Conversation (sequential queue + criticality) ──────
function Section4Conversation({ live }) {
  const liveText = (() => {
    const q = live?.capabilities?.promptQueue;
    if (!q) return null;
    const bits = [];
    if (q.awaitingReplyTitle) {
      bits.push(<>Waiting on your reply: <em>"{q.awaitingReplyTitle}"</em></>);
    }
    if (q.queued > 0) bits.push(`${q.queued} more prompt${q.queued === 1 ? '' : 's'} queued`);
    if (q.sentLast24h > 0) bits.push(`${q.sentLast24h} sent in the last 24h`);
    if (q.answeredLast7d > 0) bits.push(`you answered ${q.answeredLast7d} in the last 7d`);
    if (!bits.length) return <>No prompts active right now — Brain is quiet.</>;
    return <>{bits.reduce((acc, b, i) => acc.length === 0 ? [b] : [...acc, ' · ', b], [])}</>;
  })();
  return (
    <SectionCard
      number="4"
      title="How Brain talks to you"
      lead="When Brain has questions for you (deadlines, owners, decisions), they go through a sequential queue — one at a time on WhatsApp. The channel depends on how urgent the question is."
      action="If Brain is asking too often or about things you don't care about, click 👎 in chat — Brain learns to back off. To pause prompts entirely, set quiet hours in your Brain Channel preferences."
    >
      <ConversationDiagram />
      <LiveAnnotation>{liveText}</LiveAnnotation>
    </SectionCard>
  );
}

function ConversationDiagram() {
  const tiers = [
    { label: 'Routine', desc: '"By when?" / "Who owns it?"',     channel: 'WhatsApp text',            color: COL.good,    icon: '💬' },
    { label: 'High',    desc: '"CFO needs an answer today"',     channel: 'WhatsApp voice note',      color: COL.warn,    icon: '🔊' },
    { label: 'Top',     desc: 'Critical decision, deadline ≤24h', channel: 'Voice call (interrupts)',  color: COL.danger,  icon: '📞' },
  ];
  return (
    <div>
      {/* Sequential flow */}
      <div style={{ marginBottom: 24, padding: '14px 18px', background: COL.panel,
        border: `1px dashed ${COL.border}`, borderRadius: 10, fontSize: 13, color: COL.muted }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ color: COL.text, fontWeight: 600 }}>Brain asks</span>
          <span>→</span>
          <span style={{ color: COL.text, fontWeight: 600 }}>You reply</span>
          <span>→</span>
          <span style={{ color: COL.text, fontWeight: 600 }}>Brain asks the next thing</span>
        </div>
        <div style={{ marginTop: 6, fontSize: 12 }}>
          One open question at a time per user — no spam, no burying. If you go silent past 48 hours, Brain auto-skips and moves on.
        </div>
      </div>

      {/* Criticality tiers */}
      <div style={{ fontSize: 12, color: COL.muted, marginBottom: 8 }}>Criticality routes the channel:</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tiers.map((t) => (
          <div key={t.label} style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px',
            border: `1px solid ${t.color}55`, background: `${t.color}10`, borderRadius: 10,
          }}>
            <div style={{ fontSize: 22 }}>{t.icon}</div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: t.color }}>{t.label}</span>
                <span style={{ fontSize: 12, color: COL.muted }}>— {t.desc}</span>
              </div>
              <div style={{ fontSize: 11, color: COL.dim, marginTop: 2 }}>via {t.channel}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Section 4.5 — Star cadence (sender-stars-driven proactive notifications)

const STAR_CADENCE_ROWS = [
  { stars: 0, status: 'Unrated — normal', firstPing: 'never proactive',  channels: '—',                                        cap: 0, quiet: '—' },
  { stars: 1, status: 'Light',            firstPing: 'after 48h',         channels: 'WhatsApp text',                            cap: 1, quiet: 'respect' },
  { stars: 2, status: 'Light',            firstPing: 'after 24h',         channels: 'WhatsApp text',                            cap: 1, quiet: 'respect' },
  { stars: 3, status: 'Important',        firstPing: 'immediate',         channels: 'WhatsApp text every 4h',                   cap: 3, quiet: 'respect' },
  { stars: 4, status: 'High',             firstPing: 'immediate',         channels: 'WhatsApp voicenote, text follow-up',       cap: 2, quiet: 'respect' },
  { stars: 5, status: 'Top critical',     firstPing: 'immediate',         channels: 'voice call → voicenote → text',            cap: 3, quiet: 'BYPASS' },
];

function SectionStarCadence() {
  return (
    <SectionCard
      number="4.5"
      title="Star cadence — how stars drive proactive nudges"
      lead="Each contact carries a 0–5 star importance rating. Stars decide how aggressively Brain pings you on WhatsApp when a message arrives from them. Set stars on the Contacts page; change anytime."
    >
      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.04)', textAlign: 'left' }}>
              <Th style={{ width: 36 }}>★</Th>
              <Th>Status</Th>
              <Th>First ping</Th>
              <Th>Channel(s)</Th>
              <Th style={{ width: 70 }}>Cap</Th>
              <Th>Quiet hours</Th>
            </tr>
          </thead>
          <tbody>
            {STAR_CADENCE_ROWS.map((r) => (
              <tr key={r.stars} style={{ borderTop: `1px solid ${COL.border}` }}>
                <Td><span style={{ color: r.stars >= 4 ? '#f0a574' : COL.text }}>{r.stars > 0 ? '★'.repeat(r.stars) : '—'}</span></Td>
                <Td>{r.status}</Td>
                <Td>{r.firstPing}</Td>
                <Td>{r.channels}</Td>
                <Td>{r.cap}</Td>
                <Td><span style={{ color: r.quiet === 'BYPASS' ? '#ef4444' : COL.dim }}>{r.quiet}</span></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14, padding: '10px 14px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${COL.border}`, borderRadius: 8, fontSize: 13, color: COL.dim, lineHeight: 1.55 }}>
        <strong style={{ color: COL.text }}>Content gate</strong> — sender stars never override content. Brain skips notifications for FYI / NOISE / auto-replies / pure thanks / calendar invites / meeting reminders. Pings only fire when the message has a real ask: action verb, question mark, deadline, or actionable intent.
      </div>

      <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${COL.border}`, borderRadius: 8, fontSize: 13, color: COL.dim, lineHeight: 1.55 }}>
        <strong style={{ color: COL.text }}>Handoff</strong> — once an item becomes in-progress or delegated, the sender-star notification cadence stops and the Living Follow-up lifecycle takes over. Nexeo tracks the responsible person, deadline, delay reasons, and new commitments until verified completion. Closed or explicitly cancelled items stop completely.
      </div>

      <div style={{ marginTop: 10, padding: '10px 14px', background: 'rgba(99,102,241,0.06)', border: `1px solid rgba(99,102,241,0.25)`, borderRadius: 8, fontSize: 13, color: COL.text, lineHeight: 1.55 }}>
        <strong>Day Brief</strong> shows what Brain did on your behalf — "Brain texted you 2× — no response yet, 1 more queued" / "Brain called you, voicenote follow-up sent" / "Brain stopped pinging — you took action".
      </div>
    </SectionCard>
  );
}

function Th({ children, style }) {
  return <th style={{ padding: '8px 10px', fontWeight: 600, color: COL.dim, fontSize: 12, ...(style ?? {}) }}>{children}</th>;
}
function Td({ children, style }) {
  return <td style={{ padding: '10px', verticalAlign: 'top', ...(style ?? {}) }}>{children}</td>;
}

// ─── Section 5 — Learning (feedback loop) ────────────────────────────
function Section5Learning({ live, navigate }) {
  const overlay = live?.overlay ?? [];
  const activeRules = overlay.filter((r) => r.active);
  const liveText = (() => {
    if (!live) return null;
    if (activeRules.length === 0) {
      return <>No rules learned yet — Brain is still neutral. Click 👎 on any answer that misses to start teaching it.</>;
    }
    const cats = Array.from(new Set(activeRules.map((r) => r.category))).slice(0, 4);
    return (
      <>
        Brain has learned <strong>{activeRules.length}</strong> rule{activeRules.length === 1 ? '' : 's'} from your feedback so far
        {cats.length ? <> (categories: {cats.join(', ')})</> : ''}
        {' '}—{' '}
        <button
          type="button"
          onClick={() => navigate('/brain?subtab=overlay')}
          style={{ background: 'transparent', border: 'none', color: COL.accent2, cursor: 'pointer', padding: 0, fontSize: 13, textDecoration: 'underline' }}
        >review them</button>.
      </>
    );
  })();
  return (
    <SectionCard
      number="5"
      title="How Brain learns from you"
      lead="Every 👍 / 👎 in chat or Day Brief feeds three independent learning loops. Together they make Brain better over time without you having to write any rules."
      action="Click 👎 (and pick a quick category) on any Brain answer that misses. Visit My Rules → Learned Preferences to review what Brain has learned, edit a rule, or reset everything."
    >
      <LearningDiagram />
      <LiveAnnotation>{liveText}</LiveAnnotation>
    </SectionCard>
  );
}

// ─── Section 6 — Self-rebuild spectrum ──────────────────────────────
// Addresses the user's question: "what if Brain rebuilds itself based on
// experience?" Layers 1-2 are live. Layers 3-4 are buildable. Layer 5 is
// off-limits by design.
function Section6SelfRebuild({ live }) {
  void live;
  const layers = [
    { n: 1, label: 'Numeric calibration',     today: 'live',     color: COL.good,   desc: 'Criticality threshold drift, retrieval boosts, prompt usage counts.' },
    { n: 2, label: 'Personal directives',      today: 'live',     color: COL.good,   desc: 'Per-user overlay rules auto-promoted from feedback (Phase B).' },
    { n: 3, label: 'Tenant-shared learnings',  today: 'planned',  color: COL.warn,   desc: 'Rules other users in your tenant inherit. Requires admin review before propagation.' },
    { n: 4, label: 'Architecture amendments',  today: 'planned',  color: COL.warn,   desc: 'Brain proposes additions to brain_architecture.md when it spots recurring patterns. You review + approve before merge.' },
    { n: 5, label: 'Code rewriting',           today: 'never',    color: COL.danger, desc: 'Brain modifies its own TypeScript source. Off-limits by design — security boundary, goes through git review.' },
  ];
  return (
    <SectionCard
      number="6"
      title="The self-rebuild spectrum"
      lead={`"What if Brain rebuilds itself based on experience?" — five levels, by ascending agency. Higher levels = more change power, more user oversight required.`}
      action="Brain proposes; you dispose. Anything that affects more than one user, or that adds to the architecture doc, requires human approval. The rule is non-negotiable."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {layers.map((L) => (
          <div key={L.n} style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '12px 16px', borderRadius: 10,
            background: `${L.color}10`, border: `1px solid ${L.color}55`,
          }}>
            <div style={{
              minWidth: 40, height: 40, borderRadius: 10,
              background: `${L.color}25`, color: L.color,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontWeight: 700, fontSize: 16,
            }}>{L.n}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: COL.text, fontSize: 14 }}>{L.label}</span>
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  padding: '2px 8px', borderRadius: 4,
                  background: L.today === 'live' ? `${COL.good}25`
                            : L.today === 'never' ? `${COL.danger}25`
                            : `${COL.warn}25`,
                  color: L.today === 'live' ? COL.good
                        : L.today === 'never' ? COL.danger
                        : COL.warn,
                }}>
                  {L.today === 'live' ? '✓ live today'
                    : L.today === 'never' ? '⊘ never (by design)'
                    : '○ planned'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: COL.muted, marginTop: 4, lineHeight: 1.45 }}>
                {L.desc}
              </div>
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

function LearningDiagram() {
  return (
    <svg viewBox="0 0 800 320" style={{ width: '100%', height: 'auto', maxHeight: 320 }}>
      <defs>
        <marker id="learnArrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M 0 0 L 6 3 L 0 6 Z" fill={COL.muted} />
        </marker>
      </defs>

      {/* User feedback */}
      <g>
        <rect x="20" y="130" width="140" height="60" rx="10"
          fill="rgba(204,107,74,0.10)" stroke={COL.accent} />
        <text x="90" y="155" textAnchor="middle" fontSize="14" fill={COL.text} fontWeight="600">Your 👍 / 👎</text>
        <text x="90" y="175" textAnchor="middle" fontSize="11" fill={COL.muted}>+ optional reason</text>
      </g>

      <path d="M 160 160 L 220 160" stroke={COL.muted} strokeWidth="1.5" markerEnd="url(#learnArrow)" />

      {/* Diagnosis */}
      <g>
        <rect x="220" y="130" width="140" height="60" rx="10"
          fill="rgba(245,158,11,0.10)" stroke={COL.warn} />
        <text x="290" y="155" textAnchor="middle" fontSize="14" fill={COL.text} fontWeight="600">Diagnosis</text>
        <text x="290" y="173" textAnchor="middle" fontSize="11" fill={COL.muted}>category + fix</text>
      </g>

      {/* Three loops */}
      <path d="M 360 145 L 440 60"  stroke={COL.muted} strokeWidth="1.5" markerEnd="url(#learnArrow)" />
      <path d="M 360 160 L 440 160" stroke={COL.muted} strokeWidth="1.5" markerEnd="url(#learnArrow)" />
      <path d="M 360 175 L 440 260" stroke={COL.muted} strokeWidth="1.5" markerEnd="url(#learnArrow)" />

      <g>
        <rect x="440" y="30" width="200" height="60" rx="10"
          fill="rgba(99,102,241,0.10)" stroke={COL.accent2} />
        <text x="540" y="55" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">In-the-moment retry</text>
        <text x="540" y="73" textAnchor="middle" fontSize="11" fill={COL.muted}>"Try again with the fix"</text>
      </g>

      <g>
        <rect x="440" y="130" width="200" height="60" rx="10"
          fill="rgba(74,222,128,0.10)" stroke={COL.good} />
        <text x="540" y="155" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">Personal prompt overlay</text>
        <text x="540" y="173" textAnchor="middle" fontSize="11" fill={COL.muted}>permanent rule</text>
      </g>

      <g>
        <rect x="440" y="230" width="200" height="60" rx="10"
          fill="rgba(168,85,247,0.10)" stroke="#a855f7" />
        <text x="540" y="255" textAnchor="middle" fontSize="13" fill={COL.text} fontWeight="600">Retrieval re-ranker</text>
        <text x="540" y="273" textAnchor="middle" fontSize="11" fill={COL.muted}>page boost / penalty</text>
      </g>

      {/* Loop back to user */}
      <path d="M 640 60 C 720 60, 740 200, 90 250 C 40 260, 30 230, 30 195"
        fill="none" stroke={COL.muted} strokeWidth="1" strokeDasharray="3 3" markerEnd="url(#learnArrow)" />
      <text x="380" y="245" fontSize="11" fill={COL.muted}>better next time</text>
    </svg>
  );
}

// ─── Footer ──────────────────────────────────────────────────────────
function Footer({ onBack }) {
  return (
    <div style={{
      marginTop: 8, padding: '20px 24px', textAlign: 'center',
      background: 'rgba(204,107,74,0.06)', border: `1px solid ${COL.border}`, borderRadius: 14,
    }}>
      <div style={{ fontSize: 14, color: COL.text, marginBottom: 12 }}>
        That's the whole loop. Brain works for you only as well as the signal you give it — connect things you care about, react to its questions, and click 👎 when it misses.
      </div>
      <button
        type="button"
        onClick={onBack}
        style={{
          padding: '8px 18px', background: COL.accent, color: '#fff',
          border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
        }}
      >Take me to Day Brief →</button>
    </div>
  );
}
