/**
 * Knowledge — what Brain remembers.
 *
 * Three tabs:
 *   Contacts  — external people Brain has seen (from wiki_scribe)
 *   Companies — accounts / domains with interactions
 *   Pages     — auto-maintained wiki pages (click to open detail)
 *
 * Plus a wiki health strip (active / stale / orphan / contradicted counts).
 */
import { useEffect, useState } from 'react';
import api from '../services/api';
import { Card, Pill, Button, Empty } from '../components/ui';
import { Icon } from '../components/ui/Icon';
import WikiPageDetail from './WikiPageDetail';

const TABS = ['contacts', 'companies', 'pages'];

export default function KnowledgePage() {
  const [tab, setTab] = useState('contacts');
  const [contacts, setContacts] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [pages, setPages] = useState([]);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [wikiPageId, setWikiPageId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [c, a, p, h] = await Promise.all([
        api.get('/brain/entities?type=contact&limit=50').then((r) => r.data.entities ?? []).catch(() => []),
        api.get('/brain/entities?type=account&limit=50').then((r) => r.data.entities ?? []).catch(() => []),
        api.get('/brain/patterns').then(() => []).catch(() => []), // placeholder until /brain/wiki/list exists
        api.get('/brain/wiki/health').then((r) => r.data).catch(() => null),
      ]);
      setContacts(c);
      setCompanies(a);
      // Fetch wiki pages via a direct entity→page lookup — contacts with pages
      // will show here. For the MVP, compose from contacts+companies.
      const pageList = [...c, ...a].map((e) => ({ id: e.id, title: e.name, type: e.entityType }));
      setPages(pageList);
      setHealth(h);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  return (
    <div style={{ padding: 'var(--s-6)', maxWidth: 960, margin: '0 auto' }}>
      <header style={{ marginBottom: 'var(--s-4)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>Knowledge</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', margin: '4px 0 0' }}>
          What I remember — contacts, companies, and pages Brain maintains from every interaction.
        </p>
      </header>

      {/* Wiki health strip */}
      {health && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 'var(--s-3)', marginBottom: 'var(--s-4)' }}>
          <HealthTile label="Active" count={health.active ?? 0} variant="success" />
          <HealthTile label="Stale" count={health.stale ?? 0} variant="warning" />
          <HealthTile label="Orphan" count={health.orphan ?? 0} variant="warning" />
          <HealthTile label="Contradicted" count={health.contradicted ?? 0} variant="danger" />
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-3)', borderBottom: '1px solid var(--border)' }}>
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: 'transparent', border: 0, cursor: 'pointer',
              padding: '8px 12px', fontSize: 'var(--fs-sm)',
              borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '.5px',
            }}
          >
            {t} {t === 'contacts' ? `(${contacts.length})` : t === 'companies' ? `(${companies.length})` : `(${pages.length})`}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          <Icon name="refresh" size={14} /> Refresh
        </Button>
      </div>

      {/* Tab content */}
      {tab === 'contacts' && (
        <TabList
          rows={contacts}
          empty="No contacts yet — Brain learns from your inbox as new emails come in."
          renderRow={(c) => (
            <Card key={c.id} size="sm" style={{ marginBottom: 'var(--s-2)', cursor: 'pointer' }} onClick={() => setWikiPageId(c.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 'var(--fw-medium)' }}>{c.name}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{c.email}</div>
                </div>
                <Pill>{c.relationshipStrength ?? 0} interactions</Pill>
              </div>
            </Card>
          )}
        />
      )}

      {tab === 'companies' && (
        <TabList
          rows={companies}
          empty="No companies yet."
          renderRow={(c) => (
            <Card key={c.id} size="sm" style={{ marginBottom: 'var(--s-2)', cursor: 'pointer' }} onClick={() => setWikiPageId(c.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: 'var(--fw-medium)' }}>{c.name}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{c.company}</div>
                </div>
                <Pill>{c.relationshipStrength ?? 0} interactions</Pill>
              </div>
            </Card>
          )}
        />
      )}

      {tab === 'pages' && (
        <TabList
          rows={pages}
          empty="No wiki pages yet."
          renderRow={(p) => (
            <Card key={p.id} size="sm" style={{ marginBottom: 'var(--s-2)', cursor: 'pointer' }} onClick={() => setWikiPageId(p.id)}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontWeight: 'var(--fw-medium)' }}>{p.title}</div>
                <Pill>{p.type}</Pill>
              </div>
            </Card>
          )}
        />
      )}

      {wikiPageId && <WikiPageDetail id={wikiPageId} onClose={() => setWikiPageId(null)} />}
    </div>
  );
}

function TabList({ rows, empty, renderRow }) {
  if (rows.length === 0) return <Empty title={empty}>{' '}</Empty>;
  return <>{rows.map(renderRow)}</>;
}

function HealthTile({ label, count, variant }) {
  return (
    <Card size="sm" style={{ padding: 'var(--s-3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.5px' }}>{label}</div>
        <Pill variant={variant}>{count}</Pill>
      </div>
    </Card>
  );
}
