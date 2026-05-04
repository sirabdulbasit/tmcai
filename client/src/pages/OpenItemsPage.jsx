import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

const s = {
  wrapper: { height: '100vh', overflow: 'hidden', position: 'relative', background: 'var(--bg-1)' },
  scrollArea: { height: '100%', overflowY: 'auto', paddingBottom: 60, scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' },
  fadeHint: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(transparent, var(--bg-1))', pointerEvents: 'none', zIndex: 10, transition: 'opacity 0.3s' },
  page: { padding: '24px 32px', maxWidth: 1500 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  btn: { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'inherit' },
  btnPrimary: { background: '#cc6b4a', color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' },
  btnSmall: { padding: '4px 10px', fontSize: 'var(--fs-xs)' },
  badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + '22', color }),
  card: { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 8, cursor: 'pointer', transition: 'border-color 0.2s' },
  input: { width: '100%', background: 'var(--bg-1)', border: '1px solid var(--border)', color: 'var(--text)', padding: '8px 12px', borderRadius: 8, fontSize: 'var(--fs-sm)', fontFamily: 'inherit', boxSizing: 'border-box' },
  label: { display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 4, marginTop: 14 },
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 },
  modalBody: { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: '100%', maxWidth: 500, maxHeight: '80vh', overflow: 'auto' },
  tab: (active) => ({ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'inherit', background: active ? '#cc6b4a' : 'transparent', color: active ? '#fff' : 'var(--text-muted)', marginRight: 4 }),
  stats: { display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' },
  statCard: (color) => ({ background: 'var(--bg-2)', border: `1px solid ${color}33`, borderRadius: 10, padding: '12px 18px', minWidth: 100, textAlign: 'center' }),
  statNum: { fontSize: 'var(--fs-2xl)', fontWeight: 700, color: 'var(--text)' },
  statLabel: { fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 },
  empty: { textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 'var(--fs-base)' },
};

const PRIORITY_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#3b82f6', low: '#888' };
const STATUS_COLORS = { open: '#3b82f6', in_progress: '#f59e0b', delegated: '#a855f7', blocked: '#ef4444', done: '#4ade80', overdue: '#ef4444' };
const TYPE_ICONS = { task: '✓', email: '✉', delegation: '→', alert: '⚠', erp: '📊', okr: '🎯', risk: '⚡' };

export default function OpenItemsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // all | open | delegated | done
  const [showCreate, setShowCreate] = useState(false);
  const [selectedItem, setSelectedItem] = useState(null);
  const [form, setForm] = useState({ title: '', description: '', type: 'task', priority: 'medium', dueDate: '' });
  const [msg, setMsg] = useState('');
  const [atBottom, setAtBottom] = useState(false);
  const [cleanupPreview, setCleanupPreview] = useState(null); // { stale, dedup, total }

  function handleScroll(e) {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    setAtBottom(scrollHeight - scrollTop - clientHeight < 40);
  }

  useEffect(() => { loadItems(); loadStats(); }, [filter]);

  async function loadItems() {
    try {
      const params = filter !== 'all' ? `?status=${filter}` : '';
      const res = await api.get(`/open-items${params}`);
      setItems(res.data.items || []);
    } catch { }
    setLoading(false);
  }

  async function loadStats() {
    try {
      const res = await api.get('/open-items/stats');
      setStats(res.data);
    } catch { }
  }

  async function handleCreate() {
    if (!form.title) return;
    try {
      await api.post('/open-items', { ...form, dueDate: form.dueDate || undefined });
      setShowCreate(false);
      setForm({ title: '', description: '', type: 'task', priority: 'medium', dueDate: '' });
      setMsg('Item created');
      loadItems(); loadStats();
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Failed to create');
    }
  }

  async function handleStatusChange(id, status) {
    try {
      await api.post(`/open-items/${id}/status`, { status });
      loadItems(); loadStats();
    } catch { }
  }

  return (
    <div style={s.wrapper}>
      <div style={s.scrollArea} onScroll={handleScroll}>
      <div style={s.page}>
      <div style={s.header}>
        <div>
          <button style={{ ...s.btn, ...s.btnOutline, marginRight: 10 }} onClick={() => navigate('/')}>← Back to Chat</button>
          <span style={{ fontSize: 'var(--fs-xl)', fontWeight: 700, color: 'var(--text)' }}>Open Items</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={{ ...s.btn, ...s.btnOutline }}
            title="Auto-close items older than 30 days with no activity, plus duplicates of the same source. Critical items are never auto-closed."
            onClick={async () => {
              try {
                const dry = await api.post('/open-items/triage-cleanup', { staleDays: 30, dryRun: true });
                if ((dry.data?.total ?? 0) === 0) { setMsg('Nothing to clean up — no stale or duplicate items.'); return; }
                setCleanupPreview(dry.data);
              } catch (e) { setMsg(e?.response?.data?.error ?? 'Cleanup failed'); }
            }}
          >🧹 Smart cleanup</button>
          <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => setShowCreate(true)}>+ New Item</button>
        </div>
      </div>

      {msg && <div style={{ padding: '8px 14px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 12, color: 'var(--text)', fontSize: 'var(--fs-sm)' }}>{msg}</div>}

      {cleanupPreview && (
        <div style={{
          padding: '12px 14px', marginBottom: 12,
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.4)',
          borderRadius: 8, color: 'var(--text)', fontSize: 'var(--fs-sm)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
        }}>
          <div>
            About to auto-close <strong>{cleanupPreview.total}</strong> items —
            <strong> {cleanupPreview.stale}</strong> stale (&gt;30d, no activity, non-critical) ·
            <strong> {cleanupPreview.dedup}</strong> duplicates of the same source.
            Critical items are not touched.
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              style={{ ...s.btn, background: '#f59e0b', color: '#000', borderColor: '#f59e0b' }}
              onClick={async () => {
                try {
                  const r = await api.post('/open-items/triage-cleanup', { staleDays: 30 });
                  setMsg(`Closed ${r.data?.total ?? 0} items (${r.data?.stale ?? 0} stale, ${r.data?.dedup ?? 0} duplicates).`);
                  setCleanupPreview(null);
                  load(); loadStats();
                } catch (e) { setMsg(e?.response?.data?.error ?? 'Cleanup failed'); }
              }}
            >Yes, close them</button>
            <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => setCleanupPreview(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Stats */}
      {stats && (
        <div style={s.stats}>
          <div style={s.statCard('#3b82f6')}><div style={s.statNum}>{stats.total}</div><div style={s.statLabel}>Total Open</div></div>
          <div style={s.statCard('#ef4444')}><div style={{ ...s.statNum, color: '#ef4444' }}>{stats.byPriority?.critical || 0}</div><div style={s.statLabel}>Critical</div></div>
          <div style={s.statCard('#f59e0b')}><div style={{ ...s.statNum, color: '#f59e0b' }}>{stats.byPriority?.high || 0}</div><div style={s.statLabel}>High</div></div>
          <div style={s.statCard('#a855f7')}><div style={{ ...s.statNum, color: '#a855f7' }}>{stats.byStatus?.delegated || 0}</div><div style={s.statLabel}>Delegated</div></div>
          <div style={s.statCard('#4ade80')}><div style={{ ...s.statNum, color: '#4ade80' }}>{stats.byStatus?.done || 0}</div><div style={s.statLabel}>Done</div></div>
        </div>
      )}

      {/* Filter tabs */}
      <div style={{ marginBottom: 16 }}>
        {['all', 'open', 'in_progress', 'delegated', 'blocked', 'done', 'overdue'].map(f => (
          <button key={f} style={s.tab(filter === f)} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : f.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase())}
          </button>
        ))}
      </div>

      {/* Items list */}
      {loading ? (
        <div style={s.empty}>Loading...</div>
      ) : items.length === 0 ? (
        <div style={s.empty}>No items found. Create your first open item or connect data sources to auto-generate items.</div>
      ) : (
        items.map(item => (
          <div key={item.id} style={s.card} onClick={() => setSelectedItem(item)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14 }}>{TYPE_ICONS[item.type] || '•'}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: '#eee' }}>{item.title}</span>
                  <span style={s.badge(PRIORITY_COLORS[item.priority])}>{item.priority}</span>
                  <span style={s.badge(STATUS_COLORS[item.status])}>{item.status.replace('_', ' ')}</span>
                </div>
                {item.description && <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{item.description.substring(0, 120)}{item.description.length > 120 ? '...' : ''}</div>}
                <div style={{ fontSize: 11, color: '#666', marginTop: 6, display: 'flex', gap: 12 }}>
                  {item.sourceFeed && <span>Source: {item.sourceFeed}</span>}
                  {item.dueDate && <span>Due: {new Date(item.dueDate).toLocaleDateString()}</span>}
                  {item.delegateeName && <span>Delegated to: {item.delegateeName}</span>}
                  <span>Created: {new Date(item.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
                {item.status !== 'done' && (
                  <button style={{ ...s.btn, ...s.btnSmall, background: '#4ade80', color: '#111' }} onClick={() => handleStatusChange(item.id, 'done')}>✓ Done</button>
                )}
                {item.status === 'open' && (
                  <button style={{ ...s.btn, ...s.btnSmall, ...s.btnOutline }} onClick={() => handleStatusChange(item.id, 'in_progress')}>Start</button>
                )}
              </div>
            </div>
          </div>
        ))
      )}

    </div>
    </div>
    <div style={{ ...s.fadeHint, opacity: atBottom ? 0 : 1 }} />

      {/* Create modal */}
      {showCreate && (
        <div style={s.modal} onClick={() => setShowCreate(false)}>
          <div style={s.modalBody} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#eee', marginBottom: 16 }}>Create Open Item</div>
            <label style={s.label}>Title *</label>
            <input style={s.input} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="What needs to be done?" />
            <label style={s.label}>Description</label>
            <textarea style={{ ...s.input, minHeight: 80, resize: 'vertical' }} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Details..." />
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Type</label>
                <select style={s.input} value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                  <option value="task">Task</option><option value="email">Email</option><option value="delegation">Delegation</option>
                  <option value="alert">Alert</option><option value="erp">ERP</option><option value="okr">OKR</option><option value="risk">Risk</option>
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={s.label}>Priority</label>
                <select style={s.input} value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                  <option value="critical">Critical</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
                </select>
              </div>
            </div>
            <label style={s.label}>Due Date</label>
            <input style={s.input} type="date" value={form.dueDate} onChange={e => setForm({ ...form, dueDate: e.target.value })} />
            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => setShowCreate(false)}>Cancel</button>
              <button style={{ ...s.btn, ...s.btnPrimary }} onClick={handleCreate}>Create Item</button>
            </div>
          </div>
        </div>
      )}

      {/* Item detail modal */}
      {selectedItem && (
        <div style={s.modal} onClick={() => setSelectedItem(null)}>
          <div style={s.modalBody} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#eee' }}>{selectedItem.title}</div>
              <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => setSelectedItem(null)}>✕</button>
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <span style={s.badge(PRIORITY_COLORS[selectedItem.priority])}>{selectedItem.priority}</span>
              <span style={s.badge(STATUS_COLORS[selectedItem.status])}>{selectedItem.status.replace('_', ' ')}</span>
              <span style={s.badge('#888')}>{selectedItem.type}</span>
            </div>
            {selectedItem.description && <div style={{ fontSize: 13, color: '#ccc', marginBottom: 12, lineHeight: 1.5 }}>{selectedItem.description}</div>}
            <div style={{ fontSize: 12, color: '#888', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {selectedItem.sourceFeed && <div>Source: {selectedItem.sourceFeed}</div>}
              {selectedItem.dueDate && <div>Due: {new Date(selectedItem.dueDate).toLocaleDateString()}</div>}
              {selectedItem.delegateeName && <div>Delegated to: {selectedItem.delegateeName} {selectedItem.delegateeEmail ? `(${selectedItem.delegateeEmail})` : ''}</div>}
              <div>Created: {new Date(selectedItem.createdAt).toLocaleString()}</div>
              <div>Updated: {new Date(selectedItem.updatedAt).toLocaleString()}</div>
            </div>
            {selectedItem.delegationTrail?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 6 }}>Delegation Trail</div>
                {selectedItem.delegationTrail.map((d, i) => (
                  <div key={i} style={{ fontSize: 12, color: '#aaa', padding: '4px 0', borderBottom: '1px solid #2a2a2a' }}>
                    → {d.delegatedTo} at {new Date(d.delegatedAt).toLocaleString()} {d.note ? `— ${d.note}` : ''}
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              {selectedItem.status !== 'done' && <button style={{ ...s.btn, background: '#4ade80', color: '#111' }} onClick={() => { handleStatusChange(selectedItem.id, 'done'); setSelectedItem(null); }}>✓ Mark Done</button>}
              {selectedItem.status === 'open' && <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => { handleStatusChange(selectedItem.id, 'in_progress'); setSelectedItem(null); }}>Start Working</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

