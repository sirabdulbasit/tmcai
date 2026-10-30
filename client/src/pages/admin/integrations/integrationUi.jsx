/**
 * DEF-354 — shared pieces of Admin → Integrations: style tokens, pills, the inline confirm,
 * PKT time formatting, schedule wording, and the run-changes list used by both
 * "Test & turn on" and History.
 *
 * Tokens are the ConnectorsPage ones (var(--bg-1|2), var(--border), var(--text|-muted),
 * accent #cc6b4a, ok #4ade80, warn #f59e0b, danger #ef4444, badge = colour + '22'), so the
 * tab reads as part of Admin, not as a port of vm's light palette.
 */
import { useState } from 'react';

export const C = {
  accent: '#cc6b4a', ok: '#4ade80', warn: '#f59e0b', bad: '#ef4444', info: '#3b82f6', grey: '#888',
};

export const s = {
  card: { background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 10, padding: 16, marginBottom: 12 },
  h2: { margin: '0 0 6px', fontSize: 18, color: 'var(--text)' },
  h3: { margin: '0 0 8px', fontSize: 15, color: 'var(--text)' },
  hint: { color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.5, margin: '4px 0 0' },
  label: { display: 'block', fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', marginBottom: 4, marginTop: 12 },
  input: { width: '100%', background: 'var(--bg-1)', border: '1px solid var(--border)', color: 'var(--text)', padding: '8px 12px', borderRadius: 8, fontSize: 'var(--fs-sm)', fontFamily: 'inherit', boxSizing: 'border-box' },
  btn: { padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 'var(--fs-sm)', fontWeight: 500, fontFamily: 'inherit' },
  btnPrimary: { background: C.accent, color: '#fff' },
  btnOutline: { background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-muted)' },
  btnSuccess: { background: C.ok, color: 'var(--bg-1)' },
  btnDanger: { background: C.bad, color: '#fff' },
  btnSmall: { padding: '4px 10px', fontSize: 12 },
  disabled: { opacity: 0.45, cursor: 'not-allowed' },
  sectionTitle: { fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1, margin: '18px 0 8px', paddingBottom: 6, borderBottom: '1px solid var(--border)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' },
  th: { textAlign: 'left', padding: '6px 8px', color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' },
  td: { padding: '7px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text)', verticalAlign: 'top' },
  tdNum: { padding: '7px 8px', borderBottom: '1px solid var(--border)', color: 'var(--text)', textAlign: 'right', fontVariantNumeric: 'tabular-nums', verticalAlign: 'top' },
  mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
  error: { padding: '8px 12px', background: C.bad + '22', border: '1px solid ' + C.bad, borderRadius: 8, color: C.bad, fontSize: 'var(--fs-sm)', marginTop: 10 },
  success: { padding: '8px 12px', background: C.ok + '22', border: '1px solid ' + C.ok, borderRadius: 8, color: C.ok, fontSize: 'var(--fs-sm)', marginTop: 10 },
  warnBox: { padding: '8px 12px', background: C.warn + '22', border: '1px solid ' + C.warn, borderRadius: 8, color: C.warn, fontSize: 'var(--fs-sm)', marginTop: 10 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
};

/**
 * Owner 10-30 "Basic, Connect both UI/UX should be the same — same as Vision Metric":
 * the vm wizard's Basics/Connect building blocks (IntegrationSyncTab.tsx), on Nexeo's
 * theme variables. A section heading, a choice card (vm's bordered radio/checkbox
 * tiles), a pill, the divider above the test panel and the result boxes.
 */
export const vm = {
  section: { fontSize: '0.9rem', margin: '20px 0 6px', color: 'var(--text)' },
  sectionHint: { color: 'var(--text-muted)', fontSize: 'var(--fs-sm)', lineHeight: 1.5, margin: '0 0 8px' },
  grid2: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 },
  divider: { marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 },
  notes: { background: 'var(--bg-1)', borderRadius: 9, padding: '12px 14px', margin: '10px 0', fontSize: 'var(--fs-sm)', lineHeight: 1.7, color: 'var(--text)' },
  ok: { background: C.ok + '1a', color: C.ok, borderRadius: 8, padding: '10px 13px', fontSize: 'var(--fs-sm)', marginTop: 12 },
  bad: { background: C.bad + '1a', color: C.bad, borderRadius: 8, padding: '10px 13px', fontSize: 'var(--fs-sm)', marginTop: 12 },
  amber: { background: C.warn + '1a', color: C.warn, borderRadius: 8, padding: '10px 13px', fontSize: 'var(--fs-sm)', marginTop: 12 },
  choiceTitle: { fontWeight: 700, fontSize: 'var(--fs-sm)', color: 'var(--text)' },
  footer: { display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 14, flexWrap: 'wrap' },
};

export function choiceCard(selected, disabled = false) {
  return {
    display: 'block', borderRadius: 9, padding: '12px 14px', cursor: disabled ? 'not-allowed' : 'pointer',
    border: selected ? '1px solid ' + C.accent : '1px solid var(--border)',
    background: selected ? C.accent + '14' : 'var(--bg-1)',
    ...(disabled && !selected ? { opacity: 0.5 } : null),
  };
}

export function pill(tone = 'acc') {
  const col = tone === 'ok' ? C.ok : tone === 'warn' ? C.warn : C.accent;
  return { display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: col + '22', color: col };
}

export function btn(kind = 'outline', { small = false, disabled = false } = {}) {
  const base = kind === 'primary' ? s.btnPrimary : kind === 'success' ? s.btnSuccess : kind === 'danger' ? s.btnDanger : s.btnOutline;
  return { ...s.btn, ...base, ...(small ? s.btnSmall : null), ...(disabled ? s.disabled : null) };
}

export function Pill({ color = C.grey, children, title }) {
  return (
    <span title={title} style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
      background: color + '22', color, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

/**
 * Two-button confirm in place — never window.confirm (ClientManagementTab pattern,
 * feedback_no_browser_dialogs). The consequence text is shown WITH the buttons, so the
 * admin reads what will happen at the moment of deciding.
 */
export function InlineConfirm({ label, confirmLabel, consequence, onConfirm, kind = 'outline', small = true, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button style={btn(kind, { small, disabled })} disabled={disabled} onClick={() => setOpen(true)}>{label}</button>
    );
  }
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {consequence && <span style={{ fontSize: 12, color: C.warn, maxWidth: 360 }}>{consequence}</span>}
      <button
        style={btn(kind === 'danger' ? 'danger' : 'primary', { small, disabled: busy })}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await onConfirm(); } finally { setBusy(false); setOpen(false); }
        }}
      >{busy ? '…' : confirmLabel}</button>
      <button style={btn('outline', { small })} disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
    </span>
  );
}

// ── Time ──────────────────────────────────────────────────────────────────

/** Every time on these screens is shown in PKT (Asia/Karachi), stated — never the
 *  browser's zone silently (vm showed toLocaleString() in whatever zone the laptop had). */
export function formatPkt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }) + ' PKT';
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ordinal(n) {
  const v = n % 100;
  const suf = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suf}`;
}

export function scheduleText(integ) {
  if (!integ) return '';
  const t = integ.runTime || '02:00';
  switch (integ.frequency) {
    case 'daily': return `Every day at ${t}`;
    case 'weekly': return `Every ${WEEKDAYS[integ.dayOfWeek ?? 1] || 'week'} at ${t}`;
    case 'monthly': return integ.dayOfMonth === -1
      ? `Last day of each month at ${t}`
      : `${ordinal(integ.dayOfMonth || 1)} of each month at ${t}`;
    case 'once': return 'Only when you press Run now';
    default: return integ.frequency || '';
  }
}

/** Offset (ms) of `tz` from UTC at instant `ms`. */
function tzOffsetMs(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function wallToInstant(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m, d, hh, mm);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
}

/**
 * Preview of the first scheduled run after `now`, for the turn-on confirm. The SERVER
 * computes the real next_run_at at activation (planner.nextScheduledRun); this only lets
 * the admin see, before deciding, roughly when the first unattended run will be. Same
 * rules: wall time in the integration's zone, monthly day clamped to the month's length,
 * -1 = last day, 'once' ⇒ null.
 */
export function previewNextRun(sched, tz, now = new Date()) {
  if (!sched || sched.frequency === 'once') return null;
  const zone = tz || 'Asia/Karachi';
  const [hh, mm] = String(sched.runTime || '02:00').split(':').map(Number);
  try {
    const todayParts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now).split('-').map(Number);
    for (let i = 0; i < 400; i += 1) {
      const day = new Date(Date.UTC(todayParts[0], todayParts[1] - 1, todayParts[2] + i));
      const y = day.getUTCFullYear(); const m = day.getUTCMonth(); const d = day.getUTCDate();
      if (sched.frequency === 'weekly' && day.getUTCDay() !== Number(sched.dayOfWeek)) continue;
      if (sched.frequency === 'monthly') {
        const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
        const want = Number(sched.dayOfMonth) === -1 ? last : Math.min(Number(sched.dayOfMonth) || 1, last);
        if (d !== want) continue;
      }
      const t = wallToInstant(y, m, d, hh || 0, mm || 0, zone);
      if (t > now.getTime()) return new Date(t);
    }
  } catch { /* invalid zone — the server validates it; show nothing rather than a wrong time */ }
  return null;
}

// ── Mapping wording ───────────────────────────────────────────────────────

export function describeTarget(sugg) {
  const key = String(sugg?.targetKey || '');
  if (key.startsWith('kpi:new:')) {
    const k = key.slice('kpi:new:'.length);
    return `New KPI “${sugg.newKpi?.label || k}” (${k}${sugg.newKpi?.unit ? `, ${sugg.newKpi.unit}` : ''})`;
  }
  if (key.startsWith('kpi:')) return `KPI ${key.slice(4)}`;
  // DEF-362: Context = Brain knowledge pages; filter = the one record filter row.
  if (key === 'context:per_record') return 'Knowledge — one page per record';
  if (key === 'context:table') return 'Knowledge — one table page';
  if (key === 'filter') return 'Filter';
  return key;
}

const quote = (f) => `“${f}”`;

function listFields(fields, max = 4) {
  const arr = Array.isArray(fields) ? fields : [];
  const shown = arr.slice(0, max).map(quote).join(', ');
  return arr.length > max ? `${shown} and ${arr.length - max} more` : shown;
}

/** DEF-362: the plain words for each filter op (types.ts FILTER_OPS). */
export const FILTER_OP_WORDS = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  greater_than: 'is more than', greater_or_equal: 'is at least', less_than: 'is less than',
  less_or_equal: 'is at most', is_blank: 'is blank', is_not_blank: 'is filled in',
  after: 'is after', before: 'is before',
};

export function describeCondition(c) {
  const words = FILTER_OP_WORDS[c?.op] || c?.op || '';
  const valueless = c?.op === 'is_blank' || c?.op === 'is_not_blank';
  return `${quote(c?.field ?? '')} ${words}${valueless ? '' : ` “${c?.value ?? ''}”`}`;
}

export function describeTransform(tr) {
  if (!tr) return '';
  if (tr.mode === 'per_record') {
    return `One knowledge page per record, titled by ${quote(tr.titleField)}${(tr.bodyFields || []).length ? `, holding ${listFields(tr.bodyFields)}` : ''}.`;
  }
  if (tr.mode === 'table') return `One knowledge page with a table of ${listFields(tr.columns)}.`;
  if (Array.isArray(tr.conditions)) {
    const joiner = tr.match === 'any' ? ' or ' : ' and ';
    return `Keep only records where ${tr.conditions.map(describeCondition).join(joiner)}.`;
  }
  const dim = tr.dimensionField ? `, one reading per “${tr.dimensionField}”` : ', as a total';
  if (tr.mode === 'recipe') return describeRecipe(tr.recipe, dim);
  if (tr.mode === 'long') return `Value from “${tr.valueField}”, dated by “${tr.periodField}”${dim}.`;
  if (tr.mode === 'wide') {
    const cols = tr.columns || [];
    const shown = cols.slice(0, 3).map((c) => `“${c}”`).join(', ');
    return `One column per period (${cols.length}: ${shown}${cols.length > 3 ? '…' : ''}), dated by each column heading${dim}.`;
  }
  return '';
}

/** DEF-365 — a computed KPI (count / sum / ratio per month), in plain words.
 *  Mirrors server engine/kpiRecipe.describeKpiRecipe. */
export function describeRecipe(r, dim = ', as a total') {
  if (!r) return '';
  const what = r.measure === 'count'
    ? 'Counts the records'
    : r.measure === 'sum'
      ? `Adds up “${r.valueField}”`
      : `Divides the total of “${r.numeratorField}” by the total of “${r.denominatorField}”${r.scale && r.scale !== 1 ? ` × ${r.scale}` : ''}`;
  return `Computed: ${what} per month, dated by “${r.periodField}”${dim}. Only months that have ended are counted; blanks and non-numbers are skipped.`;
}

/** Every source field a suggestion reads — for "Where it goes" (KPI, Context, filter). */
export function fieldsOfSuggestion(sg) {
  const tr = sg?.transform;
  if (!tr) return [sg?.sourceField].filter(Boolean);
  if (tr.mode === 'wide') return tr.columns || [];
  if (tr.mode === 'long') return [tr.valueField, tr.periodField, tr.dimensionField].filter(Boolean);
  if (tr.mode === 'recipe') {
    const r = tr.recipe || {};
    return [r.periodField, r.valueField, r.numeratorField, r.denominatorField, tr.dimensionField].filter(Boolean);
  }
  if (tr.mode === 'per_record') return [tr.titleField, ...(tr.bodyFields || [])].filter(Boolean);
  if (tr.mode === 'table') return tr.columns || [];
  if (Array.isArray(tr.conditions)) return tr.conditions.map((c) => c.field).filter(Boolean);
  return [sg.sourceField].filter(Boolean);
}

/**
 * DEF-362 — exactly ONE record, as a field → value table (spec §2b Connect: "see the
 * data (1 row only)"). Vertical, so an API record with 40 flattened fields stays
 * readable; the same view serves a Google Sheet's first data row.
 */
export function OneRecord({ record, columns }) {
  if (!record) return null;
  const fields = Array.isArray(columns) && columns.length ? columns : Object.keys(record);
  return (
    <div style={{ overflowX: 'auto', marginTop: 8, maxHeight: 360, overflowY: 'auto' }}>
      <table style={s.table}>
        <thead>
          <tr><th style={s.th}>Field</th><th style={s.th}>Value</th></tr>
        </thead>
        <tbody>
          {fields.map((f) => {
            const v = record[f];
            const blank = v === undefined || v === null || String(v) === '';
            return (
              <tr key={f}>
                <td style={{ ...s.td, ...s.mono, whiteSpace: 'nowrap' }}>{f}</td>
                <td style={{ ...s.td, wordBreak: 'break-word' }}>
                  {blank ? <em style={{ color: 'var(--text-muted)' }}>blank</em> : String(v)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Splits a ReadingKey `${kpiKey}|${periodStart}|${dimensionKey}` for display. */
export function readingParts(key) {
  const [kpi, period, dim] = String(key || '').split('|');
  return { kpi, period, dim: dim || '' };
}

// ── Wizard stage ──────────────────────────────────────────────────────────

/** The server's step-3 stage before any proposal exists (integrationStore.deriveWizardStage). */
export const STAGE_NEEDS_MAPPING = 'Connected — needs a mapping';

/** True once a mapping has been suggested. Step 3 alone does not say so: the server
 *  also uses step 3 for "Connected — needs a mapping". */
export function stageHasMapping(stage) {
  return (stage?.step ?? 1) >= 3 && stage?.label !== STAGE_NEEDS_MAPPING;
}

/** The wizard step to open an integration on: Connect (2) until a mapping exists. */
export function openStepFor(stage) {
  const step = stage?.step ?? 1;
  return step === 3 && !stageHasMapping(stage) ? 2 : step;
}

// ── Run wording ───────────────────────────────────────────────────────────

/**
 * The Result pill. "Updated" ONLY when something was written; a successful run with 0
 * writes is "No changes" (vm §9 — no nonsense "Updated"). Dry runs say what WOULD change.
 */
export function runResult(run) {
  const r = run?.result;
  const writes = Number(r?.writes ?? 0);
  switch (run?.status) {
    case 'RUNNING': return { text: 'Running…', color: C.info };
    case 'FAILED': return { text: 'Failed', color: C.bad };
    case 'ABORTED': return { text: 'Stopped by the safety limit', color: C.warn };
    case 'SUCCESS':
    case 'PARTIAL': {
      const partial = run.status === 'PARTIAL' ? ' (part of the sheet unread)' : '';
      if (run.dryRun) {
        return writes > 0
          ? { text: `Test — ${writes} would change${partial}`, color: C.info }
          : { text: `Test — no changes${partial}`, color: C.grey };
      }
      if (writes > 0) return { text: `Updated${partial}`, color: run.status === 'PARTIAL' ? C.warn : C.ok };
      // 0 writes with notes (e.g. new month columns the mapping does not read)
      // is not a quiet "No changes": the notes say what was left unread.
      return Array.isArray(r?.anomalies) && r.anomalies.length > 0
        ? { text: `No changes — see notes${partial}`, color: C.warn }
        : { text: `No changes${partial}`, color: C.grey };
    }
    default: return { text: run?.status || '—', color: C.grey };
  }
}

/** DEF-362: a change row about a knowledge page rather than a KPI reading. */
export function isContextChange(c) {
  return c?.targetKind === 'context' || String(c?.targetKey || '').startsWith('context:');
}

const PAGE_OP_WORDS = {
  create: { text: 'New page', color: C.ok },
  update: { text: 'Updated', color: C.info },
  stale: { text: 'Marked stale', color: C.warn },
};

function clipText(v, n = 160) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Before → after list of one run's change rows (outcome rows, written in the same
 *  transaction as the data — or the preview rows of a dry run). DEF-362: knowledge-page
 *  rows (create / update / stale) are listed in their own table, since a page has no
 *  period or number. */
export function ChangesList({ changes, loading, dryRun }) {
  const [q, setQ] = useState('');
  if (loading) return <div style={s.hint}>Loading changes…</div>;
  if (!changes || changes.length === 0) {
    return <div style={s.hint}>{dryRun ? 'Nothing would change.' : 'Nothing was changed.'}</div>;
  }
  const needle = q.trim().toLowerCase();
  const rows = needle
    ? changes.filter((c) => `${c.subjectKey} ${c.subjectLabel || ''} ${c.sourceKey || ''}`.toLowerCase().includes(needle))
    : changes;
  const shown = rows.slice(0, 500);
  const readings = shown.filter((c) => !isContextChange(c));
  const pages = shown.filter(isContextChange);
  const hasPages = changes.some(isContextChange);
  return (
    <div>
      <div style={{ ...s.row, marginBottom: 8 }}>
        <input style={{ ...s.input, maxWidth: 260 }} placeholder={hasPages ? 'Filter by KPI, page or record…' : 'Filter by KPI, period or row…'} value={q} onChange={(e) => setQ(e.target.value)} />
        <span style={s.hint}>{rows.length} {rows.length === 1 ? 'change' : 'changes'}{rows.length > shown.length ? ` — first ${shown.length} shown` : ''}</span>
      </div>
      {readings.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>KPI</th><th style={s.th}>Period</th><th style={s.th}>Breakdown</th>
                <th style={s.th}>From</th><th style={{ ...s.th, textAlign: 'right' }}>Before</th>
                <th style={s.th}></th><th style={{ ...s.th, textAlign: 'right' }}>After</th>
              </tr>
            </thead>
            <tbody>
              {readings.map((c) => {
                const p = readingParts(c.subjectKey);
                return (
                  <tr key={c.id}>
                    <td style={s.td}>{c.subjectLabel || p.kpi}</td>
                    <td style={s.td}>{p.period}</td>
                    <td style={s.td}>{p.dim || <span style={{ color: 'var(--text-muted)' }}>Total</span>}</td>
                    <td style={{ ...s.td, color: 'var(--text-muted)' }}>{c.sourceKey || ''}</td>
                    <td style={s.tdNum}>{c.beforeValue ?? <em style={{ color: 'var(--text-muted)' }}>new</em>}</td>
                    <td style={{ ...s.td, color: 'var(--text-muted)' }}>→</td>
                    <td style={s.tdNum}>{c.afterValue ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: readings.length ? 12 : 0 }}>
          <div style={{ ...s.hint, marginBottom: 4 }}>Knowledge pages Brain reads</div>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>Page</th><th style={s.th}>What</th><th style={s.th}>From</th><th style={s.th}>Content</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((c) => {
                const op = PAGE_OP_WORDS[c.op] || { text: c.op, color: C.grey };
                const text = c.op === 'stale' ? c.beforeValue : c.afterValue;
                return (
                  <tr key={c.id}>
                    <td style={s.td}>{c.subjectLabel || c.subjectKey}</td>
                    <td style={s.td}><Pill color={op.color}>{op.text}</Pill></td>
                    <td style={{ ...s.td, color: 'var(--text-muted)' }}>{c.sourceKey || ''}</td>
                    <td style={{ ...s.td, color: 'var(--text-muted)' }} title={String(text ?? '')}>
                      {c.op === 'stale' ? 'The record is no longer in the source. The page is kept and marked stale, never deleted.' : clipText(text)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
