import { useState, useEffect } from 'react';
import api from '../services/api';

/**
 * AI Provider — pick the inference backend Brain runs on.
 *
 * Owner, 2026-08-10: he wants the panel the VM portal already has — choose
 * Vertex, paste a service account, set a region, press Verify. Until now
 * Nexeo's provider was a constant in llmRouter.ts, so changing backend meant an
 * edit and a deploy.
 *
 * Two rules the UI has to hold to:
 *
 *  - The service account is a PRIVATE KEY. It is never sent back to the
 *    browser. The box shows whether one is stored, and an empty box on save
 *    means "keep what you have" — never "erase it".
 *  - Verify makes a REAL call. A credential check would pass on a key with no
 *    quota, a retired model, or a region that does not host the model — and
 *    two of those three have bitten this project inside a week.
 */

const PROVIDERS = [
  { id: 'claude', label: 'Claude', dot: '#8b5cf6' },
  { id: 'openai', label: 'OpenAI', dot: '#10b981' },
  { id: 'gemini', label: 'Gemini', dot: '#3b82f6' },
  { id: 'vertex', label: 'Vertex AI', dot: '#60a5fa' },
  { id: 'openrouter', label: 'OpenRouter', dot: '#f97316' },
  { id: 'custom', label: 'Custom', dot: '#64748b' },
];

export default function AiProviderPanel() {
  const [cfg, setCfg] = useState(null);
  const [sa, setSa] = useState('');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const { data } = await api.get('/config/ai');
      setCfg(data);
      setSa('');
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not load the provider configuration.');
    }
  }

  async function save() {
    setSaving(true); setError(null); setResult(null);
    try {
      const writes = [
        api.put('/config/ai_provider', { value: cfg.provider }),
        api.put('/config/ai_model', { value: cfg.model }),
        api.put('/config/ai_region', { value: cfg.region }),
      ];
      // Only write the service account when the operator actually typed one.
      // An empty box means "leave the stored key alone", exactly as the hint
      // under it says — sending '' here would silently delete their credential.
      if (sa.trim()) writes.push(api.put('/config/ai_service_account_json', { value: sa.trim() }));
      await Promise.all(writes);
      await load();
    } catch (e) {
      setError(e?.response?.data?.error || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function verify() {
    setVerifying(true); setResult(null); setError(null);
    try {
      const { data } = await api.post('/config/ai/verify');
      setResult(data);
    } catch (e) {
      setResult({ ok: false, message: e?.response?.data?.error || 'The check could not run.' });
    } finally {
      setVerifying(false);
    }
  }

  if (!cfg) return <div className="config-section"><p>Loading provider configuration…</p></div>;

  const isVertex = cfg.provider === 'vertex';

  return (
    <div className="config-section">
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>🤖 AI Provider</h2>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '14px 0 20px' }}>
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setCfg({ ...cfg, provider: p.id })}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 16px', borderRadius: 10, cursor: 'pointer',
              border: cfg.provider === p.id ? '2px solid #4f46e5' : '1px solid #d4d4d8',
              background: cfg.provider === p.id ? '#eef2ff' : '#fafafa',
              color: cfg.provider === p.id ? '#4338ca' : '#3f3f46',
              fontWeight: cfg.provider === p.id ? 600 : 500,
            }}
          >
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: p.dot }} />
            {p.label}
          </button>
        ))}
      </div>

      <label className="config-label">MODEL</label>
      <input
        className="config-input"
        value={cfg.model || ''}
        onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
        placeholder="gemini-2.5-pro"
      />
      <p className="config-hint">
        {isVertex
          ? 'Enter the Vertex model ID enabled in your GCP project (e.g. gemini-2.5-pro).'
          : 'The model ID for the selected provider.'}
        {cfg.flashModel && cfg.flashModel !== cfg.model && (
          <> High-volume work uses <code>{cfg.flashModel}</code>, derived from this.</>
        )}
      </p>

      {isVertex && (
        <>
          <label className="config-label">SERVICE ACCOUNT JSON</label>
          <textarea
            className="config-input"
            rows={6}
            value={sa}
            onChange={(e) => setSa(e.target.value)}
            placeholder={
              cfg.hasServiceAccount ? '•••••••• (stored — leave blank to keep it)'
                : cfg.usesAmbientCredentials
                  ? 'Not stored. Using the server\'s GOOGLE_APPLICATION_CREDENTIALS.'
                  : 'Paste the service account JSON'
            }
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />
          <p className="config-hint">
            Stored application-wide (used by all tenants); masked on read. If a key is ever
            exposed, rotate it in GCP.
            {cfg.usesAmbientCredentials && !cfg.hasServiceAccount && (
              <> <strong>Optional here</strong> — this server already authenticates with its own
              credentials file.</>
            )}
          </p>

          <label className="config-label">REGION (LOCATION)</label>
          <input
            className="config-input"
            value={cfg.region || ''}
            onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
            placeholder="us-central1"
          />
          <p className="config-hint">Vertex AI region, e.g. us-central1, europe-west1.</p>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn-secondary" onClick={verify} disabled={verifying}>
          {verifying ? 'Checking…' : '🔌 Verify integration'}
        </button>

        {result && (
          <span style={{ color: result.ok ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
            {result.ok ? '✓ ' : '✗ '}{result.message}
          </span>
        )}
        {!result && !cfg.ready && cfg.reason && (
          <span style={{ color: '#b45309', fontWeight: 600 }}>⚠ {cfg.reason}</span>
        )}
      </div>

      {/* The provider's own error text names the real cause — wrong region, model
          not enabled, missing IAM role. Paraphrasing it would waste the reader's
          time, so it is shown verbatim. */}
      {result?.detail && (
        <pre style={{
          marginTop: 10, padding: 10, background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 8, fontSize: 11, whiteSpace: 'pre-wrap', color: '#7f1d1d',
        }}>{result.detail}</pre>
      )}

      {error && <p style={{ color: '#b91c1c', marginTop: 10 }}>{error}</p>}
    </div>
  );
}
