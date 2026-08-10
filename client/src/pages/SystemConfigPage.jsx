import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';
import ConfigEditor from '../components/ConfigEditor';
import AiProviderPanel from '../components/AiProviderPanel';

const SYSTEM_SECTIONS = [
  { title: 'Application', icon: '⚙️', keys: ['app_name', 'session_hours', 'max_tokens', 'request_timeout_ms', 'max_context_chars'] },
  { title: 'AI & RAG Pipeline', icon: '🧠', keys: ['rag_enabled', 'pii_enabled', 'rag_top_k', 'rag_min_score'] },
  { title: 'AI API Keys', icon: '🔑', keys: ['gemini_api_key', 'anthropic_api_key', 'openai_api_key', 'groq_api_key', 'openrouter_api_key'] },
];

export default function SystemConfigPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('config');

  if (!user?.isSuperAdmin) {
    return <div className="settings-page"><div className="settings-container"><h1>Access Denied</h1><p>SuperAdmin access required.</p></div></div>;
  }

  return (
    <div className="settings-page">
      <div className="settings-container" style={{ maxWidth: 720 }}>
        <div className="settings-header">
          <button className="settings-back" onClick={() => navigate('/admin')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            Back
          </button>
          <h1>System Configuration</h1>
          <span className="config-scope-badge">SuperAdmin</span>
        </div>

        {/* Tabs */}
        <div className="config-tabs">
          <button className={`config-tab ${activeTab === 'config' ? 'active' : ''}`} onClick={() => setActiveTab('config')}>Configuration</button>
          <button className={`config-tab ${activeTab === 'data' ? 'active' : ''}`} onClick={() => setActiveTab('data')}>Data Management</button>
        </div>

        {activeTab === 'config' && (
          <>
            {/* Provider selection sits ABOVE the key list: which backend Brain
                runs on is the decision, and the keys are what that decision
                needs. Owner request 2026-08-10. */}
            <AiProviderPanel />
            <ConfigEditor sections={SYSTEM_SECTIONS} apiPath="/config" />
          </>
        )}
        {activeTab === 'data' && <DataManagement />}
      </div>
    </div>
  );
}

// ─── Data Management Component ─────────────────────────────────

function DataManagement() {
  const [tenants, setTenants] = useState([]);
  const [selectedClient, setSelectedClient] = useState('');
  const [tables, setTables] = useState([]);
  const [selectedTables, setSelectedTables] = useState(new Set());
  const [preview, setPreview] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [purging, setPurging] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api.get('/config/data/tenants').then(r => setTenants(r.data.tenants)).catch(() => {});
  }, []);

  useEffect(() => {
    loadTables();
  }, [selectedClient]);

  const loadTables = async () => {
    try {
      const params = selectedClient ? `?client=${selectedClient}` : '';
      const res = await api.get(`/config/data/tables${params}`);
      setTables(res.data.tables || []);
      setSelectedTables(new Set());
      setPreview(null);
    } catch { setMsg('Failed to load tables'); }
  };

  const toggleTable = (key) => {
    setSelectedTables(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    setPreview(null);
  };

  const selectAll = (category) => {
    const keys = tables.filter(t => !category || t.category === category).map(t => t.key);
    setSelectedTables(prev => {
      const next = new Set(prev);
      keys.forEach(k => next.add(k));
      return next;
    });
    setPreview(null);
  };

  const deselectAll = () => {
    setSelectedTables(new Set());
    setPreview(null);
  };

  const handlePreview = async () => {
    setMsg('');
    try {
      const res = await api.post('/config/data/preview', {
        tables: Array.from(selectedTables),
        clientNumber: selectedClient || undefined,
      });
      setPreview(res.data.preview);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Preview failed');
    }
  };

  const handlePurge = async () => {
    setPurging(true);
    setMsg('');
    try {
      const res = await api.delete('/config/data/purge', {
        data: {
          tables: Array.from(selectedTables),
          clientNumber: selectedClient || undefined,
        },
      });
      const total = res.data.results.reduce((s, r) => s + r.deleted, 0);
      setMsg(`Purge complete: ${total} records deleted across ${res.data.results.length} tables`);
      setShowConfirm(false);
      setPreview(null);
      setSelectedTables(new Set());
      loadTables();
    } catch (err) {
      setMsg(err.response?.data?.error || 'Purge failed');
    }
    setPurging(false);
  };

  const transactional = tables.filter(t => t.category === 'transactional');
  const configuration = tables.filter(t => t.category === 'configuration');
  const totalSelected = preview ? preview.reduce((s, p) => s + p.count, 0) : 0;

  return (
    <>
      {msg && <div className={`settings-msg ${msg.includes('Failed') || msg.includes('failed') ? 'error' : ''}`}>{msg}</div>}

      {/* Client Selector */}
      <section className="settings-section">
        <h2>🏢 Select Client</h2>
        <div className="config-value">
          <select value={selectedClient} onChange={e => setSelectedClient(e.target.value)} style={{ flex: 1 }}>
            <option value="">All Clients</option>
            {tenants.map(t => (
              <option key={t.clientNumber} value={t.clientNumber}>
                {t.clientNumber} — {t.name} {!t.isActive ? '(inactive)' : ''}
              </option>
            ))}
          </select>
        </div>
        <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
          {selectedClient ? `Data will be purged only for ${selectedClient}` : 'Data will be purged across ALL clients'}
        </p>
      </section>

      {/* Transactional Data */}
      <section className="settings-section purge-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Transactional Data</h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="admin-action" onClick={() => selectAll('transactional')}>Select All</button>
            <button className="admin-action" onClick={deselectAll}>Clear</button>
          </div>
        </div>
        {transactional.map(t => (
          <label className="purge-row" key={t.key}>
            <input type="checkbox" checked={selectedTables.has(t.key)} onChange={() => toggleTable(t.key)} />
            <span className="purge-label">{t.label}</span>
            <span className="purge-count">{t.count.toLocaleString()} records</span>
          </label>
        ))}
      </section>

      {/* Configuration Data */}
      <section className="settings-section purge-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Configuration Data</h2>
          <button className="admin-action" onClick={() => selectAll('configuration')}>Select All</button>
        </div>
        {configuration.map(t => (
          <label className="purge-row" key={t.key}>
            <input type="checkbox" checked={selectedTables.has(t.key)} onChange={() => toggleTable(t.key)} />
            <span className="purge-label">{t.label}</span>
            <span className="purge-count">{t.count.toLocaleString()} records</span>
          </label>
        ))}
      </section>

      {/* Actions */}
      {selectedTables.size > 0 && (
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="settings-btn" onClick={handlePreview} style={{ flex: 1 }}>
            Preview ({selectedTables.size} tables selected)
          </button>
        </div>
      )}

      {/* Preview Results */}
      {preview && (
        <section className="settings-section" style={{ borderColor: 'rgba(239,68,68,0.3)' }}>
          <h2 style={{ color: '#ef4444' }}>Purge Preview</h2>
          <p style={{ fontSize: 12, color: '#888', marginBottom: 12 }}>
            Target: <strong>{selectedClient || 'ALL CLIENTS'}</strong> · Dependent tables auto-included
          </p>
          <div className="admin-cards">
            {preview.map(p => (
              <div className="admin-card" key={p.table} style={{ borderColor: p.count > 0 ? 'rgba(239,68,68,0.3)' : 'var(--border)' }}>
                <div className="admin-card-value" style={{ color: p.count > 0 ? '#ef4444' : '#888' }}>{p.count.toLocaleString()}</div>
                <div className="admin-card-label">{p.label}</div>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 13, color: '#ef4444', marginTop: 12, fontWeight: 600 }}>
            Total: {totalSelected.toLocaleString()} records will be permanently deleted
          </p>
          <button className="settings-btn danger" onClick={() => setShowConfirm(true)} style={{ width: '100%', marginTop: 12 }}>
            Purge Selected Data
          </button>
        </section>
      )}

      {/* Confirmation Modal */}
      {showConfirm && (
        <div className="purge-modal-overlay">
          <div className="purge-modal">
            <h3 style={{ color: '#ef4444' }}>Confirm Purge</h3>
            <p>You are about to permanently delete <strong>{totalSelected.toLocaleString()}</strong> records from <strong>{selectedClient || 'ALL CLIENTS'}</strong>.</p>
            <ul style={{ fontSize: 13, color: '#bbb', margin: '12px 0', paddingLeft: 20 }}>
              {preview.filter(p => p.count > 0).map(p => (
                <li key={p.table}>{p.label}: {p.count.toLocaleString()} records</li>
              ))}
            </ul>
            <p style={{ color: '#ef4444', fontWeight: 600, fontSize: 13 }}>This action cannot be undone.</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button className="settings-btn" onClick={() => setShowConfirm(false)} style={{ flex: 1, background: '#333' }}>Cancel</button>
              <button className="settings-btn danger" onClick={handlePurge} disabled={purging} style={{ flex: 1 }}>
                {purging ? 'Purging...' : 'Confirm Purge'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
