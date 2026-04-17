import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

const s = {
  wrapper: { height: '100vh', overflow: 'hidden', position: 'relative', background: '#111' },
  scrollArea: { height: '100%', overflowY: 'auto', paddingBottom: 60, scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' },
  fadeHint: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(transparent, #111)', pointerEvents: 'none', zIndex: 10, transition: 'opacity 0.3s' },
  page: { padding: '20px 24px', maxWidth: 960, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  card: { background: '#1e1e1e', border: '1px solid #333', borderRadius: 10, padding: 16, marginBottom: 12 },
  cardConnected: { borderColor: '#4ade80' },
  cardConfigured: { borderColor: '#f59e0b' },
  cardError: { borderColor: '#ef4444' },
  name: { fontSize: 15, fontWeight: 600, color: '#eee' },
  desc: { fontSize: 12, color: '#888', marginTop: 2 },
  badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + '22', color, marginLeft: 8 }),
  btn: { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit' },
  btnPrimary: { background: '#cc6b4a', color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid #555', color: '#aaa' },
  btnSuccess: { background: '#4ade80', color: '#111' },
  btnDanger: { background: '#ef4444', color: '#fff' },
  btnWarn: { background: '#f59e0b', color: '#111' },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 13, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid #333' },
  statusDot: (st) => ({ width: 8, height: 8, borderRadius: '50%', background: st === 'connected' ? '#4ade80' : st === 'configured' ? '#f59e0b' : st === 'error' ? '#ef4444' : '#555', display: 'inline-block', marginRight: 6 }),
  empty: { textAlign: 'center', padding: 40, color: '#666', fontSize: 14 },
  iconBox: { width: 40, height: 40, borderRadius: 8, background: '#2a2a2a', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 14, fontSize: 18 },
  input: { width: '100%', background: '#2a2a2a', border: '1px solid #444', color: '#eee', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  label: { display: 'block', fontSize: 12, color: '#888', marginBottom: 4, marginTop: 10 },
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '20px 16px', overflow: 'auto' },
  modalBody: { background: '#1e1e1e', border: '1px solid #444', borderRadius: 12, padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#333 transparent', margin: 'auto' },
  error: { padding: '8px 12px', background: '#ef444422', border: '1px solid #ef4444', borderRadius: 8, color: '#ef4444', fontSize: 12, marginTop: 10 },
  success: { padding: '8px 12px', background: '#4ade8022', border: '1px solid #4ade80', borderRadius: 8, color: '#4ade80', fontSize: 12, marginTop: 10 },
  infoMsg: { padding: '8px 14px', borderRadius: 8, marginBottom: 12, fontSize: 13 },
};

const ICONS = { email: '✉', calendar: '📅', tasks: '✓', messaging: '💬', chat: '💭', drive: '📁', social: '🌐', meetings: '📹', notes: '📝', data_warehouse: '🗄', spreadsheets: '📊', project_mgmt: '📋', erp: '🏭', crm: '👥', hr: '🧑‍💼', intelligence: '🧠', support: '🎫', dev: '⚙', kb: '📚', custom: '🔌' };
const CAT_LABELS = { email: 'Email', calendar: 'Calendar', tasks: 'Tasks', messaging: 'Messaging', chat: 'Chat', drive: 'Cloud Drive', social: 'Social Media', meetings: 'Meetings', notes: 'Notes' };

const FIELDS = {
  todoist: [{ n: 'apiKey', l: 'API Key', t: 'password', r: true }],
  trello: [{ n: 'apiKey', l: 'API Key', t: 'password', r: true }, { n: 'token', l: 'Token', t: 'password', r: true }],
  jira: [{ n: 'domain', l: 'Jira Domain (e.g. mycompany.atlassian.net)', t: 'text', r: true }, { n: 'email', l: 'Email', t: 'email', r: true }, { n: 'apiKey', l: 'API Token', t: 'password', r: true }],
  zendesk: [{ n: 'subdomain', l: 'Zendesk Subdomain', t: 'text', r: true }, { n: 'email', l: 'Agent Email', t: 'email', r: true }, { n: 'apiKey', l: 'API Token', t: 'password', r: true }],
  hubspot: [{ n: 'apiKey', l: 'Private App Token', t: 'password', r: true }],
  notion_org: [{ n: 'apiKey', l: 'Integration Token', t: 'password', r: true }],
  telegram: [{ n: 'botToken', l: 'Bot Token', t: 'password', r: true }, { n: 'chatId', l: 'Chat ID', t: 'text', r: true }],
  whatsapp: [{ n: 'phoneNumber', l: 'Your Phone Number (with country code, e.g. +923001234567)', t: 'tel', r: true }, { n: 'phoneNumberId', l: 'WhatsApp Phone Number ID (from Meta Developer Portal)', t: 'text', r: true }, { n: 'accessToken', l: 'Permanent Access Token (from Meta Business Settings)', t: 'password', r: true }, { n: 'businessAccountId', l: 'WhatsApp Business Account ID', t: 'text', r: false }],
  sap: [{ n: 'baseUrl', l: 'SAP API URL', t: 'url', r: true }, { n: 'username', l: 'Username', t: 'text', r: true }, { n: 'password', l: 'Password', t: 'password', r: true }, { n: 'client', l: 'Client Number', t: 'text', r: false }],
  odoo: [{ n: 'baseUrl', l: 'Odoo URL', t: 'url', r: true }, { n: 'database', l: 'Database', t: 'text', r: true }, { n: 'apiKey', l: 'API Key', t: 'password', r: true }],
  _api_key: [{ n: 'apiKey', l: 'API Key', t: 'password', r: true }],
  _bot_token: [{ n: 'botToken', l: 'Bot Token', t: 'password', r: true }],
  _webhook: [{ n: 'webhookUrl', l: 'Webhook URL', t: 'url', r: true }],
  _credentials: [{ n: 'baseUrl', l: 'API URL', t: 'url', r: true }, { n: 'username', l: 'Username', t: 'text', r: true }, { n: 'password', l: 'Password', t: 'password', r: true }],
};

function getFields(c) {
  return FIELDS[c.slug] || FIELDS['_' + c.authMethod] || [];
}

export default function ConnectorsPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [connectors, setConnectors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('info');
  const [atBottom, setAtBottom] = useState(false);

  // Modal
  const [modal, setModal] = useState(null);   // connector object
  const [form, setForm] = useState({});
  const [saved, setSaved] = useState(false);   // config saved, ready to test
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const [testSuccess, setTestSuccess] = useState('');
  const [oauthLoading, setOauthLoading] = useState(false);
  const [redirectUri, setRedirectUri] = useState('');
  const [testingId, setTestingId] = useState(null); // connectorTypeId being tested
  const [testResult, setTestResult] = useState({}); // { [connectorTypeId]: { success, detail, error } }

  useEffect(() => { load(); loadRedirectUri(); }, []);

  async function loadRedirectUri() {
    try { const r = await api.get('/connectors/oauth/redirect-uri'); setRedirectUri(r.data.redirectUri); } catch { setRedirectUri('http://localhost:4002/api/v1/connectors/oauth/callback'); }
  }
  useEffect(() => {
    const s = searchParams.get('success'), e = searchParams.get('error'), slug = searchParams.get('connected');
    if (s === 'true') { flash(`${slug || 'Connector'} connected successfully!`, 'success'); load(); }
    if (e) flash(e, 'error');
  }, [searchParams]);

  function flash(m, type = 'info') { setMsg(m); setMsgType(type); setTimeout(() => setMsg(''), 5000); }
  function handleScroll(e) { const { scrollTop, scrollHeight, clientHeight } = e.target; setAtBottom(scrollHeight - scrollTop - clientHeight < 40); }

  async function load() {
    try { const r = await api.get('/connectors/available'); setConnectors(r.data.connectors || []); } catch {}
    setLoading(false);
  }

  // ── Open Configure modal (ALL connectors go through modal) ──
  function openConfigure(c) {
    setModal(c);
    setSaved(false);
    setTesting(false);
    setTestError('');
    setTestSuccess('');
    setOauthLoading(false);

    // For OAuth: pre-fill credentials from another connected connector in same family
    if (c.authMethod === 'oauth2') {
      const googleSlugs = ['gmail', 'google_calendar', 'google_tasks', 'google_chat', 'google_drive_personal'];
      const msSlugs = ['outlook', 'outlook_calendar', 'ms_todo', 'ms_teams', 'onedrive_personal'];
      const family = googleSlugs.includes(c.slug) ? googleSlugs : msSlugs.includes(c.slug) ? msSlugs : [];

      // Find a sibling connector that has config
      const sibling = connectors.find(sib => family.includes(sib.slug) && sib.userConnector?.status === 'connected');
      if (sibling) {
        setForm({ _prefilled: true, _siblingName: sibling.name });
      } else {
        setForm({});
      }
    } else {
      setForm({});
    }
  }

  // ── Save config (step 1) ───────────────────────────────────
  function handleSaveConfig() {
    const fields = getFields(modal);
    for (const f of fields) {
      if (f.r && !form[f.n]) { setTestError(`${f.l} is required`); return; }
    }
    setTestError('');
    setSaved(true);
    setTestSuccess('');
  }

  // ── Test & Connect (step 2) ────────────────────────────────
  async function handleConnect() {
    setTesting(true);
    setTestError('');
    setTestSuccess('');
    try {
      const r = await api.post('/connectors/connect', { connectorTypeId: modal.id, config: form });
      if (r.data.success) {
        setTestSuccess('Connection successful!');
        setTimeout(() => { setModal(null); flash(`${modal.name} connected!`, 'success'); load(); }, 1200);
      } else {
        setTestError(r.data.error || 'Connection test failed');
      }
    } catch (err) {
      setTestError(err.response?.data?.error || 'Connection failed');
    }
    setTesting(false);
  }

  async function handleTest(c) {
    setTestingId(c.id);
    setTestResult(prev => ({ ...prev, [c.id]: null }));
    try {
      const r = await api.post('/connectors/test', { connectorTypeId: c.id });
      setTestResult(prev => ({ ...prev, [c.id]: r.data }));
      if (!r.data.success) load(); // reload to update status to error
    } catch (err) {
      setTestResult(prev => ({ ...prev, [c.id]: { success: false, error: err.response?.data?.error || 'Test failed' } }));
      load();
    }
    setTestingId(null);
  }

  async function handleDisconnect(c) {
    try { await api.post('/connectors/disconnect', { connectorTypeId: c.id }); flash(`${c.name} disconnected`); load(); } catch {}
  }

  // Group by category
  const grouped = {};
  connectors.forEach(c => { const cat = c.category || 'other'; if (!grouped[cat]) grouped[cat] = []; grouped[cat].push(c); });

  const STATUS_LABEL = { connected: { text: 'Connected', color: '#4ade80' }, configured: { text: 'Configured', color: '#f59e0b' }, error: { text: 'Error', color: '#ef4444' } };

  return (
    <div style={s.wrapper}>
      <div style={s.scrollArea} onScroll={handleScroll}>
      <div style={s.page}>
        <div style={s.header}>
          <div>
            <button style={{ ...s.btn, ...s.btnOutline, marginRight: 10 }} onClick={() => navigate('/')}>← Back to Chat</button>
            <span style={{ fontSize: 20, fontWeight: 700, color: '#eee' }}>My Connectors</span>
            <span style={s.badge('#4ade80')}>{connectors.filter(c => c.userConnector?.status === 'connected').length} Connected</span>
            <span style={s.badge('#888')}>{connectors.length} Available</span>
          </div>
        </div>

        {msg && <div style={{ ...s.infoMsg, background: msgType === 'success' ? '#4ade8022' : msgType === 'error' ? '#ef444422' : '#88888822', border: `1px solid ${msgType === 'success' ? '#4ade80' : msgType === 'error' ? '#ef4444' : '#888'}`, color: msgType === 'success' ? '#4ade80' : msgType === 'error' ? '#ef4444' : '#aaa' }}>{msg}</div>}

        {loading ? <div style={s.empty}>Loading connectors...</div> : connectors.length === 0 ? <div style={s.empty}>No connectors available. Ask your admin to enable connectors.</div> : (
          Object.entries(grouped).map(([cat, items]) => (
            <div key={cat} style={s.section}>
              <div style={s.sectionTitle}>{ICONS[cat] || '🔗'} {CAT_LABELS[cat] || cat}</div>
              {items.map(c => {
                const st = c.userConnector?.status;
                const cardSt = st === 'connected' ? s.cardConnected : st === 'error' ? s.cardError : st === 'configured' ? s.cardConfigured : {};
                return (
                  <div key={c.id} style={{ ...s.card, ...cardSt }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
                        <div style={s.iconBox}>{ICONS[c.category] || '🔗'}</div>
                        <div>
                          <div style={s.name}>
                            <span style={s.statusDot(st || 'disconnected')} />
                            {c.name}
                            {st && STATUS_LABEL[st] && <span style={s.badge(STATUS_LABEL[st].color)}>{STATUS_LABEL[st].text}</span>}
                          </div>
                          <div style={s.desc}>{c.description}</div>
                          {st === 'connected' && <div style={{ fontSize: 11, color: '#4ade80', marginTop: 4 }}>Connected {c.userConnector?.lastSyncAt ? `• Last sync: ${new Date(c.userConnector.lastSyncAt).toLocaleString()}` : ''}</div>}
                          {st === 'error' && c.userConnector?.errorMessage && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>Error: {c.userConnector.errorMessage}</div>}
                        {testResult[c.id] && (
                          <div style={{ fontSize: 11, marginTop: 4, color: testResult[c.id].success ? '#4ade80' : '#ef4444' }}>
                            {testResult[c.id].success ? `✓ ${testResult[c.id].detail}` : `✗ ${testResult[c.id].error}`}
                          </div>
                        )}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <button style={{ ...s.btn, ...s.btnOutline, fontSize: 11 }} onClick={() => window.open(`/connector-guide?slug=${c.slug}`, '_blank')} title="Setup guide">? Guide</button>
                        {st === 'connected' ? (
                          <>
                            <button
                              style={{ ...s.btn, ...s.btnOutline, fontSize: 11, opacity: testingId === c.id ? 0.6 : 1 }}
                              disabled={testingId === c.id}
                              onClick={() => handleTest(c)}
                            >
                              {testingId === c.id ? 'Testing...' : 'Test'}
                            </button>
                            <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => openConfigure(c)}>Reconfigure</button>
                            <button style={{ ...s.btn, ...s.btnDanger }} onClick={() => handleDisconnect(c)}>Disconnect</button>
                          </>
                        ) : st === 'error' ? (
                          <>
                            <button style={{ ...s.btn, ...s.btnWarn }} onClick={() => openConfigure(c)}>Reconfigure</button>
                            <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => handleDisconnect(c)}>Remove</button>
                          </>
                        ) : (
                          <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => openConfigure(c)}>Configure</button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      </div>
      <div style={{ ...s.fadeHint, opacity: atBottom ? 0 : 1 }} />

      {/* ── Configure Modal (2-step: Save config → Test & Connect) ── */}
      {modal && (
        <div style={s.modal} onClick={() => setModal(null)}>
          <div style={s.modalBody} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#eee' }}>Configure {modal.name}</div>
              <button style={{ ...s.btn, ...s.btnOutline, padding: '4px 10px' }} onClick={() => setModal(null)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>{modal.description}</span>
              <button style={{ ...s.btn, ...s.btnOutline, fontSize: 11, flexShrink: 0, marginLeft: 12 }} onClick={() => window.open(`/connector-guide?slug=${modal.slug}`, '_blank')}>? How to get credentials</button>
            </div>

            {/* ── OAuth connectors ── */}
            {modal.authMethod === 'oauth2' ? (
              <>
                {/* If sibling connector already connected, offer quick connect */}
                {form._prefilled ? (
                  <div style={{ background: '#252525', borderRadius: 8, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontSize: 13, color: '#4ade80', marginBottom: 4 }}>
                      <strong>{form._siblingName}</strong> is already connected. Same credentials will be used automatically.
                    </div>
                    <div style={{ fontSize: 12, color: '#888' }}>
                      Just click Connect below — no need to enter Client ID/Secret again.
                    </div>
                  </div>
                ) : (
                  <>
                    <label style={s.label}>Client ID <span style={{ color: '#ef4444' }}>*</span></label>
                    <input style={s.input} type="text" value={form.clientId || ''} onChange={e => setForm({ ...form, clientId: e.target.value })} placeholder="Paste your Client ID here" />

                    <label style={s.label}>Client Secret <span style={{ color: '#ef4444' }}>*</span></label>
                    <input style={s.input} type="password" value={form.clientSecret || ''} onChange={e => setForm({ ...form, clientSecret: e.target.value })} placeholder="Paste your Client Secret here" />

                    <label style={s.label}>Redirect URI <span style={{ color: '#666', fontWeight: 400 }}>(copy this and add to your app settings)</span></label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input style={{ ...s.input, background: '#1a1a1a', color: '#999', flex: 1, fontSize: 11 }} type="text" readOnly value={redirectUri || 'Loading...'} onClick={e => { e.target.select(); navigator.clipboard?.writeText(e.target.value); }} />
                      <button style={{ ...s.btn, ...s.btnOutline, flexShrink: 0 }} onClick={() => { navigator.clipboard?.writeText(redirectUri); flash('Copied!', 'success'); }}>Copy</button>
                    </div>
                    <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>Add this URL as a redirect URI in your Google Console / Azure / provider settings before clicking Connect.</div>
                  </>
                )}

                {testError && <div style={s.error}>{testError}</div>}
                {testSuccess && <div style={s.success}>{testSuccess}</div>}

                <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                  <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => setModal(null)}>Cancel</button>
                  <button
                    style={{ ...s.btn, background: '#3b82f6', color: '#fff', padding: '9px 24px', fontSize: 13, opacity: oauthLoading ? 0.6 : 1 }}
                    disabled={oauthLoading}
                    onClick={async () => {
                      // If not prefilled and no credentials entered, require them
                      if (!form._prefilled && !form.clientId && !form.clientSecret) { setTestError('Client ID and Client Secret are required'); return; }
                      setOauthLoading(true); setTestError('');
                      try {
                        // Send credentials if provided, otherwise backend reuses from sibling
                        const config = form.clientId ? { clientId: form.clientId, clientSecret: form.clientSecret } : undefined;
                        const r = await api.post('/connectors/oauth/url', { connectorTypeId: modal.id, config });
                        if (r.data.url) window.location.href = r.data.url;
                        else { setTestError(r.data.error || 'Failed to start authorization'); setOauthLoading(false); }
                      } catch (err) { setTestError(err.response?.data?.error || 'Authorization failed'); setOauthLoading(false); }
                    }}
                  >
                    {oauthLoading ? 'Redirecting...' : 'Connect'}
                  </button>
                </div>
              </>
            ) : (
              /* ── Non-OAuth: 2-step Configure → Connect ── */
              <>
                {/* Step indicator */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  <div style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRadius: 6, fontSize: 12, fontWeight: 600, background: !saved ? '#cc6b4a22' : '#333', color: !saved ? '#cc6b4a' : '#666', border: !saved ? '1px solid #cc6b4a' : '1px solid #333' }}>
                    1. Enter Credentials
                  </div>
                  <div style={{ flex: 1, padding: '6px 0', textAlign: 'center', borderRadius: 6, fontSize: 12, fontWeight: 600, background: saved ? '#cc6b4a22' : '#333', color: saved ? '#cc6b4a' : '#666', border: saved ? '1px solid #cc6b4a' : '1px solid #333' }}>
                    2. Test & Connect
                  </div>
                </div>

                {/* Step 1: Config fields */}
                {!saved ? (
                  <>
                    {getFields(modal).map(f => (
                      <div key={f.n}>
                        <label style={s.label}>{f.l} {f.r && <span style={{ color: '#ef4444' }}>*</span>}</label>
                        <input style={s.input} type={f.t} value={form[f.n] || ''} onChange={e => setForm({ ...form, [f.n]: e.target.value })} placeholder={f.l} />
                      </div>
                    ))}
                    {testError && <div style={s.error}>{testError}</div>}
                    <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
                      <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => setModal(null)}>Cancel</button>
                      <button style={{ ...s.btn, ...s.btnPrimary }} onClick={handleSaveConfig}>Save & Continue →</button>
                    </div>
                  </>
                ) : (
                  /* Step 2: Test & Connect */
                  <>
                    <div style={{ background: '#252525', borderRadius: 8, padding: 14, marginBottom: 12 }}>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Saved credentials:</div>
                      {getFields(modal).map(f => (
                        <div key={f.n} style={{ fontSize: 13, color: '#ccc', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#888' }}>{f.l}:</span>
                          <span>{f.t === 'password' ? '••••••••' : (form[f.n] || '—')}</span>
                        </div>
                      ))}
                    </div>

                    {testError && <div style={s.error}>{testError}</div>}
                    {testSuccess && <div style={s.success}>{testSuccess}</div>}

                    <div style={{ display: 'flex', gap: 10, marginTop: 16, justifyContent: 'flex-end' }}>
                      <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => { setSaved(false); setTestError(''); setTestSuccess(''); }}>← Back to Edit</button>
                      <button style={{ ...s.btn, ...s.btnSuccess, opacity: testing ? 0.6 : 1 }} disabled={testing || !!testSuccess} onClick={handleConnect}>
                        {testing ? 'Testing connection...' : testSuccess ? '✓ Connected!' : 'Connect'}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
