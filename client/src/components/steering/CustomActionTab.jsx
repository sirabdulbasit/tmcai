/**
 * HaseebOS v15 L4.3 — Custom action creation with Probabilistic Shadowing.
 *
 * Lets the user describe a new action rule (e.g. "when sender ends in @vip.com
 * and subject contains 'urgent', auto-escalate"). The rule is created in DRAFT
 * state; after 30 days of shadow data it can be promoted to SHADOW, then ACTIVE.
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';

export default function CustomActionTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [form, setForm] = useState({
    name: '',
    archetype: 'reply_needed',
    triggerConditionJson: '{"senderDomain":"","subjectContains":""}',
    action: 'escalate',
    description: '',
  });

  const load = async () => {
    setLoading(true); setErr(null);
    try {
      const { data } = await api.get('/shadow/rules');
      setRules(Array.isArray(data?.rules) ? data.rules : Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.response?.data?.error ?? e.message);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const submit = async () => {
    try {
      await api.post('/shadow/rules', {
        ...form,
        triggerCondition: JSON.parse(form.triggerConditionJson || '{}'),
        mode: 'DRAFT',
      });
      setForm({ ...form, name: '', description: '' });
      load();
    } catch (e) {
      setErr(e?.response?.data?.error ?? e.message);
    }
  };

  const promote = async (id, to) => {
    try { await api.post(`/shadow/rules/${id}/promote`, { targetMode: to }); load(); }
    catch (e) { setErr(e?.response?.data?.error ?? e.message); }
  };
  const demote = async (id) => {
    const reason = window.prompt('Reason?', 'false positives');
    if (reason === null) return;
    try { await api.post(`/shadow/rules/${id}/demote`, { reason }); load(); }
    catch (e) { setErr(e?.response?.data?.error ?? e.message); }
  };

  const modeBadge = (m) => {
    const color = m === 'ACTIVE' ? '#0a4' : m === 'SHADOW' ? '#a80' : '#555';
    return (
      <span style={{ background: color, color: '#fff', padding: '2px 6px', borderRadius: 3, fontSize: 11 }}>{m}</span>
    );
  };

  return (
    <div style={{ padding: 16 }}>
      <h2>Custom Actions (Probabilistic Shadowing)</h2>
      <p style={{ color: '#888', fontSize: 13 }}>
        New rules start in DRAFT. After 30 days of shadow data with ≥95% agreement,
        promote to ACTIVE to let the action executor fire them automatically.
      </p>
      {err && <div style={{ color: '#e55', padding: 8 }}>{err}</div>}

      <section style={{ border: '1px solid #2a2a2a', borderRadius: 6, padding: 12, marginTop: 16 }}>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Create rule</h3>
        <div style={{ display: 'grid', gap: 8, gridTemplateColumns: '1fr 1fr' }}>
          <label style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 12, color: '#999' }}>Name</span>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
                   style={{ padding: 6, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4 }} />
          </label>
          <label style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 12, color: '#999' }}>Archetype</span>
            <select value={form.archetype} onChange={(e) => setForm({ ...form, archetype: e.target.value })}
                    style={{ padding: 6, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4 }}>
              <option>reply_needed</option>
              <option>delegate</option>
              <option>inform_only</option>
              <option>schedule_meeting</option>
              <option>review_risk</option>
              <option>acknowledge</option>
            </select>
          </label>
          <label style={{ display: 'grid', gap: 2, gridColumn: 'span 2' }}>
            <span style={{ fontSize: 12, color: '#999' }}>Trigger condition (JSON)</span>
            <textarea rows={4} value={form.triggerConditionJson}
                      onChange={(e) => setForm({ ...form, triggerConditionJson: e.target.value })}
                      style={{ padding: 6, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4 }} />
          </label>
          <label style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 12, color: '#999' }}>Action</span>
            <input value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}
                   style={{ padding: 6, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4 }} />
          </label>
          <label style={{ display: 'grid', gap: 2 }}>
            <span style={{ fontSize: 12, color: '#999' }}>Description</span>
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                   style={{ padding: 6, background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4 }} />
          </label>
        </div>
        <button type="button" onClick={submit} disabled={!form.name}
                style={{ marginTop: 8, padding: '8px 14px', background: '#0a4', color: '#fff', border: 0, borderRadius: 4 }}>
          Create DRAFT
        </button>
      </section>

      <section style={{ marginTop: 20 }}>
        <h3 style={{ margin: 0, marginBottom: 8 }}>Existing rules</h3>
        {loading && <div>Loading…</div>}
        {!loading && rules.length === 0 && <div style={{ color: '#666' }}>No rules yet.</div>}
        <div style={{ display: 'grid', gap: 8 }}>
          {rules.map((r) => (
            <div key={r.id} style={{ border: '1px solid #2a2a2a', borderRadius: 6, padding: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{r.name}</strong> {modeBadge(r.mode ?? 'DRAFT')}
              </div>
              <div style={{ fontSize: 12, color: '#999' }}>{r.description}</div>
              <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
                {r.confirms ?? 0} confirms / {r.overrides ?? 0} overrides — {' '}
                {r.agreement != null ? `${(r.agreement * 100).toFixed(0)}% agreement` : 'no data'}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                {r.mode === 'DRAFT' && (
                  <button type="button" onClick={() => promote(r.id, 'SHADOW')}
                          style={{ padding: '4px 10px', background: '#a80', color: '#fff', border: 0, borderRadius: 3 }}>
                    → SHADOW
                  </button>
                )}
                {r.mode === 'SHADOW' && (
                  <button type="button" onClick={() => promote(r.id, 'ACTIVE')}
                          style={{ padding: '4px 10px', background: '#0a4', color: '#fff', border: 0, borderRadius: 3 }}>
                    → ACTIVE
                  </button>
                )}
                {r.mode !== 'DRAFT' && (
                  <button type="button" onClick={() => demote(r.id)}
                          style={{ padding: '4px 10px', background: '#733', color: '#fff', border: 0, borderRadius: 3 }}>
                    Demote
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
