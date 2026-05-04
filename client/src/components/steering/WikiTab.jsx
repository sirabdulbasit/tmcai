/**
 * WikiTab v2 — 3-pane layout (nav / list / preview) driven by design tokens.
 * Multi-tenant SaaS aware: per-user Notion status, per-user page stats.
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { Button, Field, Input, Pill, Dot, Card, Empty, ListItem } from '../ui';
import { Icon } from '../ui/Icon';

const PAGE_TYPES = [
  { key: 'entity', label: 'Entities' },
  { key: 'concept', label: 'Concepts' },
  { key: 'decision', label: 'Decisions' },
  { key: 'pattern', label: 'Patterns' },
  { key: 'meeting', label: 'Meetings' },
  { key: 'project', label: 'Projects' },
  { key: 'source_summary', label: 'Sources' },
];

export default function WikiTab() {
  const [stats, setStats] = useState(null);
  const [pages, setPages] = useState([]);
  const [pageType, setPageType] = useState('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const [notion, setNotion] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDisconnectNotion, setConfirmDisconnectNotion] = useState(false);
  // Scope filter: '' (all visible) | 'user' (my wiki) | 'tenant' (shared)
  const [scopeFilter, setScopeFilter] = useState('');

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (pageType) params.set('pageType', pageType);
      if (scopeFilter) params.set('scope', scopeFilter);
      const [s, p, n] = await Promise.all([
        api.get('/wiki/stats'),
        api.get(`/wiki/pages?${params.toString()}`),
        api.get('/connectors/notion/status').catch(() => ({ data: { connected: false } })),
      ]);
      setStats(s.data); setPages(p.data.pages ?? []); setNotion(n.data);
    } catch (e) { setErr(e?.response?.data?.error ?? e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [pageType, scopeFilter]);

  const runSearch = async (e) => {
    e?.preventDefault();
    if (!q.trim()) { load(); return; }
    setLoading(true); setErr(null);
    try {
      const r = await api.get(`/wiki/index?q=${encodeURIComponent(q)}&limit=25`);
      const hits = r.data.matches ?? [];
      setPages(hits.map((h) => ({
        id: h.id, pageType: h.pageType, title: h.title,
        status: 'active', confidence: null,
        inboundLinks: 0, outboundLinks: 0, sourceCount: 0,
        lastUpdatedAt: null, createdAt: null, storage: 'search',
      })));
    } catch (e) { setErr(e?.response?.data?.error ?? e.message); }
    finally { setLoading(false); }
  };

  const openPage = async (id) => {
    setSelected({ id, loading: true });
    try {
      const r = await api.get(`/wiki/pages/${id}`);
      setSelected(r.data);
    } catch (e) { setSelected({ id, error: e?.response?.data?.error ?? e.message }); }
  };

  const connectNotion = async () => {
    try {
      const r = await api.get('/connectors/notion/authorize');
      window.location.href = r.data.authorizeUrl;
    } catch (e) { setErr(e?.response?.data?.error ?? e.message); }
  };
  const disconnectNotion = async () => {
    try { await api.post('/connectors/notion/disconnect'); setConfirmDisconnectNotion(false); load(); }
    catch (e) { setErr(e?.response?.data?.error ?? e.message); }
  };

  const byTypeCounts = Object.fromEntries((stats?.byType ?? []).map((r) => [r.key, r.count]));
  const totalPages = (stats?.byType ?? []).reduce((s, r) => s + r.count, 0);

  return (
    <div style={{ padding: 'var(--s-6)', display: 'grid', gridTemplateColumns: '260px 340px 1fr', gap: 'var(--s-5)', height: 'calc(100vh - var(--topbar-height) - var(--s-12))' }}>
      {/* ─── nav ─── */}
      <nav style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 'var(--s-4)', overflow: 'auto' }}>
        <div style={{ marginBottom: 'var(--s-4)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-dim)', marginBottom: 'var(--s-2)' }}>Storage</div>
          {notion?.connected ? (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
              <div><Dot status="up" /> Notion <Pill variant="success">{notion.workspace ?? 'connected'}</Pill></div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>{Object.keys(notion.databases ?? {}).length} databases</div>
              {confirmDisconnectNotion ? (
                <div style={{ marginTop: 'var(--s-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Pages stay; new writes go to Postgres fallback.</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button variant="danger" size="xs" onClick={disconnectNotion}>Yes, disconnect</Button>
                    <Button variant="ghost" size="xs" onClick={() => setConfirmDisconnectNotion(false)}>Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button variant="ghost" size="xs" onClick={() => setConfirmDisconnectNotion(true)} style={{ marginTop: 'var(--s-2)' }}>Disconnect</Button>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)' }}>
              <div><Dot status="degraded" /> Notion not connected</div>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>Using Postgres fallback</div>
              <Button variant="primary" size="xs" onClick={connectNotion} style={{ marginTop: 'var(--s-2)' }}>Connect Notion</Button>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 'var(--s-4)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-dim)', marginBottom: 'var(--s-2)' }}>Visibility</div>
          <NavItem active={scopeFilter === ''} label="All visible" count={null} onClick={() => setScopeFilter('')} />
          <NavItem active={scopeFilter === 'user'} label="🔒 My wiki" count={null} onClick={() => setScopeFilter('user')} />
          <NavItem active={scopeFilter === 'tenant'} label="👥 Tenant wiki" count={null} onClick={() => setScopeFilter('tenant')} />
        </div>

        <div style={{ marginBottom: 'var(--s-4)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-dim)', marginBottom: 'var(--s-2)' }}>Page types</div>
          <NavItem active={pageType === ''} label="All pages" count={totalPages} onClick={() => setPageType('')} />
          {PAGE_TYPES.map((t) => (
            <NavItem key={t.key} active={pageType === t.key} label={t.label} count={byTypeCounts[t.key] ?? 0} onClick={() => setPageType(t.key)} />
          ))}
        </div>

        {stats && (
          <div>
            <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--text-dim)', marginBottom: 'var(--s-2)' }}>Stats</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
              {stats.totalSources} sources · {stats.totalLinks} links
            </div>
          </div>
        )}
      </nav>

      {/* ─── list ─── */}
      <div style={{ background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: 'var(--s-3)', borderBottom: '1px solid var(--border)' }}>
          <form onSubmit={runSearch}>
            <Input size="sm" placeholder="Search titles…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
        </div>
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--s-2)' }}>
          {err && <div style={{ color: 'var(--danger)', padding: 'var(--s-3)' }}>{err}</div>}
          {loading && <div style={{ color: 'var(--text-muted)', padding: 'var(--s-3)' }}>Loading…</div>}
          {!loading && pages.length === 0 && <Empty title="No pages yet">Close an OpenItem or save a chat answer — wiki_scribe will fill this in.</Empty>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
            {pages.map((p) => (
              <ListItem key={p.id} active={selected?.id === p.id} onClick={() => openPage(p.id)}>
                <ListItem.Title>
                  {p.title}
                  {p.scope === 'tenant'
                    ? <Pill variant="info" title="Visible to every user in this tenant">👥 tenant</Pill>
                    : <Pill title="Private to your account">🔒 mine</Pill>}
                  {p.sourceCount > 0 && <Pill variant="success">{p.sourceCount}</Pill>}
                </ListItem.Title>
                <ListItem.Meta>
                  <span>{p.pageType}</span>
                  {p.status && p.status !== 'active' && <span>· {p.status}</span>}
                  {p.inboundLinks + p.outboundLinks > 0 && <span>· {p.inboundLinks}↓ {p.outboundLinks}↑</span>}
                </ListItem.Meta>
              </ListItem>
            ))}
          </div>
        </div>
      </div>

      {/* ─── preview ─── */}
      <Card style={{ overflow: 'auto' }}>
        {!selected && <Empty title="Select a page">Pick a page from the list to read it here.</Empty>}
        {selected?.loading && <div style={{ color: 'var(--text-muted)' }}>Loading page…</div>}
        {selected?.error && <div style={{ color: 'var(--danger)' }}>{selected.error}</div>}
        {selected?.title && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--s-4)', marginBottom: 'var(--s-4)', paddingBottom: 'var(--s-4)', borderBottom: '1px solid var(--border)' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', flexWrap: 'wrap' }}>
                  <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>{selected.title}</h1>
                  {selected.scope === 'tenant'
                    ? <Pill variant="info" title="Shared with everyone in this tenant">👥 tenant</Pill>
                    : <Pill title="Private to your account">🔒 mine</Pill>}
                </div>
                <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>
                  {selected.pageType} · confidence {selected.confidence ?? '-'} · storage {selected.storage}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
                {selected.storage === 'notion' && (
                  <Button variant="secondary" size="sm">Open in Notion <Icon name="external" size={12} /></Button>
                )}
              </div>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 'var(--fs-md)', color: 'var(--text)', margin: 0 }}>
              {selected.bodyMarkdown ?? '(body stored in Notion — open in Notion to view)'}
            </pre>
          </>
        )}
      </Card>
    </div>
  );
}

function NavItem({ active, label, count, onClick }) {
  return (
    <button type="button" onClick={onClick}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              width: '100%', padding: 'var(--s-2) var(--s-3)', borderRadius: 'var(--r-md)',
              background: active ? 'var(--accent-dim)' : 'transparent',
              color: active ? 'var(--accent)' : 'var(--text-muted)',
              border: 0, cursor: 'pointer', fontSize: 'var(--fs-md)', textAlign: 'left',
            }}>
      <span>{label}</span>
      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{count}</span>
    </button>
  );
}
