/**
 * Admin — unified WhatsApp configuration.
 *
 * MyOS supports two WhatsApp send paths and Brain auto-routes through
 * whichever the tenant has configured + connected:
 *
 *   1. Meta Notifier (production)  — official Cloud API, one approved
 *      business number per tenant. Required for WhatsApp Business
 *      Calling, voice notes via /media, template messages.
 *
 *   2. Legacy Web.js (development) — pairs a regular WhatsApp account
 *      via QR scan. Free, fast to set up, but unofficial — Meta can
 *      ban the number, and it's not a production-grade path.
 *
 * Tenants can run either or both at once; Brain prefers Meta when both
 * are live. This page surfaces both statuses + lets admin switch
 * between configuration panels in one place instead of two tabs.
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';
import WhatsAppTab from './WhatsAppTab';
import WhatsAppNotifierTab from './WhatsAppNotifierTab';
import BrainChannelVerifyPanel from './BrainChannelVerifyPanel';
import WhatsAppHealthPanel from './WhatsAppHealthPanel';
import { useAuth } from '../../context/AuthContext';

export default function WhatsAppMergedTab({ msg, setMsg }) {
  const { user } = useAuth();
  const [provider, setProvider] = useState(() => {
    if (typeof window === 'undefined') return 'meta';
    return localStorage.getItem('admin.wa.provider') || 'meta';
  });
  const [status, setStatus] = useState({ loading: true });
  // SuperAdmin-only tenant override. Hoisted out of the inner panels
  // because both QR Code and Meta need to know which tenant they're
  // configuring; one selector here is the single source of truth.
  const [tenants, setTenants] = useState([]);
  const [selectedTenant, setSelectedTenant] = useState(user?.clientNumber || '');

  useEffect(() => {
    if (user?.isSuperAdmin) {
      api.get('/tenants').then((r) => {
        const list = r.data?.tenants || r.data || [];
        setTenants(list);
        if (!selectedTenant && list.length > 0) setSelectedTenant(list[0].clientNumber);
      }).catch(() => {});
    }
  }, []);

  const refreshStatus = async () => {
    setStatus({ loading: true });
    try {
      const [notifier, legacy] = await Promise.all([
        api.get('/admin/whatsapp-notifier').then((r) => r.data).catch(() => null),
        api.get('/admin/whatsapp/status').then((r) => r.data).catch(() => null),
      ]);
      setStatus({ loading: false, notifier, legacy });
    } catch (e) {
      setStatus({ loading: false, error: e?.message ?? 'failed to load status' });
    }
  };
  useEffect(() => { refreshStatus(); }, []);

  const pick = (p) => {
    setProvider(p);
    if (typeof window !== 'undefined') localStorage.setItem('admin.wa.provider', p);
  };

  // Best-effort label extraction from each channel's raw status payload.
  const notifierLive = !!status.notifier?.isActive && !!status.notifier?.hasToken;
  const legacyLive = status.legacy?.status === 'connected';
  const activeChannel =
    notifierLive && legacyLive ? 'meta (preferred) + webjs ready' :
    notifierLive ? 'meta notifier' :
    legacyLive   ? 'legacy webjs' :
    'NONE — Brain cannot reach users via WhatsApp';

  return (
    <div style={{ padding: 'var(--s-6)' }}>
      <WhatsAppHealthPanel />
      <h1 style={{ margin: 0 }}>WhatsApp — Brain ↔ User channel</h1>
      <p style={{ color: 'var(--text-muted)', marginTop: 'var(--s-2)', maxWidth: 760, lineHeight: 1.55 }}>
        The tenant's WhatsApp number is <strong>the</strong> way Brain communicates with users
        of this tenant — both directions, all media. Configure the production-grade{' '}
        <strong>Meta Notifier</strong> when your business number is approved; use the legacy{' '}
        <strong>WhatsApp Web (QR)</strong> path for dev/testing. Brain auto-routes everything
        (proactive pings, replies to inbound messages, voice notes) through whichever channel
        you have connected.
      </p>
      <div style={{
        marginTop: 'var(--s-3)', padding: '8px 12px',
        background: 'var(--bg-2)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)', color: 'var(--text-muted)',
        maxWidth: 760, lineHeight: 1.55,
      }}>
        <strong style={{ color: 'var(--text)' }}>Two-way coverage matrix</strong>
        <table style={{ width: '100%', marginTop: 6, borderCollapse: 'collapse' }}>
          <thead>
            <tr><th style={cellStyle}>Direction</th><th style={cellStyle}>Text</th><th style={cellStyle}>Voice note</th><th style={cellStyle}>Voice call</th></tr>
          </thead>
          <tbody>
            <tr><td style={cellStyle}>Brain → user</td><td style={cellStyle}>✅</td><td style={cellStyle}>✅ (Meta only)</td><td style={cellStyle}>✅ Business Calling API + tap-to-call CTA fallback</td></tr>
            <tr><td style={cellStyle}>User → Brain</td><td style={cellStyle}>✅</td><td style={cellStyle}>✅ (transcribe → Brain → voice reply)</td><td style={cellStyle}><span style={{ color: '#f59e0b' }}>⚠️ inbound call routing not yet built</span></td></tr>
          </tbody>
        </table>
        <div style={{ marginTop: 6 }}>
          <strong style={{ color: '#f59e0b' }}>Inbound voice call:</strong> when a user dials the
          tenant number, the call rings to whoever physically holds the SIM. Auto-answer with a
          live voice bot (real-time STT/LLM/TTS) is a separate workstream — flag it when
          prioritised and we'll wire the Meta Calling webhook + bot pipeline.
        </div>
      </div>

      {/* ── Tenant selector (SuperAdmin only) ───────────────────────────── */}
      {user?.isSuperAdmin && tenants.length > 0 && (
        <div style={{
          marginTop: 'var(--s-4)', display: 'flex', alignItems: 'center', gap: 'var(--s-3)',
          padding: '8px 12px', background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--r-md)',
        }}>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.4px' }}>
            Tenant
          </span>
          <select
            value={selectedTenant}
            onChange={(e) => setSelectedTenant(e.target.value)}
            style={{
              padding: '6px 10px', background: 'var(--bg-1)',
              border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
              color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer',
            }}
          >
            {tenants.map((t) => (
              <option key={t.clientNumber} value={t.clientNumber}>
                {t.name} ({t.clientNumber})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ── Live status row — both channels at a glance ─────────────────── */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)',
        marginTop: 'var(--s-5)', marginBottom: 'var(--s-4)',
      }}>
        <ChannelChip
          title="WhatsApp Meta"
          subtitle="Production — Cloud API"
          live={notifierLive}
          detail={status.notifier
            ? (status.notifier.configured
                ? `${status.notifier.displayNumber ?? '(no display number)'} — ${status.notifier.isActive ? 'active' : 'inactive'}${status.notifier.hasToken ? '' : ', no token'}`
                : 'not configured')
            : (status.loading ? 'loading…' : 'unavailable')}
          onPick={() => pick('meta')}
          selected={provider === 'meta'}
        />
        <ChannelChip
          title="WhatsApp QR Code"
          subtitle="Development — pair via QR scan"
          live={legacyLive}
          detail={status.legacy
            ? (status.legacy.configured === false
                ? 'not configured'
                : `${status.legacy.connected_number ?? '(unpaired)'} — ${status.legacy.status ?? 'unknown'}`)
            : (status.loading ? 'loading…' : 'unavailable')}
          onPick={() => pick('qr')}
          selected={provider === 'qr'}
        />
      </div>

      <div style={{
        padding: '8px 12px', marginBottom: 'var(--s-4)',
        background: (notifierLive || legacyLive) ? 'rgba(34,197,94,0.10)' : 'rgba(217,83,79,0.12)',
        border: '1px solid ' + ((notifierLive || legacyLive) ? 'rgba(34,197,94,0.45)' : 'rgba(217,83,79,0.45)'),
        borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)',
      }}>
        <strong>Brain ↔ user channel:</strong>{' '}
        {notifierLive && legacyLive ? 'WhatsApp Meta (preferred) + QR Code ready' :
         notifierLive ? 'WhatsApp Meta' :
         legacyLive   ? 'WhatsApp QR Code' :
         'NONE — Brain cannot reach users via WhatsApp'}
        {(!notifierLive && !legacyLive) && (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>
            — pick a panel below to configure one. Until then, Brain's criticality alerts and
            other proactive pings won't reach users.
          </span>
        )}
      </div>

      {/* Status messages render via AdminPage's floating toast (top-right,
          auto-dismiss). Don't duplicate inline here — that strands a copy
          in the form body when the user has scrolled. */}

      {/* ── Verify Brain ↔ User channel ─────────────────────────────────── */}
      {(notifierLive || legacyLive) && <BrainChannelVerifyPanel user={user} />}

      {/* ── Connection resilience guarantees ────────────────────────────── */}
      {(notifierLive || legacyLive) && (
        <div style={{
          marginTop: 'var(--s-3)', padding: '10px 12px',
          background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.30)',
          borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)', color: 'var(--text)',
          lineHeight: 1.6,
        }}>
          <strong>Stay-connected guarantees</strong>
          <ul style={{ margin: '6px 0 0 18px', padding: 0, color: 'var(--text-muted)' }}>
            <li><strong>Heartbeat watchdog</strong> — every 5 minutes, server probes each tenant's connection. If the in-memory client is missing (Chromium crashed, host slept), it auto-re-initializes from the saved LocalAuth session — no QR re-scan.</li>
            <li><strong>Auto-reconnect on disconnect</strong> — exponential backoff 10s → 30s → 2m → 5m → 10m. After 5 failed attempts, circuit breaker opens and admins are emailed.</li>
            <li><strong>Stale-lock cleanup on boot</strong> — if the previous process got SIGKILL'd, leftover Chromium SingletonLock files pointing at dead PIDs are removed before relaunch.</li>
            <li><strong>Lazy self-heal on send</strong> — the first send after a silent dropout re-initializes the provider transparently and retries once.</li>
            <li><strong>Email alerts to SuperAdmins + tenant admins</strong> — fire on hard disconnect (LOGOUT/CONFLICT/UNPAIRED), heartbeat self-heal failure, and circuit-breaker open. So you find out before users do.</li>
          </ul>
        </div>
      )}

      {/* ── Active configuration panel ───────────────────────────────────── */}
      <div style={{
        marginTop: 'var(--s-3)', padding: 'var(--s-4)',
        background: 'var(--bg-2)', border: '1px solid var(--border)',
        borderRadius: 'var(--r-md)',
      }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 'var(--s-2)',
          marginBottom: 'var(--s-3)',
        }}>
          <span style={{
            fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px',
            color: 'var(--accent)', fontWeight: 600,
          }}>
            Configure {provider === 'meta' ? 'WhatsApp Meta' : 'WhatsApp QR Code'}
          </span>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {provider === 'meta'
              ? 'Production: Meta Cloud API. Required for outbound voice notes via /media and Business Calling.'
              : 'Development: pair a phone via QR scan. No Meta enrollment needed.'}
          </span>
        </div>
        {provider === 'meta' ? (
          <WhatsAppNotifierTab />
        ) : (
          <WhatsAppTab user={user} msg={msg} setMsg={setMsg} />
        )}
      </div>
    </div>
  );
}

const cellStyle = {
  textAlign: 'left', padding: '4px 8px', fontSize: 11,
  borderBottom: '1px solid var(--border)', verticalAlign: 'top',
};

function ChannelChip({ title, subtitle, live, detail, onPick, selected }) {
  return (
    <button
      type="button"
      onClick={onPick}
      style={{
        textAlign: 'left', cursor: 'pointer',
        padding: '12px 14px', border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
        background: selected ? 'rgba(255,135,30,0.06)' : 'var(--panel, #141a22)',
        borderRadius: 'var(--r-md)', color: 'var(--text)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: live ? 'var(--success, #22c55e)' : 'var(--danger, #d9534f)',
        }} />
        <strong style={{ fontSize: 'var(--fs-sm)' }}>{title}</strong>
        <div style={{ flex: 1 }} />
        <span style={{
          fontSize: 11, padding: '1px 6px', borderRadius: 4,
          background: live ? 'rgba(34,197,94,0.18)' : 'rgba(152,160,168,0.16)',
          color: live ? '#9bd9a0' : 'var(--text-muted)',
          textTransform: 'uppercase', letterSpacing: '.3px', fontWeight: 600,
        }}>{live ? 'live' : 'offline'}</span>
      </div>
      {subtitle && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '.3px' }}>{subtitle}</div>
      )}
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>{detail}</div>
    </button>
  );
}
