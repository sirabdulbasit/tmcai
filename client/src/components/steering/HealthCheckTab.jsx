import { useEffect, useState } from 'react';
import api from '../../services/api';

// L4.1 — 13-component deep health check driven by /health/deep.
export default function HealthCheckTab() {
  const [deep, setDeep] = useState(null);
  const [dashboard, setDashboard] = useState([]);
  const [killSwitch, setKillSwitch] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/health/deep');
      setDeep(data);
    } catch {
      setDeep({ overall: 'down', counts: { total: 0, up: 0, degraded: 0, down: 0 }, components: [] });
    }
    try {
      const { data } = await api.get('/steering/dashboard');
      setDashboard(data.rows ?? []);
    } catch {
      setDashboard([]);
    }
    try {
      const { data } = await api.get('/safety/kill-switch/status');
      setKillSwitch(data);
    } catch {
      setKillSwitch(null);
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  const overallColor = deep?.overall === 'up' ? '#0a4' : deep?.overall === 'degraded' ? '#a80' : '#b22';

  return (
    <div style={{ padding: 20 }}>
      <h2>Health Check</h2>
      {deep && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <span style={{
            background: overallColor, color: '#fff', padding: '3px 8px', borderRadius: 3, fontSize: 12, textTransform: 'uppercase',
          }}>
            {deep.overall}
          </span>
          <span style={{ color: '#888', fontSize: 12 }}>
            {deep.counts.up}/{deep.counts.total} up · {deep.counts.degraded} degraded · {deep.counts.down} down
          </span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <h3>Components (13)</h3>
          <div style={{ display: 'grid', gap: 6 }}>
            {(deep?.components ?? []).map((c) => (
              <div key={c.name} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'center', padding: 8, border: '1px solid #2a2a2a', borderRadius: 4 }}>
                <span>{c.name}</span>
                <span style={{ color: '#999', fontSize: 11 }}>{c.detail ?? ''}</span>
                <span style={{ color: statusColor(c.status), fontSize: 12, textTransform: 'uppercase' }}>{c.status}</span>
              </div>
            ))}
          </div>
          {killSwitch && (
            <div style={{ marginTop: 16, padding: 12, background: killSwitch.active ? '#3a1a1a' : '#1a3a1a', borderRadius: 6 }}>
              <strong>Kill switch:</strong> {killSwitch.active ? 'ENGAGED' : 'released'}
              {killSwitch.active && killSwitch.reason && <div style={{ fontSize: 12, marginTop: 4 }}>{killSwitch.reason}</div>}
            </div>
          )}
        </div>
        <div>
          <h3>Today's KPIs</h3>
          {dashboard.length === 0 && <div style={{ color: '#666' }}>No snapshot yet — daily snapshot runs at 06:00 PKT.</div>}
          <div style={{ display: 'grid', gap: 4 }}>
            {dashboard.map((r) => (
              <div key={r.metricType} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: 4 }}>
                <span style={{ color: '#888' }}>{r.metricType}</span>
                <span>
                  <strong>{r.current?.toFixed?.(2) ?? r.current}</strong>
                  {r.deltaPct !== null && (
                    <span style={{ marginLeft: 8, color: r.deltaPct >= 0 ? '#6a6' : '#e55', fontSize: 11 }}>
                      {r.deltaPct >= 0 ? '+' : ''}{r.deltaPct.toFixed(1)}%
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function statusColor(s) {
  if (s === 'up') return '#6a6';
  if (s === 'degraded') return '#fa0';
  if (s === 'down') return '#e55';
  return '#888';
}
