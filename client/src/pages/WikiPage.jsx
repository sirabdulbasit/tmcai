/**
 * WikiPage — Rail destination that lets the user browse every LLM Wiki
 * page Brain has written for this tenant.
 *
 * Filters (sidebar): page type + search box (ILIKE on title).
 * List: newest first, showing title + first-line snippet + type pill +
 * source count + last-updated timestamp.
 * Click a row → opens WikiPageDetail modal (same component used for chat
 * citations) so the user reads the actual markdown Brain wrote.
 *
 * Scope: user-scoped types (sender_history, sender_topic, entity, gap,
 * answer) show only this user's pages; tenant-shared types (org_doc,
 * policy, project, decision, pattern, attachment_doc) show across the
 * whole tenant. Enforced server-side in GET /brain/wiki.
 */
import { useEffect, useMemo, useState } from 'react';
import api from '../services/api';
import WikiPageDetail from './WikiPageDetail';

const TYPE_LABELS = {
  mind_state: 'Mind state',
  observation: 'Observations',
  entity_person: 'People',
  topic: 'Topics',
  email_message: 'Email messages',
  sender_history: 'Sender histories',
  sender_topic: 'Sender threads',
  entity: 'Raw entities',
  org_doc: 'FACL docs',
  attachment_doc: 'Attachments',
  project: 'Projects',
  policy: 'Policies',
  decision: 'Decisions',
  pattern: 'Patterns',
  answer: 'Prior answers',
  gap: 'Open gaps',
};

const TYPE_ORDER = [
  // Cognitive layer on top
  'mind_state', 'observation',
  // Concept layer (aggregated, topic-first)
  'entity_person', 'topic', 'project', 'policy',
  // Source layer (lineage)
  'org_doc', 'attachment_doc', 'email_message', 'decision', 'pattern',
  'entity', 'sender_history', 'sender_topic',
  // Self-maintenance
  'answer', 'gap',
];

export default function WikiPage() {
  const [type, setType] = useState(null);
  const [q, setQ] = useState('');
  const [scope, setScope] = useState('all'); // 'all' | 'user' | 'tenant'
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState([]);
  const [scopeCounts, setScopeCounts] = useState({ user: 0, tenant: 0 });
  const [loading, setLoading] = useState(false);
  const [searchMode, setSearchMode] = useState('browse');
  const [detailId, setDetailId] = useState(null);
  // Archive/Delete confirmation state (inline panel per no-browser-dialogs rule).
  const [archiveFlow, setArchiveFlow] = useState(null); // { page }
  const [deleteFlow, setDeleteFlow] = useState(null);   // { page, typed }
  const [opMsg, setOpMsg] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (q.trim()) params.set('q', q.trim());
      if (scope && scope !== 'all') params.set('scope', scope);
      params.set('limit', '100');
      const { data } = await api.get(`/brain/wiki?${params}`);
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setCounts(data.counts ?? []);
      setScopeCounts(data.scopeCounts ?? { user: 0, tenant: 0 });
      setSearchMode(data.searchMode ?? 'browse');
    } catch (err) {
      setItems([]); setTotal(0);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [type, scope]);
  // Debounce the text search so we don't hammer the server on every keystroke.
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q]);

  const orderedCounts = useMemo(() => {
    const map = new Map(counts.map((c) => [c.pageType, c.n]));
    return TYPE_ORDER
      .filter((t) => map.has(t))
      .map((t) => ({ pageType: t, n: map.get(t) }));
  }, [counts]);
  const totalAllTypes = counts.reduce((s, c) => s + c.n, 0);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-1)' }}>
      <div style={{ padding: 'var(--s-4) var(--s-5) var(--s-3)', borderBottom: '1px solid var(--border)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-xl)', fontWeight: 'var(--fw-semibold)' }}>Wiki</h1>
        <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 4 }}>
          Everything Brain has written or scribed — {totalAllTypes} pages across {orderedCounts.length} categories.
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {/* Sidebar — visibility + type filters */}
        <aside style={{
          width: 220, flexShrink: 0, borderRight: '1px solid var(--border)',
          overflowY: 'auto', padding: 'var(--s-3)',
        }}>
          {/* Visibility section — keep this on top, it's the highest-level cut */}
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.5px',
            textTransform: 'uppercase', color: 'var(--text-dim)',
            padding: '4px 10px 6px',
          }}>Visibility</div>
          <TypeButton active={scope === 'all'}    label="All visible"   count={(scopeCounts.user || 0) + (scopeCounts.tenant || 0)} onClick={() => setScope('all')} />
          <TypeButton active={scope === 'user'}   label="🔒 My wiki"     count={scopeCounts.user || 0}    onClick={() => setScope('user')} />
          <TypeButton active={scope === 'tenant'} label="👥 Tenant wiki" count={scopeCounts.tenant || 0}  onClick={() => setScope('tenant')} />
          <div style={{ height: 14 }} />
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '.5px',
            textTransform: 'uppercase', color: 'var(--text-dim)',
            padding: '4px 10px 6px',
          }}>Page types</div>
          <TypeButton active={type === null} label="All" count={totalAllTypes} onClick={() => setType(null)} />
          {orderedCounts.map((c) => (
            <TypeButton
              key={c.pageType}
              active={type === c.pageType}
              label={TYPE_LABELS[c.pageType] ?? c.pageType}
              count={c.n}
              onClick={() => setType(c.pageType)}
            />
          ))}
        </aside>

        {/* Main — search + list */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 'var(--s-3) var(--s-4)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ position: 'relative' }}>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search wiki — type a word, phrase, or a full question…"
                style={{
                  width: '100%', padding: '10px 44px 10px 14px',
                  background: 'var(--bg-2)', border: '1px solid var(--border)',
                  borderRadius: 'var(--r-md)', color: 'var(--text)',
                  fontSize: 'var(--fs-md)',
                  boxSizing: 'border-box',
                }}
              />
              {q && (
                <button
                  onClick={() => setQ('')}
                  title="Clear"
                  style={{
                    position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                    background: 'transparent', border: 0, color: 'var(--text-dim)',
                    cursor: 'pointer', fontSize: 18, padding: '0 6px',
                  }}
                >×</button>
              )}
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
              {loading
                ? 'Searching…'
                : `${total} result${total === 1 ? '' : 's'}${type ? ` · ${TYPE_LABELS[type] ?? type}` : ''}${q.trim() ? ` · matching "${q.trim()}"` : ''}`}
              {q.trim() && searchMode === 'semantic' && !loading && (
                <span style={{
                  padding: '2px 8px', borderRadius: 10, background: 'rgba(204,107,74,0.15)',
                  color: 'var(--accent)', fontWeight: 'var(--fw-semibold)', fontSize: 10, letterSpacing: '.5px',
                }}>
                  SEMANTIC
                </span>
              )}
            </div>
            {q.trim() && !loading && (
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
                Results ranked by meaning, not just keyword match. Short codes (SFML, R-26-00081) also fall back to exact-text search.
              </div>
            )}
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--s-3) var(--s-4)' }}>
            {items.length === 0 && !loading && (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 'var(--fs-sm)' }}>
                No wiki pages{type ? ` of type ${TYPE_LABELS[type] ?? type}` : ''}{q.trim() ? ` matching "${q.trim()}"` : ''}.
              </div>
            )}
            {items.map((p) => (
              <WikiRow
                key={p.id}
                page={p}
                onOpen={() => setDetailId(p.id)}
                onArchive={(page) => { setArchiveFlow({ page }); setOpMsg(''); }}
                onDelete={(page) => { setDeleteFlow({ page, typed: '' }); setOpMsg(''); }}
              />
            ))}
            {opMsg && (
              <div style={{ fontSize: 12, color: opMsg.startsWith('Error') ? '#fca5a5' : '#4ade80', padding: '8px 12px' }}>
                {opMsg}
              </div>
            )}
            {archiveFlow && (
              <div style={{
                marginTop: 12, padding: '12px 14px',
                background: 'rgba(245,158,11,0.08)',
                border: '1px solid rgba(245,158,11,0.35)',
                borderRadius: 8, fontSize: 13,
              }}>
                <div style={{ marginBottom: 8 }}>
                  <strong>Archive "{archiveFlow.page.title}"?</strong> Brain will stop surfacing this page. Reversible from the API.
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={async () => {
                      try {
                        await api.patch(`/brain/wiki/pages/${archiveFlow.page.id}/archive`);
                        setOpMsg(`Archived "${archiveFlow.page.title}".`);
                        setArchiveFlow(null);
                        load();
                      } catch (err) {
                        setOpMsg(`Error: ${err?.response?.data?.error ?? err?.message ?? 'unknown'}`);
                      }
                    }}
                    style={{ padding: '6px 12px', background: '#f59e0b', color: '#000', border: 0, borderRadius: 4, fontSize: 13, cursor: 'pointer', fontWeight: 600 }}
                  >Archive</button>
                  <button
                    onClick={() => setArchiveFlow(null)}
                    style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}
                  >Cancel</button>
                </div>
              </div>
            )}
            {deleteFlow && (
              <div style={{
                marginTop: 12, padding: '14px 16px',
                background: 'rgba(220,38,38,0.08)',
                border: '1px solid rgba(220,38,38,0.35)',
                borderRadius: 8, fontSize: 13,
              }}>
                <div style={{ marginBottom: 6, fontWeight: 600, color: '#fca5a5' }}>
                  ⚠️ PERMANENT DELETE — irreversible
                </div>
                <div style={{ marginBottom: 8, color: 'var(--text-muted)', fontSize: 12 }}>
                  Brain will forget "{deleteFlow.page.title}" entirely. To confirm, type the page title exactly:
                </div>
                <input
                  type="text"
                  value={deleteFlow.typed}
                  onChange={(ev) => setDeleteFlow({ ...deleteFlow, typed: ev.target.value })}
                  placeholder={deleteFlow.page.title}
                  autoFocus
                  style={{
                    width: '100%', padding: '6px 8px',
                    background: 'var(--bg-1, #0d1117)', border: '1px solid var(--border, #28323e)',
                    borderRadius: 4, color: 'var(--text)', fontSize: 13, fontFamily: 'monospace',
                  }}
                />
                <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                  <button
                    disabled={deleteFlow.typed.trim() !== deleteFlow.page.title.trim()}
                    onClick={async () => {
                      try {
                        await api.delete(`/brain/wiki/pages/${deleteFlow.page.id}`);
                        setOpMsg(`Deleted "${deleteFlow.page.title}".`);
                        setDeleteFlow(null);
                        load();
                      } catch (err) {
                        setOpMsg(`Error: ${err?.response?.data?.error ?? err?.message ?? 'unknown'}`);
                      }
                    }}
                    style={{
                      padding: '6px 12px', background: '#dc2626', color: '#fff', border: 0, borderRadius: 4,
                      fontSize: 13, fontWeight: 600,
                      cursor: deleteFlow.typed.trim() === deleteFlow.page.title.trim() ? 'pointer' : 'not-allowed',
                      opacity: deleteFlow.typed.trim() === deleteFlow.page.title.trim() ? 1 : 0.4,
                    }}
                  >Delete permanently</button>
                  <button
                    onClick={() => setDeleteFlow(null)}
                    style={{ padding: '6px 12px', background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 4, fontSize: 13, cursor: 'pointer' }}
                  >Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {detailId && <WikiPageDetail id={detailId} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function TypeButton({ active, label, count, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        width: '100%', padding: '8px 10px', marginBottom: 3,
        background: active ? 'var(--bg-2)' : 'transparent',
        border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
        borderRadius: 'var(--r-md)',
        color: active ? 'var(--accent)' : 'var(--text-muted)',
        fontSize: 'var(--fs-sm)', textAlign: 'left', cursor: 'pointer',
        fontWeight: active ? 'var(--fw-semibold)' : 'var(--fw-normal)',
        fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{count}</span>
    </button>
  );
}

function WikiRow({ page, onOpen, onArchive, onDelete }) {
  const snippet = (page.snippet ?? '')
    .replace(/^#+\s+.+?\n/, '')      // drop leading markdown heading
    .replace(/\*\*/g, '')             // strip bold markers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const date = page.lastUpdatedAt ? new Date(page.lastUpdatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      style={{
        display: 'block', textAlign: 'left', width: '100%',
        padding: '12px 14px', marginBottom: 8,
        background: 'var(--bg-2)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)', color: 'var(--text)',
        fontFamily: 'inherit', cursor: 'pointer', fontSize: 'var(--fs-sm)',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <span style={{ fontWeight: 'var(--fw-semibold)', fontSize: 'var(--fs-md)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {page.title}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {typeof page.score === 'number' && (
            <span
              title="Semantic similarity to your search (higher = closer meaning)"
              style={{
                fontSize: 10, padding: '2px 7px', borderRadius: 10,
                background: 'rgba(74,222,128,0.12)', color: '#4ade80',
                fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
              }}
            >
              {Math.round(page.score * 100)}%
            </span>
          )}
          {page.scope === 'tenant' ? (
            <span
              title="Shared with everyone in this tenant"
              style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 10,
                background: 'rgba(96,165,250,0.14)', color: '#60a5fa',
                textTransform: 'uppercase', letterSpacing: '.5px', whiteSpace: 'nowrap',
              }}
            >👥 tenant</span>
          ) : (
            <span
              title="Private to your account"
              style={{
                fontSize: 10, padding: '2px 8px', borderRadius: 10,
                background: 'rgba(168,85,247,0.14)', color: '#a855f7',
                textTransform: 'uppercase', letterSpacing: '.5px', whiteSpace: 'nowrap',
              }}
            >🔒 mine</span>
          )}
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 10,
            background: 'rgba(204,107,74,0.14)', color: 'var(--accent)',
            textTransform: 'uppercase', letterSpacing: '.5px', whiteSpace: 'nowrap',
          }}>
            {page.pageType}
          </span>
        </div>
      </div>
      {snippet && (
        <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.45 }}>
          {snippet}
        </div>
      )}
      <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
          {page.sourceCount > 0 && `${page.sourceCount} source${page.sourceCount === 1 ? '' : 's'} · `}
          updated {date}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          {onArchive && (
            <button
              onClick={(ev) => { ev.stopPropagation(); onArchive(page); }}
              style={{
                fontSize: 11, padding: '3px 9px', borderRadius: 6,
                background: 'transparent', color: 'var(--text-muted)',
                border: '1px solid var(--border)', cursor: 'pointer',
              }}
              title="Archive — Brain stops surfacing this page. Reversible."
            >
              Archive
            </button>
          )}
          {onDelete && (
            <button
              onClick={(ev) => { ev.stopPropagation(); onDelete(page); }}
              style={{
                fontSize: 11, padding: '3px 9px', borderRadius: 6,
                background: 'transparent', color: '#fca5a5',
                border: '1px solid rgba(220,38,38,0.4)', cursor: 'pointer',
              }}
              title="Delete — IRREVERSIBLE. Brain forgets this page entirely."
            >
              Delete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
