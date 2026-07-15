/**
 * Brain Learning Center — admin surface for Phase 1 self-learning data.
 *
 * Four sections:
 *   1. Pending Memories — Brain-proposed memories awaiting approval
 *   2. Active Memories — currently influencing Brain's behavior
 *   3. Recent Feedback — last 50 user feedback rows
 *   4. Audit Feed — high-risk interactions + memory mutations (admin view)
 *
 * Per nexeo_self_learning&development.md spec §13.1.
 *
 * NO Brain action can become "active" memory without explicit approval
 * here. That's the governance guarantee — admin sees what Brain wants
 * to learn before it actually learns it.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';

const SECTIONS = [
  { key: 'pending', label: 'Pending Approval', color: '#f59e0b' },
  { key: 'active',  label: 'Active Memories',  color: '#4ade80' },
  { key: 'feedback', label: 'Recent Feedback', color: '#60a5fa' },
  { key: 'audit',   label: 'Audit Feed',       color: '#a78bfa' },
];

const SENSITIVITY_COLORS = {
  low: '#666', normal: '#888', sensitive: '#f59e0b', critical: '#ef4444',
};

const FEEDBACK_TYPE_COLORS = {
  helpful: '#4ade80',
  incorrect: '#ef4444', hallucinated: '#ef4444', privacy_concern: '#ef4444',
  incomplete: '#f59e0b', too_generic: '#f59e0b', wrong_priority: '#f59e0b',
  wrong_tone: '#f59e0b', wrong_language: '#f59e0b', cross_channel_tone_issue: '#f59e0b',
  parity_issue: '#f59e0b', too_long: '#888', too_short: '#888',
};

export default function BrainLearningTab({ user, msg, setMsg }) {
  const [section, setSection] = useState('pending');
  const [pendingMemories, setPendingMemories] = useState([]);
  const [activeMemories, setActiveMemories] = useState([]);
  const [auditEvents, setAuditEvents] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({ pending: 0, active: 0 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Fire each independently so one broken endpoint doesn't wipe
      // the rest (same pattern as the ClientManagementTab fix).
      api.get('/learning/memories?status=pending_approval&all=true')
        .then(r => {
          const m = r.data?.memories ?? [];
          setPendingMemories(m);
          setCounts(c => ({ ...c, pending: m.length }));
        }).catch(() => {});
      api.get('/learning/memories?status=active&all=true')
        .then(r => {
          const m = r.data?.memories ?? [];
          setActiveMemories(m);
          setCounts(c => ({ ...c, active: m.length }));
        }).catch(() => {});
      api.get('/learning/audit?sinceDays=14')
        .then(r => setAuditEvents(r.data?.events ?? []))
        .catch(() => {});
      // Feedback list comes through the interactions endpoint with
      // ?include_feedback (Phase 2 would add a dedicated route; for now
      // we render whatever feedback is attached to recent interactions).
      api.get('/learning/interactions?limit=50')
        .then(r => {
          const fb = [];
          for (const i of r.data?.interactions ?? []) {
            for (const f of i.feedback ?? []) fb.push({ ...f, interaction: i });
          }
          setFeedback(fb);
        }).catch(() => {});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function approveMemory(id) {
    try {
      await api.patch(`/learning/memories/${id}/approve`);
      setMsg('Memory approved — now influencing Brain.');
      load();
    } catch (e) {
      setMsg(`Approve failed: ${e?.response?.data?.error ?? e.message}`);
    }
  }

  async function rejectMemory(id) {
    const reason = window.prompt
      ? null  // no-prompt rule — we use inline ask state instead
      : null;
    // Reject without reason for now; an inline reason input is a
    // Session 2b polish (the no-browser-dialogs rule forbids prompt()).
    try {
      await api.patch(`/learning/memories/${id}/reject`);
      setMsg('Memory rejected.');
      load();
    } catch (e) {
      setMsg(`Reject failed: ${e?.response?.data?.error ?? e.message}`);
    }
  }

  async function archiveMemory(id) {
    try {
      await api.patch(`/learning/memories/${id}/archive`);
      setMsg('Memory archived.');
      load();
    } catch (e) {
      setMsg(`Archive failed: ${e?.response?.data?.error ?? e.message}`);
    }
  }

  if (loading && !pendingMemories.length && !activeMemories.length) {
    return <div style={{ color: '#888', padding: 20 }}>Loading learning data…</div>;
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Brain Learning Center</h2>
        <p style={{ color: '#888', fontSize: 13, margin: 0, lineHeight: 1.5 }}>
          Brain proposes memories and the audit feed shows everything risky it does. Nothing
          becomes "active" memory without explicit approval here.
        </p>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {SECTIONS.map((s) => {
          const isActive = section === s.key;
          const count = s.key === 'pending' ? counts.pending
                      : s.key === 'active' ? counts.active
                      : s.key === 'feedback' ? feedback.length
                      : auditEvents.length;
          return (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              style={{
                padding: '6px 14px', fontSize: 12, borderRadius: 6,
                background: isActive ? s.color : 'transparent',
                color: isActive ? '#0e1116' : s.color,
                border: '1px solid ' + s.color,
                cursor: 'pointer', fontWeight: 600,
              }}
            >
              {s.label} <span style={{ opacity: 0.7 }}>({count})</span>
            </button>
          );
        })}
        <button
          onClick={load}
          style={{
            padding: '6px 14px', fontSize: 12, borderRadius: 6,
            background: 'transparent', color: '#999',
            border: '1px solid #444', cursor: 'pointer', marginLeft: 'auto',
          }}
        >
          Refresh
        </button>
      </div>

      {/* ── Pending memories ────────────────────────────────────── */}
      {section === 'pending' && (
        <div>
          {pendingMemories.length === 0 ? (
            <div style={empty()}>No memories pending approval. Brain hasn't proposed anything new.</div>
          ) : (
            pendingMemories.map((m) => (
              <MemoryCard
                key={m.id} memory={m}
                actions={
                  <>
                    <button style={btn('approve')} onClick={() => approveMemory(m.id)}>Approve</button>
                    <button style={btn('reject')} onClick={() => rejectMemory(m.id)}>Reject</button>
                  </>
                }
              />
            ))
          )}
        </div>
      )}

      {/* ── Active memories ─────────────────────────────────────── */}
      {section === 'active' && (
        <div>
          {activeMemories.length === 0 ? (
            <div style={empty()}>No active memories yet. Approve a pending one to see it here.</div>
          ) : (
            activeMemories.map((m) => (
              <MemoryCard
                key={m.id} memory={m}
                actions={
                  <button style={btn('archive')} onClick={() => archiveMemory(m.id)}>Archive</button>
                }
              />
            ))
          )}
        </div>
      )}

      {/* ── Feedback ────────────────────────────────────────────── */}
      {section === 'feedback' && (
        <div>
          {feedback.length === 0 ? (
            <div style={empty()}>No feedback rows in the last 50 interactions.</div>
          ) : (
            feedback.map((f) => (
              <div key={f.id} style={card()}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                    background: (FEEDBACK_TYPE_COLORS[f.feedbackType] || '#888') + '22',
                    color: FEEDBACK_TYPE_COLORS[f.feedbackType] || '#888',
                  }}>{f.feedbackType}</span>
                  <span style={{ fontSize: 11, color: '#666' }}>
                    {new Date(f.createdAt).toLocaleString()} · user {f.userId}
                  </span>
                </div>
                {f.feedbackComment && (
                  <div style={{ fontSize: 13, color: '#ccc', marginBottom: 4 }}>"{f.feedbackComment}"</div>
                )}
                {f.interaction?.userPrompt && (
                  <div style={{ fontSize: 11, color: '#666', fontStyle: 'italic' }}>
                    On: "{f.interaction.userPrompt.slice(0, 80)}…" ({f.interaction.surface})
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Audit feed ──────────────────────────────────────────── */}
      {section === 'audit' && (
        <div>
          {auditEvents.length === 0 ? (
            <div style={empty()}>No audit events in the last 14 days. Nothing high-risk has happened.</div>
          ) : (
            auditEvents.map((e) => (
              <div key={`${e.kind}-${e.id}`} style={card()}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                    background: kindColor(e.kind) + '22', color: kindColor(e.kind),
                  }}>{e.kind.replace(/_/g, ' ')}</span>
                  {e.riskLevel && (
                    <span style={{
                      padding: '1px 6px', borderRadius: 3, fontSize: 10,
                      background: (e.riskLevel === 'critical' ? '#ef4444' : '#f59e0b') + '22',
                      color: e.riskLevel === 'critical' ? '#ef4444' : '#f59e0b',
                    }}>{e.riskLevel.toUpperCase()}</span>
                  )}
                  <span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>
                    {new Date(e.at).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 13, color: '#ccc', marginTop: 4 }}>{e.summary}</div>
                {e.userId && (
                  <div style={{ fontSize: 11, color: '#666', marginTop: 2 }}>user {e.userId}</div>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function MemoryCard({ memory: m, actions }) {
  return (
    <div style={card()}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <strong style={{ fontSize: 14, color: '#eee' }}>{m.title}</strong>
        <span style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
          background: '#444', color: '#bbb',
        }}>{m.memoryScope}</span>
        <span style={{
          padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600,
          background: (SENSITIVITY_COLORS[m.sensitivityLevel] || '#666') + '22',
          color: SENSITIVITY_COLORS[m.sensitivityLevel] || '#666',
        }}>{m.sensitivityLevel}</span>
        {m.confidenceScore > 0 && (
          <span style={{ fontSize: 11, color: '#666' }}>
            conf {Number(m.confidenceScore).toFixed(2)}
          </span>
        )}
      </div>
      <div style={{ fontSize: 13, color: '#ccc', marginBottom: 6, lineHeight: 1.5 }}>{m.content}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#666' }}>
        <span>type: {m.memoryType}</span>
        <span>·</span>
        <span>source: {m.sourceType || '?'}</span>
        <span>·</span>
        <span>{new Date(m.createdAt).toLocaleString()}</span>
        <span>·</span>
        <span>user: {m.userId ?? 'tenant'}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{actions}</span>
      </div>
    </div>
  );
}

function card() {
  return {
    background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
    padding: '12px 14px', marginBottom: 8,
  };
}

function empty() {
  return { color: '#666', padding: 30, textAlign: 'center', fontSize: 13 };
}

function btn(variant) {
  const base = {
    padding: '4px 12px', fontSize: 11, borderRadius: 6, border: '1px solid',
    cursor: 'pointer', fontWeight: 600,
  };
  if (variant === 'approve') {
    return { ...base, background: '#4ade8022', borderColor: '#4ade80', color: '#4ade80' };
  }
  if (variant === 'reject') {
    return { ...base, background: '#ef444422', borderColor: '#ef4444', color: '#ef4444' };
  }
  return { ...base, background: 'transparent', borderColor: '#666', color: '#999' };
}

function kindColor(kind) {
  if (kind === 'memory_approved') return '#4ade80';
  if (kind === 'memory_rejected') return '#ef4444';
  if (kind === 'memory_archived') return '#888';
  if (kind === 'interaction') return '#f59e0b';
  if (kind === 'feedback') return '#60a5fa';
  return '#888';
}
