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
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchMode, setSearchMode] = useState('browse');
  const [detailId, setDetailId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (type) params.set('type', type);
      if (q.trim()) params.set('q', q.trim());
      params.set('limit', '100');
      const { data } = await api.get(`/brain/wiki?${params}`);
      setItems(data.items ?? []);
      setTotal(data.total ?? 0);
      setCounts(data.counts ?? []);
      setSearchMode(data.searchMode ?? 'browse');
    } catch (err) {
      setItems([]); setTotal(0);
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [type]);
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
        {/* Sidebar — type filters */}
        <aside style={{
          width: 220, flexShrink: 0, borderRight: '1px solid var(--border)',
          overflowY: 'auto', padding: 'var(--s-3)',
        }}>
          <TypeButton active={type === null} label="All" count={totalAllTypes} onClick={() => setType(null)} />
          <div style={{ height: 10 }} />
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
              <WikiRow key={p.id} page={p} onOpen={() => setDetailId(p.id)} />
            ))}
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

function WikiRow({ page, onOpen }) {
  const snippet = (page.snippet ?? '')
    .replace(/^#+\s+.+?\n/, '')      // drop leading markdown heading
    .replace(/\*\*/g, '')             // strip bold markers
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  const date = page.lastUpdatedAt ? new Date(page.lastUpdatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return (
    <button
      onClick={onOpen}
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
      <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
        {page.sourceCount > 0 && `${page.sourceCount} source${page.sourceCount === 1 ? '' : 's'} · `}
        updated {date}
      </div>
    </button>
  );
}
