/**
 * Brain Improvement — admin surface for Phase 2 self-improvement
 * pipeline. Three nested sections:
 *   1. Detected Gaps — Brain's findings from interaction patterns
 *   2. Product Proposals — promoted from approved gaps
 *   3. Development Requests — promoted from approved proposals
 *
 * Hard governance rule: every transition between these requires an
 * explicit admin click. Brain authors content; admin promotes it.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../../services/api';

const SECTIONS = [
  { key: 'gaps',      label: 'Detected Gaps',       color: '#f59e0b' },
  { key: 'proposals', label: 'Product Proposals',   color: '#60a5fa' },
  { key: 'devreqs',   label: 'Development Requests', color: '#a78bfa' },
];

export default function BrainImprovementTab({ msg, setMsg }) {
  const [section, setSection] = useState('gaps');
  const [gaps, setGaps] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [devReqs, setDevReqs] = useState([]);
  const [expanded, setExpanded] = useState(null); // id of expanded card
  const [detecting, setDetecting] = useState(false);

  const load = useCallback(() => {
    api.get('/learning/gaps').then(r => setGaps(r.data?.gaps ?? [])).catch(() => {});
    api.get('/learning/proposals').then(r => setProposals(r.data?.proposals ?? [])).catch(() => {});
    api.get('/learning/development-requests').then(r => setDevReqs(r.data?.devRequests ?? [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  async function detectNow() {
    setDetecting(true);
    try {
      const r = await api.post('/learning/gaps/detect');
      setMsg(`Detection complete — ${r.data?.newGaps ?? 0} new gaps, ${r.data?.existingGaps ?? 0} existing gaps updated.`);
      load();
    } catch (e) {
      setMsg(`Detection failed: ${e?.response?.data?.error ?? e.message}`);
    } finally {
      setDetecting(false);
    }
  }

  async function approveGap(id) {
    try { await api.patch(`/learning/gaps/${id}/approve`); setMsg('Gap approved — ready to promote to proposal.'); load(); }
    catch (e) { setMsg(`Approve failed: ${e?.response?.data?.error ?? e.message}`); }
  }
  async function rejectGap(id) {
    try { await api.patch(`/learning/gaps/${id}/reject`); setMsg('Gap rejected.'); load(); }
    catch (e) { setMsg(`Reject failed: ${e?.response?.data?.error ?? e.message}`); }
  }
  async function promoteGapToProposal(gapId) {
    try {
      const r = await api.post(`/learning/proposals/from-gap/${gapId}`);
      setMsg(`Promoted to proposal (id: ${r.data?.id?.slice(0, 8)}…). Review the draft on the Proposals tab.`);
      setSection('proposals');
      load();
    } catch (e) { setMsg(`Promotion failed: ${e?.response?.data?.error ?? e.message}`); }
  }

  async function approveProposal(id) {
    try { await api.patch(`/learning/proposals/${id}/approve`); setMsg('Proposal approved.'); load(); }
    catch (e) { setMsg(`Approve failed: ${e?.response?.data?.error ?? e.message}`); }
  }
  async function rejectProposal(id) {
    try { await api.patch(`/learning/proposals/${id}/reject`); setMsg('Proposal rejected.'); load(); }
    catch (e) { setMsg(`Reject failed: ${e?.response?.data?.error ?? e.message}`); }
  }
  async function promoteProposalToDevReq(proposalId) {
    try {
      const r = await api.post(`/learning/development-requests/from-proposal/${proposalId}`);
      setMsg(`Promoted to dev request (id: ${r.data?.id?.slice(0, 8)}…).`);
      setSection('devreqs');
      load();
    } catch (e) { setMsg(`Promotion failed: ${e?.response?.data?.error ?? e.message}`); }
  }

  async function generateSpec(id) {
    try {
      await api.post(`/learning/development-requests/${id}/generate-technical-spec`);
      setMsg('Technical spec generated. Expand the card to view.');
      load();
    } catch (e) { setMsg(`Spec generation failed: ${e?.response?.data?.error ?? e.message}`); }
  }
  async function approveDevReq(id) {
    try { await api.patch(`/learning/development-requests/${id}/approve`); setMsg('Dev request approved for development.'); load(); }
    catch (e) { setMsg(`Approve failed: ${e?.response?.data?.error ?? e.message}`); }
  }
  async function rejectDevReq(id) {
    try { await api.patch(`/learning/development-requests/${id}/reject`); setMsg('Dev request rejected.'); load(); }
    catch (e) { setMsg(`Reject failed: ${e?.response?.data?.error ?? e.message}`); }
  }

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Brain Self-Improvement</h2>
        <p style={{ color: '#888', fontSize: 13, margin: 0, lineHeight: 1.5 }}>
          Brain mines patterns from accumulated interaction logs + feedback. It detects gaps, proposes fixes, and (with your approval at every step) generates development requests. Nothing ships without your explicit click.
        </p>
      </div>

      {/* Section tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {SECTIONS.map((s) => {
          const isActive = section === s.key;
          const count = s.key === 'gaps' ? gaps.length
                      : s.key === 'proposals' ? proposals.length
                      : devReqs.length;
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
        {section === 'gaps' && (
          <button
            onClick={detectNow}
            disabled={detecting}
            style={{
              padding: '6px 14px', fontSize: 12, borderRadius: 6,
              background: '#cc6b4a', color: '#fff',
              border: 'none', cursor: detecting ? 'wait' : 'pointer', fontWeight: 600,
            }}
          >
            {detecting ? 'Detecting…' : '↻ Detect Now'}
          </button>
        )}
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

      {/* ── Detected Gaps ───────────────────────────────────────── */}
      {section === 'gaps' && (
        <div>
          {gaps.length === 0 ? (
            <div style={empty()}>
              No detected gaps yet. Click "Detect Now" to run the mining job, or wait for the nightly sweep (24h cycle). Gaps require accumulated interaction logs + feedback — give the system at least a few days of real use first.
            </div>
          ) : (
            gaps.map((g) => (
              <Card key={g.id} expanded={expanded === g.id} onToggle={() => setExpanded(expanded === g.id ? null : g.id)}>
                <CardHeader>
                  <strong style={{ fontSize: 14, color: '#eee' }}>{g.title}</strong>
                  <StatusBadge status={g.status} />
                  <Badge color="#f59e0b">{g.gapType}</Badge>
                  {g.riskLevel && <RiskBadge level={g.riskLevel} />}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>
                    {g.frequencyCount}× · conf {Number(g.brainConfidence ?? 0).toFixed(2)}
                  </span>
                </CardHeader>
                <p style={cardDesc()}>{g.description}</p>
                {expanded === g.id && (
                  <>
                    {g.suggestedAction && (
                      <div style={subBlock()}>
                        <strong style={subLabel()}>Suggested Action</strong>
                        <p style={{ margin: 0, fontSize: 13, color: '#ccc' }}>{g.suggestedAction}</p>
                      </div>
                    )}
                    <div style={subBlock()}>
                      <strong style={subLabel()}>Evidence</strong>
                      <pre style={preStyle()}>{JSON.stringify(g.evidence, null, 2)}</pre>
                    </div>
                  </>
                )}
                <CardActions>
                  {g.status === 'new' && (
                    <>
                      <button style={btn('approve')} onClick={() => approveGap(g.id)}>Approve</button>
                      <button style={btn('reject')} onClick={() => rejectGap(g.id)}>Reject</button>
                    </>
                  )}
                  {g.status === 'approved' && (
                    <button style={btn('promote')} onClick={() => promoteGapToProposal(g.id)}>Promote to Proposal →</button>
                  )}
                  {g.status === 'converted_to_proposal' && (
                    <span style={{ fontSize: 11, color: '#60a5fa' }}>✓ proposal created</span>
                  )}
                </CardActions>
              </Card>
            ))
          )}
        </div>
      )}

      {/* ── Product Proposals ───────────────────────────────────── */}
      {section === 'proposals' && (
        <div>
          {proposals.length === 0 ? (
            <div style={empty()}>No proposals yet. Promote an approved gap to create one.</div>
          ) : (
            proposals.map((p) => (
              <Card key={p.id} expanded={expanded === p.id} onToggle={() => setExpanded(expanded === p.id ? null : p.id)}>
                <CardHeader>
                  <strong style={{ fontSize: 14, color: '#eee' }}>{p.title}</strong>
                  <StatusBadge status={p.status} />
                  <Badge color="#60a5fa">{p.priority}</Badge>
                  <RiskBadge level={p.riskLevel} />
                </CardHeader>
                <p style={cardDesc()}>{p.problemStatement}</p>
                {expanded === p.id && (
                  <div style={subBlock()}>
                    <strong style={subLabel()}>Proposal (Markdown)</strong>
                    <pre style={preStyle()}>{p.proposalMarkdown}</pre>
                  </div>
                )}
                <CardActions>
                  {(p.status === 'draft' || p.status === 'awaiting_approval') && (
                    <>
                      <button style={btn('approve')} onClick={() => approveProposal(p.id)}>Approve</button>
                      <button style={btn('reject')} onClick={() => rejectProposal(p.id)}>Reject</button>
                    </>
                  )}
                  {p.status === 'approved' && (
                    <button style={btn('promote')} onClick={() => promoteProposalToDevReq(p.id)}>Create Dev Request →</button>
                  )}
                  {p.status === 'converted_to_development' && (
                    <span style={{ fontSize: 11, color: '#a78bfa' }}>✓ dev request created</span>
                  )}
                </CardActions>
              </Card>
            ))
          )}
        </div>
      )}

      {/* ── Development Requests ────────────────────────────────── */}
      {section === 'devreqs' && (
        <div>
          {devReqs.length === 0 ? (
            <div style={empty()}>No development requests yet. Promote an approved proposal to create one.</div>
          ) : (
            devReqs.map((d) => (
              <Card key={d.id} expanded={expanded === d.id} onToggle={() => setExpanded(expanded === d.id ? null : d.id)}>
                <CardHeader>
                  <strong style={{ fontSize: 14, color: '#eee' }}>{d.title}</strong>
                  <StatusBadge status={d.status} />
                  <RiskBadge level={d.riskLevel} />
                  {d.pullRequestUrl && (
                    <a href={d.pullRequestUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#60a5fa' }}>PR ↗</a>
                  )}
                </CardHeader>
                <p style={cardDesc()}>{d.description}</p>
                {expanded === d.id && (
                  <>
                    <div style={subBlock()}>
                      <strong style={subLabel()}>Requirement</strong>
                      <pre style={preStyle()}>{d.requirementMarkdown}</pre>
                    </div>
                    {d.technicalSpecMarkdown && (
                      <div style={subBlock()}>
                        <strong style={subLabel()}>Technical Spec</strong>
                        <pre style={preStyle()}>{d.technicalSpecMarkdown}</pre>
                      </div>
                    )}
                  </>
                )}
                <CardActions>
                  {!d.technicalSpecMarkdown && (
                    <button style={btn('generate')} onClick={() => generateSpec(d.id)}>Generate Technical Spec</button>
                  )}
                  {(d.status === 'draft' || d.status === 'awaiting_approval') && d.technicalSpecMarkdown && (
                    <>
                      <button style={btn('approve')} onClick={() => approveDevReq(d.id)}>Approve for Development</button>
                      <button style={btn('reject')} onClick={() => rejectDevReq(d.id)}>Reject</button>
                    </>
                  )}
                </CardActions>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function Card({ expanded, onToggle, children }) {
  return (
    <div
      style={{
        background: '#1a1a1a', border: '1px solid ' + (expanded ? '#666' : '#333'), borderRadius: 8,
        padding: '12px 14px', marginBottom: 10, cursor: 'pointer',
      }}
      onClick={onToggle}
    >
      {children}
    </div>
  );
}

function CardHeader({ children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
      {children}
    </div>
  );
}

function CardActions({ children }) {
  return (
    <div
      style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
}

function Badge({ color, children }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
      background: color + '22', color,
    }}>{children}</span>
  );
}

function StatusBadge({ status }) {
  const colors = {
    new: '#888', under_review: '#f59e0b', approved: '#4ade80', rejected: '#ef4444',
    converted_to_proposal: '#60a5fa', converted_to_development: '#a78bfa',
    draft: '#888', awaiting_approval: '#f59e0b',
    approved_for_development: '#4ade80', coding_in_progress: '#a78bfa',
    pr_created: '#60a5fa', review_required: '#f59e0b', uat_required: '#f59e0b',
    approved_for_release: '#4ade80', deployed: '#22c55e',
    implemented: '#22c55e',
  };
  return <Badge color={colors[status] || '#666'}>{status.replace(/_/g, ' ')}</Badge>;
}

function RiskBadge({ level }) {
  if (!level) return null;
  const colors = { low: '#888', medium: '#f59e0b', high: '#fb923c', critical: '#ef4444' };
  return (
    <span style={{
      padding: '1px 6px', borderRadius: 3, fontSize: 10, fontWeight: 700,
      background: (colors[level] || '#888') + '22', color: colors[level] || '#888',
    }}>{level.toUpperCase()}</span>
  );
}

function cardDesc() {
  return { fontSize: 13, color: '#bbb', margin: '4px 0 6px', lineHeight: 1.5 };
}

function subBlock() {
  return {
    background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6,
    padding: '8px 10px', marginTop: 8,
  };
}

function subLabel() {
  return {
    display: 'block', fontSize: 10, textTransform: 'uppercase',
    letterSpacing: 1, color: '#666', marginBottom: 4,
  };
}

function preStyle() {
  return {
    margin: 0, fontSize: 11, color: '#aaa',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 320, overflowY: 'auto',
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
  if (variant === 'approve') return { ...base, background: '#4ade8022', borderColor: '#4ade80', color: '#4ade80' };
  if (variant === 'reject')  return { ...base, background: '#ef444422', borderColor: '#ef4444', color: '#ef4444' };
  if (variant === 'promote') return { ...base, background: '#60a5fa22', borderColor: '#60a5fa', color: '#60a5fa' };
  if (variant === 'generate') return { ...base, background: '#a78bfa22', borderColor: '#a78bfa', color: '#a78bfa' };
  return { ...base, background: 'transparent', borderColor: '#666', color: '#999' };
}
