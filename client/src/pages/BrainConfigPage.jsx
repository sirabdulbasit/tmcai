import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import api from '../services/api';

const s = {
  wrapper: { height: '100vh', overflow: 'hidden', position: 'relative', background: '#111' },
  scrollArea: { height: '100%', overflowY: 'auto', paddingBottom: 60, scrollbarWidth: 'thin', scrollbarColor: '#333 transparent' },
  fadeHint: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 60, background: 'linear-gradient(transparent, #111)', pointerEvents: 'none', zIndex: 10, transition: 'opacity 0.3s' },
  page: { padding: '20px 24px', maxWidth: 900, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  btn: { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500, fontFamily: 'inherit' },
  btnPrimary: { background: '#cc6b4a', color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid #555', color: '#aaa' },
  btnSuccess: { background: '#4ade80', color: '#111' },
  tab: (active) => ({ padding: '8px 18px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 500, fontFamily: 'inherit', background: active ? '#cc6b4a' : 'transparent', color: active ? '#fff' : '#888', marginRight: 4 }),
  section: { background: '#1e1e1e', border: '1px solid #333', borderRadius: 10, padding: 20, marginBottom: 16 },
  sectionTitle: { fontSize: 15, fontWeight: 600, color: '#eee', marginBottom: 12 },
  sectionDesc: { fontSize: 12, color: '#888', marginBottom: 16 },
  input: { width: '100%', background: '#2a2a2a', border: '1px solid #444', color: '#eee', padding: '8px 12px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box' },
  textarea: { width: '100%', background: '#2a2a2a', border: '1px solid #444', color: '#eee', padding: '10px 14px', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', minHeight: 150, resize: 'vertical', lineHeight: 1.6 },
  label: { display: 'block', fontSize: 12, color: '#888', marginBottom: 4, marginTop: 14 },
  row: { display: 'flex', gap: 12, alignItems: 'flex-end' },
  ruleCard: { background: '#252525', border: '1px solid #333', borderRadius: 8, padding: 12, marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  badge: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 600, background: color + '22', color }),
  msg: (type) => ({ padding: '8px 14px', background: type === 'success' ? '#4ade8022' : '#25252', border: `1px solid ${type === 'success' ? '#4ade80' : '#444'}`, borderRadius: 8, marginBottom: 12, color: type === 'success' ? '#4ade80' : '#eee', fontSize: 13 }),
};

export default function BrainConfigPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('context');
  const [msg, setMsg] = useState('');
  const [atBottom, setAtBottom] = useState(false);

  function handleScroll(e) {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    setAtBottom(scrollHeight - scrollTop - clientHeight < 40);
  }

  // Local form state
  const [context, setContext] = useState('');
  const [automationLevel, setAutomationLevel] = useState('drafts_only');
  const [alertThresholds, setAlertThresholds] = useState({});
  const [briefingSections, setBriefingSections] = useState([]);
  const [briefingTime, setBriefingTime] = useState('08:30');
  const [briefingFormat, setBriefingFormat] = useState('detailed');

  useEffect(() => { loadConfig(); }, []);

  async function loadConfig() {
    try {
      const res = await api.get('/brain');
      const c = res.data.config;
      setConfig(c);
      setContext(c.masterContext || '');
      setAutomationLevel(c.automationLevel || 'drafts_only');
      setAlertThresholds(c.alertThresholds || {});
      const bc = c.briefingConfig || {};
      setBriefingSections(bc.sections || ['summary', 'critical_items', 'calendar', 'feed_digest', 'delegation_followup']);
      setBriefingTime(bc.deliveryTime || '08:30');
      setBriefingFormat(bc.format || 'detailed');
    } catch { }
    setLoading(false);
  }

  async function save(data) {
    setSaving(true);
    try {
      const res = await api.patch('/brain', data);
      setConfig(res.data.config);
      setMsg('Saved!');
      setTimeout(() => setMsg(''), 3000);
    } catch (err) {
      setMsg(err.response?.data?.error || 'Save failed');
    }
    setSaving(false);
  }

  // Engine state
  const [engineStatus, setEngineStatus] = useState(null);
  const [engineRunning, setEngineRunning] = useState(false);

  useEffect(() => { loadEngineStatus(); }, []);

  async function loadEngineStatus() {
    try { const r = await api.get('/brain/engine/status'); setEngineStatus(r.data); } catch {}
  }

  async function runEngineNow() {
    setEngineRunning(true);
    try {
      const r = await api.post('/brain/engine/run');
      setMsg(r.data.success ? `Engine completed in ${r.data.duration}ms — ${r.data.itemsScored} items scored` : r.data.error);
      loadEngineStatus();
    } catch (err) { setMsg(err.response?.data?.error || 'Engine failed'); }
    setEngineRunning(false);
  }

  const AUTOMATION_LEVELS = [
    { value: 'observe_only', label: 'Observe Only', desc: 'Just log decisions, no suggestions yet' },
    { value: 'drafts_only', label: 'Drafts Only (Default)', desc: 'AI suggests actions but never auto-executes' },
    { value: 'supervised', label: 'Supervised', desc: 'Confirmed patterns auto-execute, visible in briefing' },
    { value: 'full_auto', label: 'Full Auto', desc: 'High-confidence patterns run silently with monthly audit' },
  ];

  const ALL_BRIEFING_SECTIONS = [
    { id: 'summary', label: 'Summary', desc: 'Open items count, meeting count, key highlight' },
    { id: 'critical_items', label: 'Critical Items', desc: 'Must-act-today items with suggested actions' },
    { id: 'calendar', label: 'Calendar', desc: "Today's meetings with context and prep notes" },
    { id: 'feed_digest', label: 'Feed Digest', desc: 'Summary of WhatsApp/Chat/Email from last 24h' },
    { id: 'delegation_followup', label: 'Delegation Follow-up', desc: 'Stale delegations with chase messages' },
    { id: 'erp_snapshot', label: 'ERP Snapshot', desc: 'Cash position, AR/AP, budget variance' },
    { id: 'intelligence', label: 'Intelligence Feed', desc: 'Risks, opportunities, sentiment from org data' },
    { id: 'thought_prompts', label: 'Thought Prompts', desc: 'Reflection prompts based on patterns' },
  ];

  const THRESHOLD_FIELDS = [
    { key: 'overdueHours', label: 'Overdue Hours', desc: 'Hours before delegated item is stale', default: 48 },
    { key: 'followUpHours', label: 'Follow-up Timer', desc: 'Hours before auto follow-up reminder', default: 72 },
    { key: 'budgetVariancePct', label: 'Budget Variance %', desc: 'ERP budget overrun alert threshold', default: 10 },
    { key: 'arOverdueDays', label: 'AR Overdue Days', desc: 'Accounts receivable overdue alert', default: 60 },
    { key: 'revenueAlertPct', label: 'Revenue Alert %', desc: 'Below plan revenue alert', default: 85 },
    { key: 'cashRunwayDays', label: 'Cash Runway Days', desc: 'Minimum cash runway before critical', default: 30 },
    { key: 'okrCriticalPct', label: 'OKR Critical %', desc: 'Below this % OKR is critical', default: 50 },
    { key: 'okrAtRiskPct', label: 'OKR At-Risk %', desc: 'Below this % OKR is at-risk', default: 70 },
    { key: 'sentimentAlertDays', label: 'Sentiment Alert Days', desc: 'Days of negative sentiment before alert', default: 3 },
    { key: 'poApprovalHours', label: 'PO Approval Hours', desc: 'Unapproved PO age before alert', default: 72 },
  ];

  if (loading) return <div style={{ ...s.page, textAlign: 'center', color: '#666', paddingTop: 60 }}>Loading brain config...</div>;

  return (
    <div style={s.wrapper}>
      <div style={s.scrollArea} onScroll={handleScroll}>
      <div style={s.page}>
      <div style={s.header}>
        <div>
          <button style={{ ...s.btn, ...s.btnOutline, marginRight: 10 }} onClick={() => navigate('/')}>← Back to Chat</button>
          <span style={{ fontSize: 20, fontWeight: 700, color: '#eee' }}>My Brain</span>
          <span style={{ fontSize: 12, color: '#888', marginLeft: 12 }}>Personal AI Configuration</span>
        </div>
      </div>

      {msg && <div style={s.msg(msg === 'Saved!' ? 'success' : 'info')}>{msg}</div>}

      {/* Tabs */}
      <div style={{ marginBottom: 20 }}>
        {[
          { id: 'context', label: '🧠 My Context' },
          { id: 'briefing', label: '📋 Briefing' },
          { id: 'thresholds', label: '⚡ Alert Thresholds' },
          { id: 'automation', label: '🤖 Automation' },
          { id: 'engine', label: '⚙ Engine' },
        ].map(t => (
          <button key={t.id} style={s.tab(tab === t.id)} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Context Tab */}
      {tab === 'context' && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Master Context</div>
          <div style={s.sectionDesc}>
            Describe your role, responsibilities, team members, key relationships, and active projects.
            The AI uses this context to understand your world and make better suggestions.
          </div>
          <textarea
            style={s.textarea}
            value={context}
            onChange={e => setContext(e.target.value)}
            placeholder={`Example:\nI am the Managing Director of TMC. My team includes:\n- Salman (Finance) — handles invoices and payments\n- Mohsin (SAP Pre-sales) — technical queries\n- Saba (BD) — business development\n\nKey clients: ...\nActive projects: ...\nI personally handle: CXO emails, financial approvals, HR matters`}
          />
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <button style={{ ...s.btn, ...s.btnPrimary }} disabled={saving} onClick={() => save({ masterContext: context })}>
              {saving ? 'Saving...' : 'Save Context'}
            </button>
          </div>
        </div>
      )}

      {/* Briefing Tab */}
      {tab === 'briefing' && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Morning Briefing Configuration</div>
          <div style={s.sectionDesc}>Choose which sections appear in your daily briefing and when it's delivered.</div>

          <label style={s.label}>Briefing Sections</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {ALL_BRIEFING_SECTIONS.map(sec => (
              <label key={sec.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', padding: '6px 10px', background: briefingSections.includes(sec.id) ? '#2a2a2a' : 'transparent', borderRadius: 6 }}>
                <input
                  type="checkbox"
                  checked={briefingSections.includes(sec.id)}
                  onChange={() => {
                    setBriefingSections(prev =>
                      prev.includes(sec.id) ? prev.filter(s => s !== sec.id) : [...prev, sec.id]
                    );
                  }}
                />
                <div>
                  <div style={{ fontSize: 13, color: '#eee' }}>{sec.label}</div>
                  <div style={{ fontSize: 11, color: '#888' }}>{sec.desc}</div>
                </div>
              </label>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Delivery Time</label>
              <input style={s.input} type="time" value={briefingTime} onChange={e => setBriefingTime(e.target.value)} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={s.label}>Format</label>
              <select style={s.input} value={briefingFormat} onChange={e => setBriefingFormat(e.target.value)}>
                <option value="detailed">Detailed</option>
                <option value="summary">Summary</option>
                <option value="bullets">Bullet Points</option>
              </select>
            </div>
          </div>

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button style={{ ...s.btn, ...s.btnPrimary }} disabled={saving} onClick={() => save({ briefingConfig: { sections: briefingSections, deliveryTime: briefingTime, format: briefingFormat, channel: 'chat' } })}>
              {saving ? 'Saving...' : 'Save Briefing Config'}
            </button>
          </div>
        </div>
      )}

      {/* Thresholds Tab */}
      {tab === 'thresholds' && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Alert Thresholds</div>
          <div style={s.sectionDesc}>Configure when the AI should create alerts. These thresholds drive open item creation from ERP, delegation monitoring, and OKR tracking.</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {THRESHOLD_FIELDS.map(f => (
              <div key={f.key}>
                <label style={s.label}>{f.label}</label>
                <input
                  style={s.input}
                  type="number"
                  value={alertThresholds[f.key] ?? f.default}
                  onChange={e => setAlertThresholds({ ...alertThresholds, [f.key]: Number(e.target.value) })}
                />
                <div style={{ fontSize: 10, color: '#666', marginTop: 2 }}>{f.desc}</div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button style={{ ...s.btn, ...s.btnPrimary }} disabled={saving} onClick={() => save({ alertThresholds })}>
              {saving ? 'Saving...' : 'Save Thresholds'}
            </button>
          </div>
        </div>
      )}

      {/* Automation Tab */}
      {tab === 'automation' && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Automation Level</div>
          <div style={s.sectionDesc}>Control how much autonomy the AI has. Start with "Drafts Only" and gradually increase as you build trust.</div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {AUTOMATION_LEVELS.map(level => (
              <label key={level.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '12px 14px', background: automationLevel === level.value ? '#2a2a2a' : 'transparent', border: automationLevel === level.value ? '1px solid #cc6b4a' : '1px solid #333', borderRadius: 8 }}>
                <input
                  type="radio"
                  name="automationLevel"
                  checked={automationLevel === level.value}
                  onChange={() => setAutomationLevel(level.value)}
                  style={{ marginTop: 2 }}
                />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#eee' }}>{level.label}</div>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{level.desc}</div>
                </div>
              </label>
            ))}
          </div>

          <div style={{ marginTop: 16, textAlign: 'right' }}>
            <button style={{ ...s.btn, ...s.btnPrimary }} disabled={saving} onClick={() => save({ automationLevel })}>
              {saving ? 'Saving...' : 'Save Automation Level'}
            </button>
          </div>
        </div>
      )}

      {/* Engine Tab */}
      {tab === 'engine' && (
        <div style={s.section}>
          <div style={s.sectionTitle}>Brain Engine</div>
          <div style={s.sectionDesc}>
            The Brain Engine runs your intelligence pipeline — ingesting feeds, classifying items, scoring priorities, generating delegation messages. Configure when it runs, or trigger it manually.
          </div>

          {/* Status display */}
          <div style={{ background: '#252525', borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, color: '#888', marginBottom: 4 }}>Engine Status</div>
                <div style={{ fontSize: 16, fontWeight: 600, color: engineStatus?.running ? '#f59e0b' : '#4ade80' }}>
                  {engineStatus?.running ? '⟳ Running...' : '● Ready'}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 12, color: '#888' }}>
                  Last run: {engineStatus?.lastRun ? `${Math.round((Date.now() - new Date(engineStatus.lastRun).getTime()) / 3600000)}h ago` : 'Never'}
                </div>
                {engineStatus?.nextRun && (
                  <div style={{ fontSize: 12, color: '#888' }}>
                    Next run: in {Math.max(0, Math.round((new Date(engineStatus.nextRun).getTime() - Date.now()) / 3600000))}h
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Run now button */}
          <button
            style={{ ...s.btn, ...s.btnPrimary, padding: '10px 24px', fontSize: 14, width: '100%', marginBottom: 16, opacity: engineRunning ? 0.6 : 1 }}
            disabled={engineRunning}
            onClick={runEngineNow}
          >
            {engineRunning ? '⟳ Engine running — please wait...' : '⚡ Run Engine Now'}
          </button>

          {/* Schedule config */}
          <label style={s.label}>Engine Schedule</label>
          <select style={s.input} defaultValue={engineStatus?.schedule || ''} onChange={e => save({ engineSchedule: e.target.value || null })}>
            <option value="">On demand only (no automatic runs)</option>
            <option value="0 3 * * *">Daily at 3:00 AM</option>
            <option value="0 6 * * *">Daily at 6:00 AM</option>
            <option value="0 8 * * *">Daily at 8:00 AM</option>
            <option value="0 */6 * * *">Every 6 hours</option>
            <option value="0 */12 * * *">Every 12 hours</option>
          </select>
          <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>When the engine runs, it ingests all your connected feeds, classifies items, scores priorities, and generates delegation messages.</div>
        </div>
      )}
    </div>
    </div>
    <div style={{ ...s.fadeHint, opacity: atBottom ? 0 : 1 }} />
    </div>
  );
}
