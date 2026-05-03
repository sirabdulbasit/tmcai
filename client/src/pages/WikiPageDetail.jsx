/**
 * WikiPageDetail — the connected-page viewer.
 *
 * Shows a wiki page's body PLUS its outbound links ("Linked to") and
 * inbound links ("Referenced by") — the same web-of-connections
 * Obsidian surfaces per-page. Every linked-page title is clickable and
 * navigates WITHIN this modal (push / back / breadcrumb) so you can
 * walk Brain's knowledge graph without ever leaving the dialog.
 *
 * Also auto-linkifies mentions of known entity/topic titles in page
 * bodies at render time — so if Fahim is mentioned in an email body,
 * clicking "Fahim Ahmed Varraich" jumps to his entity_person page.
 */
import { useState, useEffect, useMemo } from 'react';
import api from '../services/api';
import { Card, Pill, Button } from '../components/ui';
import { Icon } from '../components/ui/Icon';

export default function WikiPageDetail({ id: initialId, onClose }) {
  // Stack of pages visited in this session — enables back navigation
  // without closing the modal.
  const [stack, setStack] = useState([initialId]);
  const id = stack[stack.length - 1];
  const [page, setPage] = useState(null);
  const [graph, setGraph] = useState({ outbound: [], inbound: [] });
  const [linkCatalog, setLinkCatalog] = useState([]); // [{id, title, pageType}] for auto-linkify
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  // Reset stack whenever the modal is opened with a fresh top-level id.
  useEffect(() => {
    if (initialId) setStack([initialId]);
  }, [initialId]);

  // Load page body + graph in parallel
  useEffect(() => {
    if (!id) return;
    setLoading(true); setErr(null); setPage(null); setGraph({ outbound: [], inbound: [] });
    Promise.all([
      api.get(`/brain/wiki/pages/${id}`).then((r) => r.data).catch((e) => { setErr(e?.response?.data?.error ?? e.message); return null; }),
      api.get(`/brain/wiki/pages/${id}/graph`).then((r) => r.data).catch(() => ({ outbound: [], inbound: [] })),
    ]).then(([p, g]) => {
      setPage(p);
      setGraph(g ?? { outbound: [], inbound: [] });
      // Build a catalog for auto-linkify: known entity/topic/project titles.
      // Dedupe — prefer concept types over sources.
      const known = new Map();
      for (const row of [...(g?.outbound ?? []), ...(g?.inbound ?? [])]) {
        if (['entity_person', 'topic', 'project', 'policy'].includes(row.pageType)) {
          if (!known.has(row.title)) known.set(row.title, row);
        }
      }
      setLinkCatalog(Array.from(known.values()));
    }).finally(() => setLoading(false));
  }, [id]);

  const push = (nextId) => setStack((s) => [...s, nextId]);
  const back = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));

  if (!initialId) return null;

  return (
    <div
      role="dialog"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        zIndex: 'calc(var(--z-modal) + 2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--s-4)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--bg-1)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)', width: 'min(820px, 94vw)',
          maxHeight: '88vh', overflow: 'auto', padding: 'var(--s-5)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        {/* Top row: back button when navigated deeper, breadcrumb, close */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--s-3)', gap: 'var(--s-2)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', minWidth: 0 }}>
            {stack.length > 1 && (
              <button
                onClick={back}
                title="Back"
                style={{ background: 'transparent', border: 0, color: 'var(--text-muted)', cursor: 'pointer', fontSize: 18, padding: 2 }}
              >←</button>
            )}
            <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)' }}>Wiki</div>
            {stack.length > 1 && (
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                · {stack.length - 1} hop{stack.length > 2 ? 's' : ''} from opened page
              </span>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 0, color: 'var(--text-muted)', cursor: 'pointer' }} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>

        {err && <Card style={{ background: 'var(--danger-dim)', color: 'var(--danger)' }}>{err}</Card>}

        {loading && !err && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}

        {page && !loading && (
          <>
            <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>{page.title}</h1>
            <div style={{ display: 'flex', gap: 'var(--s-2)', margin: 'var(--s-2) 0 var(--s-3)', flexWrap: 'wrap' }}>
              <Pill>{page.pageType}</Pill>
              <Pill variant={page.status === 'orphan' ? 'warning' : page.status === 'stale' ? 'warning' : page.status === 'contradicted' ? 'danger' : 'success'}>
                {page.status}
              </Pill>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', alignSelf: 'center' }}>
                sources: {page.sourceCount ?? 0} · linked to: {graph.outbound.length} · referenced by: {graph.inbound.length}
              </span>
            </div>

            {page.bodyMarkdown ? (
              <LinkifiedBody text={page.bodyMarkdown} catalog={linkCatalog} onNavigate={push} />
            ) : (
              <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Page body empty.</div>
            )}

            <div style={{ marginTop: 'var(--s-3)', fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
              Last updated {page.lastUpdatedAt ? new Date(page.lastUpdatedAt).toLocaleString() : '—'}
            </div>

            {/* Connection web — what does this page point at, and who points at it? */}
            {graph.outbound.length > 0 && (
              <LinkList
                label="Linked to"
                help="Pages this one references."
                rows={graph.outbound}
                onNavigate={push}
              />
            )}

            {graph.inbound.length > 0 && (
              <LinkList
                label={`Referenced by (${graph.inbound.length})`}
                help="Pages that point back at this one."
                rows={graph.inbound}
                onNavigate={push}
              />
            )}

            <div style={{ marginTop: 'var(--s-4)', display: 'flex', justifyContent: 'flex-end' }}>
              <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Render the page body, turning any occurrence of a known entity /
 *  topic / project title into a clickable pill that navigates. Very
 *  cheap — we just do one replace pass per catalog entry. For bodies
 *  that don't contain any known titles, the text falls through unchanged.
 */
function LinkifiedBody({ text, catalog, onNavigate }) {
  const segments = useMemo(() => {
    if (!text) return [''];
    if (!catalog || catalog.length === 0) return [text];
    // Sort titles by length desc so longer titles match before shorter subsets.
    const entries = [...catalog].sort((a, b) => (b.title?.length ?? 0) - (a.title?.length ?? 0));
    let chunks = [text];
    for (const e of entries) {
      if (!e.title || e.title.length < 4) continue;
      const escaped = e.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`\\b${escaped}\\b`, 'g');
      const next = [];
      for (const c of chunks) {
        if (typeof c !== 'string') { next.push(c); continue; }
        const parts = c.split(re);
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) next.push({ match: e.title, pageId: e.id });
          next.push(parts[i]);
        }
      }
      chunks = next;
    }
    return chunks;
  }, [text, catalog]);

  return (
    <div style={{
      whiteSpace: 'pre-wrap', fontFamily: 'inherit',
      fontSize: 'var(--fs-sm)', color: 'var(--text)',
      padding: 'var(--s-3)', background: 'var(--bg-2)',
      borderRadius: 'var(--r-md)', border: '1px solid var(--border)',
      lineHeight: 1.55,
    }}>
      {segments.map((seg, i) => typeof seg === 'string'
        ? <span key={i}>{seg}</span>
        : (
          <button
            key={i}
            onClick={() => onNavigate(seg.pageId)}
            title="Open linked wiki page"
            style={{
              background: 'rgba(204,107,74,0.10)', color: 'var(--accent)',
              border: '1px solid rgba(204,107,74,0.25)',
              borderRadius: 6, padding: '1px 6px', margin: '0 1px',
              cursor: 'pointer', fontSize: 'inherit', fontFamily: 'inherit',
              fontWeight: 'var(--fw-medium)',
            }}
          >
            {seg.match}
          </button>
        )
      )}
    </div>
  );
}

function LinkList({ label, help, rows, onNavigate }) {
  // Group by page type so the list reads like categories.
  const grouped = new Map();
  for (const r of rows) {
    const k = r.pageType;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(r);
  }
  const ORDER = ['entity_person', 'topic', 'project', 'policy', 'org_doc', 'attachment_doc', 'email_message', 'sender_topic', 'sender_history', 'decision', 'pattern', 'answer', 'gap', 'observation'];
  const keys = Array.from(grouped.keys()).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  return (
    <div style={{ marginTop: 'var(--s-4)' }}>
      <div style={{
        fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px',
        color: 'var(--accent)', fontWeight: 'var(--fw-semibold)', marginBottom: 2,
      }}>{label}</div>
      {help && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginBottom: 8 }}>{help}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {keys.map((k) => (
          <div key={k}>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 4 }}>
              {k} ({grouped.get(k).length})
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {grouped.get(k).slice(0, 10).map((r) => (
                <button
                  key={r.id}
                  onClick={() => onNavigate(r.id)}
                  style={{
                    textAlign: 'left', padding: '6px 10px',
                    background: 'var(--bg-2)', border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)', cursor: 'pointer', fontSize: 'var(--fs-sm)',
                    color: 'var(--text)', fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--accent)')}
                  onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
                >
                  <div style={{ fontWeight: 'var(--fw-medium)' }}>{r.title}</div>
                  {r.snippet && (
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>
                      {r.snippet.replace(/\s+/g, ' ').slice(0, 140)}
                    </div>
                  )}
                </button>
              ))}
              {grouped.get(k).length > 10 && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>
                  + {grouped.get(k).length - 10} more
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
