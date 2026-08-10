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
 * STYLING NOTE: this deliberately reuses `settings-section`, `config-row`,
 * `config-key`, `config-value` and `config-badge` — the same classes
 * ConfigEditor renders the "AI API Keys" block with, directly below. The first
 * version hardcoded light-theme colours and looked foreign on the dark UI. A
 * settings panel that does not match the panel beneath it reads as bolted on,
 * so the only inline styles left here are layout, never colour: colour comes
 * from the theme's CSS variables so it follows light and dark automatically.
 *
 * Two rules the UI has to hold to:
 *  - The service account is a PRIVATE KEY. It is never sent back to the
 *    browser. The box shows whether one is stored, and an empty box on save
 *    means "keep what you have" — never "erase it".
 *  - Verify makes a REAL call. A credential check would pass on a key with no
 *    quota, a retired model, or a region that does not host the model — and two
 *    of those three have bitten this project inside a week.
 */

const PROVIDERS = [
  { id: 'claude', label: 'Claude', dot: '#a855f7' },
  { id: 'openai', label: 'OpenAI', dot: '#10b981' },
  { id: 'gemini', label: 'Gemini', dot: '#3b82f6' },
  { id: 'vertex', label: 'Vertex AI', dot: '#60a5fa' },
  { id: 'openrouter', label: 'OpenRouter', dot: '#f97316' },
  { id: 'custom', label: 'Custom', dot: '#94a3b8' },
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
      // under it promises — sending '' would silently delete their credential.
      if (sa.trim()) writes.push(api.put('/config/ai_service_account_json', { value: sa.trim() }));
      await Promise.all(writes);
      await load();
      setResult({ ok: true, message: 'Saved. Press Verify to test it for real.' });
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

  if (!cfg) {
    return (
      <section className="settings-section">
        <h2>🤖 AI Provider</h2>
        <p className="config-desc">Loading…</p>
      </section>
    );
  }

  const isVertex = cfg.provider === 'vertex';

  return (
    <section className="settings-section">
      <h2>🤖 AI Provider</h2>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '4px 0 18px' }}>
        {PROVIDERS.map((p) => {
          const on = cfg.provider === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => setCfg({ ...cfg, provider: p.id })}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '9px 15px', borderRadius: 10, cursor: 'pointer',
                fontSize: 14, fontWeight: on ? 600 : 500,
                // Colour from the theme, never literals — so this follows the
                // dark UI it sits in, and any future theme change.
                background: on ? 'var(--bg-active, var(--bg-hover))' : 'var(--bg-input)',
                border: `1px solid ${on ? 'var(--accent, #6366f1)' : 'var(--border-input)'}`,
                color: on ? 'var(--text-primary, var(--text))' : 'var(--text-secondary, var(--text-muted))',
              }}
            >
              <span style={{ width: 9, height: 9, borderRadius: '50%', background: p.dot, flexShrink: 0 }} />
              {p.label}
            </button>
          );
        })}
      </div>

      <div className="config-row">
        <div className="config-key">
          <code>ai_model</code>
          <span className="config-desc">
            {isVertex
              ? 'Vertex model ID enabled in your GCP project (e.g. gemini-2.5-pro).'
              : 'Model ID for the selected provider.'}
          </span>
        </div>
        <div className="config-value">
          <input
            type="text"
            value={cfg.model || ''}
            onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
            placeholder="gemini-2.5-pro"
          />
        </div>
      </div>

      {isVertex && (
        <>
          <div className="config-row">
            <div className="config-key">
              <code>ai_service_account_json</code>
              <span className="config-badge sensitive">encrypted</span>
              <span className="config-desc">
                Stored application-wide; masked on read. Leave blank to keep the stored value.
                {cfg.usesAmbientCredentials && !cfg.hasServiceAccount
                  && ' Optional — this server already authenticates with its own credentials file.'}
              </span>
            </div>
            <div className="config-value">
              <textarea
                rows={5}
                value={sa}
                onChange={(e) => setSa(e.target.value)}
                placeholder={
                  cfg.hasServiceAccount
                    ? '•••••••• (stored)'
                    : cfg.usesAmbientCredentials
                      ? 'Not stored — using the server credentials file'
                      : 'Paste the service account JSON'
                }
                style={{
                  width: '100%', fontFamily: 'monospace', fontSize: 12, padding: 10,
                  borderRadius: 8, resize: 'vertical',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-input)',
                  color: 'var(--text)',
                }}
              />
            </div>
          </div>

          <div className="config-row">
            <div className="config-key">
              <code>ai_region</code>
              <span className="config-desc">Vertex AI region, e.g. us-central1, europe-west1.</span>
            </div>
            <div className="config-value">
              <input
                type="text"
                value={cfg.region || ''}
                onChange={(e) => setCfg({ ...cfg, region: e.target.value })}
                placeholder="us-central1"
              />
            </div>
          </div>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
        <button className="settings-btn" onClick={save} disabled={saving} style={{ padding: '10px 18px' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="settings-btn" onClick={verify} disabled={verifying} style={{ padding: '10px 18px' }}>
          {verifying ? 'Checking…' : '🔌 Verify integration'}
        </button>

        {result && (
          <span style={{ color: result.ok ? '#22c55e' : '#f87171', fontWeight: 600, fontSize: 14 }}>
            {result.ok ? '✓ ' : '✗ '}{result.message}
          </span>
        )}
        {!result && !cfg.ready && cfg.reason && (
          <span style={{ color: '#fbbf24', fontWeight: 600, fontSize: 14 }}>⚠ {cfg.reason}</span>
        )}
      </div>

      {/* The provider's own error text names the real cause — wrong region,
          model not enabled, missing IAM role. Paraphrasing it would waste the
          reader's time, so it is shown verbatim. */}
      {result?.detail && (
        <pre style={{
          marginTop: 10, padding: 10, borderRadius: 8, fontSize: 11,
          whiteSpace: 'pre-wrap', overflowX: 'auto',
          background: 'var(--bg-input)',
          border: '1px solid var(--border-input)',
          color: 'var(--text-muted)',
        }}>{result.detail}</pre>
      )}

      {error && <p style={{ color: '#f87171', marginTop: 10, fontSize: 14 }}>{error}</p>}
    </section>
  );
}
