import React, { useState, useEffect } from 'react';
import api from '../../services/api';
import ConfigEditor from '../../components/ConfigEditor';
import { CLIENT_SECTIONS } from './adminConstants';

// ═══════════════════════════════════════════════════════════════
// TAB 1: Client Management (Tenants + Users + Client Config)
// ═══════════════════════════════════════════════════════════════

function ClientManagementTab({ user, msg, setMsg }) {
  const [tenants, setTenants] = useState([]);
  const [users, setUsers] = useState([]);
  const [prices, setPrices] = useState([]);
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [subTab, setSubTab] = useState(user?.isSuperAdmin ? 'tenants' : 'users');

  // ─── New Client form (info + license + config all-in-one) ────
  const [nc, setNc] = useState({
    name: '', domain: '',
    adminSeats: 1, standardSeats: 10, basicSeats: 50, discount: 0, term: 'M',
    startDate: new Date().toISOString().slice(0, 10),
    endDate: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10),
  });

  const [availableTiers, setAvailableTiers] = useState([]);

  // ─── New User form ───────────────────────────────────────────
  const [newUser, setNewUser] = useState({ empcode: '', name: '', email: '', password: '', userType: 'ST', department: '', clientNumber: '' });

  // ─── Edit User + Integration ────────────────────────────────
  const [editUser, setEditUser] = useState(null);

  useEffect(() => { loadAll(); }, []);

  const loadAll = async () => {
    try {
      if (user?.isSuperAdmin) {
        const [tRes, pRes] = await Promise.all([api.get('/tenants'), api.get('/licenses/prices')]);
        setTenants(tRes.data.tenants || []);
        setPrices(pRes.data.prices || []);
      }
      const [uRes, tRes2] = await Promise.all([api.get('/admin/users'), api.get('/tiers')]);
      setUsers(uRes.data.users || []);
      setAvailableTiers(tRes2.data.tiers || []);
    } catch {}
  };

  const priceMap = {};
  prices.forEach(p => { priceMap[p.roleType] = Number(p.pricePerSeat); });

  // ─── Create Client (info + license in one step) ──────────────
  const createTenant = async () => {
    if (!nc.name) { setMsg('Company name is required'); return; }
    try {
      // Step 1: Create tenant
      const res = await api.post('/tenants', { name: nc.name, domain: nc.domain });
      const cn = res.data.tenant.clientNumber;

      // Step 2: Assign license
      await api.put(`/tenants/${cn}/license`, {
        adminSeats: nc.adminSeats, standardSeats: nc.standardSeats, basicSeats: nc.basicSeats,
        discount: nc.discount, term: nc.term, startDate: nc.startDate, endDate: nc.endDate,
      });

      setMsg(`Client ${cn} created with license`);
      setNc({ name: '', domain: '', adminSeats: 1, standardSeats: 10, basicSeats: 50, discount: 0, term: 'M',
        startDate: new Date().toISOString().slice(0, 10), endDate: new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10) });
      setShowCreateTenant(false);
      loadAll();
    } catch (err) { setMsg(err.response?.data?.error || 'Failed to create client'); }
  };

  // ─── Create User ─────────────────────────────────────────────
  const createUser = async () => {
    if (!newUser.empcode || !newUser.name || !newUser.email || !newUser.password) { setMsg('All fields required'); return; }
    const targetClient = user?.isSuperAdmin ? newUser.clientNumber : user?.clientNumber;
    if (!targetClient) { setMsg('Please select a client'); return; }
    try {
      const res = await api.post('/user/users', { ...newUser, clientNumber: targetClient });
      const shouldInvite = document.getElementById('sendInvite')?.checked;
      if (shouldInvite && res.data.user?.id) {
        await api.post(`/user/users/${res.data.user.id}/invite`, { baseUrl: window.location.origin }).catch(() => {});
        setMsg('User created and invitation sent');
      } else {
        setMsg('User created');
      }
      setNewUser({ empcode: '', name: '', email: '', password: '', userType: 'ST', department: '', clientNumber: '' });
      setShowCreateUser(false);
      loadAll();
    } catch (err) { setMsg(err.response?.data?.error || 'Failed'); }
  };

  const resetPassword = async (empcode) => {
    try {
      const res = await api.post(`/user/users/${empcode}/reset-password`);
      setMsg(`Password reset for ${empcode}: ${res.data.tempPassword}`);
    } catch (err) { setMsg(err.response?.data?.error || 'Failed'); }
  };

  const sendInvite = async (userId) => {
    try {
      await api.post(`/user/users/${userId}/invite`, { baseUrl: window.location.origin });
      setMsg('Invitation email sent');
      return true;
    } catch (err) {
      setMsg(err.response?.data?.error || 'Failed to send invitation');
      return false;
    }
  };

  const toggleTenantActive = async (cn, active) => {
    await api.patch(`/tenants/${cn}`, { isActive: !active }).catch(() => {});
    loadAll();
  };

  const calcGross = () => (nc.adminSeats * (priceMap['AD'] || 0)) + (nc.standardSeats * (priceMap['ST'] || 0)) + (nc.basicSeats * (priceMap['BS'] || 0));

  return (
    <>
      {/* Sub-tabs */}
      <div className="config-tabs sub-tabs">
        {user?.isSuperAdmin && <button className={`config-tab ${subTab === 'tenants' ? 'active' : ''}`} onClick={() => setSubTab('tenants')}>Clients</button>}
        <button className={`config-tab ${subTab === 'users' ? 'active' : ''}`} onClick={() => setSubTab('users')}>Users</button>
        <button className={`config-tab ${subTab === 'clientconfig' ? 'active' : ''}`} onClick={() => setSubTab('clientconfig')}>Client Config</button>
        <button className={`config-tab ${subTab === 'connectors' ? 'active' : ''}`} onClick={() => setSubTab('connectors')}>Client Connectors</button>
      </div>

      {/* ═══ Clients (SuperAdmin) ═══ */}
      {subTab === 'tenants' && user?.isSuperAdmin && (
        <section className="settings-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>Clients ({tenants.length})</h2>
            <button className="settings-btn" onClick={() => setShowCreateTenant(!showCreateTenant)}>
              {showCreateTenant ? 'Cancel' : '+ New Client'}
            </button>
          </div>

          {/* Create Client — Full Form (Info + License) */}
          {showCreateTenant && (
            <div className="admin-create-form">
              <h3 style={{ fontSize: 14, color: '#e8e8e0', marginBottom: 12 }}>Client Information</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="settings-field"><label>Company Name *</label><input value={nc.name} onChange={e => setNc(c => ({ ...c, name: e.target.value }))} placeholder="Pakistan State Oil" /></div>
                <div className="settings-field"><label>Domain</label><input value={nc.domain} onChange={e => setNc(c => ({ ...c, domain: e.target.value }))} placeholder="pso.com.pk" /></div>
              </div>
              <p style={{ fontSize: 11, color: '#888', margin: '4px 0 16px' }}>Client number auto-generated from name</p>

              <h3 style={{ fontSize: 14, color: '#e8e8e0', marginBottom: 12, paddingTop: 12, borderTop: '1px solid #333' }}>License Allocation</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                <div className="settings-field"><label>AD Seats (${priceMap['AD'] || '?'}/seat)</label><input type="number" min="0" value={nc.adminSeats} onChange={e => setNc(c => ({ ...c, adminSeats: parseInt(e.target.value) || 0 }))} /></div>
                <div className="settings-field"><label>ST Seats (${priceMap['ST'] || '?'}/seat)</label><input type="number" min="0" value={nc.standardSeats} onChange={e => setNc(c => ({ ...c, standardSeats: parseInt(e.target.value) || 0 }))} /></div>
                <div className="settings-field"><label>BS Seats (${priceMap['BS'] || '?'}/seat)</label><input type="number" min="0" value={nc.basicSeats} onChange={e => setNc(c => ({ ...c, basicSeats: parseInt(e.target.value) || 0 }))} /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
                <div className="settings-field"><label>Discount %</label><input type="number" min="0" max="100" value={nc.discount} onChange={e => setNc(c => ({ ...c, discount: parseFloat(e.target.value) || 0 }))} /></div>
                <div className="settings-field"><label>Term</label>
                  <select value={nc.term} onChange={e => setNc(c => ({ ...c, term: e.target.value }))}>
                    <option value="M">Monthly</option><option value="Q">Quarterly</option><option value="Y">Yearly</option>
                  </select>
                </div>
                <div className="settings-field"><label>Start</label><input type="date" value={nc.startDate} onChange={e => setNc(c => ({ ...c, startDate: e.target.value }))} /></div>
                <div className="settings-field"><label>End</label><input type="date" value={nc.endDate} onChange={e => setNc(c => ({ ...c, endDate: e.target.value }))} /></div>
              </div>

              {/* Price summary */}
              {(() => {
                const gross = calcGross();
                const disc = gross * (nc.discount / 100);
                return (
                  <div style={{ background: '#1a1a1a', borderRadius: 8, padding: 12, margin: '10px 0', fontSize: 13, display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#888' }}>Gross: ${gross.toLocaleString()}{nc.discount > 0 ? ` − ${nc.discount}%` : ''}</span>
                    <span style={{ color: 'var(--accent)', fontWeight: 700 }}>Net: ${(gross - disc).toLocaleString()}/period</span>
                  </div>
                );
              })()}

              <button className="settings-btn" onClick={createTenant} style={{ width: '100%' }}>Create Client with License</button>
            </div>
          )}

          {/* Client table */}
          <table className="admin-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Client #</th><th>Name</th><th>Domain</th><th>Users</th><th>License</th><th>Expiry</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {tenants.map(t => (
                <TenantRow key={t.clientNumber} tenant={t} onToggle={toggleTenantActive} onSaved={loadAll} setMsg={setMsg} />
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ═══ Users ═══ */}
      {subTab === 'users' && (
        <section className="settings-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>Users ({users.length})</h2>
            <button className="settings-btn" onClick={() => setShowCreateUser(!showCreateUser)}>
              {showCreateUser ? 'Cancel' : '+ New User'}
            </button>
          </div>
          {showCreateUser && (
            <div className="admin-create-form">
              {/* Client selector: SA can pick, AD sees own client locked */}
              <div className="settings-field">
                <label>Client</label>
                {user?.isSuperAdmin ? (
                  <select value={newUser.clientNumber} onChange={e => setNewUser(u => ({ ...u, clientNumber: e.target.value }))}>
                    <option value="">Select client...</option>
                    {tenants.map(t => <option key={t.clientNumber} value={t.clientNumber}>{t.clientNumber} — {t.name}</option>)}
                  </select>
                ) : (
                  <input value={user?.clientNumber} disabled style={{ opacity: 0.6, cursor: 'not-allowed' }} />
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="settings-field"><label>Employee Code *</label><input value={newUser.empcode} onChange={e => setNewUser(u => ({ ...u, empcode: e.target.value }))} placeholder="EMP-001" /></div>
                <div className="settings-field"><label>Full Name *</label><input value={newUser.name} onChange={e => setNewUser(u => ({ ...u, name: e.target.value }))} placeholder="Ahmed Khan" /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="settings-field"><label>Email *</label><input value={newUser.email} onChange={e => setNewUser(u => ({ ...u, email: e.target.value }))} placeholder="ahmed@company.com" /></div>
                <div className="settings-field"><label>Password *</label><input type="password" value={newUser.password} onChange={e => setNewUser(u => ({ ...u, password: e.target.value }))} placeholder="Min 6 chars" /></div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div className="settings-field"><label>User Type</label>
                  <select value={newUser.userType} onChange={e => setNewUser(u => ({ ...u, userType: e.target.value }))}>
                    {user?.isSuperAdmin && <option value="SA">SA — SuperAdmin</option>}
                    {user?.isSuperAdmin && <option value="AD">AD — Admin</option>}
                    {availableTiers.filter(t => t.is_active).map(t => (
                      <option key={t.tier_code} value={t.tier_code}>{t.tier_code} — {t.tier_name} (${Number(t.price_per_seat).toFixed(0)}/seat)</option>
                    ))}
                  </select>
                </div>
                <div className="settings-field"><label>Department</label><input value={newUser.department} onChange={e => setNewUser(u => ({ ...u, department: e.target.value }))} placeholder="Optional" /></div>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#bbb', marginTop: 8 }}>
                <input type="checkbox" id="sendInvite" defaultChecked style={{ accentColor: 'var(--accent)' }} />
                Send invitation email (user sets their own password)
              </label>
              <button className="settings-btn" onClick={async () => { await createUser(); }} style={{ width: '100%', marginTop: 8 }}>Create User</button>
            </div>
          )}
          <table className="admin-table" style={{ marginTop: 12 }}>
            <thead><tr><th>Empcode</th><th>Name</th><th>Email</th><th>Type</th><th>Dept</th><th>Actions</th></tr></thead>
            <tbody>
              {users.map(u => (
                <React.Fragment key={u.id}>
                  <tr>
                    <td>{u.empcode}</td>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td><span className={`badge-type type-${u.userType}`}>{u.userType}</span></td>
                    <td>{u.department || '—'}</td>
                    <td style={{ display: 'flex', gap: 4 }}>
                      <button className="admin-action" onClick={() => setEditUser(editUser?.id === u.id ? null : u)}>
                        {editUser?.id === u.id ? 'Close' : 'Edit'}
                      </button>
                      <InviteButton userId={u.id} onInvite={sendInvite} />
                      <button className="admin-action" onClick={() => resetPassword(u.empcode)}>Reset</button>
                    </td>
                  </tr>
                  {editUser?.id === u.id && (
                    <tr><td colSpan={6} style={{ padding: 0 }}>
                      <EditUserPanel user={u} availableTiers={availableTiers} isSuperAdmin={user?.isSuperAdmin} onUpdate={() => { loadAll(); setMsg('User updated'); }} onMsg={setMsg} />
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ═══ Client Config (SMTP, GDrive raw keys) ═══ */}
      {subTab === 'clientconfig' && (
        <ClientConfigSection user={user} tenants={tenants} />
      )}

      {/* ═══ Client Connectors — tenant-level knowledge sources ═══ */}
      {subTab === 'connectors' && (
        <ClientConnectorsSection user={user} tenants={tenants} />
      )}
    </>
  );
}

function InviteButton({ userId, onInvite }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handle = async () => {
    setSending(true);
    const ok = await onInvite(userId);
    setSending(false);
    if (ok) { setSent(true); setTimeout(() => setSent(false), 3000); }
  };

  return (
    <button
      className="admin-action"
      onClick={handle}
      disabled={sending}
      title="Send invitation email"
      style={sent ? { borderColor: '#4ade80', color: '#4ade80' } : sending ? { opacity: 0.5 } : {}}
    >
      {sending ? 'Sending...' : sent ? 'Sent ✓' : 'Invite'}
    </button>
  );
}

function ClientConfigSection({ user, tenants }) {
  const [selectedClient, setSelectedClient] = useState(user?.clientNumber || '');
  const targetClient = user?.isSuperAdmin ? selectedClient : undefined;
  const effectiveClient = targetClient || user?.clientNumber;

  return (
    <>
      {/* Client selector */}
      <section className="settings-section" style={{ paddingBottom: 12 }}>
        <div className="settings-field">
          <label>Client</label>
          {user?.isSuperAdmin ? (
            <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)}>
              {tenants.map(t => <option key={t.clientNumber} value={t.clientNumber}>{t.clientNumber} — {t.name}</option>)}
            </select>
          ) : (
            <input value={user?.clientNumber} disabled style={{ opacity: 0.6 }} />
          )}
        </div>
      </section>

      <ConfigEditor key={selectedClient} sections={CLIENT_SECTIONS} apiPath="/config" clientNumber={targetClient} />

      <div style={{ marginTop: 12, padding: '10px 14px', background: 'rgba(136,136,136,0.08)', border: '1px dashed rgba(136,136,136,0.3)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)' }}>
        Looking for FACL folder setup + scribe? That moved to the <strong>Client Connectors</strong> tab.
      </div>
    </>
  );
}

/** Client Connectors tab — tenant-level knowledge sources managed
 *  separately from each user's personal connectors. Cards pattern mirrors
 *  the My Connectors page so the mental model is the same. */
function ClientConnectorsSection({ user, tenants }) {
  const [selectedClient, setSelectedClient] = useState(user?.clientNumber || '');
  const effective = user?.isSuperAdmin ? selectedClient : user?.clientNumber;
  const [state, setState] = useState(null);
  const [busySlug, setBusySlug] = useState(null);
  const [msg, setMsg] = useState(null);
  // Modal state: 'connect' picks which admin; 'folder' edits folder ID.
  const [modal, setModal] = useState(null); // { kind: 'connect'|'folder', slug, item }

  const load = async () => {
    if (!effective) return;
    try {
      const { data } = await api.get(`/admin/client-connectors?cn=${effective}`);
      setState(data);
    } catch (e) { setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message }); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [effective]);

  const openFolder = (item) => setModal({ kind: 'folder', slug: item.slug, item });

  // One-click Connect. No modal. Server returns 409 + oauthRedirectTo if
  // the current admin hasn't OAuthed Google personally yet; we send them
  // to the regular Connectors OAuth, they come back and click once more.
  const doConnect = async (slug) => {
    setBusySlug(slug); setMsg(null);
    try {
      const { data } = await api.post(`/admin/client-connectors/${slug}/connect`, { clientNumber: effective });
      setMsg({ kind: 'ok', text: `✓ Connected as ${data.connectedAs}. Next: set the folder.` });
      load();
    } catch (e) {
      const resp = e?.response?.data;
      if (resp?.needsOauth && resp?.oauthRedirectTo) {
        setMsg({ kind: 'ok', text: 'Opening Google authorisation — come back and click Connect once more when you return.' });
        setTimeout(() => { window.location.href = resp.oauthRedirectTo; }, 600);
      } else {
        setMsg({ kind: 'error', text: resp?.error ?? e.message });
      }
    }
    setBusySlug(null);
  };

  const submitFolder = async (folderId, indexFileName) => {
    if (!modal) return;
    setBusySlug(modal.slug); setMsg(null);
    try {
      await api.post(`/admin/client-connectors/${modal.slug}/set-folder`, { clientNumber: effective, folderId, indexFileName });
      setMsg({ kind: 'ok', text: 'Folder saved. You can Test it now or Scribe all.' });
      setModal(null);
      load();
    } catch (e) { setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message }); }
    setBusySlug(null);
  };

  const runTest = async (slug) => {
    setBusySlug(slug); setMsg(null);
    try {
      const { data } = await api.post(`/admin/client-connectors/${slug}/test`, { clientNumber: effective });
      const txt = data.stage === 'folder_verified'
        ? `✓ Folder "${data.folder.name}" verified · ${data.sample.length} files visible · auth as ${data.adminEmail}`
        : `✓ Connection verified · auth as ${data.adminEmail}${data.driveUser ? ` (Drive user ${data.driveUser})` : ''}`;
      setMsg({ kind: 'ok', text: txt });
    } catch (e) { setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message }); }
    setBusySlug(null);
  };

  const runDisconnect = async (slug) => {
    setBusySlug(slug);
    try { await api.post(`/admin/client-connectors/${slug}/disconnect`, { clientNumber: effective }); setMsg({ kind: 'ok', text: 'Disconnected.' }); load(); }
    catch (e) { setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message }); }
    setBusySlug(null);
  };

  const scribeAll = async () => {
    setBusySlug('__all__'); setMsg(null);
    try {
      const { data } = await api.post('/admin/client-connectors/scribe-all', { clientNumber: effective });
      setMsg({ kind: 'ok', text: data.queued?.length ? `Scribing ${data.queued.length} connector${data.queued.length > 1 ? 's' : ''} in background.` : 'No ready-to-scribe connectors. Connect + set folder first.' });
      setTimeout(load, 1500);
    } catch (e) { setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message }); }
    setBusySlug(null);
  };

  if (!state) return <div style={{ padding: 20, color: 'var(--text-muted)' }}>Loading connectors…</div>;

  const configured = state.configuredCount;
  const total = state.items.length;
  const anyRunning = state.anyRunning;
  const needs = state.needsRescribe;

  return (
    <>
      {/* Client selector (for SuperAdmin) */}
      {user?.isSuperAdmin && (
        <section className="settings-section" style={{ paddingBottom: 12 }}>
          <div className="settings-field">
            <label>Client</label>
            <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)}>
              {tenants.map(t => <option key={t.clientNumber} value={t.clientNumber}>{t.clientNumber} — {t.name}</option>)}
            </select>
          </div>
        </section>
      )}

      {/* Header + Scribe-all banner */}
      <section className="settings-section" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 22 }}>🧠</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
            Tenant knowledge connectors · {configured}/{total} configured
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {anyRunning
              ? 'Scribing in progress — rebuilding Brain memory from connected sources.'
              : needs
                ? 'One or more connectors changed since the last scribe. Re-scribe to keep Brain in sync.'
                : configured === 0
                  ? 'Connect a source first, then hit Scribe all to index the tenant knowledge base.'
                  : 'All set. Auto-updates on new files; re-scribe if a connector changes.'}
          </div>
        </div>
        <button
          className="admin-action"
          style={{ background: needs || configured > 0 ? '#cc6b4a' : 'transparent', color: needs || configured > 0 ? '#fff' : 'var(--text-muted)', borderColor: '#cc6b4a', fontWeight: 600 }}
          disabled={busySlug === '__all__' || anyRunning || configured === 0}
          onClick={scribeAll}
        >
          {anyRunning ? 'Scribing…' : needs ? '🧠 Re-scribe all' : '🧠 Scribe all'}
        </button>
      </section>

      {msg && (
        <div className={`settings-msg ${msg.kind === 'error' ? 'error' : ''}`} style={{ marginTop: 8 }}>{msg.text}</div>
      )}

      {/* Connector cards */}
      <section className="settings-section" style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {state.items.map((item) => (
          <ClientConnectorCard
            key={item.slug}
            item={item}
            busy={busySlug === item.slug}
            onConnect={() => doConnect(item.slug)}
            onFolder={() => openFolder(item)}
            onTest={() => runTest(item.slug)}
            onDisconnect={() => runDisconnect(item.slug)}
          />
        ))}
      </section>

      {/* Step 2: set folder ID (only enabled after Connect) */}
      {modal?.kind === 'folder' && (
        <FolderModal
          item={modal.item}
          onCancel={() => setModal(null)}
          onSave={submitFolder}
          busy={busySlug === modal.slug}
        />
      )}
    </>
  );
}

function ClientConnectorCard({ item, busy, onConnect, onFolder, onTest, onDisconnect }) {
  const running = item.scribeStatus === 'running';
  const ok = !!item.lastScribedAt && !running;
  const liveBlocked = !item.liveInPoc;

  const pill = running ? { text: 'Scribing…', color: '#f59e0b' }
    : liveBlocked ? { text: 'Coming soon', color: '#9ba0aa' }
    : ok ? { text: `✓ ${item.docCount} docs`, color: '#4ade80' }
    : item.scribeable ? { text: 'Ready to scribe', color: '#f59e0b' }
    : item.connected ? { text: 'Connected · folder needed', color: '#f59e0b' }
    : { text: 'Not connected', color: '#9ba0aa' };

  return (
    <div style={{
      background: 'var(--bg-2)', border: '1px solid var(--border)',
      borderRadius: 10, padding: 14, opacity: liveBlocked ? 0.6 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 26 }}>{item.icon}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{item.name}</div>
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 10, background: pill.color + '22', color: pill.color, fontWeight: 600 }}>{pill.text}</span>
          </div>
          {item.connected && item.connectionDetail?.userEmail && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
              Connected as <strong>{item.connectionDetail.userEmail}</strong>
            </div>
          )}
          {item.folderId && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, fontFamily: 'monospace' }}>
              Folder: {String(item.folderId).slice(0, 28)}{String(item.folderId).length > 28 ? '…' : ''}
              {item.indexFile && ` · Index: ${item.indexFile}`}
            </div>
          )}
          {item.lastScribedAt && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
              Last scribed {humanAgo(Date.now() - new Date(item.lastScribedAt).getTime())}
            </div>
          )}
          {liveBlocked && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
              Same connect → folder → scribe pattern as Google Drive. Wiring pending.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {!item.connected && !liveBlocked && (
            <button className="admin-action" disabled={busy} onClick={onConnect} style={{ background: '#cc6b4a', color: '#fff', borderColor: '#cc6b4a' }}>
              Connect
            </button>
          )}
          {item.connected && (
            <>
              <button className="admin-action" disabled={busy} onClick={onTest}>Test</button>
              <button
                className="admin-action"
                disabled={busy}
                onClick={onFolder}
                style={item.scribeable ? {} : { background: '#cc6b4a', color: '#fff', borderColor: '#cc6b4a' }}
              >
                {item.folderId ? 'Change folder' : 'Set folder'}
              </button>
              <button className="admin-action" disabled={busy} onClick={onConnect}>Re-connect</button>
              <button className="admin-action" disabled={busy} onClick={onDisconnect} style={{ color: '#ef4444', borderColor: '#ef4444' }}>Disconnect</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function FolderModal({ item, onCancel, onSave, busy }) {
  const [folderId, setFolderId] = useState(item.folderId ?? '');
  const [indexFile, setIndexFile] = useState(item.indexFile ?? '');
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 20 }} onClick={onCancel}>
      <div style={{ background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, width: '100%', maxWidth: 520 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)' }}>{item.folderId ? 'Change' : 'Set'} folder · {item.name}</div>
          <button className="admin-action" onClick={onCancel}>✕</button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
          This is the folder Brain reads as the tenant's shared knowledge base.
        </div>
        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>
            Folder ID <span style={{ color: '#ef4444' }}>*</span>
          </label>
          <input
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            placeholder="1abc…xyz"
            autoFocus
            style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
            From the Drive URL: drive.google.com/drive/folders/<strong>&lt;folderId&gt;</strong>
          </div>
        </div>
        <div className="settings-field" style={{ marginBottom: 12 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Index file name (optional)</label>
          <input
            value={indexFile}
            onChange={(e) => setIndexFile(e.target.value)}
            placeholder="e.g. TMC_Drive_Index.md"
            style={{ width: '100%', padding: '8px 10px', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="admin-action" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="admin-action" disabled={busy || !folderId.trim()} onClick={() => onSave(folderId.trim(), indexFile.trim())} style={{ background: '#cc6b4a', color: '#fff', borderColor: '#cc6b4a' }}>
            {busy ? 'Saving…' : 'Save folder'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Legacy inline Drive connector — kept for reference but no longer rendered.
 *  Client Connectors tab supersedes this. */
function ClientDriveConnector({ clientNumber }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get(`/admin/client-drive/status${clientNumber ? `?cn=${clientNumber}` : ''}`);
      setState(data);
    } catch (e) { setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message }); }
  };
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [clientNumber]);

  const runTest = async () => {
    setBusy(true); setMsg(null);
    try {
      const { data } = await api.post('/admin/client-drive/test', { clientNumber });
      setMsg({ kind: 'ok', text: `✓ Folder verified: ${data.folder.name} · ${data.sample.length} files visible · auth as ${data.adminEmail}` });
    } catch (e) {
      setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message });
    }
    setBusy(false);
  };
  const runScribe = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.post('/admin/client-drive/scribe', { clientNumber });
      setMsg({ kind: 'ok', text: 'Scribing in background — takes a minute or two. Status updates automatically.' });
      setTimeout(load, 1500);
    } catch (e) { setMsg({ kind: 'error', text: e?.response?.data?.error ?? e.message }); }
    setBusy(false);
  };

  if (!state) return null;
  const hasFolder = !!state.folderId;
  const running = state.scribeStatus === 'running';
  const ok = state.scribeStatus === 'ok';
  const err = state.scribeStatus === 'error';

  const statusPill = running
    ? { text: 'Scribing…', color: '#f59e0b' }
    : ok ? { text: `✓ ${state.docCount} docs`, color: '#4ade80' }
    : err ? { text: 'Error', color: '#ef4444' }
    : hasFolder ? { text: 'Configured', color: '#9ba0aa' }
    : { text: 'Folder not set', color: '#9ba0aa' };

  const lastScribed = state.lastScribedAt ? new Date(state.lastScribedAt) : null;
  const lastWhen = lastScribed ? humanAgo(Date.now() - lastScribed.getTime()) : 'never';

  return (
    <section className="settings-section" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <div style={{ fontSize: 24 }}>📁</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
            Google Drive · Tenant knowledge (FACL)
            <span style={{ marginLeft: 10, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: statusPill.color + '22', color: statusPill.color, fontWeight: 600 }}>
              {statusPill.text}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            Every user in this tenant's Brain reads the docs in this folder as shared org knowledge.
            {hasFolder && lastScribed && <> · Last scribed {lastWhen}.</>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="admin-action" onClick={runTest} disabled={busy || !hasFolder}>Test</button>
          <button className="admin-action" onClick={runScribe} disabled={busy || !hasFolder || running} style={{ background: '#cc6b4a', color: '#fff', borderColor: '#cc6b4a' }}>
            {running ? 'Scribing…' : '🧠 Scribe now'}
          </button>
        </div>
      </div>
      {!hasFolder && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 10, background: 'rgba(204,107,74,0.06)', border: '1px dashed rgba(204,107,74,0.3)', borderRadius: 6 }}>
          Set <code>google_drive_folder_id</code> above and Save, then come back and hit Test + Scribe.
        </div>
      )}
      {hasFolder && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
          Folder: {state.folderId}{state.indexFileName ? ` · Index: ${state.indexFileName}` : ''}
        </div>
      )}
      {msg && (
        <div style={{
          marginTop: 8, fontSize: 12, padding: '8px 10px', borderRadius: 6,
          background: msg.kind === 'ok' ? 'rgba(74,222,128,0.08)' : 'rgba(239,68,68,0.08)',
          border: `1px solid ${msg.kind === 'ok' ? '#4ade80' : '#ef4444'}`,
          color: msg.kind === 'ok' ? '#4ade80' : '#ef4444',
        }}>{msg.text}</div>
      )}
      {state.lastSummary && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          Last scribe: {state.lastSummary.scanned} scanned · {state.lastSummary.updated} updated · {state.lastSummary.unchanged} unchanged · {state.lastSummary.skipped} skipped
          {state.lastSummary.errors > 0 && ` · ${state.lastSummary.errors} errors`}
        </div>
      )}
    </section>
  );
}

function ClientComingSoonConnector({ name, icon, note }) {
  return (
    <section className="settings-section" style={{ marginTop: 16, opacity: 0.55 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 24 }}>{icon}</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
            {name} · Tenant knowledge
            <span style={{ marginLeft: 10, fontSize: 11, padding: '2px 8px', borderRadius: 10, background: 'rgba(136,136,136,0.15)', color: '#9ba0aa', fontWeight: 600 }}>
              Coming soon
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{note}</div>
        </div>
      </div>
    </section>
  );
}

function humanAgo(ms) {
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ═══════════════════════════════════════════════════════════════
// Edit User Panel (inline, with integration setup)
// ═══════════════════════════════════════════════════════════════

function EditUserPanel({ user: u, availableTiers = [], isSuperAdmin, onUpdate, onMsg }) {
  const [form, setForm] = useState({
    name: u.name, department: u.department || '', userType: u.userType,
    city: u.city || '', contactNumber: u.contactNumber || '', jobDescription: u.jobDescription || '',
  });
  const [saving, setSaving] = useState(false);
  const [intStatus, setIntStatus] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => { loadIntStatus(); }, []);

  const loadIntStatus = async () => {
    try { const res = await api.get(`/integration/status/${u.id}`); setIntStatus(res.data); } catch {}
  };

  const saveUser = async () => {
    setSaving(true);
    try {
      await api.patch(`/admin/users/${u.id}`, form);
      onMsg('User updated');
      onUpdate();
    } catch (err) { onMsg(err.response?.data?.error || 'Failed to update user'); }
    setSaving(false);
  };

  const connectGoogle = async () => {
    try {
      const res = await api.get(`/integration/connect/${u.id}`);
      window.open(res.data.url, '_blank', 'width=600,height=700');
      // Poll for completion
      const poll = setInterval(async () => {
        const s = await api.get(`/integration/status/${u.id}`);
        if (s.data.connected) { clearInterval(poll); setIntStatus(s.data); onMsg(`Google connected: ${s.data.email}`); }
      }, 3000);
      setTimeout(() => clearInterval(poll), 120000); // stop polling after 2 min
    } catch (err) { onMsg(err.response?.data?.error || 'Failed to start connection'); }
  };

  const testConnection = async () => {
    setTesting(true);
    try {
      const res = await api.post(`/integration/test/${u.id}`);
      if (res.data.success) {
        onMsg(`Integration OK — Email: ${res.data.email}, Calendars: ${res.data.calendarCount}`);
        setIntStatus({ ...intStatus, status: 'active', error: null, email: res.data.email });
      } else {
        onMsg(`Integration Error: ${res.data.error}`);
        setIntStatus({ ...intStatus, status: 'error', error: res.data.error });
      }
    } catch (err) { onMsg('Test failed'); }
    setTesting(false);
  };

  const disconnectGoogle = async () => {
    try {
      await api.delete(`/integration/disconnect/${u.id}`);
      setIntStatus({ connected: false });
      onMsg('Integration disconnected');
    } catch (err) { onMsg('Disconnect failed'); }
  };

  const inputStyle = { width: '100%', padding: '6px 10px', fontSize: 13, background: '#2a2a2a', border: '1px solid #444', borderRadius: 6, color: '#eee' };

  return (
    <div style={{ background: '#1a1a1a', padding: 16, borderTop: '2px solid #cc6b4a' }}>
      {/* ── User Details ── */}
      <h4 style={{ color: '#cc6b4a', margin: '0 0 12px 0', fontSize: 14 }}>Edit User: {u.name}</h4>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div><label style={{ fontSize: 11, color: '#888' }}>Name</label><input style={inputStyle} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
        <div><label style={{ fontSize: 11, color: '#888' }}>Department</label><input style={inputStyle} value={form.department} onChange={e => setForm(f => ({ ...f, department: e.target.value }))} /></div>
        <div><label style={{ fontSize: 11, color: '#888' }}>User Type</label>
          <select style={inputStyle} value={form.userType} onChange={e => setForm(f => ({ ...f, userType: e.target.value }))}>
            {isSuperAdmin && <option value="SA">SA — SuperAdmin</option>}
            {isSuperAdmin && <option value="AD">AD — Admin</option>}
            {availableTiers.filter(t => t.is_active).map(t => (
              <option key={t.tier_code} value={t.tier_code}>{t.tier_code} — {t.tier_name}</option>
            ))}
          </select>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 12 }}>
        <div><label style={{ fontSize: 11, color: '#888' }}>City</label><input style={inputStyle} value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} /></div>
        <div><label style={{ fontSize: 11, color: '#888' }}>Contact Number</label><input style={inputStyle} value={form.contactNumber} onChange={e => setForm(f => ({ ...f, contactNumber: e.target.value }))} /></div>
        <div><label style={{ fontSize: 11, color: '#888' }}>Job Description</label><input style={inputStyle} value={form.jobDescription} onChange={e => setForm(f => ({ ...f, jobDescription: e.target.value }))} /></div>
      </div>
      <button className="settings-btn" onClick={saveUser} disabled={saving} style={{ marginBottom: 16 }}>
        {saving ? 'Saving...' : 'Save User Details'}
      </button>

      {/* ── Email & Calendar Integration ── */}
      <div style={{ borderTop: '1px solid #333', paddingTop: 12 }}>
        <h4 style={{ color: '#cc6b4a', margin: '0 0 10px 0', fontSize: 14 }}>Email & Calendar Integration</h4>

        {intStatus === null ? (
          <p style={{ color: '#888', fontSize: 12 }}>Loading...</p>
        ) : !intStatus.connected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ color: '#888', fontSize: 13 }}>Not connected</span>
            <button className="settings-btn" onClick={connectGoogle} style={{ padding: '6px 16px', fontSize: 12 }}>
              Connect Google (Gmail + Calendar)
            </button>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <span style={{
                display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
                background: intStatus.status === 'active' ? '#4ade80' : intStatus.status === 'expired' ? '#f59e0b' : '#ef4444',
              }} />
              <span style={{ fontSize: 13, color: '#eee' }}>
                {intStatus.provider === 'google' ? 'Google' : 'Microsoft'} — {intStatus.email}
              </span>
              <span style={{ fontSize: 11, color: '#888' }}>({intStatus.scopes})</span>
              <span style={{
                fontSize: 11, padding: '2px 8px', borderRadius: 10,
                background: intStatus.status === 'active' ? 'rgba(74,222,128,0.15)' : 'rgba(239,68,68,0.15)',
                color: intStatus.status === 'active' ? '#4ade80' : '#ef4444',
              }}>
                {intStatus.status}
              </span>
            </div>

            {intStatus.error && (
              <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, padding: '8px 12px', marginBottom: 8, fontSize: 12, color: '#ef4444' }}>
                Error: {intStatus.error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <button className="admin-action" onClick={testConnection} disabled={testing} style={{ borderColor: '#4ade80', color: '#4ade80' }}>
                {testing ? 'Testing...' : 'Test Connection'}
              </button>
              <button className="admin-action" onClick={connectGoogle} style={{ borderColor: '#f59e0b', color: '#f59e0b' }}>
                Reconnect
              </button>
              <button className="admin-action" onClick={disconnectGoogle} style={{ borderColor: '#ef4444', color: '#ef4444' }}>
                Disconnect
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Tenant Row (used in Client table)
// ═══════════════════════════════════════════════════════════════

function TenantRow({ tenant: t, onToggle, onSaved, setMsg }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(t.name);
  const [domain, setDomain] = useState(t.domain || '');

  const save = async () => {
    try {
      await api.patch(`/tenants/${t.clientNumber}`, { name, domain: domain || null });
      setMsg(`Client ${t.clientNumber} updated`);
      setEditing(false);
      onSaved();
    } catch (err) { setMsg(err.response?.data?.error || 'Failed to update'); }
  };

  if (editing) {
    return (
      <tr>
        <td><strong>{t.clientNumber}</strong></td>
        <td><input value={name} onChange={e => setName(e.target.value)} style={{ width: '100%', padding: '4px 8px', fontSize: 13, background: 'var(--bg-input)', border: '1px solid var(--accent)', borderRadius: 6, color: '#fff' }} /></td>
        <td><input value={domain} onChange={e => setDomain(e.target.value)} style={{ width: '100%', padding: '4px 8px', fontSize: 12, background: 'var(--bg-input)', border: '1px solid var(--border-input)', borderRadius: 6, color: '#bbb' }} placeholder="domain.com" /></td>
        <td>{t.userCount}</td>
        <td>{t.license ? <span style={{ fontSize: 11 }}>{t.license.adminSeats}AD/{t.license.standardSeats}ST/{t.license.basicSeats}BS</span> : <span style={{ color: '#888', fontSize: 11 }}>None</span>}</td>
        <td>{t.expiry ? <span style={{ color: new Date(t.expiry) > new Date() ? '#4ade80' : '#ef4444', fontSize: 12 }}>{new Date(t.expiry).toLocaleDateString()}</span> : '—'}</td>
        <td><span className={`badge-type ${t.isActive ? 'type-ST' : 'type-SA'}`}>{t.isActive ? 'Active' : 'Inactive'}</span></td>
        <td style={{ display: 'flex', gap: 4 }}>
          <button className="admin-action" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }} onClick={save}>Save</button>
          <button className="admin-action" onClick={() => setEditing(false)}>Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td><strong>{t.clientNumber}</strong></td>
      <td>{t.name}</td>
      <td style={{ fontSize: 12, color: '#888' }}>{t.domain || '—'}</td>
      <td>{t.userCount}</td>
      <td>{t.license ? <span style={{ fontSize: 11 }}>{t.license.adminSeats}AD/{t.license.standardSeats}ST/{t.license.basicSeats}BS</span> : <span style={{ color: '#888', fontSize: 11 }}>None</span>}</td>
      <td>{t.expiry ? <span style={{ color: new Date(t.expiry) > new Date() ? '#4ade80' : '#ef4444', fontSize: 12 }}>{new Date(t.expiry).toLocaleDateString()}</span> : '—'}</td>
      <td><span className={`badge-type ${t.isActive ? 'type-ST' : 'type-SA'}`} style={{ cursor: 'pointer' }} onClick={() => onToggle(t.clientNumber, t.isActive)}>{t.isActive ? 'Active' : 'Inactive'}</span></td>
      <td><button className="admin-action" onClick={() => setEditing(true)}>Edit</button></td>
    </tr>
  );
}

export default ClientManagementTab;
export { TenantRow };
