/**
 * BrainMemoryPage — Settings surface for everything Brain remembers
 * about the user.
 *
 * Quality Sprint 5d/5f finish (2026-05-21). Three tabs:
 *   - Memories  : user preferences (explicit + pending inferred).
 *                 User can confirm inferred, edit values, dismiss.
 *   - Persons   : unified contact identities. Search, view facets, merge.
 *   - Activity  : recent Brain action artifacts (preview/dispatch log).
 *
 * Per third-party review safety constraint: inferred memories MUST
 * require explicit user action before they're applied. This page is
 * where that confirmation happens.
 */
import { useEffect, useState } from 'react';
import api from '../services/api';

const TABS = [
  { id: 'memories', label: 'Memories' },
  { id: 'persons', label: 'Persons' },
  { id: 'activity', label: 'Activity' },
];

export default function BrainMemoryPage() {
  const [tab, setTab] = useState('memories');

  return (
    <div style={pageStyle}>
      <header style={headerStyle}>
        <h1 style={{ margin: 0 }}>Brain Memory</h1>
        <p style={{ marginTop: 6, color: '#888' }}>
          What Brain remembers about you, who you talk to, and what it's done recently.
        </p>
      </header>

      <nav style={tabsStyle}>
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              ...tabBtnStyle,
              borderBottom: tab === t.id ? '2px solid #e94560' : '2px solid transparent',
              color: tab === t.id ? '#fff' : '#aaa',
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div style={{ marginTop: 24 }}>
        {tab === 'memories' && <MemoriesTab />}
        {tab === 'persons' && <PersonsTab />}
        {tab === 'activity' && <ActivityTab />}
      </div>
    </div>
  );
}

// ─── Memories ────────────────────────────────────────────────────

function MemoriesTab() {
  const [data, setData] = useState({ applicable: [], pendingInferred: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get('/v1/brain/settings/memories');
      setData(r.data);
      setError(null);
    } catch (e) {
      setError(e?.response?.data?.error ?? e?.message ?? 'unknown');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function confirmInferred(key) {
    await api.patch(`/v1/brain/settings/memories/${encodeURIComponent(key)}`, { confirm: true });
    await load();
  }

  async function dismiss(key) {
    if (!window.confirm(`Dismiss "${key}"?`)) return;
    await api.delete(`/v1/brain/settings/memories/${encodeURIComponent(key)}`);
    await load();
  }

  async function reflectNow() {
    setLoading(true);
    try {
      await api.post('/v1/brain/settings/reflect-now');
      await load();
    } catch (e) {
      setError(e?.response?.data?.error ?? 'unknown');
      setLoading(false);
    }
  }

  if (loading) return <div style={infoStyle}>Loading...</div>;
  if (error) return <div style={errorStyle}>Error: {error}</div>;

  return (
    <div>
      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h2 style={{ margin: 0 }}>Active preferences</h2>
          <span style={subtleStyle}>{data.applicable.length} memories</span>
        </div>
        {data.applicable.length === 0 ? (
          <p style={infoStyle}>
            Brain hasn't learned any preferences yet. Tell it things like "remember I sign off as Best regards" — it'll show up here.
          </p>
        ) : (
          <ul style={listStyle}>
            {data.applicable.map((m) => (
              <li key={m.key} style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <strong>{m.key}</strong>{' '}
                  <span style={subtleStyle}>({m.source})</span>
                  <div style={{ marginTop: 4 }}>
                    {typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}
                  </div>
                </div>
                <button onClick={() => dismiss(m.key)} style={dismissBtn}>Dismiss</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h2 style={{ margin: 0 }}>Pending inferred</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={reflectNow} style={primaryBtn}>Reflect now</button>
          </div>
        </div>
        <p style={subtleStyle}>
          Brain has noticed these patterns. Review and confirm to apply, or dismiss to discard.
        </p>
        {data.pendingInferred.length === 0 ? (
          <p style={infoStyle}>
            Nothing pending. Brain's background reflection runs every 6 hours; "Reflect now" triggers it on demand.
          </p>
        ) : (
          <ul style={listStyle}>
            {data.pendingInferred.map((m) => (
              <li key={m.key} style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <strong>{m.key}</strong>{' '}
                  <span style={subtleStyle}>(confidence {Math.round((m.confidence ?? 0) * 100)}%)</span>
                  <div style={{ marginTop: 4 }}>
                    {typeof m.value === 'string' ? m.value : JSON.stringify(m.value)}
                  </div>
                </div>
                <button onClick={() => confirmInferred(m.key)} style={primaryBtn}>Confirm</button>
                <button onClick={() => dismiss(m.key)} style={dismissBtn}>Dismiss</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── Persons ─────────────────────────────────────────────────────

function PersonsTab() {
  const [persons, setPersons] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get('/v1/brain/settings/persons', { params: search ? { q: search } : {} });
      setPersons(r.data.persons ?? []);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  async function openDetail(id) {
    const r = await api.get(`/v1/brain/settings/persons/${id}`);
    setSelected(r.data.person);
  }

  async function deletePerson(id) {
    if (!window.confirm('Delete this person record? Facets will cascade.')) return;
    await api.delete(`/v1/brain/settings/persons/${id}`);
    setSelected(null);
    await load();
  }

  return (
    <div>
      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h2 style={{ margin: 0 }}>People Brain knows</h2>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
            placeholder="Search by name fragment..."
            style={inputStyle}
          />
          <button onClick={load} style={primaryBtn}>Search</button>
        </div>
        {loading ? (
          <div style={infoStyle}>Loading...</div>
        ) : persons.length === 0 ? (
          <p style={infoStyle}>No persons found. Brain builds these as you interact (or via the backfill script).</p>
        ) : (
          <ul style={listStyle}>
            {persons.map((p) => (
              <li key={p.id} style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <strong>{p.displayName ?? p.display_name}</strong>{' '}
                  <span style={subtleStyle}>
                    ({p.facetCount ?? (p.facets?.length ?? 0)} facets)
                  </span>
                </div>
                <button onClick={() => openDetail(p.id)} style={primaryBtn}>View</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && (
        <section style={{ ...sectionStyle, border: '1px solid #555' }}>
          <div style={sectionHeaderStyle}>
            <h3 style={{ margin: 0 }}>{selected.displayName}</h3>
            <button onClick={() => setSelected(null)} style={dismissBtn}>Close</button>
          </div>
          <ul style={listStyle}>
            {(selected.facets ?? []).map((f) => (
              <li key={f.id} style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <strong>{f.facetType}</strong>: {f.facetValue}
                  <div style={{ marginTop: 4, fontSize: 12 }}>
                    <span style={subtleStyle}>source: {f.source} · confidence: {Math.round((f.confidence ?? 0) * 100)}%</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 16 }}>
            <button onClick={() => deletePerson(selected.id)} style={dangerBtn}>Delete person</button>
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Activity ────────────────────────────────────────────────────

function ActivityTab() {
  const [artifacts, setArtifacts] = useState([]);
  const [hours, setHours] = useState(48);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get('/v1/brain/settings/artifacts', { params: { hours, limit: 100 } });
      setArtifacts(r.data.artifacts ?? []);
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [hours]);

  if (loading) return <div style={infoStyle}>Loading...</div>;

  return (
    <div>
      <section style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <h2 style={{ margin: 0 }}>Recent Brain activity</h2>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} style={selectStyle}>
            <option value={24}>Last 24h</option>
            <option value={48}>Last 48h</option>
            <option value={168}>Last 7 days</option>
          </select>
        </div>
        {artifacts.length === 0 ? (
          <p style={infoStyle}>No actions in this window.</p>
        ) : (
          <ul style={listStyle}>
            {artifacts.map((a) => (
              <li key={a.id} style={rowStyle}>
                <div style={{ flex: 1 }}>
                  <strong>{a.actionType}</strong>{' '}
                  <span style={statusStyle(a.status)}>{a.status}</span>
                  {' · '}
                  <span style={subtleStyle}>{a.channel}</span>
                  {' · '}
                  <span style={subtleStyle}>{new Date(a.createdAt).toLocaleString()}</span>
                  {a.errorMessage && (
                    <div style={{ marginTop: 4, color: '#ff6b6b' }}>Error: {a.errorMessage}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────────────────

const pageStyle = { padding: '32px 48px', maxWidth: 960, margin: '0 auto', color: '#eee' };
const headerStyle = { marginBottom: 24 };
const tabsStyle = { display: 'flex', gap: 0, borderBottom: '1px solid #333' };
const tabBtnStyle = {
  padding: '12px 24px', background: 'transparent', border: 'none', cursor: 'pointer',
  fontSize: 14, fontWeight: 500,
};
const sectionStyle = { marginBottom: 32, padding: 16, background: '#1a1a2e', borderRadius: 8 };
const sectionHeaderStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 };
const listStyle = { listStyle: 'none', padding: 0, margin: 0 };
const rowStyle = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '12px 0', borderBottom: '1px solid #2a2a3e',
};
const infoStyle = { color: '#888', padding: 12 };
const errorStyle = { color: '#ff6b6b', padding: 12 };
const subtleStyle = { color: '#777', fontSize: 13 };
const primaryBtn = {
  padding: '6px 14px', background: '#e94560', color: 'white',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
};
const dismissBtn = {
  padding: '6px 14px', background: 'transparent', color: '#aaa',
  border: '1px solid #444', borderRadius: 4, cursor: 'pointer', fontSize: 13,
};
const dangerBtn = {
  padding: '8px 16px', background: '#7a1f1f', color: 'white',
  border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 13,
};
const inputStyle = {
  flex: 1, padding: '8px 12px', background: '#0f0f1e', color: '#eee',
  border: '1px solid #333', borderRadius: 4, fontSize: 14,
};
const selectStyle = {
  padding: '6px 10px', background: '#0f0f1e', color: '#eee',
  border: '1px solid #333', borderRadius: 4,
};
function statusStyle(status) {
  const color = {
    succeeded: '#4caf50', failed: '#ff6b6b', cancelled: '#999',
    previewed: '#888', confirmed: '#ffc107', dispatching: '#ffc107',
    expired: '#666',
  }[status] ?? '#aaa';
  return { color, fontSize: 12, textTransform: 'uppercase', fontWeight: 600 };
}
