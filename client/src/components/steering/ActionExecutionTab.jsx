import { useEffect, useState } from 'react';
import api from '../../services/api';

export default function ActionExecutionTab() {
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get('/risk/pending-approvals');
      setPending(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err?.response?.data?.error ?? err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const approve = async (id) => {
    await api.post(`/risk/approve/${id}`, {});
    load();
  };
  const reject = async (id) => {
    const reason = window.prompt('Reason for rejection?', 'not needed');
    if (reason === null) return;
    await api.post(`/risk/reject/${id}`, { reason });
    load();
  };
  const preview = async (actionId) => {
    try {
      const { data } = await api.get(`/actions/${actionId}/preview`);
      setSelected(data);
    } catch (err) {
      setError(err?.response?.data?.error ?? err.message);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>Action Execution</h2>
      <p style={{ color: '#888', fontSize: 13 }}>
        Pending approvals for MEDIUM / HIGH-risk actions. Approve to execute, reject to decline.
      </p>
      {error && <div style={{ color: '#e55', padding: 12 }}>{error}</div>}
      {loading && <div>Loading…</div>}
      {!loading && pending.length === 0 && <div style={{ color: '#666', padding: 24 }}>No pending approvals.</div>}
      <div style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {pending.map((p) => (
          <div key={p.id} style={{ border: '1px solid #2a2a2a', borderRadius: 6, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong>{p.actionType}</strong>
                <span style={{ marginLeft: 8, fontSize: 12, color: tierColor(p.riskTier) }}>
                  {p.riskTier ?? '—'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: '#888' }}>
                {new Date(p.createdAt).toLocaleString()}
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button onClick={() => approve(p.id)} style={btnStyle('#2a8')}>Approve</button>
              <button onClick={() => reject(p.id)} style={btnStyle('#a33')}>Reject</button>
              <button onClick={() => preview(p.id)} style={btnStyle('#555')}>Preview undo</button>
            </div>
          </div>
        ))}
      </div>
      {selected && (
        <div style={{ marginTop: 24, padding: 16, border: '1px solid #2a2a2a', borderRadius: 6 }}>
          <h3>Undo Preview for action {selected.rootActionId}</h3>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{JSON.stringify(selected, null, 2)}</pre>
          <button onClick={() => setSelected(null)} style={btnStyle('#555')}>Close</button>
        </div>
      )}
    </div>
  );
}

function tierColor(tier) {
  if (tier === 'HIGH') return '#e55';
  if (tier === 'MEDIUM') return '#fa0';
  if (tier === 'LOW') return '#6a6';
  return '#888';
}

function btnStyle(bg) {
  return {
    background: bg,
    color: '#fff',
    border: 'none',
    borderRadius: 4,
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: 13,
  };
}
