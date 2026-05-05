/**
 * My Rules — every place the user steers Brain:
 *
 *   Standing Instructions — typed natural-language rules (the 6th MyOS layer)
 *   Patterns              — shadow_rules Brain has learned (DRAFT/SHADOW/ACTIVE/FROZEN)
 *   Risk Radar            — predicate rules driving the daily risk surface
 *   Decisions             — every decision_log row (audit + filter + supersede)
 *   Delegations           — every delegation_log row (audit + filter)
 *   Compose Hints         — legacy free-text prompts (deprecated → Standing Instructions)
 */
import { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { Card, Pill, Button, Empty } from '../components/ui';
import { Icon } from '../components/ui/Icon';
import DelegateePicker from '../components/DelegateePicker';

const ACTION_OPTIONS = [
  { v: 'dismissed', l: 'Archive / Ignore' },
  { v: 'approved',  l: 'Draft reply' },
  { v: 'delegated', l: 'Delegate to…' },
  { v: 'snoozed',   l: 'Add to Open Items' },
];

// Tab order reflects the user-steering hierarchy: explicit instructions first,
// then learned patterns, then the risk surface they drive, then the audit
// trails. "Compose Hints" sits last because it's the legacy free-text
// equivalent of Standing Instructions and is being phased out.
const TABS = [
  { id: 'standing',    label: 'Standing Instructions' },
  { id: 'overlay',     label: 'Learned Preferences' },
  { id: 'patterns',    label: 'Patterns' },
  { id: 'risk-radar',  label: 'Risk Radar' },
  { id: 'decisions',   label: 'Decisions' },
  { id: 'delegations', label: 'Delegations' },
  { id: 'prompts',     label: 'Compose Hints' },
];

export default function MyRulesPage() {
  // Default to Standing Instructions — the surface the user reaches for most
  // when steering Brain. URL ?subtab=… preserves cross-link from Day Brief.
  const [tab, setTab] = useState(() => {
    if (typeof window === 'undefined') return 'standing';
    const q = new URLSearchParams(window.location.search).get('subtab');
    return TABS.some((t) => t.id === q) ? q : 'standing';
  });
  // Compose Hints is deprecated. Hide the tab unless this user actually
  // has legacy hints to manage. Once empty, the tab disappears entirely
  // and the only place rules can be added is Standing Instructions.
  const [hasPrompts, setHasPrompts] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.get('/brief/prompts')
      .then((r) => { if (!cancelled) setHasPrompts((r.data?.prompts ?? []).length > 0); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  // If the user lands on the prompts tab via URL but has no hints,
  // bounce to Standing Instructions so the empty tab isn't the default.
  useEffect(() => {
    if (tab === 'prompts' && !hasPrompts) {
      // Don't auto-bounce — user might be on prompts to clean up. We
      // only filter the visible tabs; selection stays valid.
    }
  }, [tab, hasPrompts]);

  const visibleTabs = TABS.filter((t) => t.id !== 'prompts' || hasPrompts);

  const select = (id) => {
    setTab(id);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.set('subtab', id);
      window.history.replaceState({}, '', url);
    }
  };

  return (
    <div style={{ padding: 'var(--s-6) var(--s-8)', maxWidth: 1400 }}>
      <header style={{ marginBottom: 'var(--s-4)' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-2xl)' }}>My Rules</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', margin: '4px 0 0' }}>
          The instructions you've given, what Brain has learned, the risk
          surface they drive, and every action that's been taken.
        </p>
      </header>

      <div style={{ display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-3)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => select(t.id)}
            style={{
              background: 'transparent', border: 0, cursor: 'pointer',
              padding: '8px 12px', fontSize: 'var(--fs-sm)',
              borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === t.id ? 'var(--accent)' : 'var(--text-muted)',
              textTransform: 'uppercase', letterSpacing: '.5px',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'standing'    && <StandingInstructionsTab />}
      {tab === 'overlay'     && <LearnedPreferencesTab />}
      {tab === 'patterns'    && <PatternsTab />}
      {tab === 'risk-radar'  && <RiskRadarTab />}
      {tab === 'decisions'   && <DecisionsTab />}
      {tab === 'delegations' && <DelegationsTab />}
      {tab === 'prompts'     && <PromptsTab />}
    </div>
  );
}

// ─── Patterns (shadow_rules) ──────────────────────────────────

const MODES = ['DRAFT', 'SHADOW', 'ACTIVE', 'FROZEN'];

function PatternsTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/brief/rules');
      setRules(data.rules ?? []);
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const grouped = MODES.reduce((a, m) => ({ ...a, [m]: rules.filter((r) => r.mode === m) }), {});

  return (
    <>
      <Refresh onClick={load} loading={loading} />
      {!loading && rules.length === 0 && (
        <Empty title="No patterns yet">
          Brain learns from your clicks in <em>My Attention</em>. Once a decision repeats enough times, it'll appear here.
        </Empty>
      )}
      {MODES.map((m) => grouped[m].length > 0 && (
        <ModeSection key={m} mode={m} count={grouped[m].length}>
          {grouped[m].map((r) => <RuleRow key={r.id} rule={r} onChange={load} />)}
        </ModeSection>
      ))}
    </>
  );
}

function ModeSection({ mode, count, children }) {
  const notes = {
    DRAFT:  { v: undefined,   t: 'Observing — not enough evidence yet.' },
    SHADOW: { v: 'accent',    t: 'Ready to activate when you trust it.' },
    ACTIVE: { v: 'success',   t: 'Brain acts on these without asking.' },
    FROZEN: { v: 'warning',   t: "Paused — Brain won't act until unfrozen." },
  }[mode];
  return (
    <section style={{ marginBottom: 'var(--s-5)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-2)', marginBottom: 'var(--s-2)' }}>
        <h3 style={{ fontSize: 'var(--fs-md)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)', margin: 0 }}>{mode}</h3>
        <Pill variant={notes.v}>{count}</Pill>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>{notes.t}</span>
      </div>
      {children}
    </section>
  );
}

function RuleRow({ rule, onChange }) {
  const [busy, setBusy] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [pickAction, setPickAction] = useState(rule.action);
  const [delegatee, setDelegatee] = useState(null);       // { userId?, email, name }
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(null);

  const call = async (fn) => { setBusy(true); try { await fn(); onChange(); } catch {} finally { setBusy(false); } };

  const saveEdit = async () => {
    if (pickAction === 'delegated' && !delegatee) { setPickerOpen(true); return; }
    setBusy(true);
    try {
      await api.put(`/brief/rules/${rule.id}`, {
        action: pickAction,
        delegateeUserId: delegatee?.userId,
        delegateeEmail:  delegatee?.email,
        delegateeName:   delegatee?.name,
      });
      setEditOpen(false);
      onChange();
    } catch (e) { setError(e?.response?.data?.error ?? 'Failed'); }
    finally { setBusy(false); }
  };

  const userOverridden = rule.metadata?.userOverride ?? (rule.description ?? '').startsWith('MD set');
  const tc = rule.triggerCondition ?? {};

  return (
    <Card size="sm" style={{ marginBottom: 'var(--s-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 'var(--fw-medium)' }}>{rule.name}</span>
            {userOverridden && <Pill variant="accent">manual</Pill>}
          </div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
            Action: <strong>{rule.action}</strong> · Evidence: {rule.evidence ?? 0} · Agreement: {Math.round((rule.agreement ?? 0) * 100)}%{rule.archetype && ` · ${rule.archetype.replace('_', ' ')}`}
          </div>
          {rule.description && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>{rule.description}</div>}
          {rule.frozenReason && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--warning)', marginTop: 2 }}>Frozen: {rule.frozenReason}</div>}
        </div>
        <div style={{ display: 'flex', gap: 'var(--s-2)' }}>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditOpen((x) => !x)}>
            {editOpen ? 'Cancel' : 'Edit action'}
          </Button>
          {rule.mode === 'ACTIVE' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => call(() => api.post(`/brief/rules/${rule.id}/freeze`))}>Freeze</Button>}
          {rule.mode === 'FROZEN' && <Button variant="primary" size="sm" disabled={busy} onClick={() => call(() => api.post(`/brief/rules/${rule.id}/unfreeze`))}>Unfreeze</Button>}
          {rule.mode === 'SHADOW' && <Button variant="primary" size="sm" disabled={busy} onClick={() => call(() => api.post(`/shadow/rules/${rule.id}/promote`, { targetMode: 'ACTIVE' }))}>Activate</Button>}
          {confirmDelete ? (
            <>
              <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Delete permanently?</span>
              <Button variant="danger" size="sm" disabled={busy} onClick={() => {
                call(() => api.delete(`/brief/rules/${rule.id}`));
                setConfirmDelete(false);
              }}>Yes, delete</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete</Button>
          )}
        </div>
      </div>
      {error && (
        <div style={{
          marginTop: 6, padding: '6px 10px',
          fontSize: 'var(--fs-xs)', color: '#ef4444',
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 'var(--r-sm)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}>
          <span>✗ {error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {editOpen && (
        <div style={{ marginTop: 'var(--s-3)', padding: 'var(--s-3)', background: 'var(--bg-2)', borderRadius: 'var(--r-sm)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginBottom: 6 }}>
            Change what Brain does when this pattern matches. Locks the action — miner stops overriding it.
          </div>
          <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', flexWrap: 'wrap' }}>
            <select
              value={pickAction}
              onChange={(e) => { setPickAction(e.target.value); setDelegatee(null); }}
              style={{ padding: '6px 10px', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}
            >
              {ACTION_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
            </select>
            {pickAction === 'delegated' && (
              <button
                onClick={() => setPickerOpen(true)}
                style={{ padding: '6px 10px', background: 'var(--bg-1)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)', cursor: 'pointer' }}
              >
                {delegatee ? `→ ${delegatee.name ?? delegatee.email}` : 'Pick delegatee…'}
              </button>
            )}
            <div style={{ flex: 1 }} />
            <Button variant="primary" size="sm" disabled={busy} onClick={saveEdit}>Save</Button>
          </div>
          <DelegateePicker
            open={pickerOpen}
            context={{ itemType: tc.itemType, archetype: tc.archetype, senderDomain: tc.senderDomain }}
            onCancel={() => setPickerOpen(false)}
            onPick={(who) => { setDelegatee(who); setPickerOpen(false); }}
          />
        </div>
      )}
    </Card>
  );
}

// ─── Decisions (decision_logs with filters) ────────────────────

function DecisionsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ itemType: '', action: '', q: '', since: sinceDays(7), source: 'mine' });
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [rowError, setRowError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (f.itemType) p.set('itemType', f.itemType);
      if (f.action)   p.set('action', f.action);
      if (f.q)        p.set('q', f.q);
      if (f.since)    p.set('since', f.since);
      if (f.source)   p.set('source', f.source);
      const { data } = await api.get(`/brief/decisions?${p.toString()}`);
      setRows(data.decisions ?? []);
    } finally { setLoading(false); }
  }, [f.itemType, f.action, f.q, f.since, f.source]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <FilterBar>
        <Select value={f.source} onChange={(v) => setF({ ...f, source: v })} options={[{ v: 'mine', l: 'Mine' }, { v: 'brain', l: "Brain's" }, { v: 'all', l: 'All' }]} />
        <Select value={f.itemType} onChange={(v) => setF({ ...f, itemType: v })} options={['', 'email', 'whatsapp', 'task', 'meeting']} placeholder="All types" />
        <Select value={f.action} onChange={(v) => setF({ ...f, action: v })} options={['', 'draft_reply', 'delegate', 'add_open_item', 'ignore', 'acknowledge']} placeholder="All actions" />
        <Select value={f.since} onChange={(v) => setF({ ...f, since: v })} options={[{ v: sinceDays(1), l: 'Today' }, { v: sinceDays(7), l: 'Last 7 days' }, { v: sinceDays(30), l: 'Last 30 days' }, { v: '', l: 'All time' }]} />
        <Search value={f.q} onChange={(v) => setF({ ...f, q: v })} placeholder="Search subject / action" />
      </FilterBar>

      <DangerZone
        label="Delete all"
        count={rows.length}
        confirmPhrase="DELETE ALL MY DECISIONS"
        explainer={`Permanently removes ${rows.length} decision log${rows.length === 1 ? '' : 's'} matching these filters. Brain will forget any learning based on them — patterns may regress to DRAFT. This cannot be undone.`}
        onConfirm={async () => {
          await api.post('/brief/decisions/delete-all', {
            confirmPhrase: 'DELETE ALL MY DECISIONS',
            source: f.source,
            since: f.since || undefined,
          });
          load();
        }}
      />

      {loading && rows.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> :
       rows.length === 0 ? <Empty title="No matches">Adjust filters or try a wider date range.</Empty> :
        rows.map((d) => (
          <Card key={d.id} size="sm" style={{ marginBottom: 'var(--s-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
              <Pill>{d.itemType}</Pill>
              <Pill variant={d.userDecision === 'dismissed' ? undefined : d.userDecision === 'delegated' ? 'accent' : 'success'}>{d.userDecision}</Pill>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>
                  {d.outputSummary || d.inputSummary || d.actionTaken || '(no summary)'}
                </div>
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
                  {new Date(d.createdAt).toLocaleString()}{d.dedupHash && ` · hash ${d.dedupHash.slice(0, 8)}`}{d.overrideReason && ` · override: ${d.overrideReason}`}
                </div>
              </div>
              {confirmDeleteId === d.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    Delete decision log? Brain loses 1 evidence point.
                  </span>
                  <Button
                    variant="danger" size="sm"
                    disabled={deletingId === d.id}
                    onClick={async () => {
                      setDeletingId(d.id);
                      try {
                        await api.delete(`/brief/decisions/${d.id}`, { data: { confirm: true } });
                        setConfirmDeleteId(null);
                        load();
                      } catch (e) {
                        setRowError({ id: d.id, message: e?.response?.data?.error ?? 'Failed to delete' });
                      } finally {
                        setDeletingId(null);
                      }
                    }}
                  >{deletingId === d.id ? 'Deleting…' : 'Yes, delete'}</Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(d.id)}>Delete</Button>
              )}
            </div>
            {rowError?.id === d.id && (
              <div style={{
                marginTop: 6, padding: '6px 10px',
                fontSize: 'var(--fs-xs)', color: '#ef4444',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 'var(--r-sm)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
              }}>
                <span>✗ {rowError.message}</span>
                <button
                  onClick={() => setRowError(null)}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                  aria-label="Dismiss"
                >×</button>
              </div>
            )}
          </Card>
        ))}
    </>
  );
}

// ─── Delegations (delegation_logs with filters) ────────────────

function DelegationsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [f, setF] = useState({ delegatee: '', itemType: '', q: '', since: sinceDays(30), source: 'mine' });
  // Inline-confirm state for per-row deletes — no browser dialogs.
  // Tracks which row's "Delete" was clicked once; second click confirms.
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [rowError, setRowError] = useState(null); // { id, message }
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams();
      if (f.delegatee) p.set('delegatee', f.delegatee);
      if (f.itemType)  p.set('itemType', f.itemType);
      if (f.q)         p.set('q', f.q);
      if (f.since)     p.set('since', f.since);
      if (f.source)    p.set('source', f.source);
      const { data } = await api.get(`/brief/delegations?${p.toString()}`);
      setRows(data.delegations ?? []);
    } finally { setLoading(false); }
  }, [f.delegatee, f.itemType, f.q, f.since, f.source]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <FilterBar>
        <Select value={f.source} onChange={(v) => setF({ ...f, source: v })} options={[{ v: 'mine', l: 'Mine' }, { v: 'brain', l: "Brain's autonomous" }, { v: 'all', l: 'All' }]} />
        <Search value={f.delegatee} onChange={(v) => setF({ ...f, delegatee: v })} placeholder="Delegatee name or email" />
        <Select value={f.itemType} onChange={(v) => setF({ ...f, itemType: v })} options={['', 'email', 'whatsapp', 'task']} placeholder="All types" />
        <Select value={f.since} onChange={(v) => setF({ ...f, since: v })} options={[{ v: sinceDays(7), l: 'Last 7 days' }, { v: sinceDays(30), l: 'Last 30 days' }, { v: sinceDays(90), l: 'Last 90 days' }, { v: '', l: 'All time' }]} />
        <Search value={f.q} onChange={(v) => setF({ ...f, q: v })} placeholder="Subject / sender" />
      </FilterBar>

      <DangerZone
        label="Delete all"
        count={rows.length}
        confirmPhrase="DELETE ALL MY DELEGATIONS"
        explainer={`Permanently removes ${rows.length} delegation record${rows.length === 1 ? '' : 's'} matching these filters. Brain will forget the delegatee patterns learned from them. This cannot be undone.`}
        onConfirm={async () => {
          await api.post('/brief/delegations/delete-all', {
            confirmPhrase: 'DELETE ALL MY DELEGATIONS',
            source: f.source,
            since: f.since || undefined,
          });
          load();
        }}
      />

      {loading && rows.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> :
       rows.length === 0 ? <Empty title="No matches">Nothing delegated matching those filters.</Empty> :
        rows.map((d) => (
          <Card key={d.id} size="sm" style={{ marginBottom: 'var(--s-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
              <Pill>{d.itemType}</Pill>
              {d.delegatedBy === 'brain' && <Pill variant="success">auto</Pill>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--fs-sm)' }}>
                  <strong>{d.delegateeName ?? d.delegateeEmail}</strong>
                  {d.taskArchetype && <span style={{ color: 'var(--text-dim)' }}> · {d.taskArchetype.replace('_', ' ')}</span>}
                </div>
                {d.subject && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2 }}>{d.subject}</div>}
                {d.briefNote && <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2, fontStyle: 'italic' }}>"{d.briefNote}"</div>}
                <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)', marginTop: 2 }}>
                  {new Date(d.createdAt).toLocaleString()} {d.senderEmail && ` · from ${d.senderEmail}`}
                </div>
              </div>
              {confirmDeleteId === d.id ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
                    Confirm delete? Brain will lose 1 frequency point.
                  </span>
                  <Button
                    variant="danger" size="sm"
                    disabled={deletingId === d.id}
                    onClick={async () => {
                      setDeletingId(d.id);
                      try {
                        await api.delete(`/brief/delegations/${d.id}`, { data: { confirm: true } });
                        setConfirmDeleteId(null);
                        load();
                      } catch (e) {
                        setRowError({ id: d.id, message: e?.response?.data?.error ?? 'Failed to delete' });
                      } finally {
                        setDeletingId(null);
                      }
                    }}
                  >{deletingId === d.id ? 'Deleting…' : 'Yes, delete'}</Button>
                  <Button
                    variant="ghost" size="sm"
                    onClick={() => setConfirmDeleteId(null)}
                  >Cancel</Button>
                </div>
              ) : (
                <Button
                  variant="ghost" size="sm"
                  onClick={() => setConfirmDeleteId(d.id)}
                >Delete</Button>
              )}
            </div>
            {rowError?.id === d.id && (
              <div style={{
                marginTop: 6,
                padding: '6px 10px',
                fontSize: 'var(--fs-xs)',
                color: '#ef4444',
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.3)',
                borderRadius: 'var(--r-sm)',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
              }}>
                <span>✗ {rowError.message}</span>
                <button
                  onClick={() => setRowError(null)}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                  aria-label="Dismiss"
                >×</button>
              </div>
            )}
          </Card>
        ))}
    </>
  );
}

// ─── DangerZone ─────────────────────────────────────────────────
// Collapsible strip above the list showing a big red "Delete all" button
// guarded by an exact-phrase typed confirmation. MD has to type
// "DELETE ALL MY DECISIONS" (or DELEGATIONS) character-for-character.
function DangerZone({ label, count, confirmPhrase, explainer, onConfirm }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (count === 0) return null;

  return (
    <div style={{
      marginBottom: 'var(--s-3)',
      padding: '8px 12px',
      background: open ? 'var(--danger-dim, rgba(239,68,68,0.08))' : 'var(--bg-2)',
      border: '1px solid ' + (open ? 'var(--danger, #ef4444)' : 'var(--border)'),
      borderRadius: 'var(--r-md)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)' }}>
        <Icon name="alert-triangle" size={14} color={open ? 'var(--danger)' : 'var(--text-dim)'} />
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-dim)' }}>Danger zone</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => { setOpen((x) => !x); setTyped(''); }}
          style={{
            background: 'transparent', border: 0, color: open ? 'var(--danger)' : 'var(--text-muted)',
            fontSize: 'var(--fs-xs)', cursor: 'pointer', textDecoration: 'underline',
          }}
        >
          {open ? 'Cancel' : `${label} (${count})`}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 10, fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>
          <div style={{ marginBottom: 6 }}>{explainer}</div>
          <div style={{ marginBottom: 6 }}>
            To confirm, type <strong style={{ color: 'var(--danger)' }}>{confirmPhrase}</strong> below:
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmPhrase}
              style={{
                flex: 1, padding: '6px 10px',
                background: 'var(--bg-1)', border: '1px solid var(--border)',
                borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)',
              }}
            />
            <button
              onClick={async () => {
                if (typed !== confirmPhrase) return;
                setBusy(true);
                try { await onConfirm(); setError(null); } catch (e) { setError(e?.response?.data?.error ?? 'Failed'); }
                finally { setBusy(false); setOpen(false); setTyped(''); }
              }}
              disabled={typed !== confirmPhrase || busy}
              style={{
                padding: '6px 14px', borderRadius: 'var(--r-sm)',
                background: typed === confirmPhrase && !busy ? 'var(--danger)' : 'var(--bg-2)',
                color: typed === confirmPhrase && !busy ? '#fff' : 'var(--text-dim)',
                border: 0, cursor: typed === confirmPhrase && !busy ? 'pointer' : 'not-allowed',
                fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-medium)',
              }}
            >
              {busy ? 'Deleting…' : 'Delete all'}
            </button>
          </div>
          {error && (
            <div style={{
              marginTop: 8, padding: '6px 10px',
              fontSize: 'var(--fs-xs)', color: '#ef4444',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 'var(--r-sm)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
            }}>
              <span>✗ {error}</span>
              <button
                onClick={() => setError(null)}
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                aria-label="Dismiss"
              >×</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Prompts (user-authored) ───────────────────────────────────

const SCOPES = [
  { v: 'global',      l: 'Global — applies everywhere' },
  { v: 'triage',      l: 'Triage — when Brain classifies new items' },
  { v: 'draft_reply', l: 'Draft replies' },
  { v: 'delegation',  l: 'Delegations — forward cover notes' },
];

// ─── LearnedPreferencesTab ──────────────────────────────────────────
// Shows the per-user prompt overlay: rules Brain has auto-promoted from
// repeated 👎 diagnoses + any rules the user added by hand. Each rule is
// editable, can be toggled off (still stored, just not injected into
// prompts), and the whole list can be reset. The overlay is what Brain
// reads on EVERY chat answer / draft after a rule is created — see
// brainComposer.ts and userPromptOverlayService.ts.
function LearnedPreferencesTab() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [editing, setEditing] = useState(null); // { id?, ruleText }
  const [showAdd, setShowAdd] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/brain/overlay');
      setRules(r.data?.rules ?? []);
    } catch (e) {
      setError(e?.response?.data?.error ?? 'Could not load preferences');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const toggleActive = async (rule) => {
    setBusyId(rule.id);
    try {
      await api.patch(`/brain/overlay/${rule.id}`, { active: !rule.active });
      await load();
    } catch (e) { setError(e?.response?.data?.error ?? 'Update failed'); }
    finally { setBusyId(null); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const text = (editing.ruleText ?? '').trim();
    if (text.length < 6) { setError('Rule too short (minimum 6 characters)'); return; }
    setBusyId(editing.id ?? 'new');
    try {
      if (editing.id) {
        await api.patch(`/brain/overlay/${editing.id}`, { ruleText: text });
      } else {
        await api.post('/brain/overlay', { ruleText: text, category: 'custom' });
      }
      setEditing(null); setShowAdd(false);
      await load();
    } catch (e) { setError(e?.response?.data?.error ?? 'Save failed'); }
    finally { setBusyId(null); }
  };

  const deleteRule = async (id) => {
    setBusyId(id);
    try {
      await api.delete(`/brain/overlay/${id}`);
      await load();
    } catch (e) { setError(e?.response?.data?.error ?? 'Delete failed'); }
    finally { setBusyId(null); }
  };

  const resetAll = async () => {
    setBusyId('reset');
    try {
      await api.post('/brain/overlay/reset', {});
      setResetConfirm(false);
      await load();
    } catch (e) { setError(e?.response?.data?.error ?? 'Reset failed'); }
    finally { setBusyId(null); }
  };

  const sourceLabel = (s) => s === 'feedback_diagnosis' ? '🤖 Auto from 👎' : s === 'manual' ? '✍️ Manual' : 'Seed';
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <div style={{ padding: '0 4px' }}>
      <div style={{
        background: 'rgba(99,102,241,0.08)',
        border: '1px solid rgba(99,102,241,0.3)',
        borderRadius: 8, padding: 12, marginBottom: 16,
        fontSize: 13, color: 'var(--text)', lineHeight: 1.5,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>What is this?</div>
        Rules Brain has learned about how you want it to answer. These get
        prepended to every chat answer and draft. Auto-promoted when 👎
        feedback shows the same problem twice within 14 days; you can also
        add rules by hand. Toggle off to silence a rule without losing it,
        or delete to remove permanently.
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', marginBottom: 12,
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)',
          borderRadius: 6, color: '#fca5a5', fontSize: 13,
        }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => { setShowAdd(true); setEditing({ ruleText: '' }); }}
          style={{
            padding: '6px 14px', borderRadius: 6, border: '1px solid var(--accent)',
            background: 'var(--accent)', color: '#fff',
            cursor: 'pointer', fontSize: 13, fontWeight: 600,
          }}
        >+ Add rule</button>
        <div style={{ flex: 1 }} />
        {rules.length > 0 && (
          <button
            type="button"
            onClick={() => setResetConfirm(true)}
            disabled={busyId === 'reset'}
            style={{
              padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)',
              background: 'transparent', color: 'var(--text-muted)',
              cursor: 'pointer', fontSize: 13,
            }}
          >Reset all</button>
        )}
      </div>

      {showAdd && editing && !editing.id && (
        <div style={{
          padding: 12, marginBottom: 16,
          background: 'var(--bg-2)', border: '1px solid var(--border)',
          borderRadius: 8,
        }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>New rule (one line directive — what should Brain do differently?)</div>
          <textarea
            value={editing.ruleText}
            onChange={(e) => setEditing({ ...editing, ruleText: e.target.value.slice(0, 240) })}
            placeholder="e.g. Keep answers tight — prefer 2-3 sentences for casual questions."
            rows={2}
            style={{
              width: '100%', boxSizing: 'border-box',
              fontSize: 13, padding: 8,
              background: 'var(--bg-1)', border: '1px solid var(--border)',
              borderRadius: 6, color: 'var(--text)', resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button
              type="button" onClick={saveEdit}
              disabled={busyId === 'new'}
              style={{
                padding: '6px 14px', borderRadius: 6, border: '1px solid var(--accent)',
                background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
              }}
            >{busyId === 'new' ? 'Saving…' : 'Save'}</button>
            <button
              type="button" onClick={() => { setShowAdd(false); setEditing(null); }}
              style={{
                padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 13,
              }}
            >Cancel</button>
          </div>
        </div>
      )}

      {resetConfirm && (
        <div style={{
          padding: 12, marginBottom: 16,
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.4)',
          borderRadius: 8, fontSize: 13, color: 'var(--text)',
          display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        }}>
          <div style={{ flex: 1 }}>
            Delete all {rules.length} learned preference{rules.length === 1 ? '' : 's'}? Brain will start fresh and re-learn from new feedback.
          </div>
          <button
            type="button" onClick={resetAll} disabled={busyId === 'reset'}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #f59e0b', background: '#f59e0b', color: '#000', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
          >{busyId === 'reset' ? 'Resetting…' : 'Yes, reset'}</button>
          <button
            type="button" onClick={() => setResetConfirm(false)}
            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}
          >Cancel</button>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--text-muted)' }}>Loading…</div>
      ) : rules.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: 40,
          color: 'var(--text-muted)', fontSize: 13,
          background: 'var(--bg-2)', borderRadius: 8, border: '1px dashed var(--border)',
        }}>
          No learned preferences yet. Brain auto-creates these from repeated 👎 feedback, or you can add one above.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rules.map((r) => (
            <div key={r.id} style={{
              padding: 12, background: 'var(--bg-2)',
              border: '1px solid var(--border)', borderRadius: 8,
              opacity: r.active ? 1 : 0.55,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  {editing?.id === r.id ? (
                    <textarea
                      value={editing.ruleText}
                      onChange={(e) => setEditing({ ...editing, ruleText: e.target.value.slice(0, 240) })}
                      rows={2}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        fontSize: 13, padding: 8,
                        background: 'var(--bg-1)', border: '1px solid var(--border)',
                        borderRadius: 6, color: 'var(--text)', resize: 'vertical',
                      }}
                    />
                  ) : (
                    <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.4 }}>{r.ruleText}</div>
                  )}
                  <div style={{
                    fontSize: 11, color: 'var(--text-muted)',
                    marginTop: 6, display: 'flex', gap: 12, flexWrap: 'wrap',
                  }}>
                    <span>{sourceLabel(r.source)}</span>
                    <span>{r.category}</span>
                    <span>added {fmtDate(r.createdAt)}</span>
                    {r.hitsCount > 0 && (
                      <span>used in {r.hitsCount} {r.hitsCount === 1 ? 'turn' : 'turns'}</span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {editing?.id === r.id ? (
                    <>
                      <button
                        type="button" onClick={saveEdit} disabled={busyId === r.id}
                        style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid var(--accent)', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                      >Save</button>
                      <button
                        type="button" onClick={() => setEditing(null)}
                        style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}
                      >Cancel</button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button" onClick={() => toggleActive(r)} disabled={busyId === r.id}
                        title={r.active ? 'Click to disable (Brain stops using this rule)' : 'Click to re-enable'}
                        style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)', background: r.active ? 'rgba(74,222,128,0.15)' : 'transparent', color: r.active ? '#4ade80' : 'var(--text-muted)', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}
                      >{r.active ? 'Active' : 'Inactive'}</button>
                      <button
                        type="button" onClick={() => setEditing({ id: r.id, ruleText: r.ruleText })}
                        style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 11 }}
                      >Edit</button>
                      <button
                        type="button" onClick={() => deleteRule(r.id)} disabled={busyId === r.id}
                        style={{ padding: '4px 10px', borderRadius: 4, border: '1px solid rgba(239,68,68,0.3)', background: 'transparent', color: '#fca5a5', cursor: 'pointer', fontSize: 11 }}
                      >Delete</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PromptsTab() {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null); // { id?, text, scope, isActive }
  const [loading, setLoading] = useState(true);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [saveError, setSaveError] = useState(null);

  const load = async () => {
    setLoading(true);
    try { const { data } = await api.get('/brief/prompts'); setRows(data.prompts ?? []); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!editing) return;
    const body = { text: editing.text, scope: editing.scope, isActive: editing.isActive };
    try {
      if (editing.id) await api.put(`/brief/prompts/${editing.id}`, body);
      else await api.post('/brief/prompts', body);
      setEditing(null);
      setSaveError(null);
      load();
    } catch (e) { setSaveError(e?.response?.data?.error ?? 'Failed to save'); }
  };

  const toggle = async (row) => {
    await api.put(`/brief/prompts/${row.id}`, { isActive: !row.isActive });
    load();
  };

  const remove = async (row) => {
    await api.delete(`/brief/prompts/${row.id}`);
    setConfirmDeleteId(null);
    load();
  };

  return (
    <>
      <div style={{
        marginBottom: 'var(--s-3)', padding: '10px 12px',
        background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.45)',
        borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)', color: 'var(--text)',
        display: 'flex', alignItems: 'flex-start', gap: 8,
      }}>
        <Icon name="alert-triangle" size={14} color="#f59e0b" />
        <div style={{ flex: 1 }}>
          <strong>Compose Hints is being phased out.</strong> Use <em>Standing
          Instructions</em> instead — Brain parses your rule into a structured
          form (subject + condition + action + due-date) and respects it across
          every answer, triage and autonomous action, not just compose. Existing
          hints still apply during reply drafting; new rules should be added as
          Standing Instructions.
        </div>
      </div>
      <div style={{ marginBottom: 'var(--s-3)', display: 'flex', justifyContent: 'space-between' }}>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', margin: 0, maxWidth: 560 }}>
          Legacy free-text rules prepended to Brain's compose system prompt
          (triage / draft reply / delegation). Kept for backwards compatibility.
        </p>
        <Button variant="primary" size="sm" onClick={() => setEditing({ text: '', scope: 'global', isActive: true })}>
          + Add hint
        </Button>
      </div>

      {loading && rows.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div> :
       rows.length === 0 && !editing ? <Empty title="No prompts yet">Tell Brain anything specific — e.g. "Loop Umair in on Acme emails" or "Keep replies under 3 sentences".</Empty> :
        rows.map((p) => (
          <Card key={p.id} size="sm" style={{ marginBottom: 'var(--s-2)', opacity: p.isActive ? 1 : 0.5 }}>
            <div style={{ display: 'flex', gap: 'var(--s-3)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', marginBottom: 4 }}>
                  <Pill variant={p.scope === 'global' ? 'accent' : 'info'}>{p.scope}</Pill>
                  {!p.isActive && <Pill>paused</Pill>}
                </div>
                <div style={{ fontSize: 'var(--fs-sm)' }}>{p.text}</div>
              </div>
              <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'flex-start' }}>
                <Button variant="ghost" size="sm" onClick={() => setEditing({ id: p.id, text: p.text, scope: p.scope, isActive: p.isActive })}>Edit</Button>
                <Button variant="ghost" size="sm" onClick={() => toggle(p)}>{p.isActive ? 'Pause' : 'Resume'}</Button>
                {confirmDeleteId === p.id ? (
                  <>
                    <Button variant="danger" size="sm" onClick={() => remove(p)}>Yes, delete</Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
                  </>
                ) : (
                  <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteId(p.id)}>Delete</Button>
                )}
              </div>
            </div>
          </Card>
        ))}

      {editing && (
        <Card style={{ marginTop: 'var(--s-3)', borderColor: 'var(--accent)' }}>
          <div style={{ fontSize: 'var(--fs-xs)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)', marginBottom: 8 }}>
            {editing.id ? 'Edit prompt' : 'New prompt'}
          </div>
          <textarea
            value={editing.text}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            rows={4}
            placeholder={'e.g. "Always loop in Umair on UAE sales emails"'}
            style={{ width: '100%', padding: 8, background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 'var(--s-2)', marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)' }}>Scope:</div>
            <select
              value={editing.scope}
              onChange={(e) => setEditing({ ...editing, scope: e.target.value })}
              style={{ padding: '6px 8px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}
            >
              {SCOPES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
            </select>
            <label style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />
              Active
            </label>
            <div style={{ flex: 1 }} />
            <Button variant="ghost" size="sm" onClick={() => { setEditing(null); setSaveError(null); }}>Cancel</Button>
            <Button variant="primary" size="sm" onClick={save} disabled={!editing.text.trim()}>Save</Button>
          </div>
          {saveError && (
            <div style={{
              marginTop: 8, padding: '6px 10px',
              fontSize: 'var(--fs-xs)', color: '#ef4444',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: 'var(--r-sm)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
            }}>
              <span>✗ {saveError}</span>
              <button
                onClick={() => setSaveError(null)}
                style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: 14 }}
                aria-label="Dismiss"
              >×</button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

// ─── Shared helpers ────────────────────────────────────────────

function sinceDays(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

function Refresh({ onClick, loading }) {
  return (
    <div style={{ marginBottom: 'var(--s-3)' }}>
      <Button variant="ghost" size="sm" onClick={onClick} disabled={loading}>
        <Icon name="refresh" size={14} /> Refresh
      </Button>
    </div>
  );
}

function FilterBar({ children }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-3)', flexWrap: 'wrap', alignItems: 'center' }}>
      {children}
    </div>
  );
}

function Search({ value, onChange, placeholder }) {
  return (
    <input
      type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      style={{ padding: '6px 10px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)', minWidth: 200 }}
    />
  );
}

function Select({ value, onChange, options, placeholder }) {
  const items = options.map((o) => typeof o === 'string' ? { v: o, l: o || (placeholder ?? 'All') } : o);
  return (
    <select
      value={value} onChange={(e) => onChange(e.target.value)}
      style={{ padding: '6px 10px', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', color: 'var(--text)', fontSize: 'var(--fs-sm)' }}
    >
      {items.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}

// ─── Risk Radar — user-defined rules driving the daily radar ───────

function RiskRadarTab() {
  const [rules, setRules] = useState([]);
  const [overrides, setOverrides] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await api.get('/risk-rules');
      setRules(r.data?.rules ?? []);
      setOverrides(r.data?.overrides ?? []);
    } catch (err) {
      setError(err.response?.data?.error ?? err.message);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const isOverridden = (ruleKey) =>
    !!ruleKey && overrides.some((o) => o.ruleKey === ruleKey && o.disabled);

  const toggleSystem = async (rule, enable) => {
    try {
      const url = `/risk-rules/system/${encodeURIComponent(rule.ruleKey)}/${enable ? 'enable' : 'disable'}`;
      await api.post(url, {});
      await load();
    } catch (err) { setError(err.response?.data?.error ?? err.message); }
  };

  const toggleEnabled = async (rule, value) => {
    try {
      await api.patch(`/risk-rules/${rule.id}`, { enabled: value });
      await load();
    } catch (err) { setError(err.response?.data?.error ?? err.message); }
  };

  const remove = async (rule) => {
    try {
      await api.delete(`/risk-rules/${rule.id}`);
      setConfirmDeleteId(null);
      await load();
    } catch (err) { setError(err.response?.data?.error ?? err.message); }
  };

  const grouped = {
    system: rules.filter((r) => r.scope === 'system'),
    tenant: rules.filter((r) => r.scope === 'tenant'),
    user:   rules.filter((r) => r.scope === 'user' && !r.ruleKey?.startsWith('user_migrated:')),
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 'var(--s-3)', flexWrap: 'wrap', gap: 12 }}>
        <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', margin: 0, maxWidth: 760, lineHeight: 1.5 }}>
          Rules that drive your Risk Radar. Each rule scans a data source (recent
          inbound, open items, or wiki/CRM pages) and fires a flag when the
          predicate matches. System rules ship with MyOS — disable any you
          don't want. Tenant rules are admin-defined; user rules are yours.
        </p>
        <button
          onClick={() => setShowAdd(true)}
          style={{
            background: 'var(--accent, #4fa9ff)', color: '#0e1116',
            border: 0, padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >+ Add rule</button>
      </div>

      {error && (
        <div style={{ background: 'rgba(217,83,79,0.16)', border: '1px solid #d9534f', color: '#f0a3a0', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-muted)' }}>Loading…</div>
      ) : rules.length === 0 ? (
        <Empty title="No rules yet">Add your first rule above.</Empty>
      ) : (
        <>
          {grouped.system.length > 0 && (
            <RuleGroup title="System rules (ship with MyOS)" rules={grouped.system}
              actions={(r) => {
                const off = isOverridden(r.ruleKey);
                return (
                  <button
                    onClick={() => toggleSystem(r, off)}
                    style={pillBtnStyle(off ? 'enable' : 'disable')}
                  >{off ? 'Re-enable' : 'Disable for me'}</button>
                );
              }}
              isOverridden={isOverridden}
            />
          )}
          {grouped.tenant.length > 0 && (
            <RuleGroup title="Tenant rules (admin-defined)" rules={grouped.tenant}
              actions={(r) => (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                  <input type="checkbox" checked={r.enabled} onChange={(e) => toggleEnabled(r, e.target.checked)} />
                  enabled
                </label>
              )}
            />
          )}
          {grouped.user.length > 0 ? (
            <RuleGroup title="My rules" rules={grouped.user}
              actions={(r) => (
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <input type="checkbox" checked={r.enabled} onChange={(e) => toggleEnabled(r, e.target.checked)} />
                    enabled
                  </label>
                  {confirmDeleteId === r.id ? (
                    <>
                      <button onClick={() => remove(r)} style={pillBtnStyle('delete')}>Yes, delete</button>
                      <button onClick={() => setConfirmDeleteId(null)} style={pillBtnStyle('disable')}>Cancel</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDeleteId(r.id)} style={pillBtnStyle('delete')}>Delete</button>
                  )}
                </span>
              )}
            />
          ) : (
            <div style={{ marginTop: 16, padding: 16, border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
              You haven't added any custom rules yet. Click <strong>+ Add rule</strong> above.
            </div>
          )}
        </>
      )}

      {showAdd && (
        <AddRiskRuleModal
          onClose={() => setShowAdd(false)}
          onSaved={async () => { setShowAdd(false); await load(); }}
        />
      )}
    </div>
  );
}

function RuleGroup({ title, rules, actions, isOverridden }) {
  return (
    <section style={{ marginBottom: 'var(--s-5)' }}>
      <h3 style={{ fontSize: 'var(--fs-md)', textTransform: 'uppercase', letterSpacing: '.5px', color: 'var(--accent)', margin: '12px 0 6px' }}>
        {title} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>· {rules.length}</span>
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rules.map((r) => (
          <RuleCard key={r.id} rule={r} actions={actions(r)}
            disabled={isOverridden ? isOverridden(r.ruleKey) : !r.enabled} />
        ))}
      </div>
    </section>
  );
}

function RuleCard({ rule, actions, disabled }) {
  return (
    <div style={{
      padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 8,
      background: disabled ? 'rgba(255,255,255,0.02)' : 'var(--panel, #141a22)',
      opacity: disabled ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 14 }}>{rule.name}</strong>
            <SeverityPill severity={rule.severity} />
            <SourcePill source={rule.source} />
            {disabled && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· disabled</span>}
          </div>
          {rule.description && (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>{rule.description}</div>
          )}
          <div style={{ marginTop: 8, padding: '6px 8px', background: 'var(--bg-2, rgba(255,255,255,0.03))', borderRadius: 4, fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace', overflowX: 'auto' }}>
            {summarisePredicate(rule.predicate)}
          </div>
          {rule.suggestedAction && (
            <div style={{ marginTop: 6, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>Suggests:</span>{' '}
              <em style={{ color: 'var(--accent)' }}>{rule.suggestedAction}</em>
            </div>
          )}
          {rule.fireCount > 0 && (
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
              Fired {rule.fireCount}× · last {rule.lastFiredAt ? new Date(rule.lastFiredAt).toLocaleString() : '—'}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0 }}>{actions}</div>
      </div>
    </div>
  );
}

function SeverityPill({ severity }) {
  const map = {
    high:   { bg: 'rgba(217,83,79,0.18)',  fg: '#f0a3a0' },
    medium: { bg: 'rgba(240,161,74,0.18)', fg: '#f4c594' },
    low:    { bg: 'rgba(152,160,168,0.15)', fg: 'var(--text-muted)' },
  }[severity] ?? { bg: 'rgba(152,160,168,0.15)', fg: 'var(--text-muted)' };
  return (
    <span style={{ padding: '1px 8px', borderRadius: 999, background: map.bg, color: map.fg, fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px' }}>
      {severity}
    </span>
  );
}

function SourcePill({ source }) {
  const labels = { feed_event: 'Inbox', open_item: 'Open Items', wiki_page: 'Wiki / CRM' };
  return (
    <span style={{ padding: '1px 8px', borderRadius: 999, background: 'var(--bg-2)', color: 'var(--text-muted)', fontSize: 10, textTransform: 'lowercase', letterSpacing: '.3px' }}>
      {labels[source] ?? source}
    </span>
  );
}

function pillBtnStyle(kind) {
  const palette = {
    enable:   { bg: 'rgba(76,175,80,0.18)',  fg: '#9bd9a0', border: 'rgba(76,175,80,0.4)' },
    disable:  { bg: 'rgba(240,161,74,0.18)', fg: '#f4c594', border: 'rgba(240,161,74,0.4)' },
    delete:   { bg: 'rgba(217,83,79,0.18)',  fg: '#f0a3a0', border: 'rgba(217,83,79,0.4)' },
  }[kind] ?? { bg: 'transparent', fg: 'var(--text)', border: 'var(--border)' };
  return {
    padding: '4px 10px', borderRadius: 6, fontSize: 12,
    background: palette.bg, color: palette.fg,
    border: `1px solid ${palette.border}`,
    cursor: 'pointer',
  };
}

function summarisePredicate(p) {
  if (!p) return '—';
  if ('all' in p) return p.all.map(summarisePredicate).join(' AND ');
  if ('any' in p) return p.all ? p.all.map(summarisePredicate).join(' AND ') : (p.any ?? []).map(summarisePredicate).join(' OR ');
  if ('not' in p) return 'NOT (' + summarisePredicate(p.not) + ')';
  const v = Array.isArray(p.value) ? `[${p.value.join(', ')}]` : JSON.stringify(p.value);
  return `${p.field} ${p.op} ${v}`;
}

function AddRiskRuleModal({ onClose, onSaved }) {
  const [form, setForm] = useState({
    name: '', description: '',
    source: 'feed_event',
    lookbackHours: 24,
    severity: 'medium',
    titleTemplate: '',
    suggestedAction: '',
    predicateText: '{\n  "all": [\n    { "field": "subject", "op": "matches", "value": "(your-pattern-here)" }\n  ]\n}',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const upd = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!form.name.trim()) { setError('Name is required.'); return; }
    let predicate;
    try { predicate = JSON.parse(form.predicateText); }
    catch { setError('Predicate must be valid JSON.'); return; }
    setSaving(true);
    try {
      await api.post('/risk-rules', {
        name: form.name.trim(),
        description: form.description.trim() || null,
        source: form.source,
        lookbackHours: form.source === 'feed_event' ? Number(form.lookbackHours) || 24 : null,
        predicate,
        severity: form.severity,
        titleTemplate: form.titleTemplate.trim() || null,
        suggestedAction: form.suggestedAction.trim() || null,
      });
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error ?? err.message);
    } finally { setSaving(false); }
  };

  // Preset templates by source so the user starts with something useful.
  const applyPreset = (source) => {
    const presets = {
      feed_event: '{\n  "all": [\n    { "field": "sentiment_score", "op": "lt", "value": -0.3 },\n    { "field": "importance_stars", "op": "gte", "value": 4 }\n  ]\n}',
      open_item: '{\n  "all": [\n    { "field": "priority", "op": "in", "value": ["critical","high"] },\n    { "field": "age_days", "op": "gte", "value": 5 }\n  ]\n}',
      wiki_page: '{\n  "all": [\n    { "field": "page_type", "op": "equals", "value": "project" },\n    { "field": "stagnant_days", "op": "gte", "value": 21 }\n  ]\n}',
    };
    setForm((f) => ({ ...f, source, predicateText: presets[source] }));
  };

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, padding: 16,
    }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit} style={{
        background: 'var(--panel, #141a22)', color: 'var(--text)',
        border: '1px solid var(--border)', borderRadius: 12,
        padding: 24, width: '100%', maxWidth: 640,
        maxHeight: '90vh', overflowY: 'auto',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>Add Risk Radar rule</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: 12, margin: '0 0 16px' }}>
          Brain will fire a flag whenever the predicate matches. Pick a source to load a starter predicate.
        </p>

        {error && (
          <div style={{ background: 'rgba(217,83,79,0.16)', border: '1px solid #d9534f', color: '#f0a3a0', padding: 8, borderRadius: 6, marginBottom: 12, fontSize: 13 }}>
            {error}
          </div>
        )}

        <ModalField label="Name *">
          <input value={form.name} onChange={upd('name')} placeholder="Escalation email" style={modalInput} autoFocus />
        </ModalField>
        <ModalField label="Description">
          <input value={form.description} onChange={upd('description')} placeholder="What this rule catches" style={modalInput} />
        </ModalField>

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: 1 }}>
            <ModalField label="Source *">
              <select value={form.source} onChange={(e) => applyPreset(e.target.value)} style={modalInput}>
                <option value="feed_event">Feed event (inbound message)</option>
                <option value="open_item">Open item (tracked work)</option>
                <option value="wiki_page">Wiki page (project / CRM)</option>
              </select>
            </ModalField>
          </div>
          <div style={{ flex: 1 }}>
            <ModalField label="Severity">
              <select value={form.severity} onChange={upd('severity')} style={modalInput}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </ModalField>
          </div>
        </div>

        {form.source === 'feed_event' && (
          <ModalField label="Lookback (hours)">
            <input type="number" value={form.lookbackHours} onChange={upd('lookbackHours')} min={1} max={168} style={modalInput} />
          </ModalField>
        )}

        <ModalField label="Predicate (JSON)" hint="Available fields depend on source. See the system rules above for examples.">
          <textarea
            value={form.predicateText} onChange={upd('predicateText')}
            spellCheck={false} rows={9}
            style={{ ...modalInput, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
          />
        </ModalField>

        <ModalField label="Title template (optional)" hint="Use {placeholders} for fields. Default: rule name + best-guess subject.">
          <input value={form.titleTemplate} onChange={upd('titleTemplate')}
            placeholder='Escalation: "{subject}" — {sender_name}' style={modalInput} />
        </ModalField>

        <ModalField label="Suggested action (optional)">
          <input value={form.suggestedAction} onChange={upd('suggestedAction')}
            placeholder="Respond personally within 1 hour." style={modalInput} />
        </ModalField>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button type="button" onClick={onClose} style={pillBtnStyle('disable')}>Cancel</button>
          <button type="submit" disabled={saving} style={{
            background: saving ? 'var(--panel-2)' : 'var(--accent)',
            color: saving ? 'var(--text-muted)' : '#0e1116',
            border: 0, padding: '8px 16px', borderRadius: 6, fontSize: 13, fontWeight: 500,
            cursor: saving ? 'not-allowed' : 'pointer',
          }}>{saving ? 'Saving…' : 'Add rule'}</button>
        </div>
      </form>
    </div>
  );
}

function ModalField({ label, hint, children }) {
  return (
    <label style={{ display: 'block', marginBottom: 10 }}>
      <span style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{label}</span>
      {children}
      {hint && <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 3, fontStyle: 'italic' }}>{hint}</span>}
    </label>
  );
}

const modalInput = {
  width: '100%', boxSizing: 'border-box',
  background: 'var(--bg-2, #1b232d)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6,
  padding: '8px 10px', fontSize: 13,
  fontFamily: 'inherit',
};

// ─── Standing Instructions — typed natural-language rules ────────
//
// The 6th MyOS layer. Every compose turn, every triage decision and
// every cognitive tick reads these and must respect them. Brain parses
// the user's plain-English instruction server-side into a structured
// kind (standing_rule / watchpoint / todo / follow_up / scheduled /
// update_request) with subject + condition + action + due-date.

const KIND_COLOR = {
  standing_rule:  { bg: 'rgba(59,130,246,0.14)',  fg: '#60a5fa' },
  watchpoint:     { bg: 'rgba(239,68,68,0.14)',   fg: '#f87171' },
  follow_up:      { bg: 'rgba(245,158,11,0.14)',  fg: '#f59e0b' },
  scheduled:      { bg: 'rgba(168,85,247,0.14)',  fg: '#c084fc' },
  todo:           { bg: 'rgba(34,197,94,0.14)',   fg: '#4ade80' },
  update_request: { bg: 'rgba(14,165,233,0.14)',  fg: '#38bdf8' },
};

function StandingInstructionsTab() {
  const [list, setList] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [scope, setScope] = useState('user');
  const [toast, setToast] = useState(null); // { kind: 'success'|'error'|'info', text }

  const notify = useCallback((t, kind = 'info') => {
    setToast({ text: t, kind });
    window.clearTimeout(notify._t);
    notify._t = window.setTimeout(() => setToast(null), 3500);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/brain/instructions');
      setList(r.data?.instructions ?? []);
      setIsAdmin(!!r.data?.isAdmin);
      setScope((cur) => (cur === 'client' && !r.data?.isAdmin ? 'user' : cur));
    } catch (err) {
      notify(err?.response?.data?.error ?? 'Failed to load instructions', 'error');
    } finally { setLoading(false); }
  }, [notify]);
  useEffect(() => { load(); }, [load]);
  // Default new-instruction scope to 'client' for admins (their preferences
  // are typically tenant-wide policy), 'user' for everyone else.
  useEffect(() => { if (isAdmin) setScope((cur) => cur || 'client'); }, [isAdmin]);

  const save = async () => {
    const clean = text.trim();
    if (!clean) return;
    setSaving(true);
    try {
      const r = await api.post('/brain/instructions', { text: clean, scope });
      const kind = r.data?.structured?.kind ?? 'instruction';
      const sc = r.data?.scope ?? scope;
      notify(`Saved ${sc === 'client' ? 'tenant-wide' : 'personal'} ${kind.replace(/_/g, ' ')} — Brain will respect this from now on`, 'success');
      setText('');
      await load();
    } catch (err) {
      notify(err?.response?.data?.error ?? 'Could not save instruction', 'error');
    } finally { setSaving(false); }
  };

  const changeStatus = async (id, status) => {
    try {
      await api.patch(`/brain/instructions/${id}/status`, { status });
      notify(status === 'archived' ? 'Instruction archived' : `Instruction ${status}`, 'info');
      await load();
    } catch (err) {
      notify(err?.response?.data?.error ?? 'Update failed', 'error');
    }
  };

  const clientList = list.filter((i) => i.scope === 'client');
  const userList = list.filter((i) => i.scope !== 'client');

  const placeholder = scope === 'client'
    ? `Set a tenant-wide rule… e.g. "All client emails must be acknowledged within 4 hours" or "Never quote a price without CFO approval"`
    : `Tell Brain what to do… e.g. "Always delegate Raazia's emails to Asad" or "Alert me if anyone mentions EXIM"`;

  return (
    <>
      <p style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', margin: '0 0 var(--s-3)', maxWidth: 760, lineHeight: 1.5 }}>
        The rules you've explicitly given Brain. Type a plain-English
        instruction and Brain parses it into a structured rule (subject +
        condition + action + due-date) — then respects it across every
        answer, triage decision and autonomous action. <em>Client</em>{' '}
        rules apply to every user in your tenant (admin-only); <em>User</em>{' '}
        rules apply only to you.
      </p>

      <div style={{ display: 'flex', gap: 'var(--s-2)', alignItems: 'center', marginBottom: 'var(--s-3)', flexWrap: 'wrap' }}>
        {isAdmin && (
          <div style={{ display: 'inline-flex', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)', padding: 2 }}>
            <button
              type="button"
              onClick={() => setScope('client')}
              style={{
                padding: '6px 10px', fontSize: 'var(--fs-xs)', fontWeight: 600,
                border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                background: scope === 'client' ? 'rgba(59,130,246,0.18)' : 'transparent',
                color: scope === 'client' ? '#60a5fa' : 'var(--text-muted)',
              }}
              title="Rule applies to every user in the tenant"
            >Client rule</button>
            <button
              type="button"
              onClick={() => setScope('user')}
              style={{
                padding: '6px 10px', fontSize: 'var(--fs-xs)', fontWeight: 600,
                border: 'none', borderRadius: 'var(--r-sm)', cursor: 'pointer',
                background: scope === 'user' ? 'rgba(34,197,94,0.18)' : 'transparent',
                color: scope === 'user' ? '#4ade80' : 'var(--text-muted)',
              }}
              title="Rule applies only to you"
            >My rule</button>
          </div>
        )}
        <input
          type="text" value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !saving) save(); }}
          placeholder={placeholder}
          style={{
            flex: 1, minWidth: 260, padding: '10px 12px', fontSize: 'var(--fs-sm)',
            background: 'var(--bg-2)', border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)', color: 'var(--text)',
          }}
          disabled={saving}
        />
        <Button variant="primary" size="sm" onClick={save} disabled={saving || !text.trim()}>
          {saving ? 'Saving…' : (scope === 'client' ? 'Set tenant rule' : 'Tell Brain')}
        </Button>
      </div>

      {toast && (
        <div style={{
          marginBottom: 'var(--s-3)', padding: '8px 12px',
          background: toast.kind === 'error' ? 'rgba(217,83,79,0.16)' : toast.kind === 'success' ? 'rgba(34,197,94,0.16)' : 'rgba(59,130,246,0.16)',
          border: '1px solid ' + (toast.kind === 'error' ? '#d9534f' : toast.kind === 'success' ? '#22c55e' : '#3b82f6'),
          color: 'var(--text)', borderRadius: 'var(--r-md)', fontSize: 'var(--fs-xs)',
        }}>{toast.text}</div>
      )}

      {loading ? (
        <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
      ) : list.length === 0 ? (
        <Empty title="No standing instructions yet">
          Anything you tell Brain here becomes a rule it reads before every decision. Think delegation rules, watchpoints, or follow-ups.
        </Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
          {clientList.length > 0 && (
            <InstructionGroup
              label={`Client rules · ${clientList.length}`}
              labelColor="#60a5fa"
              note={!isAdmin ? '(tenant-wide, admin-managed)' : null}
            >
              {clientList.map((ins) => (
                <InstructionRow
                  key={ins.id} ins={ins}
                  canEdit={isAdmin}
                  onStatus={(status) => changeStatus(ins.id, status)}
                />
              ))}
            </InstructionGroup>
          )}
          {userList.length > 0 && (
            <InstructionGroup label={`My rules · ${userList.length}`} labelColor="#4ade80">
              {userList.map((ins) => (
                <InstructionRow
                  key={ins.id} ins={ins}
                  canEdit
                  onStatus={(status) => changeStatus(ins.id, status)}
                />
              ))}
            </InstructionGroup>
          )}
        </div>
      )}
    </>
  );
}

function InstructionGroup({ label, labelColor, note, children }) {
  return (
    <div>
      <div style={{
        fontSize: 'var(--fs-xs)', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '.4px', color: labelColor, marginBottom: 6,
      }}>
        {label}
        {note && (
          <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            {note}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-2)' }}>{children}</div>
    </div>
  );
}

function InstructionRow({ ins, canEdit, onStatus }) {
  const c = KIND_COLOR[ins.kind] ?? { bg: 'rgba(156,163,175,0.14)', fg: 'var(--text-muted)' };
  return (
    <div style={{
      padding: '10px 12px', background: 'var(--bg-2)',
      border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
      display: 'flex', alignItems: 'flex-start', gap: 10,
    }}>
      <span style={{
        fontSize: 10, padding: '2px 8px', borderRadius: 10,
        background: c.bg, color: c.fg,
        fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.3px',
        whiteSpace: 'nowrap', flexShrink: 0,
      }}>
        {(ins.kind ?? 'instruction').replace(/_/g, ' ')}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-sm)', fontWeight: 'var(--fw-semibold)', color: 'var(--text)' }}>
          {ins.title}
        </div>
        <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.45 }}>
          {ins.originalText}
        </div>
        {(ins.subject || ins.condition || ins.action || ins.dueAt) && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {ins.subject   && <Pill>subject: {ins.subject}</Pill>}
            {ins.condition && <Pill>condition: {ins.condition}</Pill>}
            {ins.action    && <Pill>action: {ins.action}</Pill>}
            {ins.dueAt     && <Pill>due: {new Date(ins.dueAt).toLocaleDateString()}</Pill>}
          </div>
        )}
        {ins.status && ins.status !== 'active' && (
          <div style={{ marginTop: 6 }}>
            <Pill variant={ins.status === 'paused' ? 'warning' : undefined}>{ins.status}</Pill>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
        {canEdit ? (
          <>
            {ins.status !== 'paused' && (
              <Button size="sm" variant="ghost" onClick={() => onStatus('paused')}
                title="Pause — Brain will still remember it but won't act on it">
                Pause
              </Button>
            )}
            {ins.status === 'paused' && (
              <Button size="sm" variant="ghost" onClick={() => onStatus('active')}
                title="Resume — Brain starts acting on this rule again">
                Resume
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onStatus('archived')}
              title="Archive — remove this standing instruction">
              Archive
            </Button>
          </>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
            admin-managed
          </span>
        )}
      </div>
    </div>
  );
}
