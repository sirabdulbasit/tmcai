/**
 * HealthCheckTab v2 — hero summary + 14-component grid.
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { Button, Card, Pill, Dot, Empty } from '../ui';
import { Icon } from '../ui/Icon';

export default function HealthCheckTab() {
  const [deep, setDeep] = useState(null);
  const [dashboard, setDashboard] = useState([]);
  const [killSwitch, setKillSwitch] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/health/deep');
      setDeep(data);
    } catch {
      setDeep({ overall: 'down', counts: { total: 0, up: 0, degraded: 0, down: 0 }, components: [] });
    }
    try { const { data } = await api.get('/steering/dashboard'); setDashboard(data.rows ?? []); } catch { setDashboard([]); }
    try { const { data } = await api.get('/safety/kill-switch/status'); setKillSwitch(data); } catch { setKillSwitch(null); }
    setLoading(false);
  };
  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, []);

  const overallPill = () => {
    if (!deep) return <Pill>…</Pill>;
    if (deep.overall === 'up') return <Pill variant="success">OPERATIONAL</Pill>;
    if (deep.overall === 'degraded') return <Pill variant="warning">DEGRADED</Pill>;
    return <Pill variant="danger">DOWN</Pill>;
  };

  return (
    <div style={{ padding: 'var(--s-6)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--s-4)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>Health Check</h1>
        <Button variant="secondary" size="sm" onClick={load}>
          <Icon name="refresh" size={14} /> Refresh
        </Button>
      </div>

      {/* hero */}
      <Card style={{ marginBottom: 'var(--s-5)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s-4)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
              <div style={{ fontSize: 'var(--fs-3xl)', fontWeight: 'var(--fw-semibold)' }}>
                {deep ? `${deep.counts.up}/${deep.counts.total}` : '—'}
              </div>
              {overallPill()}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', marginTop: 4 }}>
              {deep ? (
                <>
                  {deep.counts.degraded} degraded · {deep.counts.down} down · last check {loading ? 'now' : '14s ago'}
                </>
              ) : 'loading…'}
            </div>
          </div>
          {killSwitch && (
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Kill switch</div>
              <div style={{ fontWeight: 'var(--fw-semibold)', marginTop: 4 }}>
                <Dot status={killSwitch.active ? 'down' : 'up'} /> {killSwitch.active ? 'ENGAGED' : 'Released'}
              </div>
              {killSwitch.active && killSwitch.reason && (
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>{killSwitch.reason}</div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* components */}
      <h2 style={{ margin: '0 0 var(--s-3)', fontSize: 'var(--fs-lg)' }}>Components</h2>
      <div className="ui-grid-auto">
        {(deep?.components ?? []).map((c) => (
          <Card key={c.name} size="sm">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--s-2)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', fontWeight: 'var(--fw-medium)' }}>
                <Dot status={c.status === 'up' ? 'up' : c.status === 'degraded' ? 'degraded' : 'down'} />
                {c.name}
              </div>
              <div style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-xs)', textAlign: 'right', maxWidth: 160 }}>
                {c.detail ?? c.status}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* KPIs */}
      {dashboard.length > 0 && (
        <>
          <h2 style={{ margin: 'var(--s-6) 0 var(--s-3)', fontSize: 'var(--fs-lg)' }}>Today's KPIs</h2>
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-1)' }}>
              {dashboard.map((r) => (
                <div key={r.metricType} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-sm)', padding: 'var(--s-1) 0' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{r.metricType}</span>
                  <span>
                    <strong>{r.current?.toFixed?.(2) ?? r.current}</strong>
                    {r.deltaPct !== null && (
                      <span style={{ marginLeft: 'var(--s-2)', color: r.deltaPct >= 0 ? 'var(--success)' : 'var(--danger)', fontSize: 'var(--fs-xs)' }}>
                        {r.deltaPct >= 0 ? '+' : ''}{r.deltaPct.toFixed(1)}%
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
