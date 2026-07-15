import React, { useState, useEffect } from 'react';
import api from '../../services/api';
import ConfigEditor from '../../components/ConfigEditor';
import { SYSTEM_SECTIONS, CLIENT_SECTIONS } from './adminConstants';

// ═══════════════════════════════════════════════════════════════
// TAB: Application Configuration
// ═══════════════════════════════════════════════════════════════

export default function ConfigTab({ user }) {
  const [subTab, setSubTab] = useState('config');

  return (
    <>
      {user?.isSuperAdmin && (
        <div className="config-tabs sub-tabs">
          <button className={`config-tab ${subTab === 'config' ? 'active' : ''}`} onClick={() => setSubTab('config')}>Settings</button>
          <button className={`config-tab ${subTab === 'data' ? 'active' : ''}`} onClick={() => setSubTab('data')}>Data Management</button>
        </div>
      )}

      {subTab === 'config' && (
        <>
          {user?.isSuperAdmin && <LogoUploader />}
          {user?.isSuperAdmin && <DisplayDefaultsSection />}
          <ConfigEditor sections={user?.isSuperAdmin ? SYSTEM_SECTIONS : CLIENT_SECTIONS} apiPath="/config" />
        </>
      )}

      {subTab === 'data' && user?.isSuperAdmin && <DataManagementSection />}
    </>
  );
}

function LogoUploader() {
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const currentLogoUrl = `/api/health/logo?t=${Date.now()}`;

  const handleFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { setMsg('Please select an image file'); return; }
    if (file.size > 2 * 1024 * 1024) { setMsg('Max 2MB'); return; }

    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result);
    reader.readAsDataURL(file);
    setMsg('');
  };

  const upload = async () => {
    if (!preview) return;
    setSaving(true);
    setMsg('');
    try {
      await api.post('/config/logo', { logo: preview });
      setMsg('Logo uploaded');
      setPreview(null);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Upload failed');
    }
    setSaving(false);
  };

  return (
    <section className="settings-section">
      <h2>🖼 Client Logo</h2>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <img
          src={preview || currentLogoUrl}
          alt="Logo"
          style={{ width: 64, height: 64, borderRadius: 12, border: '1px solid #333', objectFit: 'contain', background: '#1a1a1a' }}
          onError={(e) => { e.target.src = '/tmc-logo.png'; }}
        />
        <div style={{ flex: 1 }}>
          <input type="file" accept="image/*" onChange={handleFile} style={{ fontSize: 12, color: '#888' }} />
          <p style={{ fontSize: 11, color: '#666', marginTop: 4 }}>PNG or SVG, max 2MB. Shown on login, chat, and emails.</p>
        </div>
        {preview && (
          <button className="settings-btn" onClick={upload} disabled={saving}>
            {saving ? 'Uploading...' : 'Save Logo'}
          </button>
        )}
      </div>
      {msg && <div className={`settings-msg ${msg.includes('failed') ? 'error' : ''}`} style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  );
}

// ─── Display defaults (SA-only) ─────────────────────────────
// Sets the default --fs-scale for every user in this tenant. Individual
// users can still set a personal override in Settings → Display; their
// override wins over this default.

function DisplayDefaultsSection() {
  const PRESETS = [
    { label: 'Small', value: 0.9 },
    { label: 'Normal', value: 1.0 },
    { label: 'Large', value: 1.15 },
    { label: 'XL', value: 1.3 },
  ];
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/profile/app-defaults/font-scale').then((r) => {
      setScale(Number(r.data?.fontScale) || 1);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async (next) => {
    const clamped = Math.min(1.4, Math.max(0.85, Number(next) || 1));
    setSaving(true); setMsg('');
    try {
      await api.put('/profile/app-defaults/font-scale', { fontScale: clamped });
      setScale(clamped);
      setMsg(`Organisation default set to ${Math.round(clamped * 100)}%. New users and anyone without a personal override will see this size.`);
      setTimeout(() => setMsg(''), 4000);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Failed to save');
    }
    setSaving(false);
  };

  const pct = Math.round(Number(scale) * 100);

  return (
    <section className="settings-section">
      <h2>🔤 Display Defaults</h2>
      <p style={{ fontSize: 12, color: '#666', marginTop: -4, marginBottom: 10 }}>
        Sets the default interface text size for <strong>every user in this tenant</strong>. Individual users can still set a personal override in Settings → Display, which wins over this.
      </p>
      <div className="settings-field">
        <label>Default text size · {pct}%</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="settings-btn" onClick={() => save(Math.max(0.85, scale - 0.05))} disabled={saving || loading || scale <= 0.85}>A−</button>
          <button className="settings-btn" onClick={() => save(Math.min(1.4, scale + 0.05))} disabled={saving || loading || scale >= 1.4}>A+</button>
          <span style={{ width: 1, height: 22, background: 'var(--border)', margin: '0 4px' }} />
          {PRESETS.map((p) => (
            <button
              key={p.value}
              className="settings-btn"
              onClick={() => save(p.value)}
              disabled={saving || loading}
              style={Math.abs(scale - p.value) < 0.02 ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
            >
              {p.label}
            </button>
          ))}
        </div>
        {msg && <div style={{ fontSize: 12, color: '#4ade80', marginTop: 8 }}>{msg}</div>}
      </div>
    </section>
  );
}

// ─── Data Management (from SystemConfigPage) ───────────────────

function DataManagementSection() {
  const [tenants, setTenants] = useState([]);
  const [selectedClient, setSelectedClient] = useState('');
  const [tables, setTables] = useState([]);
  const [selectedTables, setSelectedTables] = useState(new Set());
  const [preview, setPreview] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [purging, setPurging] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => { api.get('/config/data/tenants').then(r => setTenants(r.data.tenants)).catch(() => {}); }, []);
  useEffect(() => { loadTables(); }, [selectedClient]);

  const loadTables = async () => {
    try {
      const params = selectedClient ? `?client=${selectedClient}` : '';
      const res = await api.get(`/config/data/tables${params}`);
      setTables(res.data.tables || []);
      setSelectedTables(new Set());
      setPreview(null);
    } catch {}
  };

  const toggleTable = (key) => { setSelectedTables(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; }); setPreview(null); };
  const selectAll = (cat) => { setSelectedTables(new Set(tables.filter(t => !cat || t.category === cat).map(t => t.key))); setPreview(null); };

  const handlePreview = async () => {
    setMsg('');
    try { const res = await api.post('/config/data/preview', { tables: Array.from(selectedTables), clientNumber: selectedClient || undefined }); setPreview(res.data.preview); }
    catch (err) { setMsg(err.response?.data?.error || 'Preview failed'); }
  };

  const handlePurge = async () => {
    setPurging(true);
    try {
      const res = await api.delete('/config/data/purge', { data: { tables: Array.from(selectedTables), clientNumber: selectedClient || undefined } });
      const total = res.data.results.reduce((s, r) => s + r.deleted, 0);
      setMsg(`Purged ${total} records`);
      setShowConfirm(false); setPreview(null); setSelectedTables(new Set()); loadTables();
    } catch (err) { setMsg(err.response?.data?.error || 'Purge failed'); }
    setPurging(false);
  };

  const transactional = tables.filter(t => t.category === 'transactional');
  const aiMemory = tables.filter(t => t.category === 'ai_memory');
  const monitoring = tables.filter(t => t.category === 'monitoring');
  const configuration = tables.filter(t => t.category === 'configuration');
  const totalSelected = preview ? preview.reduce((s, p) => s + p.count, 0) : 0;

  return (
    <>
      {msg && <div className={`settings-msg ${msg.includes('Failed') || msg.includes('failed') ? 'error' : ''}`}>{msg}</div>}

      <section className="settings-section">
        <h2>Select Client</h2>
        <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)} style={{ width: '100%', padding: '8px 12px', fontSize: 13, background: 'var(--bg-input)', border: '1px solid var(--border-input)', borderRadius: 8, color: '#e8e8e0' }}>
          <option value="">All Clients</option>
          {tenants.map(t => <option key={t.clientNumber} value={t.clientNumber}>{t.clientNumber} — {t.name}</option>)}
        </select>
      </section>

      <section className="settings-section purge-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Transactional Data</h2>
          <div style={{ display: 'flex', gap: 6 }}><button className="admin-action" onClick={() => selectAll('transactional')}>All</button><button className="admin-action" onClick={() => setSelectedTables(new Set())}>Clear</button></div>
        </div>
        {transactional.map(t => (
          <label className="purge-row" key={t.key}><input type="checkbox" checked={selectedTables.has(t.key)} onChange={() => toggleTable(t.key)} /><span className="purge-label">{t.label}</span><span className="purge-count">{t.count.toLocaleString()}</span></label>
        ))}
      </section>

      {aiMemory.length > 0 && (
      <section className="settings-section purge-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>AI Memory & Learning</h2>
          <div style={{ display: 'flex', gap: 6 }}><button className="admin-action" onClick={() => selectAll('ai_memory')}>All</button></div>
        </div>
        {aiMemory.map(t => (
          <label className="purge-row" key={t.key}><input type="checkbox" checked={selectedTables.has(t.key)} onChange={() => toggleTable(t.key)} /><span className="purge-label">{t.label}</span><span className="purge-count">{t.count.toLocaleString()}</span></label>
        ))}
      </section>
      )}

      {monitoring.length > 0 && (
      <section className="settings-section purge-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Monitoring & Usage</h2>
          <div style={{ display: 'flex', gap: 6 }}><button className="admin-action" onClick={() => selectAll('monitoring')}>All</button></div>
        </div>
        {monitoring.map(t => (
          <label className="purge-row" key={t.key}><input type="checkbox" checked={selectedTables.has(t.key)} onChange={() => toggleTable(t.key)} /><span className="purge-label">{t.label}</span><span className="purge-count">{t.count.toLocaleString()}</span></label>
        ))}
      </section>
      )}

      <section className="settings-section purge-section">
        <h2>Configuration Data</h2>
        {configuration.map(t => (
          <label className="purge-row" key={t.key}><input type="checkbox" checked={selectedTables.has(t.key)} onChange={() => toggleTable(t.key)} /><span className="purge-label">{t.label}</span><span className="purge-count">{t.count.toLocaleString()}</span></label>
        ))}
      </section>

      {selectedTables.size > 0 && <button className="settings-btn" onClick={handlePreview} style={{ width: '100%', marginBottom: 12 }}>Preview ({selectedTables.size} tables)</button>}

      {preview && (
        <section className="settings-section" style={{ borderColor: 'rgba(239,68,68,0.3)' }}>
          <h2 style={{ color: '#ef4444' }}>Purge Preview — {selectedClient || 'ALL CLIENTS'}</h2>
          <div className="admin-cards">
            {preview.map(p => <div className="admin-card" key={p.table} style={{ borderColor: p.count > 0 ? 'rgba(239,68,68,0.3)' : 'var(--border)' }}><div className="admin-card-value" style={{ color: p.count > 0 ? '#ef4444' : '#888' }}>{p.count}</div><div className="admin-card-label">{p.label}</div></div>)}
          </div>
          <button className="settings-btn danger" onClick={() => setShowConfirm(true)} style={{ width: '100%', marginTop: 12 }}>Purge {totalSelected} Records</button>
        </section>
      )}

      {showConfirm && (
        <div className="purge-modal-overlay">
          <div className="purge-modal">
            <h3 style={{ color: '#ef4444' }}>Confirm Purge</h3>
            <p>Permanently delete <strong>{totalSelected}</strong> records from <strong>{selectedClient || 'ALL CLIENTS'}</strong>?</p>
            <p style={{ color: '#ef4444', fontWeight: 600, fontSize: 13, marginTop: 10 }}>This cannot be undone.</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button className="settings-btn" onClick={() => setShowConfirm(false)} style={{ flex: 1, background: '#333' }}>Cancel</button>
              <button className="settings-btn danger" onClick={handlePurge} disabled={purging} style={{ flex: 1 }}>{purging ? 'Purging...' : 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
