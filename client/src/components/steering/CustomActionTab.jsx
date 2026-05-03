/**
 * CustomActionTab v2 — Probabilistic Shadowing management.
 * DRAFT → SHADOW → ACTIVE lifecycle with per-rule stats.
 */
import { useEffect, useState } from 'react';
import api from '../../services/api';
import { Button, Field, Input, Textarea, Select, Card, Pill, Empty } from '../ui';

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
    } catch (e) { setErr(e?.response?.data?.error ?? e.message); }
    finally { setLoading(false); }
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
    } catch (e) { setErr(e?.response?.data?.error ?? e.message); }
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

  const badgeFor = (mode) => {
    const m = (mode ?? 'DRAFT').toUpperCase();
    if (m === 'ACTIVE') return <Pill variant="success">{m}</Pill>;
    if (m === 'SHADOW') return <Pill variant="warning">{m}</Pill>;
    if (m === 'FROZEN') return <Pill variant="danger">{m}</Pill>;
    return <Pill>{m}</Pill>;
  };

  return (
    <div style={{ padding: 'var(--s-6)', display: 'flex', flexDirection: 'column', gap: 'var(--s-5)' }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>Custom Actions</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: 'var(--s-2)', maxWidth: 640 }}>
          New rules start <Pill>DRAFT</Pill>. After 30 days of shadow data with ≥95% agreement, promote to <Pill variant="warning">SHADOW</Pill>. At 98% promote to <Pill variant="success">ACTIVE</Pill>.
        </p>
      </div>

      {err && <Card style={{ background: 'var(--danger-dim)', borderColor: 'var(--danger)', color: 'var(--danger)' }}>{err}</Card>}

      <Card>
        <h3 style={{ margin: 0, marginBottom: 'var(--s-4)' }}>Create rule</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--s-3)' }}>
          <Field label="Name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Archetype">
            <Select value={form.archetype} onChange={(e) => setForm({ ...form, archetype: e.target.value })}>
              <option>reply_needed</option><option>delegate</option><option>inform_only</option>
              <option>schedule_meeting</option><option>review_risk</option><option>acknowledge</option>
            </Select>
          </Field>
          <Field label="Trigger condition (JSON)" className="ui-field" style={{ gridColumn: 'span 2' }}>
            <Textarea rows={4} value={form.triggerConditionJson} onChange={(e) => setForm({ ...form, triggerConditionJson: e.target.value })} />
          </Field>
          <Field label="Action"><Input value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} /></Field>
          <Field label="Description"><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
        </div>
        <Button variant="primary" onClick={submit} disabled={!form.name}>Create DRAFT</Button>
      </Card>

      <div>
        <h3 style={{ margin: 0, marginBottom: 'var(--s-3)' }}>Existing rules</h3>
        {loading && <div style={{ color: 'var(--text-muted)' }}>Loading…</div>}
        {!loading && rules.length === 0 && <Empty title="No rules yet">Create a DRAFT above; it will appear here with its agreement stats as evidence accumulates.</Empty>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>
          {rules.map((r) => (
            <Card key={r.id} size="sm">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 'var(--s-3)', alignItems: 'center' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
                    <strong>{r.name}</strong>
                    {badgeFor(r.mode)}
                  </div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 4 }}>{r.description}</div>
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 4 }}>
                    {r.confirms ?? 0} confirms · {r.overrides ?? 0} overrides · {r.agreement != null ? `${(r.agreement * 100).toFixed(0)}% agreement` : 'no data'}
                  </div>
                </div>
                {r.mode === 'DRAFT' && <Button variant="secondary" size="sm" onClick={() => promote(r.id, 'SHADOW')}>→ SHADOW</Button>}
                {r.mode === 'SHADOW' && <Button variant="primary" size="sm" onClick={() => promote(r.id, 'ACTIVE')}>→ ACTIVE</Button>}
                {r.mode && r.mode !== 'DRAFT' && <Button variant="danger" size="sm" onClick={() => demote(r.id)}>Demote</Button>}
                <Button variant="ghost" size="sm">⋯</Button>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
