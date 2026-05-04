/**
 * ActionExecutionTab v2 — Pending approvals split-pane (list + detail).
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { Button, Card, Pill, Empty, ListItem, RiskBanner } from '../ui';
import { Icon } from '../ui/Icon';

export default function ActionExecutionTab() {
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  // Inline reject prompt — id of the row whose reject form is open + its current text.
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const { data } = await api.get('/risk/pending-approvals');
      setPending(Array.isArray(data) ? data : []);
    } catch (err) { setError(err?.response?.data?.error ?? err.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, []);

  const approve = async (id) => { await api.post(`/risk/approve/${id}`, {}); load(); };
  const reject = async (id, reason) => {
    await api.post(`/risk/reject/${id}`, { reason });
    setRejectingId(null);
    setRejectReason('');
    load();
  };
  const preview = async (actionId) => {
    try {
      const { data } = await api.get(`/actions/${actionId}/preview`);
      setSelected(data);
    } catch (err) { setError(err?.response?.data?.error ?? err.message); }
  };

  const tierPill = (tier) => {
    if (tier === 'HIGH') return <Pill variant="danger">HIGH</Pill>;
    if (tier === 'MEDIUM' || tier === 'MED') return <Pill variant="warning">MEDIUM</Pill>;
    if (tier === 'LOW') return <Pill variant="success">LOW</Pill>;
    return <Pill>{tier ?? '—'}</Pill>;
  };

  const counts = pending.reduce((a, p) => {
    if (p.riskTier === 'HIGH') a.high++;
    else if (p.riskTier === 'MEDIUM' || p.riskTier === 'MED') a.med++;
    else a.low++;
    return a;
  }, { high: 0, med: 0, low: 0 });

  return (
    <div style={{ padding: 'var(--s-6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', marginBottom: 'var(--s-2)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>Pending Approvals</h1>
        <Pill variant="danger">{counts.high} HIGH</Pill>
        <Pill variant="warning">{counts.med} MEDIUM</Pill>
      </div>
      <p style={{ color: 'var(--text-muted)', marginTop: 0, marginBottom: 'var(--s-5)' }}>
        MEDIUM and HIGH risk actions wait here for your approval. Approve to execute, reject to decline.
      </p>

      {error && <Card style={{ background: 'var(--danger-dim)', color: 'var(--danger)', borderColor: 'var(--danger)', marginBottom: 'var(--s-4)' }}>{error}</Card>}

      <div style={{ display: 'grid', gridTemplateColumns: '360px 1fr', gap: 'var(--s-4)' }}>
        <Card style={{ padding: 0, overflow: 'auto', maxHeight: 640 }}>
          {loading && <div style={{ padding: 'var(--s-4)', color: 'var(--text-muted)' }}>Loading…</div>}
          {!loading && pending.length === 0 && <Empty title="No pending approvals">All action proposals are auto-executed or already processed.</Empty>}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {pending.map((p) => (
              <div key={p.id} style={{ padding: 'var(--s-3) var(--s-4)', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
                   onClick={() => preview(p.id)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <strong>{p.actionType}</strong>
                  {tierPill(p.riskTier)}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                  {new Date(p.createdAt).toLocaleString()}
                </div>
                {rejectingId === p.id ? (
                  <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 'var(--s-2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <input
                      type="text"
                      autoFocus
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Reason for rejection?"
                      style={{
                        padding: '6px 10px',
                        background: 'var(--bg-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--r-sm)',
                        fontSize: 'var(--fs-sm)',
                        color: 'var(--text)',
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && rejectReason.trim()) reject(p.id, rejectReason.trim()); if (e.key === 'Escape') { setRejectingId(null); setRejectReason(''); } }}
                    />
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Button variant="danger" size="sm" disabled={!rejectReason.trim()} onClick={() => reject(p.id, rejectReason.trim())}>Confirm reject</Button>
                      <Button variant="ghost" size="sm" onClick={() => { setRejectingId(null); setRejectReason(''); }}>Cancel</Button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 'var(--s-2)' }}>
                    <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); approve(p.id); }}>Approve</Button>
                    <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); setRejectingId(p.id); setRejectReason('not needed'); }}>Reject</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card>
          {!selected && <Empty title="Select an approval">Pick a pending action from the list to preview its undo graph and entity context.</Empty>}
          {selected && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--s-3)', marginBottom: 'var(--s-4)' }}>
                <div>
                  <h2 style={{ margin: 0 }}>Action {selected.rootActionId}</h2>
                  <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>Undo preview</div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setSelected(null)}>
                  <Icon name="close" size={14} /> Close
                </Button>
              </div>
              <pre style={{ background: 'var(--bg-0)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 'var(--s-3)', fontSize: 'var(--fs-sm)', overflow: 'auto', fontFamily: 'var(--font-mono)' }}>
                {JSON.stringify(selected, null, 2)}
              </pre>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
