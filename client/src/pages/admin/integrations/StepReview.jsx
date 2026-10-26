/**
 * DEF-354 — Step 3, Review the mapping: field-wise approval of ONE mapping version.
 *
 * Rules this screen keeps (spec §2.3, vm §9):
 *   - approval is per FIELD and per VERSION — the version on screen travels with every
 *     approve/withdraw, so a decision can never land on a version the admin is not looking
 *     at. The wizard keeps that version id; Test & turn on dry-runs and activates exactly it;
 *   - only a DRAFT version can be decided. The running (APPROVED) version is frozen: a
 *     change goes through "Ask the AI", which makes a new version carrying every approved
 *     row (so the running mapping keeps running until the new one is turned on);
 *   - refused decisions come back with their reason (e.g. the KPI is already fed by another
 *     integration — "one field, one owner") and are shown, never swallowed;
 *   - Continue stays disabled until ≥1 field is approved.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listSuggestions, approveSuggestions, rejectSuggestions, listKpiDefinitions, createKpiDefinition,
  proposeAndWait, errorText,
} from '../../../services/integrationsApi';
import { proposalStageText } from './WorkingOverlay';
import { C, s, btn, Pill, describeTarget, describeTransform } from './integrationUi';

const STATUS_PILL = {
  PENDING: { text: 'Waiting for you', color: C.info },
  APPROVED: { text: 'Approved', color: C.ok },
  REJECTED: { text: 'Not used', color: C.grey },
  SET_ASIDE: { text: 'Set aside', color: C.warn },
  BLANK: { text: 'Never filled in', color: C.grey },
};

const TYPE_WORDS = { number: 'Numbers', date: 'Dates', text: 'Text', empty: 'Always blank' };

const KPI_KEY_RE = /^[a-z][a-z0-9_]{0,79}$/;

export default function StepReview({ integ, setMsg, signal, setWorking, versionId, setVersionId, onNext, onBack }) {
  const [version, setVersion] = useState(null);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState([]);
  const [error, setError] = useState('');
  const [prompt, setPrompt] = useState('');
  const [kpis, setKpis] = useState([]);

  const load = useCallback(async (vid) => {
    setLoading(true);
    setError('');
    try {
      const [res, defs] = await Promise.all([listSuggestions(integ.id, vid || undefined), listKpiDefinitions()]);
      setVersion(res.version);
      setSuggestions(res.suggestions);
      setKpis(defs);
      if (res.version && res.version.id !== vid) setVersionId(res.version.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [integ.id, setVersionId]);

  useEffect(() => { load(versionId); }, [load, versionId]);

  const editable = version?.status === 'DRAFT';
  const approved = suggestions.filter((x) => x.status === 'APPROVED');
  const pending = suggestions.filter((x) => x.status === 'PENDING');
  const spec = version?.spec || {};
  const notices = Array.isArray(spec.notices) ? spec.notices : [];
  const coverage = Array.isArray(spec.coverage) ? spec.coverage : [];

  // "Where it goes" for the coverage table: every suggestion that reads the field.
  const destinations = useMemo(() => {
    const m = new Map();
    for (const sg of suggestions) {
      if (sg.status === 'REJECTED') continue;
      const fields = sg.transform?.mode === 'wide' ? (sg.transform.columns || []) : [sg.sourceField];
      for (const f of fields) {
        if (!m.has(f)) m.set(f, []);
        m.get(f).push(sg);
      }
    }
    return m;
  }, [suggestions]);

  async function decide(kind, ids) {
    if (!version) return;
    setBusy(true);
    setError('');
    setRefused([]);
    try {
      const fn = kind === 'approve' ? approveSuggestions : rejectSuggestions;
      const res = await fn(integ.id, version.id, ids);
      setRefused(Array.isArray(res?.refused) ? res.refused : []);
      const created = Array.isArray(res?.createdKpis) && res.createdKpis.length
        ? ` New KPI${res.createdKpis.length === 1 ? '' : 's'} created: ${res.createdKpis.join(', ')}.` : '';
      setMsg(`${kind === 'approve' ? 'Approved' : 'Withdrawn'}: ${res?.updated ?? 0}.${created}`);
      await load(version.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function askAi() {
    const startedAt = new Date().toISOString();
    const title = 'The AI is revising the mapping';
    setWorking({ title, stage: proposalStageText(null), startedAt });
    try {
      const res = await proposeAndWait(integ.id, prompt, {
        signal,
        onTick: (job) => setWorking({ title, stage: proposalStageText(job), startedAt }),
      });
      setPrompt('');
      setMsg(`Mapping version ${res?.mappingVersion ?? ''} is ready to review. Approved fields were carried over.`);
      if (res?.versionId) setVersionId(res.versionId);
      else await load(null);
    } catch (e) {
      setMsg(`Failed to revise the mapping: ${errorText(e)}`);
    } finally {
      setWorking(null);
    }
  }

  if (loading && !version) return <div style={s.hint}>Loading the mapping…</div>;

  if (!version) {
    return (
      <div>
        <h3 style={s.h3}>Review the mapping</h3>
        <p style={s.hint}>No mapping has been suggested yet. Go back to Connect, test the connection and press “Suggest the mapping”.</p>
        {error && <div style={s.error}>{error}</div>}
        <div style={{ ...s.row, marginTop: 16 }}>
          <button style={btn('outline')} onClick={onBack}>← Connect</button>
        </div>
      </div>
    );
  }

  const refusedById = new Map(refused.map((r) => [r.id, r.reason]));

  return (
    <div>
      <div style={{ ...s.row, justifyContent: 'space-between' }}>
        <h3 style={{ ...s.h3, margin: 0 }}>Review the mapping</h3>
        <span style={s.hint}>
          Version {version.version} · {version.status === 'DRAFT' ? 'not turned on yet' : version.status === 'APPROVED' ? 'the one running' : 'replaced'}
          {spec.provider ? ` · suggested by ${spec.provider}` : ''}
        </span>
      </div>

      {version.aiSummary && <p style={{ ...s.hint, color: 'var(--text)', marginTop: 10 }}>{version.aiSummary}</p>}
      {version.adminPrompt && <p style={s.hint}>You asked: “{version.adminPrompt}”</p>}

      {notices.length > 0 && (
        <div style={s.warnBox}>
          <strong>Could not be done:</strong>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {notices.map((n, i) => <li key={i}>{String(n)}</li>)}
          </ul>
        </div>
      )}

      {!editable && (
        <div style={s.warnBox}>
          {version.status === 'APPROVED'
            ? 'This is the mapping that is running, so it cannot be changed here. Ask the AI below for a new version — every approved field is carried over, and the running mapping keeps running until you turn the new one on.'
            : 'This version was replaced by a newer one.'}
        </div>
      )}

      {coverage.length > 0 && (
        <>
          <div style={s.sectionTitle}>What is in the sheet</div>
          <div style={{ overflowX: 'auto' }}>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>Field</th><th style={{ ...s.th, textAlign: 'right' }}>Filled</th>
                  <th style={s.th}>What it holds</th><th style={s.th}>Where it goes</th>
                </tr>
              </thead>
              <tbody>
                {coverage.map((f) => {
                  const dest = destinations.get(f.field) || [];
                  const pct = f.total ? Math.round((f.filled / f.total) * 100) : 0;
                  return (
                    <tr key={f.field}>
                      <td style={s.td}><strong>{f.field}</strong></td>
                      <td style={s.tdNum}>{f.filled} of {f.total} ({pct}%)</td>
                      <td style={s.td}>
                        {TYPE_WORDS[f.inferredType] || f.inferredType}
                        {Array.isArray(f.samples) && f.samples.length > 0 && (
                          <span style={{ color: 'var(--text-muted)' }}> — e.g. {f.samples.slice(0, 3).map((v) => `“${v}”`).join(', ')}</span>
                        )}
                      </td>
                      <td style={s.td}>
                        {dest.length === 0
                          ? <span style={{ color: 'var(--text-muted)' }}>Not used</span>
                          : dest.map((d) => (
                            <div key={d.id}>{describeTarget(d)} <Pill color={(STATUS_PILL[d.status] || {}).color}>{(STATUS_PILL[d.status] || {}).text || d.status}</Pill></div>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ ...s.sectionTitle, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span>Suggested fields · {suggestions.length}</span>
        {editable && (
          <span style={s.row}>
            <button
              style={btn('success', { small: true, disabled: busy || pending.length === 0 })}
              disabled={busy || pending.length === 0}
              onClick={() => decide('approve', 'all')}
            >Approve all waiting ({pending.length})</button>
            <button
              style={btn('outline', { small: true, disabled: busy || approved.length === 0 })}
              disabled={busy || approved.length === 0}
              onClick={() => decide('reject', approved.map((x) => x.id))}
            >Withdraw all approved ({approved.length})</button>
          </span>
        )}
      </div>

      {suggestions.length === 0 && <p style={s.hint}>The AI found nothing it could map. Ask it again below, or add the KPI you expect first.</p>}

      {suggestions.map((sg) => {
        const pill = STATUS_PILL[sg.status] || { text: sg.status, color: C.grey };
        const why = refusedById.get(sg.id);
        return (
          <div key={sg.id} style={{ ...s.card, background: 'var(--bg-1)', padding: 12, marginBottom: 8 }}>
            <div style={{ ...s.row, justifyContent: 'space-between' }}>
              <div style={{ ...s.row, gap: 8 }}>
                <strong style={{ color: 'var(--text)' }}>{sg.sourceField}</strong>
                <span style={{ color: 'var(--text-muted)' }}>→</span>
                <span style={{ color: 'var(--text)' }}>{describeTarget(sg)}</span>
                <Pill color={pill.color}>{pill.text}</Pill>
                {sg.carriedFromId && <Pill color={C.grey} title="Approved in an earlier version and carried over">Carried over</Pill>}
              </div>
              {editable && (
                <span style={s.row}>
                  {sg.status === 'PENDING' && (
                    <button style={btn('success', { small: true, disabled: busy })} disabled={busy} onClick={() => decide('approve', [sg.id])}>Approve</button>
                  )}
                  {sg.status === 'APPROVED' && (
                    <button style={btn('outline', { small: true, disabled: busy })} disabled={busy} onClick={() => decide('reject', [sg.id])}>Withdraw</button>
                  )}
                  {(sg.status === 'PENDING' || sg.status === 'SET_ASIDE' || sg.status === 'BLANK') && (
                    <button style={btn('outline', { small: true, disabled: busy })} disabled={busy} onClick={() => decide('reject', [sg.id])}>Don’t use</button>
                  )}
                </span>
              )}
            </div>
            {sg.transform && <div style={{ ...s.hint, marginTop: 6 }}>{describeTransform(sg.transform)}</div>}
            {sg.samples?.length > 0 && (
              <div style={s.hint}>Values in the sheet: {sg.samples.slice(0, 3).map((v) => `“${v}”`).join(', ')}</div>
            )}
            {sg.reason && <div style={{ ...s.hint, color: sg.status === 'SET_ASIDE' ? C.warn : 'var(--text-muted)' }}>{sg.reason}</div>}
            {why && <div style={s.error}>Not changed: {why}</div>}
          </div>
        );
      })}

      {refused.filter((r) => !suggestions.some((x) => x.id === r.id)).map((r) => (
        <div key={r.id} style={s.error}>Not changed: {r.reason}</div>
      ))}

      {error && <div style={s.error}>{error}</div>}

      <div style={s.sectionTitle}>Ask the AI</div>
      <textarea
        style={{ ...s.input, minHeight: 64, resize: 'vertical' }}
        value={prompt}
        maxLength={4000}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="e.g. “Orders” is a count of orders, map it to a new KPI; ignore the Notes column."
      />
      <div style={{ ...s.row, marginTop: 8 }}>
        <button style={btn('primary', { small: true, disabled: busy })} disabled={busy} onClick={askAi}>Make a new version</button>
        <span style={s.hint}>Fields you approved are kept; the AI only revisits the rest.</span>
      </div>

      <AddKpi
        existing={kpis}
        onCreated={(def) => {
          setKpis((k) => [...k, def]);
          setMsg(`KPI “${def?.label ?? ''}” added. Ask the AI for a new version to map a field to it.`);
        }}
      />

      <div style={{ ...s.row, justifyContent: 'space-between', marginTop: 16 }}>
        <button style={btn('outline')} onClick={onBack}>← Connect</button>
        <span style={s.row}>
          {approved.length === 0 && <span style={s.hint}>Approve at least one field to continue.</span>}
          <button style={btn('primary', { disabled: approved.length === 0 })} disabled={approved.length === 0} onClick={onNext}>
            Continue
          </button>
        </span>
      </div>
    </div>
  );
}

/** Minimal "Add a KPI" form → POST kpi-definitions. Key pattern mirrors KPI_KEY_RE in
 *  types.ts / the DB CHECK; the server validates again and its message is shown. */
function AddKpi({ existing, onCreated }) {
  const [open, setOpen] = useState(false);
  const [kpiKey, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [unit, setUnit] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const keyOk = KPI_KEY_RE.test(kpiKey);
  const taken = existing.some((k) => k.kpiKey === kpiKey);
  const canSave = keyOk && !taken && label.trim().length > 0 && !busy;

  async function save() {
    setBusy(true);
    setError('');
    try {
      const def = await createKpiDefinition({ kpiKey, label: label.trim(), unit: unit.trim() || null });
      onCreated(def);
      setKey(''); setLabel(''); setUnit(''); setOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div style={{ marginTop: 14 }}>
        <button style={btn('outline', { small: true })} onClick={() => setOpen(true)}>+ Add a KPI</button>
        <span style={{ ...s.hint, marginLeft: 8 }}>{existing.length} KPI{existing.length === 1 ? '' : 's'} in your catalogue.</span>
      </div>
    );
  }
  return (
    <div style={{ ...s.card, background: 'var(--bg-1)', marginTop: 14 }}>
      <div style={s.h3}>Add a KPI</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 }}>
        <div>
          <label style={s.label} htmlFor="kpi-key">Key</label>
          <input id="kpi-key" style={s.input} value={kpiKey} maxLength={80} onChange={(e) => setKey(e.target.value.trim().toLowerCase())} placeholder="monthly_revenue" />
        </div>
        <div>
          <label style={s.label} htmlFor="kpi-label">Label</label>
          <input id="kpi-label" style={s.input} value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} placeholder="Monthly revenue" />
        </div>
        <div>
          <label style={s.label} htmlFor="kpi-unit">Unit (optional)</label>
          <input id="kpi-unit" style={s.input} value={unit} maxLength={20} onChange={(e) => setUnit(e.target.value)} placeholder="PKR" />
        </div>
      </div>
      {kpiKey && !keyOk && <div style={s.hint}>The key starts with a letter and uses only a–z, 0–9 and _.</div>}
      {taken && <div style={s.hint}>That key is already in your catalogue.</div>}
      {error && <div style={s.error}>{error}</div>}
      <div style={{ ...s.row, marginTop: 10 }}>
        <button style={btn('primary', { small: true, disabled: !canSave })} disabled={!canSave} onClick={save}>{busy ? 'Adding…' : 'Add KPI'}</button>
        <button style={btn('outline', { small: true })} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
