/**
 * Admin → Connectors tab.
 *
 * Lets the tenant admin pick which personal connectors are ELIGIBLE for
 * users in this tenant. Only enabled types show up on each user's
 * /connectors page; the rest are hidden entirely (not "greyed out").
 *
 * Backend already enforces this — `listAvailableForUser` only returns
 * the enabled set, and `connectUserConnector` throws "This connector
 * is not enabled for your organization" if a user tries to bypass
 * the UI. This tab is the management surface for that gate.
 */
import { useState, useEffect, useMemo } from 'react';
import api from '../../services/api';

const CATEGORY_LABEL = {
  email: 'Email', calendar: 'Calendar', tasks: 'Tasks',
  messaging: 'Messaging', chat: 'Chat', drive: 'Cloud Drive',
  meetings: 'Meetings', notes: 'Notes', erp: 'ERP', crm: 'CRM',
  social: 'Social', kb: 'Knowledge Base', custom: 'Custom',
  data_warehouse: 'Data Warehouse', spreadsheets: 'Spreadsheets',
  project_mgmt: 'Project Mgmt', hr: 'HR', intelligence: 'Intelligence',
  support: 'Support', dev: 'Dev Tools',
};

export default function ConnectorsAdminTab({ user, msg, setMsg }) {
  const [allTypes, setAllTypes] = useState([]);
  const [enabledMap, setEnabledMap] = useState({}); // connectorTypeId -> boolean
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'enabled' | 'disabled'
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get('/admin/connectors');
        if (cancelled) return;
        setAllTypes(data.allTypes ?? []);
        // configs comes back as full rows; we only need the boolean map
        const map = {};
        for (const c of data.configs ?? []) {
          // Personal connectors only — org connectors have their own toggle UX
          if (c.scope === 'personal') map[c.connectorTypeId] = !!c.isEnabled;
        }
        setEnabledMap(map);
      } catch (e) {
        setMsg(`Failed to load connectors: ${e?.response?.data?.error ?? e.message}`);
      } finally {
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [setMsg]);

  async function toggle(typeId, next) {
    setSavingId(typeId);
    // Optimistic — flip immediately, revert on failure.
    const prev = enabledMap[typeId];
    setEnabledMap((m) => ({ ...m, [typeId]: next }));
    try {
      await api.post('/admin/connectors/personal/toggle', {
        connectorTypeId: typeId, enabled: next,
      });
      setMsg(`${next ? 'Enabled' : 'Disabled'} for tenant`);
    } catch (e) {
      setEnabledMap((m) => ({ ...m, [typeId]: prev })); // revert
      setMsg(`Toggle failed: ${e?.response?.data?.error ?? e.message}`);
    } finally {
      setSavingId(null);
    }
  }

  const personalTypes = useMemo(
    () => allTypes.filter((t) => t.scope === 'personal' || t.scope === 'both'),
    [allTypes],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return personalTypes.filter((t) => {
      const enabled = !!enabledMap[t.id];
      if (filter === 'enabled' && !enabled) return false;
      if (filter === 'disabled' && enabled) return false;
      if (q && !(t.name?.toLowerCase().includes(q) || t.slug?.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [personalTypes, enabledMap, filter, search]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const t of filtered) {
      const cat = t.category || 'other';
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(t);
    }
    // Sort categories: enabled-count desc, then alpha
    return Array.from(map.entries()).sort(([a, ax], [b, bx]) => {
      const aEn = ax.filter((t) => enabledMap[t.id]).length;
      const bEn = bx.filter((t) => enabledMap[t.id]).length;
      if (aEn !== bEn) return bEn - aEn;
      return a.localeCompare(b);
    });
  }, [filtered, enabledMap]);

  const counts = useMemo(() => ({
    total: personalTypes.length,
    enabled: personalTypes.filter((t) => enabledMap[t.id]).length,
  }), [personalTypes, enabledMap]);

  if (loading) return <div style={{ color: '#888', padding: 20 }}>Loading connectors…</div>;

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 18 }}>Connector Eligibility</h2>
        <p style={{ color: '#888', fontSize: 13, margin: 0, lineHeight: 1.5 }}>
          Pick which personal connectors your users can see on their <code>/connectors</code> page.
          Disabled connectors are hidden entirely — users won't even see the card.
          Changes apply immediately, no restart needed.
        </p>
      </div>

      {/* Stats + filter row */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: 16, gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 13, color: '#aaa' }}>
          <span><strong style={{ color: '#4ade80' }}>{counts.enabled}</strong> enabled</span>
          <span><strong style={{ color: '#666' }}>{counts.total - counts.enabled}</strong> hidden</span>
          <span><strong style={{ color: '#aaa' }}>{counts.total}</strong> total</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { v: 'all', l: 'All' },
            { v: 'enabled', l: 'Enabled' },
            { v: 'disabled', l: 'Hidden' },
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setFilter(opt.v)}
              style={{
                padding: '5px 12px', fontSize: 12, borderRadius: 6,
                background: filter === opt.v ? '#cc6b4a' : 'transparent',
                color: filter === opt.v ? '#fff' : '#aaa',
                border: '1px solid ' + (filter === opt.v ? '#cc6b4a' : '#444'),
                cursor: 'pointer',
              }}
            >
              {opt.l}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name…"
            style={{
              padding: '5px 10px', fontSize: 12, borderRadius: 6,
              background: '#1a1a1a', border: '1px solid #444',
              color: '#ccc', width: 160,
            }}
          />
        </div>
      </div>

      {grouped.length === 0 ? (
        <div style={{ color: '#666', padding: 30, textAlign: 'center', fontSize: 13 }}>
          No connectors match the current filter.
        </div>
      ) : (
        grouped.map(([cat, types]) => (
          <div key={cat} style={{ marginBottom: 24 }}>
            <div style={{
              fontSize: 11, textTransform: 'uppercase', letterSpacing: 1,
              color: '#888', marginBottom: 8, paddingBottom: 4,
              borderBottom: '1px solid #333',
            }}>
              {CATEGORY_LABEL[cat] || cat}
              <span style={{ marginLeft: 8, color: '#555' }}>
                ({types.filter((t) => enabledMap[t.id]).length}/{types.length})
              </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
              {types.map((t) => {
                const en = !!enabledMap[t.id];
                const saving = savingId === t.id;
                return (
                  <label
                    key={t.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 12px', borderRadius: 8,
                      border: '1px solid ' + (en ? '#4ade8044' : '#333'),
                      background: en ? '#0d2415' : '#1a1a1a',
                      cursor: saving ? 'wait' : 'pointer',
                      opacity: saving ? 0.7 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={en}
                      disabled={saving}
                      onChange={(e) => toggle(t.id, e.target.checked)}
                      style={{ cursor: saving ? 'wait' : 'pointer', accentColor: '#4ade80' }}
                    />
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{
                        color: en ? '#dfd' : '#ccc',
                        fontSize: 13, fontWeight: 500,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {t.name}
                      </div>
                      <div style={{ color: '#666', fontSize: 11 }}>
                        {t.slug}
                        {t.authMethod ? ` · ${t.authMethod}` : ''}
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        ))
      )}
    </div>
  );
}
