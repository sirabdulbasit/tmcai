import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

// ─── Helpers ────────────────────────────────────────────────────

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const mins = Math.round((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function sentimentBg(score) {
  if (score > 0.3) return '#4ade8033';
  if (score < -0.3) return '#ef444433';
  return '#88888833';
}

function sentimentColor(score) {
  if (score > 0.3) return '#4ade80';
  if (score < -0.3) return '#ef4444';
  return '#888';
}

function scoreColor(score) {
  if (score >= 8) return '#ef4444';
  if (score >= 6) return '#f59e0b';
  return '#888';
}

function scoreBg(score) {
  if (score >= 8) return '#ef444422';
  if (score >= 6) return '#f59e0b22';
  return '#88888822';
}

function formatScore(score) {
  return score != null ? Number(score).toFixed(1) : '—';
}

const TYPE_LABELS = { weekly_review: 'Weekly review', reflection_prompt: 'Reflection', pattern_insight: 'Pattern insight', shadow_score_report: 'Shadow report', user_note: 'Note' };
const INTENT_COLORS = { ESCALATION: '#ef4444', NEW_TASK: '#3b82f6', INFORMATION: '#888', RISK: '#f59e0b', OPPORTUNITY: '#4ade80', FYI: '#666', NOISE: '#555' };

// ─── Styles ─────────────────────────────────────────────────────

const s = {
  wrapper: { height: '100vh', overflow: 'hidden', background: '#111' },
  scroll: { height: '100%', overflowY: 'auto', paddingBottom: 40, scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' },
  page: { maxWidth: 960, margin: '0 auto', padding: '16px 20px' },
  banner: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#1a1a1a', border: '0.5px solid #333', borderRadius: 8, padding: '8px 16px', marginBottom: 10, flexWrap: 'wrap', gap: 8 },
  section: { background: '#1a1a1a', border: '0.5px solid #333', borderRadius: 12, marginBottom: 10, overflow: 'hidden' },
  sHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '0.5px solid #333' },
  sBody: { padding: '12px 16px' },
  sDot: (color) => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  card: { border: '0.5px solid #333', borderRadius: 8, padding: '10px 12px', marginBottom: 6 },
  statGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 },
  statBox: (color) => ({ background: '#1e1e1e', border: `1px solid ${color}33`, borderRadius: 10, padding: '12px 14px', textAlign: 'center' }),
  statNum: (color) => ({ fontSize: 22, fontWeight: 700, color }),
  statLabel: { fontSize: 11, color: '#888', marginTop: 2 },
  badge: (bg, color) => ({ display: 'inline-block', padding: '1px 7px', borderRadius: 8, fontSize: 10, fontWeight: 600, background: bg, color, marginRight: 6 }),
  brainBox: { background: '#252525', borderLeft: '2px solid #3b82f6', borderRadius: '0 6px 6px 0', padding: '5px 8px', marginBottom: 6, fontSize: 11, color: '#aaa', lineHeight: 1.5 },
  ceoIntent: { borderLeft: '2px solid #f59e0b', padding: '4px 0 4px 8px', marginBottom: 8, fontSize: 11, color: '#aaa', fontStyle: 'italic', lineHeight: 1.5 },
  situation: { border: '0.5px solid #f59e0b55', borderRadius: 10, padding: '12px 14px', marginBottom: 8 },
  btn: { padding: '5px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 500, fontFamily: 'inherit', marginRight: 6, marginTop: 4 },
  btnPrimary: { background: '#cc6b4a', color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid #444', color: '#aaa' },
  btnDanger: { background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444' },
  btnSuccess: { background: '#4ade8022', color: '#4ade80', border: '1px solid #4ade8044' },
  empty: { fontSize: 12, color: '#666', padding: '8px 0' },
  loading: { textAlign: 'center', padding: 60, color: '#666' },
};

// ─── Component ──────────────────────────────────────────────────

export default function DayBriefPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState({});
  const [brain, setBrain] = useState({});
  const [thoughts, setThoughts] = useState([]);
  const [patterns, setPatterns] = useState({});
  const [engineRunning, setEngineRunning] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [itemsRes, statsRes, brainRes, thoughtsRes, patternsRes] = await Promise.all([
        api.get('/open-items?status=open&status=in_progress&status=delegated&status=blocked'),
        api.get('/open-items/stats'),
        api.get('/brain'),
        api.get('/thoughts/drafts').catch(() => ({ data: { entries: [] } })),
        api.get('/decisions/patterns').catch(() => ({ data: {} })),
      ]);
      setItems((itemsRes.data.items || []).sort((a, b) => (b.priorityScore || 0) - (a.priorityScore || 0)).slice(0, 12));
      setStats(statsRes.data || {});
      setBrain(brainRes.data?.config || {});
      setThoughts(thoughtsRes.data?.entries || []);
      setPatterns(patternsRes.data || {});
    } catch (e) {
      setError('Failed to load Day Brief. Check connections and try again.');
    }
    setLoading(false);
  }

  async function runEngine() {
    setEngineRunning(true);
    try {
      await api.post('/brain/engine/run');
      await loadAll();
    } catch {}
    setEngineRunning(false);
  }

  async function publishThought(id) {
    try { await api.post(`/thoughts/${id}/publish`); loadAll(); } catch {}
  }

  async function dismissThought(id) {
    try { await api.patch(`/thoughts/${id}`, { status: 'dismissed' }); loadAll(); } catch {}
  }

  async function confirmPattern(pattern) {
    try { await api.post('/decisions/patterns/confirm', { pattern }); loadAll(); } catch {}
  }

  async function revokePattern(idx) {
    try { await api.post('/decisions/patterns/revoke', { patternIndex: idx }); loadAll(); } catch {}
  }

  function sendPrompt(text) {
    navigate('/?prompt=' + encodeURIComponent(text));
  }

  if (loading) return <div style={s.loading}>Loading Day Brief...</div>;
  if (error) return <div style={{ ...s.loading, color: '#ef4444' }}>{error}</div>;

  const firstName = user?.name?.split(' ')[0] || 'there';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const isMonday = new Date().getDay() === 1;

  // Group items by entity for situation blocks
  const byEntity = {};
  items.forEach(item => { if (item.entityId) { byEntity[item.entityId] = byEntity[item.entityId] || []; byEntity[item.entityId].push(item); } });
  const situations = Object.entries(byEntity).filter(([, group]) => group.length >= 3);
  const situationItemIds = new Set(situations.flatMap(([, group]) => group.map(i => i.id)));
  const individualItems = items.filter(i => !situationItemIds.has(i.id));

  // Stale delegation items
  const staleItems = items.filter(i => {
    const meta = i.metadata || {};
    return meta.autoDelegate || meta.ceoIntentSummary;
  });

  // Pattern insights (Monday only)
  const patternInsights = isMonday ? thoughts.filter(t => t.type === 'pattern_insight') : [];
  const otherThoughts = thoughts.filter(t => t.type !== 'pattern_insight').slice(0, 3);

  return (
    <div style={s.wrapper}>
      <div style={s.scroll}>
        <div style={s.page}>

          {/* Back button */}
          <div style={{ marginBottom: 10 }}>
            <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => navigate('/')}>← Back to Chat</button>
          </div>

          {/* Engine banner */}
          <div style={s.banner}>
            <div style={{ fontSize: 11, color: '#888' }}>
              {brain.engineRunning
                ? '⟳ Brain engine running...'
                : `Engine ran ${timeAgo(brain.lastEngineRun)} · Next: ${brain.nextEngineRun ? timeAgo(brain.nextEngineRun) : 'on demand'}`
              }
            </div>
            <button style={{ ...s.btn, ...s.btnPrimary, opacity: engineRunning ? 0.6 : 1 }} disabled={engineRunning} onClick={runEngine}>
              {engineRunning ? '⟳ Running...' : '⚡ Run engine now'}
            </button>
          </div>

          {/* Engine freshness warning */}
          {(!brain.lastEngineRun || (Date.now() - new Date(brain.lastEngineRun).getTime()) > 25 * 3600000) && (
            <div style={{ padding: '8px 14px', background: '#f59e0b22', border: '1px solid #f59e0b44', borderRadius: 8, marginBottom: 10, fontSize: 12, color: '#f59e0b' }}>
              ⚠ Engine has not run recently. Data may be stale. Click "Run engine now" above.
            </div>
          )}

          {/* Header */}
          <div style={{ ...s.section, padding: '16px 20px' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#f0f0f0' }}>{getGreeting()}, {firstName}</div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 12 }}>{today}</div>

            <div style={s.statGrid}>
              <div style={s.statBox('#ef4444')}><div style={s.statNum('#ef4444')}>{stats.byPriority?.critical || 0}</div><div style={s.statLabel}>Critical</div></div>
              <div style={s.statBox('#f59e0b')}><div style={s.statNum('#f59e0b')}>{stats.byPriority?.high || 0}</div><div style={s.statLabel}>High</div></div>
              <div style={s.statBox('#3b82f6')}><div style={s.statNum('#3b82f6')}>{stats.byStatus?.delegated || 0}</div><div style={s.statLabel}>Delegated</div></div>
              <div style={s.statBox('#4ade80')}><div style={s.statNum('#4ade80')}>{stats.total || 0}</div><div style={s.statLabel}>Total Open</div></div>
            </div>
          </div>

          {/* Section A — Critical Items */}
          <div style={s.section}>
            <div style={s.sHead}><div style={s.sDot('#ef4444')} /><span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>A — Critical Items</span><span style={{ fontSize: 11, color: '#666', marginLeft: 'auto' }}>{items.length} of 12</span></div>
            <div style={s.sBody}>
              {items.length === 0 ? <div style={s.empty}>All clear — no open items today!</div> : (
                <>
                  {/* Situation blocks */}
                  {situations.map(([entityId, group]) => {
                    const topItem = group[0];
                    const meta = topItem.metadata || {};
                    return (
                      <div key={entityId} style={s.situation}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#f59e0b' }}>[SITUATION]</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>{topItem.entityId}</span>
                          <span style={{ fontSize: 11, color: '#888' }}>— {group.length} signals · Score {formatScore(group[0].priorityScore)}</span>
                        </div>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                          {group.map(g => <span key={g.id} style={s.badge('#33333388', '#aaa')}>{g.sourceFeed || g.type}</span>)}
                        </div>
                        {meta.situationBlock && <div style={s.brainBox}>{meta.situationBlock}</div>}
                        <div>
                          <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => sendPrompt(`Draft action for ${topItem.title} situation`)}>Draft action ↗</button>
                          <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => navigate('/open-items')}>View {group.length} items</button>
                        </div>
                      </div>
                    );
                  })}

                  {/* Individual items */}
                  {individualItems.map(item => {
                    const meta = item.metadata || {};
                    const suggestions = meta.rankedSuggestions || [];
                    const entityCtx = meta.entityContext;
                    return (
                      <div key={item.id} style={s.card}>
                        {/* Row 1: score + title + source */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <span style={{ ...s.badge(scoreBg(item.priorityScore), scoreColor(item.priorityScore)), fontWeight: 700, fontSize: 11 }}>{formatScore(item.priorityScore)}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: '#eee', flex: 1 }}>{item.title}</span>
                          {item.sourceFeed && <span style={s.badge('#33333388', '#888')}>{item.sourceFeed}{meta.classificationPass ? ` · pass ${meta.classificationPass}` : ''}</span>}
                        </div>

                        {/* Row 2: entity context */}
                        {entityCtx && <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{entityCtx}</div>}

                        {/* Row 3: ERG note */}
                        {meta.propagationNote && <div style={{ fontSize: 11, color: '#f59e0b', fontStyle: 'italic', marginBottom: 4 }}>ERG: {meta.propagationNote}</div>}

                        {/* Row 4: brain box */}
                        {(suggestions[0]?.reasoning || item.description) && (
                          <div style={s.brainBox}>{suggestions[0]?.reasoning || item.description?.slice(0, 150)}</div>
                        )}

                        {/* Row 5: draft ready */}
                        {suggestions.length > 0 && <div style={{ fontSize: 10, color: '#4ade80', marginBottom: 4 }}>Draft ready — approve and send in one click</div>}

                        {/* Row 6: action buttons */}
                        <div>
                          {suggestions.length > 0 ? (
                            <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => sendPrompt(`${suggestions[0].label} for "${item.title}"`)}>{suggestions[0].label} ↗</button>
                          ) : (
                            <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => sendPrompt(`Help me with "${item.title}"`)}>View detail ↗</button>
                          )}
                          <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => sendPrompt(`Delegate "${item.title}"`)}>Delegate</button>
                          <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => sendPrompt(`Snooze "${item.title}" for 24 hours`)}>Snooze</button>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>

          {/* Section B — Calendar */}
          <div style={s.section}>
            <div style={s.sHead}><div style={s.sDot('#3b82f6')} /><span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>B — Today's Calendar</span></div>
            <div style={s.sBody}>
              <div style={s.empty}>Calendar data loads from Day Brief chat command. <button style={{ ...s.btn, ...s.btnOutline, marginLeft: 4 }} onClick={() => sendPrompt('day brief')}>Load via chat ↗</button></div>
            </div>
          </div>

          {/* Section C — Email Digest */}
          <div style={s.section}>
            <div style={s.sHead}><div style={s.sDot('#888')} /><span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>C — Email Digest</span></div>
            <div style={s.sBody}>
              {items.filter(i => i.sourceFeed === 'gmail').length > 0 ? (
                items.filter(i => i.sourceFeed === 'gmail').slice(0, 4).map(item => {
                  const meta = item.metadata || {};
                  const intent = meta.intent || item.priority?.toUpperCase() || 'INFORMATION';
                  return (
                    <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '0.5px solid #252525' }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: INTENT_COLORS[intent] || '#888', flexShrink: 0 }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: '#eee' }}>{item.title}</div>
                        <div style={{ fontSize: 10, color: '#666' }}>
                          <span style={s.badge((INTENT_COLORS[intent] || '#888') + '22', INTENT_COLORS[intent] || '#888')}>{intent}</span>
                          {meta.classificationPass && <span>pass {meta.classificationPass}</span>}
                          {meta.confidence && <span> · {Math.round(meta.confidence * 100)}%</span>}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div style={s.empty}>No classified emails. Run the engine to ingest and classify your emails.</div>
              )}
            </div>
          </div>

          {/* Section D — Delegation Follow-up */}
          <div style={s.section}>
            <div style={s.sHead}><div style={s.sDot('#f59e0b')} /><span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>D — Delegation Follow-up</span></div>
            <div style={s.sBody}>
              {staleItems.length === 0 ? <div style={s.empty}>All delegations on track.</div> : (
                staleItems.map(item => {
                  const meta = item.metadata || {};
                  const hoursStale = Math.round((Date.now() - new Date(item.updatedAt).getTime()) / 3600000);
                  return (
                    <div key={item.id} style={s.card}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: hoursStale > 72 ? '#ef4444' : '#f59e0b', marginBottom: 4 }}>
                        {hoursStale}h stale{hoursStale > 72 ? ' · AUTO-DELEGATE TRIGGERED' : ' · approaching threshold'}
                      </div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#eee', marginBottom: 4 }}>{item.title} {item.delegateeName ? `(${item.delegateeName})` : ''}</div>
                      {meta.ceoIntentSummary ? (
                        <>
                          <div style={s.ceoIntent}>{meta.ceoIntentSummary}</div>
                          <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => sendPrompt(`Send delegation message for "${item.title}"`)}>Send via chat ↗</button>
                        </>
                      ) : (
                        <div style={{ fontSize: 11, color: '#666' }}>CEO Intent Summary will be generated at next engine run.</div>
                      )}
                      <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => sendPrompt(`Chase ${item.delegateeName || 'delegatee'} about "${item.title}"`)}>Chase ↗</button>
                      <button style={{ ...s.btn, ...s.btnOutline }}>Snooze</button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Section E — Pattern Promotion (Monday only) */}
          {isMonday && patternInsights.length > 0 && (
            <div style={s.section}>
              <div style={s.sHead}><div style={s.sDot('#4ade80')} /><span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>E — Pattern Promotion</span><span style={{ fontSize: 10, color: '#666', marginLeft: 'auto' }}>Monday analysis</span></div>
              <div style={s.sBody}>
                {patternInsights.map((p, idx) => (
                  <div key={p.id} style={{ ...s.card, borderColor: '#4ade8044' }}>
                    <div style={{ fontSize: 11, color: '#4ade80', fontWeight: 600, marginBottom: 4 }}>Pattern detected — Sunday analysis</div>
                    <div style={{ fontSize: 13, color: '#eee', marginBottom: 4 }}>{p.title}</div>
                    <div style={{ fontSize: 11, color: '#888', marginBottom: 8 }}>{p.content?.slice(0, 200)}</div>
                    <button style={{ ...s.btn, ...s.btnSuccess }} onClick={() => confirmPattern(p)}>Approve auto-action ↗</button>
                    <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => dismissThought(p.id)}>Not yet</button>
                    <button style={{ ...s.btn, ...s.btnDanger }} onClick={() => revokePattern(idx)}>Never</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Section F — Thought Prompts */}
          {otherThoughts.length > 0 && (
            <div style={s.section}>
              <div style={s.sHead}><div style={s.sDot('#3b82f6')} /><span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>F — Thought Prompts</span></div>
              <div style={s.sBody}>
                {otherThoughts.map(t => (
                  <div key={t.id} style={s.card}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <span style={s.badge('#3b82f622', '#3b82f6')}>{TYPE_LABELS[t.type] || t.type}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#eee' }}>{t.title}</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#aaa', marginBottom: 6, lineHeight: 1.5 }}>{t.content?.slice(0, 280)}{t.content?.length > 280 ? '...' : ''}</div>
                    <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => publishThought(t.id)}>Publish</button>
                    <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => sendPrompt(`Show me the full ${t.type} for "${t.title}"`)}>Read full ↗</button>
                    <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => dismissThought(t.id)}>Dismiss</button>
                  </div>
                ))}
                <div style={{ marginTop: 8 }}><button style={{ ...s.btn, ...s.btnOutline }} onClick={() => navigate('/thoughts')}>View all thought entries ↗</button></div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{ textAlign: 'center', fontSize: 11, color: '#555', padding: '12px 0' }}>
            Generated at {new Date().toLocaleTimeString()} · Sections configured in My Brain → Briefing
          </div>

        </div>
      </div>
    </div>
  );
}
