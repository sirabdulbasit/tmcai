import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

const s = {
  wrapper: { height: '100vh', overflow: 'hidden', position: 'relative', background: 'var(--bg-1)' },
  scrollArea: { height: '100%', overflowY: 'auto', paddingBottom: 60, scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' },
  fadeHint: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(transparent, var(--bg-1))', pointerEvents: 'none', zIndex: 10, transition: 'opacity 0.3s' },
  page: { padding: '24px 32px', maxWidth: 1400 },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  card: { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 12 },
  cardConnected: { borderColor: '#4ade80' },
  cardConfigured: { borderColor: '#f59e0b' },
  cardError: { borderColor: '#ef4444' },
  name: { fontSize: 'var(--fs-base)', fontWeight: 600, color: 'var(--text)' },
  desc: { fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginTop: 2 },
  badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + '22', color, marginLeft: 8 }),
  btn: { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'inherit' },
  btnPrimary: { background: '#cc6b4a', color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' },
  btnSuccess: { background: '#4ade80', color: 'var(--bg-1)' },
  btnDanger: { background: '#ef4444', color: '#fff' },
  btnWarn: { background: '#f59e0b', color: 'var(--bg-1)' },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10, paddingBottom: 6, borderBottom: '1px solid var(--border)' },
  statusDot: (st) => ({ width: 8, height: 8, borderRadius: '50%', background: st === 'connected' ? '#4ade80' : st === 'configured' ? '#f59e0b' : st === 'error' ? '#ef4444' : 'var(--border)', display: 'inline-block', marginRight: 6 }),
  empty: { textAlign: 'center', padding: 40, color: 'var(--text-muted)', fontSize: 'var(--fs-base)' },
  iconBox: { width: 40, height: 40, borderRadius: 8, background: 'var(--bg-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: 14, fontSize: 18 },
  input: { width: '100%', background: 'var(--bg-1)', border: '1px solid var(--border)', color: 'var(--text)', padding: '8px 12px', borderRadius: 8, fontSize: 'var(--fs-sm)', fontFamily: 'inherit', boxSizing: 'border-box' },
  label: { display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 4, marginTop: 10 },
  modal: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '20px 16px', overflow: 'auto' },
  modalBody: { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#333 transparent', margin: 'auto' },
  error: { padding: '8px 12px', background: '#ef444422', border: '1px solid #ef4444', borderRadius: 8, color: '#ef4444', fontSize: 'var(--fs-sm)', marginTop: 10 },
  success: { padding: '8px 12px', background: '#4ade8022', border: '1px solid #4ade80', borderRadius: 8, color: '#4ade80', fontSize: 'var(--fs-sm)', marginTop: 10 },
  infoMsg: { padding: '8px 14px', borderRadius: 8, marginBottom: 12, fontSize: 'var(--fs-sm)' },
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

  // Historical Pull — user-triggered, server runs in background, UI polls
  // /connectors/backfill/status for progress. The button goes disabled while
  // the request is in flight (brief, < 1s); once the server responds the
  // progress banner takes over as the "still running" indicator.
  const [historicalPulling, setHistoricalPulling] = useState(false);
  const [historicalDays, setHistoricalDays] = useState(90);
  async function handleHistoricalPull(days) {
    setHistoricalPulling(true);
    try {
      const pullDays = days ?? historicalDays;
      const { data } = await api.post('/connectors/historical-pull', { days: pullDays });
      const parts = [];
      if (data.triggered?.length) parts.push(`started: ${data.triggered.map((t) => t.slug).join(', ')}`);
      if (data.skipped?.length) parts.push(`skipped: ${data.skipped.map((t) => t.slug).join(', ')}`);
      setMsg(`Historical pull kicked off (${pullDays} days) — ${parts.join(' · ')}. Progress shown below; you can leave this page.`);
      setMsgType('success');
    } catch (err) {
      setMsg(`Historical pull failed: ${err?.response?.data?.error ?? err.message}`);
      setMsgType('error');
    } finally {
      setHistoricalPulling(false);
    }
  }

  // Attachment backfill progress — polled every 5s while not complete so the
  // user sees Brain setting itself up after connecting Gmail.
  const [backfill, setBackfill] = useState(null); // { state, totalEvents, processed, etaSeconds }
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const { data } = await api.get('/connectors/backfill/status');
        if (!cancelled) setBackfill(data);
      } catch { /* silent */ }
    }
    poll();
    const t = setInterval(() => {
      if (backfill && (backfill.state === 'complete' || backfill.totalEvents === 0)) return;
      poll();
    }, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [backfill?.state]);

  useEffect(() => { load(); loadRedirectUri(); }, []);

  // ── Cross-tab + cross-system state sync ─────────────────────────────
  // Connector status changes happen on the server (OAuth callback,
  // admin enable/disable, disconnect). Multiple clients viewing this
  // page need to converge on the latest server state. Three layers:
  //
  //   1. BroadcastChannel — instant (same browser only). When OAuth
  //      lands in tab A, tab B in the same browser refreshes within ms.
  //   2. focus + visibilitychange — when ANY tab regains focus, it
  //      refetches. Catches the cross-browser case where a user
  //      switches browsers / machines.
  //   3. Polling every 30s — cross-system fallback. Two users on
  //      different machines viewing the page each see updates within
  //      30s without anyone refreshing. Pauses while the tab is
  //      hidden (no point burning CPU) and resumes on visibility.
  //
  // 30s is a deliberate trade-off: low enough that "I just connected
  // Gmail in the office, my colleague at home should see it" is fast,
  // high enough not to hammer the server.
  useEffect(() => {
    let bc;
    let poll;
    const onFocus = () => load();
    const onVisible = () => {
      if (!document.hidden) {
        load();
        // Restart polling on visibility return (was paused)
        if (!poll) poll = setInterval(() => { if (!document.hidden) load(); }, 30000);
      } else {
        if (poll) { clearInterval(poll); poll = null; }
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    try {
      bc = new BroadcastChannel('myos-connectors');
      bc.onmessage = (e) => { if (e.data?.type === 'refresh') load(); };
    } catch { /* older browser */ }
    // Start polling immediately (page is visible on mount)
    poll = setInterval(() => { if (!document.hidden) load(); }, 30000);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      if (poll) clearInterval(poll);
      try { bc?.close(); } catch {}
    };
  }, []);

  // After a successful OAuth callback in THIS tab, broadcast so other
  // tabs of the same app reload their connector list immediately.
  useEffect(() => {
    const s = searchParams.get('success');
    if (s !== 'true') return;
    try { new BroadcastChannel('myos-connectors').postMessage({ type: 'refresh' }); } catch {}
  }, [searchParams]);

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

  // ── WhatsApp (Personal) QR pairing — separate modal ──
  const [waPair, setWaPair] = useState(null); // { connector, status, qrDataUrl, connectedNumber, error }
  const waPollRef = useRef(null);

  async function openWhatsAppPair(c) {
    setWaPair({ connector: c, status: 'connecting', qrDataUrl: null, connectedNumber: null });
    try {
      const r = await api.post('/connectors/whatsapp_personal/pair');
      setWaPair((prev) => prev ? { ...prev, ...r.data } : prev);
    } catch (err) {
      setWaPair((prev) => prev ? { ...prev, status: 'error', error: err.response?.data?.error || 'Failed to start pairing' } : prev);
    }
    // Poll status every 2s until connected / error
    if (waPollRef.current) clearInterval(waPollRef.current);
    waPollRef.current = setInterval(async () => {
      try {
        const r = await api.get('/connectors/whatsapp_personal/status');
        setWaPair((prev) => prev ? { ...prev, ...r.data } : prev);
        if (r.data.status === 'connected') {
          clearInterval(waPollRef.current); waPollRef.current = null;
          flash('WhatsApp paired successfully!', 'success');
          setTimeout(() => { setWaPair(null); load(); }, 1500);
        } else if (r.data.status === 'error') {
          clearInterval(waPollRef.current); waPollRef.current = null;
        }
      } catch {}
    }, 2000);
  }

  function closeWhatsAppPair() {
    if (waPollRef.current) { clearInterval(waPollRef.current); waPollRef.current = null; }
    setWaPair(null);
  }

  async function handleWhatsAppDisconnect(c) {
    try {
      await api.post('/connectors/whatsapp_personal/disconnect');
      flash('WhatsApp disconnected', 'info');
      load();
    } catch (err) { flash(err.response?.data?.error || 'Disconnect failed', 'error'); }
  }

  // ── WhatsApp excluded-contacts modal ──
  // Numbers listed here are DROPPED at ingest. Brain never sees them,
  // they never surface in Day Brief. E.164 format (+92300...).
  const [waExcludedOpen, setWaExcludedOpen] = useState(false);
  const [waExcludedList, setWaExcludedList] = useState([]);
  const [waExcludedInput, setWaExcludedInput] = useState('');
  const [waExcludedSaving, setWaExcludedSaving] = useState(false);

  async function openWhatsAppExcluded() {
    setWaExcludedOpen(true);
    setWaExcludedInput('');
    try {
      const r = await api.get('/connectors/whatsapp_personal/excluded');
      setWaExcludedList(r.data.numbers || []);
    } catch { setWaExcludedList([]); }
  }

  function waExcludedAdd() {
    const v = waExcludedInput.trim();
    if (!v) return;
    if (!/^\+?\d{7,15}$/.test(v.replace(/[\s\-()]/g, ''))) {
      flash('Enter a valid phone number (e.g. +923001234567)', 'error');
      return;
    }
    setWaExcludedList((prev) => Array.from(new Set([...prev, v])));
    setWaExcludedInput('');
  }

  function waExcludedRemove(n) {
    setWaExcludedList((prev) => prev.filter((x) => x !== n));
  }

  async function waExcludedSave() {
    setWaExcludedSaving(true);
    try {
      const r = await api.post('/connectors/whatsapp_personal/excluded', { numbers: waExcludedList });
      setWaExcludedList(r.data.numbers || []);
      flash('Excluded contacts saved', 'success');
      setWaExcludedOpen(false);
    } catch (err) {
      flash(err.response?.data?.error || 'Save failed', 'error');
    }
    setWaExcludedSaving(false);
  }

  // ── Open Configure modal (ALL connectors go through modal) ──
  function openConfigure(c) {
    // WhatsApp (Personal) is QR-pair, not credential entry — route to QR modal.
    if (c.slug === 'whatsapp_personal' || c.authMethod === 'qr_pair') {
      openWhatsAppPair(c);
      return;
    }
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
    if (c.slug === 'whatsapp_personal' || c.authMethod === 'qr_pair') {
      return handleWhatsAppDisconnect(c);
    }
    try { await api.post('/connectors/disconnect', { connectorTypeId: c.id }); flash(`${c.name} disconnected`); load(); } catch {}
  }

  // ── Scribe (single, global manual trigger) ──
  // Brain auto-updates the per-sender Wiki on every incoming feed event,
  // so re-scribe is only needed when the MD has added/removed a connector
  // or wants to rebuild from source history. ONE button for all.
  const [scribeState, setScribeState] = useState({ items: [], rescribeRecommended: false, unscribedNames: [], runningCount: 0 });

  useEffect(() => {
    async function refresh() {
      try { const r = await api.get('/connectors/scribe-state'); setScribeState(r.data); } catch {}
    }
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, []);

  // ── FACL folder configuration (Google Drive → specific folder ID) ──
  // The tenant's FACL folder holds curated org knowledge (SOPs, deal
  // memos, playbooks). Brain scribes its contents into wiki_pages so
  // triage can reference them. Config lives in metadata on the
  // google_drive_personal user_connector.
  const [faclStatus, setFaclStatus] = useState(null);
  const [faclOpen, setFaclOpen] = useState(false);
  const [faclInput, setFaclInput] = useState('');
  const [faclSaving, setFaclSaving] = useState(false);

  async function loadFaclStatus() {
    try { const r = await api.get('/connectors/facl/status'); setFaclStatus(r.data); } catch {}
  }
  useEffect(() => { loadFaclStatus(); const t = setInterval(loadFaclStatus, 20000); return () => clearInterval(t); }, []);

  async function handleFaclSave() {
    const folderId = faclInput.trim();
    if (!folderId) { flash('Paste the Google Drive folder ID', 'error'); return; }
    setFaclSaving(true);
    try {
      await api.post('/connectors/facl/set-folder', { folderId });
      flash('FACL folder saved — scribing in background.', 'success');
      setFaclOpen(false);
      setFaclInput('');
      loadFaclStatus();
    } catch (err) {
      flash(err.response?.data?.error || 'Failed to save folder', 'error');
    }
    setFaclSaving(false);
  }

  async function handleFaclRescribe() {
    try {
      await api.post('/connectors/facl/rescribe');
      flash('Re-scribing FACL folder in background.', 'success');
      loadFaclStatus();
    } catch (err) {
      flash(err.response?.data?.error || 'Re-scribe failed', 'error');
    }
  }

  function faclStatusLine() {
    if (!faclStatus?.connected) return null;
    if (faclStatus.status === 'running') return 'Scribing now…';
    if (!faclStatus.folderId) return 'No FACL folder set';
    if (!faclStatus.lastScribedAt) return `Folder set, not yet scribed`;
    const mins = Math.floor((Date.now() - new Date(faclStatus.lastScribedAt).getTime()) / 60000);
    const when = mins < 60 ? `${mins}m ago` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h ago` : `${Math.floor(mins / 1440)}d ago`;
    return `${faclStatus.docCount ?? 0} docs indexed · last scribe ${when}`;
  }

  async function handleScribeAll() {
    try {
      const r = await api.post('/connectors/scribe-all');
      const queued = r.data?.queued || [];
      if (queued.length === 0) {
        flash('No supported connectors to scribe. Connect Gmail or Google Calendar first.', 'info');
        return;
      }
      flash(`Scribing ${queued.length} connector${queued.length > 1 ? 's' : ''} in background — takes a minute or two.`, 'success');
    } catch (err) {
      flash(err.response?.data?.error || 'Scribe-all failed', 'error');
    }
    try { const r2 = await api.get('/connectors/scribe-state'); setScribeState(r2.data); } catch {}
  }

  function lastScribedGlobalLabel() {
    const supported = (scribeState.items || []).filter((i) => i.supportsScribe && i.lastScribedAt);
    if (supported.length === 0) return null;
    const latest = supported.reduce((best, i) => {
      const t = new Date(i.lastScribedAt).getTime();
      return t > best ? t : best;
    }, 0);
    if (!latest) return null;
    const mins = Math.floor((Date.now() - latest) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 48) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
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

        {/* Attachment backfill progress — shown while Brain is
            retro-processing your connected mailbox. Disappears once
            caught up. */}
        {backfill && backfill.state !== 'complete' && backfill.totalEvents > 0 && (
          <div style={{
            marginBottom: 14,
            padding: '12px 16px',
            background: 'rgba(204,107,74,0.08)',
            border: '1px solid rgba(204,107,74,0.35)',
            borderRadius: 10,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <div style={{ fontSize: 20 }}>📎</div>
            <div style={{ flex: 1, fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>
              <strong>Historical pull in progress — Brain is reading your history</strong>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                {backfill.processed} of {backfill.totalEvents} messages scanned ·
                {' '}~{humaniseEta(backfill.etaSeconds)} remaining ·
                {' '}runs in the background — you can leave this page, Brain will keep working.
              </div>
              <div style={{ marginTop: 6, height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, Math.round((backfill.processed / Math.max(1, backfill.totalEvents)) * 100))}%`,
                  background: '#cc6b4a',
                  transition: 'width 0.4s',
                }} />
              </div>
            </div>
          </div>
        )}

        {/* Global Brain-memory control. Always visible so MD can trigger
            a re-scribe any time a connector changes. Shows the current
            state (never scribed / in progress / last scribed Xh ago). */}
        {(() => {
          const isRunning = scribeState.runningCount > 0;
          const needs = scribeState.rescribeRecommended;
          const lastLabel = lastScribedGlobalLabel();
          const supportedConnected = (scribeState.items || []).filter((i) => i.status === 'connected' && i.supportsScribe);
          if (supportedConnected.length === 0) return null;
          return (
            <div style={{
              marginBottom: 14,
              padding: '12px 16px',
              background: needs ? 'rgba(204,107,74,0.08)' : 'rgba(74,222,128,0.05)',
              border: `1px solid ${needs ? 'rgba(204,107,74,0.35)' : 'rgba(74,222,128,0.25)'}`,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            }}>
              <div style={{ fontSize: 20 }}>🧠</div>
              <div style={{ flex: 1, fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>
                {isRunning ? (
                  <>
                    <strong>Scribing {scribeState.runningCount} connector{scribeState.runningCount > 1 ? 's' : ''}…</strong>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                      Pulling history and building Brain memory. Takes a minute or two — you can leave this page.
                    </div>
                  </>
                ) : needs ? (
                  <>
                    <strong>
                      ⚠ Pending scribe — {scribeState.unscribedNames?.length ?? 0} connector
                      {(scribeState.unscribedNames?.length ?? 0) === 1 ? '' : 's'} waiting
                    </strong>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>
                      Brain has no memory from these sources yet. Click <em>Scribe all</em> to pull history and build sender-memory pages.
                    </div>
                    {(scribeState.unscribedNames?.length ?? 0) > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {scribeState.unscribedNames.map((nm) => (
                          <span
                            key={nm}
                            style={{
                              fontSize: 11,
                              padding: '3px 9px',
                              borderRadius: 12,
                              background: 'rgba(204,107,74,0.18)',
                              border: '1px solid rgba(204,107,74,0.45)',
                              color: '#cc6b4a',
                              fontWeight: 600,
                            }}
                          >
                            ⏳ {nm}
                          </span>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <strong>Brain memory up to date.</strong>
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                      Auto-updates on every new message. {lastLabel && `Last full scribe: ${lastLabel}.`} Re-scribe if you change a connector.
                    </div>
                  </>
                )}
              </div>
              {!isRunning && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 8, fontSize: 'var(--fs-xs)' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Days:</span>
                    {[30, 90, 180, 365].map((d) => (
                      <button
                        key={d}
                        onClick={() => setHistoricalDays(d)}
                        style={{
                          background: historicalDays === d ? 'var(--accent)' : 'transparent',
                          color: historicalDays === d ? '#fff' : 'var(--text-muted)',
                          border: 'none', padding: '2px 8px', borderRadius: 6,
                          cursor: 'pointer', fontFamily: 'inherit', fontSize: 'var(--fs-xs)',
                        }}
                      >{d}</button>
                    ))}
                  </div>
                  <button
                    style={{ ...s.btn, ...s.btnOutline, whiteSpace: 'nowrap' }}
                    onClick={() => handleHistoricalPull()}
                    disabled={historicalPulling}
                    title="Pull email / calendar / attachments from the selected time window and rebuild Brain memory from it."
                  >
                    {historicalPulling ? '⏳ Pulling…' : `⏪ Historical Pull (${historicalDays}d)`}
                  </button>
                  <button
                    style={{ ...s.btn, ...s.btnPrimary, whiteSpace: 'nowrap' }}
                    onClick={handleScribeAll}
                  >
                    🧠 {needs ? 'Scribe all' : 'Re-scribe all'}
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {loading ? <div style={s.empty}>Loading connectors...</div> : connectors.length === 0 ? <div style={s.empty}>No connectors available. Ask your admin to enable connectors.</div> : (
          Object.entries(grouped).map(([cat, items]) => (
            <div key={cat} style={s.section}>
              <div style={s.sectionTitle}>{ICONS[cat] || '🔗'} {CAT_LABELS[cat] || cat}</div>
              {items.map(c => {
                const st = c.userConnector?.status;
                const cardSt = st === 'connected' ? s.cardConnected : st === 'error' ? s.cardError : st === 'configured' ? s.cardConfigured : {};
                const scribeItem = (scribeState.items || []).find((it) => it.slug === c.slug);
                const scribePending = st === 'connected' && scribeItem?.supportsScribe && !scribeItem.lastScribedAt && !scribeItem.isRunning;
                const scribeRunning = scribeItem?.isRunning;
                const scribeDone = st === 'connected' && scribeItem?.supportsScribe && scribeItem.lastScribedAt && !scribeItem.isRunning;
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
                            {scribePending && (
                              <span
                                title="Brain has no memory from this source yet — click Scribe all in the banner above."
                                style={{
                                  fontSize: 10,
                                  padding: '2px 7px',
                                  marginLeft: 6,
                                  borderRadius: 10,
                                  background: 'rgba(204,107,74,0.18)',
                                  border: '1px solid rgba(204,107,74,0.45)',
                                  color: '#cc6b4a',
                                  fontWeight: 700,
                                  letterSpacing: 0.3,
                                }}
                              >⏳ PENDING SCRIBE</span>
                            )}
                            {scribeRunning && (
                              <span
                                title="Brain is pulling history right now."
                                style={{
                                  fontSize: 10,
                                  padding: '2px 7px',
                                  marginLeft: 6,
                                  borderRadius: 10,
                                  background: 'rgba(96,165,250,0.18)',
                                  border: '1px solid rgba(96,165,250,0.45)',
                                  color: '#60a5fa',
                                  fontWeight: 700,
                                  letterSpacing: 0.3,
                                }}
                              >⏳ SCRIBING…</span>
                            )}
                            {scribeDone && (
                              <span
                                title={`Last scribed: ${new Date(scribeItem.lastScribedAt).toLocaleString()}`}
                                style={{
                                  fontSize: 10,
                                  padding: '2px 7px',
                                  marginLeft: 6,
                                  borderRadius: 10,
                                  background: 'rgba(74,222,128,0.12)',
                                  border: '1px solid rgba(74,222,128,0.35)',
                                  color: '#4ade80',
                                  fontWeight: 700,
                                  letterSpacing: 0.3,
                                }}
                              >✓ SCRIBED</span>
                            )}
                          </div>
                          <div style={s.desc}>{c.description}</div>
                          {st === 'connected' && <div style={{ fontSize: 11, color: '#4ade80', marginTop: 4 }}>Connected {c.userConnector?.lastSyncAt ? `• Last sync: ${new Date(c.userConnector.lastSyncAt).toLocaleString()}` : ''}</div>}
                          {st === 'error' && c.userConnector?.errorMessage && <div style={{ fontSize: 11, color: '#ef4444', marginTop: 4 }}>Error: {c.userConnector.errorMessage}</div>}
                        {testResult[c.id] && (
                          <div style={{ fontSize: 11, marginTop: 4, color: testResult[c.id].success ? '#4ade80' : '#ef4444' }}>
                            {testResult[c.id].success ? `✓ ${testResult[c.id].detail}` : `✗ ${testResult[c.id].error}`}
                          </div>
                        )}
                        {/* FACL is a TENANT-level knowledge base — configured in
                            Admin / Client Config → Google Drive. Per-user Drive
                            connector no longer owns this setup. */}
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
                            {c.slug === 'whatsapp_personal' && (
                              <button
                                style={{ ...s.btn, ...s.btnOutline, fontSize: 11 }}
                                onClick={openWhatsAppExcluded}
                                title="Manage excluded contacts (wife, family) — their messages are never read by Brain"
                              >
                                Excluded contacts
                              </button>
                            )}
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
                {/* Managed: tenant/admin has already configured an OAuth app — user just clicks Connect. */}
                {modal.tenantOauthAvailable ? (
                  <div style={{ background: '#252525', borderRadius: 8, padding: 16, marginBottom: 12 }}>
                    <div style={{ fontSize: 13, color: '#4ade80', marginBottom: 4 }}>
                      OAuth is managed by your organization.
                    </div>
                    <div style={{ fontSize: 12, color: '#888' }}>
                      Click Connect to authorize your {modal.name} account — no credentials to enter.
                    </div>
                  </div>
                ) : form._prefilled ? (
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
                      // Require pasted creds only when the tenant has no OAuth app and there's no connected sibling.
                      if (!modal.tenantOauthAvailable && !form._prefilled && !form.clientId && !form.clientSecret) {
                        setTestError('Client ID and Client Secret are required');
                        return;
                      }
                      setOauthLoading(true); setTestError('');
                      try {
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

      {/* ── WhatsApp (Personal) Excluded Contacts Modal ── */}
      {waExcludedOpen && (
        <div style={s.modal} onClick={() => setWaExcludedOpen(false)}>
          <div style={s.modalBody} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#eee' }}>Excluded WhatsApp contacts</div>
              <button style={{ ...s.btn, ...s.btnOutline, padding: '4px 10px' }} onClick={() => setWaExcludedOpen(false)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 14, lineHeight: 1.5 }}>
              Messages from these numbers are <strong style={{ color: '#eee' }}>dropped at the door</strong> — they never
              enter Day Brief, Brain never reads them, and no reply is ever drafted. Use this for family, close friends,
              or any private chat you want kept out of the system.
            </div>

            <label style={s.label}>Add a number</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{ ...s.input, flex: 1 }}
                placeholder="+923001234567"
                value={waExcludedInput}
                onChange={(e) => setWaExcludedInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); waExcludedAdd(); } }}
              />
              <button style={{ ...s.btn, ...s.btnPrimary, flexShrink: 0 }} onClick={waExcludedAdd}>Add</button>
            </div>

            <div style={{ marginTop: 16 }}>
              {waExcludedList.length === 0 ? (
                <div style={{ fontSize: 12, color: '#666', padding: '12px 0', textAlign: 'center' }}>No excluded contacts yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {waExcludedList.map((n) => (
                    <div key={n} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: '#252525', borderRadius: 8 }}>
                      <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#ccc' }}>{n}</span>
                      <button style={{ ...s.btn, ...s.btnDanger, fontSize: 11, padding: '4px 10px' }} onClick={() => waExcludedRemove(n)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20, justifyContent: 'flex-end' }}>
              <button style={{ ...s.btn, ...s.btnOutline }} onClick={() => setWaExcludedOpen(false)}>Cancel</button>
              <button
                style={{ ...s.btn, ...s.btnPrimary, opacity: waExcludedSaving ? 0.6 : 1 }}
                disabled={waExcludedSaving}
                onClick={waExcludedSave}
              >
                {waExcludedSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── WhatsApp (Personal) QR Pair Modal ── */}
      {waPair && (
        <div style={s.modal} onClick={closeWhatsAppPair}>
          <div style={s.modalBody} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#eee' }}>Pair WhatsApp</div>
              <button style={{ ...s.btn, ...s.btnOutline, padding: '4px 10px' }} onClick={closeWhatsAppPair}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 14 }}>
              On your phone: WhatsApp → Settings → Linked Devices → Link a Device, then scan the QR below.
            </div>

            {waPair.status === 'connected' ? (
              <div style={{ textAlign: 'center', padding: 32 }}>
                <div style={{ fontSize: 46, marginBottom: 10 }}>✓</div>
                <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 600 }}>Paired</div>
                {waPair.connectedNumber && <div style={{ fontSize: 13, color: '#aaa', marginTop: 6 }}>{waPair.connectedNumber}</div>}
              </div>
            ) : waPair.status === 'error' ? (
              <div>
                <div style={s.error}>{waPair.error || 'Pairing failed'}</div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                  <button style={{ ...s.btn, ...s.btnOutline }} onClick={closeWhatsAppPair}>Close</button>
                  <button style={{ ...s.btn, ...s.btnPrimary }} onClick={() => openWhatsAppPair(waPair.connector)}>Retry</button>
                </div>
              </div>
            ) : (
              <div style={{ textAlign: 'center' }}>
                {waPair.qrDataUrl ? (
                  <img
                    src={waPair.qrDataUrl}
                    alt="WhatsApp QR code"
                    style={{ width: 260, height: 260, background: '#fff', padding: 12, borderRadius: 8 }}
                  />
                ) : (
                  <div style={{ padding: 80, color: '#888', fontSize: 13 }}>
                    Waiting for QR code…
                  </div>
                )}
                <div style={{ fontSize: 11, color: '#666', marginTop: 10 }}>
                  Status: {waPair.status}
                  {waPair.status === 'qr' && ' · QR refreshes automatically'}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Human-friendly ETA for the attachment backfill banner. Caps at 60 min. */
function humaniseEta(sec) {
  if (!sec || sec < 10) return 'a moment';
  if (sec < 60) return `${sec} sec`;
  const m = Math.ceil(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}
