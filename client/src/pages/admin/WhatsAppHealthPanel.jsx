/**
 * WhatsApp Health — resilience dashboard panel.
 *
 * Renders inline inside WhatsAppMergedTab (top of tab). Auto-refreshes
 * every 30s. Shows at-a-glance: uptime %, current status, last N
 * probe results as sparkline dots, auto-recovery counters.
 *
 * Read-only. All actions still happen from the existing WhatsApp
 * config panels below — this is pure observability.
 */
import { useState, useEffect } from 'react';
import api from '../../services/api';

export default function WhatsAppHealthPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.get('/admin/whatsapp-health');
        if (!cancelled) setData(r.data);
      } catch {
        if (!cancelled) setData({ error: true });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (loading) return <div style={panelStyle()}>Loading health data…</div>;
  if (!data || data.error) return null;

  const { stats, history, config, notifier, init, voice = [], voiceProviders = {}, activity = [] } = data;
  const configConnected = config?.status === 'connected';
  const notifierReady = !!notifier?.is_active;
  const lastVoice = voice.length ? voice[voice.length - 1] : null;
  const lastActivity = activity.length ? activity[activity.length - 1] : null;

  return (
    <div style={panelStyle()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 14, color: '#eee' }}>WhatsApp Resilience</strong>
        <StatusPill ok={configConnected} label={configConnected ? 'QR-pair connected' : 'QR-pair down'} />
        {init?.state === 'connecting' && (
          <StatusPill ok label={`initializing · deadline ${new Date(init.deadlineAt).toLocaleTimeString()}`} />
        )}
        {init?.state === 'init_timeout' && (
          <StatusPill
            ok={false}
            label={init.requiresRepair
              ? `init timeout ×${init.consecutiveTimeouts} · re-pair required`
              : `init timeout ×${init.consecutiveTimeouts} · retry scheduled`}
          />
        )}
        <StatusPill ok={notifierReady} label={notifierReady ? 'Meta notifier active' : 'Meta notifier inactive'} />
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#666' }}>
          auto-refresh every 30s
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 12 }}>
        <StatBox
          label="Uptime (last 3h)"
          value={`${stats.uptimePct}%`}
          color={stats.uptimePct >= 95 ? '#4ade80' : stats.uptimePct >= 80 ? '#f59e0b' : '#ef4444'}
        />
        <StatBox
          label="Avg probe latency"
          value={stats.avgLatencyMs != null ? `${stats.avgLatencyMs}ms` : '—'}
          color="#60a5fa"
        />
        <StatBox
          label="Auto-recoveries"
          value={`${stats.reinitSuccessCount}✓ / ${stats.reinitFailedCount}✗`}
          color={stats.reinitFailedCount > 0 ? '#f59e0b' : '#666'}
        />
        <StatBox
          label="Messages today"
          value={config?.messages_today ?? 0}
          color="#a78bfa"
        />
      </div>

      <div style={{
        padding: '9px 10px', marginBottom: 12, borderRadius: 6,
        background: '#0f0f0f', border: '1px solid #333',
      }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 7, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Voice transcription providers
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {Object.entries(voiceProviders).map(([name, state]) => (
            <StatusPill
              key={name}
              ok={!!state?.configured}
              label={`${name}${state?.detail ? ` — ${state.detail}` : ''}`}
            />
          ))}
          {Object.keys(voiceProviders).length === 0 && (
            <span style={{ fontSize: 11, color: '#666' }}>Provider status unavailable.</span>
          )}
        </div>
        <div style={{ marginTop: 8, fontSize: 11, color: lastVoice?.outcome === 'success' ? '#4ade80' : lastVoice ? '#f59e0b' : '#666' }}>
          {lastVoice
            ? `Last voice attempt: ${lastVoice.provider} · ${lastVoice.outcome} · ${lastVoice.latencyMs}ms · ${lastVoice.mimeType} · ${lastVoice.bytes} bytes${lastVoice.error ? ` · ${lastVoice.error}` : ''}`
            : 'No voice transcription attempt recorded since the last server restart.'}
        </div>
        <div style={{ marginTop: 5, fontSize: 11, color: lastActivity?.state === 'failed' || lastActivity?.state === 'unsupported' ? '#f59e0b' : lastActivity ? '#60a5fa' : '#666' }}>
          {lastActivity
            ? `Last activity signal: ${lastActivity.state} · reaction ${lastActivity.reactionOk ? 'accepted' : 'rejected'} · ${lastActivity.voice ? 'voice turn' : 'text turn'}`
            : 'No QR activity signal recorded since the last server restart.'}
        </div>
      </div>

      {/* Sparkline — last 60 probe samples as coloured dots */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: '#666', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Recent probes (newest right, hover for detail)
        </div>
        <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          {(history.length > 60 ? history.slice(-60) : history).map((h, i) => (
            <span
              key={i}
              title={`${new Date(h.at).toLocaleTimeString()} — ${h.ok ? 'OK' : (h.error || 'FAIL')}${h.latencyMs ? ` (${h.latencyMs}ms)` : ''}${h.action && h.action !== 'noop' ? ` [${h.action}]` : ''}`}
              style={{
                width: 10, height: 10, borderRadius: 2,
                background: h.ok ? '#4ade80' : '#ef4444',
                opacity: h.action === 'reinit_success' ? 1 : h.ok ? 0.7 : 1,
                border: h.action === 'reinit_success' ? '1px solid #f59e0b' : 'none',
              }}
            />
          ))}
          {history.length === 0 && (
            <span style={{ fontSize: 11, color: '#666' }}>
              No probe data yet. Watchdog runs every 60s — check back in a minute.
            </span>
          )}
        </div>
      </div>

      {stats.lastError && (
        <div style={{
          padding: '6px 10px', fontSize: 12, borderRadius: 4,
          background: '#ef444422', color: '#ef4444',
          border: '1px solid #ef4444', marginTop: 8,
        }}>
          <strong>Last error:</strong> {stats.lastError}
        </div>
      )}
      {init?.requiresRepair && (
        <div style={{
          padding: '8px 10px', fontSize: 12, borderRadius: 4,
          background: '#f59e0b22', color: '#f59e0b',
          border: '1px solid #f59e0b', marginTop: 8,
        }}>
          <strong>Action required:</strong> the QR session is likely wedged after repeated initialization timeouts. Use Change Number / Reset Pairing below and scan a fresh QR.
        </div>
      )}
    </div>
  );
}

function StatusPill({ ok, label }) {
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
      background: (ok ? '#4ade80' : '#ef4444') + '22',
      color: ok ? '#4ade80' : '#ef4444',
      border: '1px solid ' + (ok ? '#4ade80' : '#ef4444'),
    }}>
      {ok ? '●' : '○'} {label}
    </span>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div style={{
      padding: '10px 12px', background: '#0f0f0f',
      border: '1px solid #333', borderRadius: 6,
    }}>
      <div style={{ fontSize: 10, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color }}>{value}</div>
    </div>
  );
}

function panelStyle() {
  return {
    background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
    padding: '14px 16px', marginBottom: 16,
  };
}
