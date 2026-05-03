import { useState, useEffect, useRef } from 'react';
import api from '../../services/api';

const s = {
  section: { background: '#1e1e1e', border: '1px solid #333', borderRadius: 10, padding: 20, marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 600, color: '#e8e8e0', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 0.5 },
  label: { display: 'block', fontSize: 12, color: '#888', marginBottom: 4, marginTop: 12 },
  input: { width: '100%', background: '#2a2a2a', border: '1px solid #444', color: '#eee', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' },
  btn: { padding: '8px 18px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: 'inherit' },
  btnPrimary: { background: '#cc6b4a', color: '#fff' },
  btnDanger: { background: '#ef4444', color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid #555', color: '#aaa' },
  statusDot: (color) => ({ width: 10, height: 10, borderRadius: '50%', background: color, display: 'inline-block', marginRight: 8 }),
  badge: { display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 500 },
  row: { display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 },
  progress: { height: 6, background: '#333', borderRadius: 3, flex: 1 },
  progressFill: (pct) => ({ height: '100%', borderRadius: 3, background: pct > 80 ? '#ef4444' : '#cc6b4a', width: `${Math.min(pct, 100)}%` }),
  qrBox: { textAlign: 'center', padding: 20, background: '#fff', borderRadius: 12, display: 'inline-block' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 },
  th: { background: '#2a2a2a', color: '#e8e8e0', textAlign: 'left', padding: '8px 10px', borderBottom: '2px solid #cc6b4a', fontSize: 11, textTransform: 'uppercase' },
  td: { padding: '7px 10px', borderBottom: '1px solid #2a2a2a', color: '#bbb' },
};

const STATUS_COLORS = { connected: '#4ade80', connecting: '#f59e0b', disconnected: '#666', error: '#ef4444', not_configured: '#666' };

export default function WhatsAppTab({ user, msg, setMsg }) {
  // ── Tenant selector (SuperAdmin can pick which client to configure) ──
  const [tenants, setTenants] = useState([]);
  const [selectedTenant, setSelectedTenant] = useState(user?.clientNumber || '');

  const [config, setConfig] = useState(null);
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [testing, setTesting] = useState(false);     // Test Connection in flight
  const [sendingTest, setSendingTest] = useState(false); // Send Test Message in flight
  const [disconnecting, setDisconnecting] = useState(false);
  const [qrCode, setQrCode] = useState(null);
  const [messages, setMessages] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [testNumber, setTestNumber] = useState('');
  const [showTest, setShowTest] = useState(false);
  const qrPollRef = useRef(null);

  // Form state — QR-code path only. Provider is forced to 'webjs'; Meta
  // credentials live in the WhatsApp Meta panel. Daily/monthly limits +
  // max-tokens have been removed from the UI: Brain decides response
  // length and pacing based on conversation context, and the backend
  // keeps a sane backstop (whatsapp_config.daily_limit default).
  const [companyNumber, setCompanyNumber] = useState(''); // The bot's WhatsApp number users message TO

  // ── Load tenant list for SuperAdmin ─────────────────────────────
  useEffect(() => {
    if (user?.isSuperAdmin) {
      api.get('/tenants').then(r => {
        const list = r.data?.tenants || r.data || [];
        setTenants(list);
        if (!selectedTenant && list.length > 0) setSelectedTenant(list[0].clientNumber);
      }).catch(() => {});
    }
  }, []);

  // ── Reload when tenant changes ──────────────────────────────────
  useEffect(() => {
    if (selectedTenant) loadAll();
    return () => { if (qrPollRef.current) clearInterval(qrPollRef.current); };
  }, [selectedTenant]);

  // Helper: add tenant query param for SuperAdmin
  const q = user?.isSuperAdmin && selectedTenant ? `?cn=${selectedTenant}` : '';
  const qAnd = user?.isSuperAdmin && selectedTenant ? `&cn=${selectedTenant}` : '';

  async function loadAll() {
    setLoading(true);
    try {
      const [cfgRes, statusRes, msgRes, sessRes] = await Promise.all([
        api.get(`/admin/whatsapp/config${q}`).catch(() => ({ data: { configured: false } })),
        api.get(`/admin/whatsapp/status${q}`).catch(() => ({ data: { status: 'not_configured' } })),
        api.get(`/admin/whatsapp/messages?limit=20${qAnd}`).catch(() => ({ data: { messages: [] } })),
        api.get(`/admin/whatsapp/sessions${q}`).catch(() => ({ data: { sessions: [] } })),
      ]);
      setConfig(cfgRes.data);
      setStatus(statusRes.data);
      setMessages(msgRes.data.messages || []);
      setSessions(sessRes.data.sessions || []);
      if (cfgRes.data.configured) {
        setCompanyNumber(cfgRes.data.connected_number || cfgRes.data.company_number || '');
      }
      // Auto-start QR polling if already in connecting state
      if (statusRes.data?.status === 'connecting') {
        // Fetch QR immediately (don't wait for first poll interval)
        try {
          const qrRes = await api.get(`/admin/whatsapp/qr${q}`);
          if (qrRes.data.qrCode) setQrCode(qrRes.data.qrCode);
        } catch {}
        startQRPolling();
      }
    } catch {}
    setLoading(false);
  }

  // ── Save config ─────────────────────────────────────────────────
  // Provider is hard-coded to 'webjs' — this panel only manages the QR
  // Code path. Meta-Cloud credentials live in the WhatsApp Meta panel.
  async function handleSave() {
    setSaving(true);
    try {
      await api.post(`/admin/whatsapp/config${q}`, {
        provider: 'webjs',
        companyNumber: companyNumber || undefined,
      });
      setMsg('WhatsApp QR Code config saved');
      await loadAll();
    } catch (e) { setMsg('Failed to save config'); }
    setSaving(false);
  }

  // ── Connect ─────────────────────────────────────────────────────
  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await api.post(`/admin/whatsapp/connect${q}`);
      setStatus(res.data);
      if (res.data.status === 'connecting') {
        // Start polling for QR code (webjs)
        startQRPolling();
      }
      setMsg(res.data.status === 'connected' ? 'Connected!' : 'Connecting... scan QR code');
    } catch (e) {
      // Surface the real server error so the admin can diagnose (Chrome
      // path, provider conflict with WhatsApp Personal, missing deps…).
      const detail = e?.response?.data?.error ?? e?.message ?? 'unknown error';
      setMsg(`Connection failed: ${detail}`);
    }
    setConnecting(false);
  }

  // ── QR polling ──────────────────────────────────────────────────
  function startQRPolling() {
    if (qrPollRef.current) clearInterval(qrPollRef.current);
    qrPollRef.current = setInterval(async () => {
      try {
        const res = await api.get(`/admin/whatsapp/qr${q}`);
        if (res.data.qrCode) setQrCode(res.data.qrCode);
        if (res.data.status === 'connected') {
          clearInterval(qrPollRef.current);
          qrPollRef.current = null;
          setQrCode(null);
          setMsg('WhatsApp connected!');
          loadAll();
        }
      } catch {}
    }, 3000);
  }

  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  // ── Disconnect ──────────────────────────────────────────────────
  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await api.post(`/admin/whatsapp/disconnect${q}`);
      if (qrPollRef.current) { clearInterval(qrPollRef.current); qrPollRef.current = null; }
      setQrCode(null);
      setMsg('Disconnected');
      loadAll();
    } catch (e) { setMsg('Disconnect failed'); }
    finally { setDisconnecting(false); }
  }

  // ── Test message ────────────────────────────────────────────────
  async function handleTestSend() {
    if (!testNumber) return;
    setSendingTest(true);
    try {
      const res = await api.post(`/admin/whatsapp/test${q}`, { testNumber });
      setMsg(res.data.success ? `Test sent! (ID: ${res.data.messageId})` : `Test failed: ${res.data.error}`);
      setShowTest(false);
      loadAll();
    } catch (e) { setMsg('Test send failed'); }
    finally { setSendingTest(false); }
  }

  // ── Test Connection ─────────────────────────────────────────────
  // Centralized so the button gets a proper loading state — the inline
  // version in the JSX had no spinner and no disabled gate, so users
  // could rapid-fire clicks during the up-to-8s server-side self-heal
  // wait.
  async function handleTestConnection() {
    setTesting(true);
    try {
      const res = await api.post(`/admin/whatsapp/test-connection${q}`);
      if (res.data.success) {
        setMsg(`Connection OK — Connected number: ${res.data.connectedNumber}`);
        loadAll();
      } else {
        setMsg(`Connection failed: ${res.data.error ?? 'no detail returned by provider'}`);
      }
    } catch (e) {
      const detail = e?.response?.data?.error ?? e?.message ?? 'unknown error';
      setMsg(`Test connection failed: ${detail}`);
    } finally {
      setTesting(false);
    }
  }

  // ── Approve / Reject ───────────────────────────────────────────
  async function handleApprove(id) {
    try { await api.post(`/admin/whatsapp/messages/${id}/approve`); setMsg('Approved & sent'); loadAll(); } catch { setMsg('Approve failed'); }
  }
  async function handleReject(id) {
    try { await api.post(`/admin/whatsapp/messages/${id}/reject`); setMsg('Rejected'); loadAll(); } catch { setMsg('Reject failed'); }
  }

  if (loading) return <div style={{ color: '#888', padding: 20 }}>Loading WhatsApp config...</div>;

  const st = status?.status || 'not_configured';

  return (
    <div>
      {/* ── Company WhatsApp Number (paired phone) ───────────── */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Company WhatsApp Number</div>
        <p style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>
          The phone whose WhatsApp account scans the QR code. Users will see this
          number when Brain messages them. Use a spare SIM — not your main account.
        </p>
        <label style={s.label}>WhatsApp Number (E.164 format) *</label>
        <input style={{
          ...s.input, maxWidth: 300,
          borderColor: companyNumber && !/^\+\d{10,15}$/.test(companyNumber.replace(/[\s-]/g, '')) ? '#ef4444' : '#444',
        }} value={companyNumber} onChange={e => setCompanyNumber(e.target.value)} placeholder="+923001234567" />
        {companyNumber && !/^\+\d{10,15}$/.test(companyNumber.replace(/[\s-]/g, '')) && (
          <p style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>Invalid format. Must start with + followed by 10-15 digits. Example: +923001234567</p>
        )}
      </div>

      {/* ── Save + Test Connection ────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button
          style={{ ...s.btn, ...s.btnPrimary, opacity: saving ? 0.85 : 1 }}
          onClick={handleSave}
          disabled={saving || testing}
        >
          {saving && <span className="btn-spinner" />}
          {saving ? 'Saving…' : 'Save Configuration'}
        </button>
        <button
          style={{ ...s.btn, ...s.btnOutline, opacity: testing ? 0.85 : 1 }}
          onClick={handleTestConnection}
          disabled={testing || saving}
          title={testing ? 'Probing the provider… up to 8s if a self-heal kicks in' : 'Probe the WhatsApp provider without sending a message'}
        >
          {testing && <span className="btn-spinner" />}
          {testing ? 'Testing…' : 'Test Connection'}
        </button>
      </div>

      {/* ── Section 3: Connection Status ───────────────────────── */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Connection Status</div>
        <div style={s.row}>
          {/* Halo pulse during connecting/testing — subtle radiating ring
              so users see "something is happening" instead of staring at
              a static dot for up to 8 seconds. */}
          <span
            className={(st === 'connecting' || testing || connecting) ? 'status-dot-pulse' : ''}
            style={{ ...s.statusDot(STATUS_COLORS[st] || '#666'), color: STATUS_COLORS[st] || '#666' }}
          />
          <span style={{ fontWeight: 600, color: '#eee', textTransform: 'uppercase' }}>
            {testing ? 'testing…' : connecting && st !== 'connecting' ? 'connecting…' : st}
          </span>
          {status?.connected_number && <span style={{ color: '#888', marginLeft: 8 }}>{status.connected_number}</span>}
          {status?.connected_at && <span style={{ color: '#555', fontSize: 11, marginLeft: 8 }}>Since {new Date(status.connected_at).toLocaleString()}</span>}
        </div>

        {/* QR Code display (webjs connecting) */}
        {qrCode && st === 'connecting' && (
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <div style={s.qrBox}>
              <img src={qrCode} alt="QR Code" style={{ width: 250, height: 250 }} />
            </div>
            <p style={{ color: '#888', fontSize: 12, marginTop: 8 }}>Open WhatsApp → Linked Devices → Link a Device → Scan this QR</p>
            <p style={{ color: '#555', fontSize: 11 }}>QR refreshes automatically every 3 seconds</p>
          </div>
        )}

        {/* Error display */}
        {st === 'error' && status?.last_error && (
          <div style={{ marginTop: 8, padding: 10, background: '#2a1a1a', border: '1px solid #ef4444', borderRadius: 8, color: '#ef4444', fontSize: 12 }}>
            {status.last_error}
          </div>
        )}

        {/* Usage counters — informational only. No hard caps surfaced
            in the UI; Brain self-paces, and the backend keeps a generous
            backstop on whatsapp_config.daily_limit. */}
        {st === 'connected' && (
          <div style={{ marginTop: 12, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
            {status?.messages_today ?? 0} sent today · {status?.messages_this_month ?? 0} this month
          </div>
        )}

        {/* Action buttons */}
        <div style={{ ...s.row, marginTop: 16 }}>
          {(st === 'disconnected' || st === 'not_configured' || st === 'error') && (
            <button
              style={{ ...s.btn, ...s.btnPrimary, opacity: connecting ? 0.85 : 1 }}
              onClick={handleConnect}
              disabled={connecting}
            >
              {connecting && <span className="btn-spinner" />}
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          )}
          {st === 'connected' && (
            <>
              <button
                style={{ ...s.btn, ...s.btnPrimary }}
                onClick={() => setShowTest(true)}
                disabled={disconnecting}
              >
                Send Test Message
              </button>
              {!confirmDisconnect ? (
                <button
                  style={{ ...s.btn, ...s.btnDanger, opacity: disconnecting ? 0.85 : 1 }}
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={disconnecting}
                >
                  Disconnect
                </button>
              ) : (
                <>
                  <span style={{ color: '#ef4444', fontSize: 12, marginRight: 6 }}>Are you sure?</span>
                  <button
                    style={{ ...s.btn, ...s.btnDanger, fontSize: 11, padding: '4px 12px', opacity: disconnecting ? 0.85 : 1 }}
                    onClick={() => { setConfirmDisconnect(false); handleDisconnect(); }}
                    disabled={disconnecting}
                  >
                    {disconnecting && <span className="btn-spinner" />}
                    {disconnecting ? 'Disconnecting…' : 'Yes, Disconnect'}
                  </button>
                  <button
                    style={{ ...s.btn, ...s.btnOutline, fontSize: 11, padding: '4px 12px' }}
                    onClick={() => setConfirmDisconnect(false)}
                    disabled={disconnecting}
                  >
                    Cancel
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Test Message Modal ─────────────────────────────────── */}
      {showTest && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Send Test Message</div>
          <label style={s.label}>Phone Number (E.164 format)</label>
          <input style={s.input} value={testNumber} onChange={e => setTestNumber(e.target.value)} placeholder="+923001234567" />
          <p style={{ color: '#888', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            Message: "This is a test message from TMCAI. WhatsApp is configured correctly. — Sent via TMCAI Admin Panel"
          </p>
          <div style={{ ...s.row, marginTop: 12 }}>
            <button
              style={{ ...s.btn, ...s.btnPrimary, opacity: sendingTest ? 0.85 : 1 }}
              onClick={handleTestSend}
              disabled={sendingTest || !testNumber}
            >
              {sendingTest && <span className="btn-spinner" />}
              {sendingTest ? 'Sending…' : 'Send Test'}
            </button>
            <button
              style={{ ...s.btn, ...s.btnOutline }}
              onClick={() => setShowTest(false)}
              disabled={sendingTest}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Section 4: Message Log ─────────────────────────────── */}
      <div style={s.section}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={s.sectionTitle}>Recent Messages</div>
          <button style={{ ...s.btn, ...s.btnOutline, fontSize: 11 }} onClick={loadAll}>Refresh</button>
        </div>
        {messages.length === 0 ? (
          <p style={{ color: '#555', fontSize: 12 }}>No messages yet</p>
        ) : (
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Dir</th>
                  <th style={s.th}>Number</th>
                  <th style={s.th}>Content</th>
                  <th style={s.th}>Status</th>
                  <th style={s.th}>Time</th>
                  <th style={s.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m, i) => (
                  <tr key={m.id || i}>
                    <td style={s.td}>{m.direction === 'inbound' ? '📥' : '📤'}</td>
                    {/* Show the OTHER party — recipient for outbound, sender
                        for inbound. The previous `from_number || to_number`
                        always rendered the tenant's connected number for
                        outbound rows, which was misleading. */}
                    <td style={s.td}>{m.direction === 'inbound' ? (m.from_number || '?') : (m.to_number || '?')}</td>
                    <td style={{ ...s.td, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.content?.slice(0, 60)}</td>
                    <td style={s.td}>
                      <span style={{ ...s.badge,
                        background: m.status === 'sent' ? '#4ade8022' : m.status === 'failed' ? '#ef444422' : m.status === 'queued' ? '#f59e0b22' : '#33333366',
                        color: m.status === 'sent' ? '#4ade80' : m.status === 'failed' ? '#ef4444' : m.status === 'queued' ? '#f59e0b' : '#888',
                      }}>{m.status}</span>
                    </td>
                    <td style={{ ...s.td, fontSize: 11, color: '#555' }}>{m.created_at ? new Date(m.created_at).toLocaleString() : ''}</td>
                    <td style={s.td}>
                      {m.status === 'queued' && m.requires_approval && (
                        <>
                          <button style={{ ...s.btn, ...s.btnPrimary, fontSize: 10, padding: '2px 8px', marginRight: 4 }} onClick={() => handleApprove(m.id)}>Approve</button>
                          <button style={{ ...s.btn, ...s.btnDanger, fontSize: 10, padding: '2px 8px' }} onClick={() => handleReject(m.id)}>Reject</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Section 5: Active Sessions ─────────────────────────── */}
      <div style={s.section}>
        <div style={s.sectionTitle}>Active WhatsApp Sessions</div>
        {sessions.length === 0 ? (
          <p style={{ color: '#555', fontSize: 12 }}>No active conversations</p>
        ) : (
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>User</th>
                <th style={s.th}>Messages</th>
                <th style={s.th}>Last Active</th>
                <th style={s.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((ses, i) => (
                <tr key={ses.id || i}>
                  <td style={s.td}>{ses.user_name}</td>
                  <td style={s.td}>{ses.message_count}</td>
                  <td style={{ ...s.td, fontSize: 11 }}>{ses.last_message_at ? new Date(ses.last_message_at).toLocaleString() : ''}</td>
                  <td style={s.td}>
                    <button style={{ ...s.btn, ...s.btnOutline, fontSize: 10, padding: '2px 8px' }}
                      onClick={async () => { await api.delete(`/admin/whatsapp/sessions/${ses.id}`); loadAll(); }}>
                      End Session
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
