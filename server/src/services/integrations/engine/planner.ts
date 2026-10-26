/**
 * DEF-354 — Integrations Stage 1: the run planner. PURE: no I/O, no clock, no
 * model (spec INTEGRATIONS_DESIGN.md §1 "every run is deterministic code").
 *
 * Ported from vm integrationSyncPlanner.ts (classifyValue, changeCapTripped,
 * isDue / nextScheduledRun), narrowed to Stage 1's one writer (KPI readings)
 * and with the vm defects the port notes list closed here:
 *
 *  - A blank NEVER produces a reading (vm §9 "a blank never overwrites"). The
 *    blank policy only decides whether the blank is reported as an anomaly.
 *  - A value that is not plainly a number is skipped and counted, never coerced
 *    ("1,23" is not 1.23 and not 123 — it is reported). Values travel as
 *    canonical decimal strings so the planner's "unchanged" test and the
 *    database's `IS DISTINCT FROM` guard agree (types.ts header).
 *  - A period that cannot be read without guessing (a bare "January", or
 *    "03/04/2026" which is March or April) is skipped and named, never guessed.
 *  - Two different values for one reading in one sheet: neither is written —
 *    picking one, or summing them, would be a guess about what the sheet means.
 *  - An approved row whose KPI is missing or switched off FAILS the plan
 *    (vm §9 "an unconfigured target fails the run"; critique #18) — never a
 *    silent drop that reports SUCCESS.
 *  - Schedule maths takes the integration's own time zone (vm hard-coded
 *    Asia/Karachi), applies run_time to weekly/monthly too (vm ignored it), and
 *    never owes a slot before activation — a NULL activatedAt owes nothing (vm
 *    fell back to back-filling).
 */
import type {
  ApprovedKpiRow,
  CapVerdict,
  ExistingReadings,
  KpiDefinitionRef,
  KpiGrain,
  KpiPlan,
  PlannedReading,
  PlannerModule,
  ReadingKey,
  ScheduleConfig,
  ValueVerdict,
} from '../types';

/** A definition as the planner can use it. `grain` is optional so the
 *  contract's KpiDefinitionRef still fits; absent ⇒ 'month' (the schema default). */
export type PlannerKpiDef = KpiDefinitionRef & { grain?: KpiGrain | string };

/** dimension_key is VARCHAR(200), and subject_key (kpi|period|dimension) is
 *  VARCHAR(255): 80 + 1 + 10 + 1 + 160 fits. A longer cell is skipped, named. */
const MAX_DIMENSION_LEN = 160;
/** NUMERIC(20,6): at most 14 integer digits and 6 decimals. */
const MAX_INT_DIGITS = 14;
const MAX_EXAMPLES = 3;

export function readingKey(kpiKey: string, periodStart: string, dimensionKey: string): ReadingKey {
  return `${kpiKey}|${periodStart}|${dimensionKey}`;
}

// ── Values ────────────────────────────────────────────────────────────────

/** Cells that mean "nothing here" in hand-kept sheets. Compared lower-cased. */
const BLANK_TOKENS = new Set(['', '-', '--', '–', '—', 'n/a', 'na', '#n/a', 'null', 'nil']);

const CURRENCY_PREFIX = /^(?:[$€£¥₹₨]|rs\.?|pkr|usd|eur|gbp|inr|aed|sar)\s*/i;
const CURRENCY_SUFFIX = /\s*(?:[$€£¥₹₨]|rs\.?|pkr|usd|eur|gbp|inr|aed|sar)$/i;
const PLAIN_NUMBER = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const GROUPED_NUMBER = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

export const parseNumber: PlannerModule['parseNumber'] = (raw) => {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[  ]/g, ' ').trim();
  let negative = false;
  // Accounting negative "(1,234)".
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { negative = true; s = paren[1].trim(); }
  const takeSign = () => {
    const m = /^([+-])\s*/.exec(s);
    if (!m) return false;
    if (m[1] === '-') negative = !negative;
    s = s.slice(m[0].length);
    return true;
  };
  // "-$12", "$-12" and "$ 12" are all the same number; a second sign is not.
  const signedFirst = takeSign();
  s = s.replace(CURRENCY_PREFIX, '');
  if (!signedFirst) takeSign();
  s = s.replace(CURRENCY_SUFFIX, '');
  s = s.replace(/\s*%$/, '').trim();
  if (!PLAIN_NUMBER.test(s) && !GROUPED_NUMBER.test(s)) return null;
  return canonicalDecimal(s.replace(/,/g, ''), negative);
};

/** "0012.3400" ⇒ "12.34"; rounded half away from zero to 6 decimals, exactly as
 *  NUMERIC(20,6) stores it, so a re-read of the stored value compares equal. */
function canonicalDecimal(unsigned: string, negative: boolean): string | null {
  const [intRaw, fracRaw = ''] = unsigned.split('.');
  const intDigits = (intRaw || '0').replace(/^0+(?=\d)/, '');
  const frac7 = (fracRaw + '0000000').slice(0, 7);
  const rounded = (BigInt(intDigits + frac7) + 5n) / 10n;
  const digits = rounded.toString().padStart(7, '0');
  const intPart = digits.slice(0, -6);
  const fracPart = digits.slice(-6).replace(/0+$/, '');
  if (intPart.length > MAX_INT_DIGITS) return null;
  const body = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative && body !== '0' ? `-${body}` : body;
}

function quote(raw: string): string {
  const s = raw.length > 40 ? `${raw.slice(0, 37)}...` : raw;
  return `"${s}"`;
}

export const classifyValue: PlannerModule['classifyValue'] = (raw, policy): ValueVerdict => {
  let text: string;
  if (raw === null || raw === undefined) text = '';
  else if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { kind: 'invalid', reason: `${String(raw)} is not a number` };
    text = String(raw);
  } else if (typeof raw === 'string') text = raw;
  else return { kind: 'invalid', reason: 'the cell does not hold a number' };

  const trimmed = text.replace(/[  ]/g, ' ').trim();
  if (BLANK_TOKENS.has(trimmed.toLowerCase())) {
    return policy === 'abnormal'
      ? { kind: 'blank_alert', reason: 'blank where a number was expected — the existing figure was kept' }
      : { kind: 'blank_expected', reason: 'blank — skipped, the existing figure was kept' };
  }
  const value = parseNumber(trimmed);
  if (value === null) return { kind: 'invalid', reason: `${quote(trimmed)} is not a number` };
  return { kind: 'ok', value };
};

// ── Periods ───────────────────────────────────────────────────────────────

type Precision = 'day' | 'month';
interface ParsedPeriod { y: number; m: number; d: number; precision: Precision }

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function mk(y: number, m: number, d: number, precision: Precision): ParsedPeriod | null {
  if (!(y >= 1900 && y <= 2199) || !(m >= 1 && m <= 12)) return null;
  if (!(d >= 1 && d <= daysInMonth(y, m))) return null;
  return { y, m, d, precision };
}

function monthOf(name: string): number | null {
  return MONTHS[name.toLowerCase().replace(/\.$/, '')] ?? null;
}

/** Reads a period cell or a wide-column header. Returns null rather than guess. */
function parsePeriodDetailed(raw: string): ParsedPeriod | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[  ]/g, ' ').trim();
  if (!s) return null;
  let m: RegExpExecArray | null;

  // ISO-like, optional time: 2026-01-15, 2026/01/15, 2026-01-15T00:00:00Z
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/.exec(s))) return mk(+m[1], +m[2], +m[3], 'day');
  // Year + month: 2026-01, 2026/1
  if ((m = /^(\d{4})[-/.](\d{1,2})$/.exec(s))) return mk(+m[1], +m[2], 1, 'month');
  // Month + year: 01/2026, 1-2026
  if ((m = /^(\d{1,2})[-/.](\d{4})$/.exec(s))) return mk(+m[2], +m[1], 1, 'month');
  // Numeric day + month + year. Day-first and month-first are both common;
  // when both parts could be the month and they differ, the date is ambiguous.
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s.*)?$/.exec(s))) {
    const a = +m[1]; const b = +m[2]; const y = +m[3];
    if (a > 12 && b <= 12) return mk(y, b, a, 'day');
    if (b > 12 && a <= 12) return mk(y, a, b, 'day');
    if (a === b) return mk(y, a, b, 'day');
    return null;
  }
  // Jan 2026, January-2026, Jan, 2026, Sept. 2026
  if ((m = /^([A-Za-z]+\.?)\s*[-/,\s]?\s*(\d{4})$/.exec(s))) {
    const mo = monthOf(m[1]);
    return mo ? mk(+m[2], mo, 1, 'month') : null;
  }
  // Jan-26, Jan '26 (Sheets' "MMM-yy"). A space alone ("Jan 26") reads as a day, so it is not accepted.
  if ((m = /^([A-Za-z]+\.?)\s*(?:-|')\s*'?(\d{2})$/.exec(s))) {
    const mo = monthOf(m[1]);
    return mo ? mk(2000 + +m[2], mo, 1, 'month') : null;
  }
  // 2026 Jan, 2026-January
  if ((m = /^(\d{4})\s*[-/\s]\s*([A-Za-z]+\.?)$/.exec(s))) {
    const mo = monthOf(m[2]);
    return mo ? mk(+m[1], mo, 1, 'month') : null;
  }
  // 15 Jan 2026, 15-Jan-2026
  if ((m = /^(\d{1,2})\s*[-\s]\s*([A-Za-z]+\.?)\s*[-\s,]\s*(\d{4})$/.exec(s))) {
    const mo = monthOf(m[2]);
    return mo ? mk(+m[3], mo, +m[1], 'day') : null;
  }
  // Jan 15, 2026
  if ((m = /^([A-Za-z]+\.?)\s+(\d{1,2}),?\s+(\d{4})$/.exec(s))) {
    const mo = monthOf(m[1]);
    return mo ? mk(+m[3], mo, +m[2], 'day') : null;
  }
  // A bare month name ("January") has no year, a bare year has no month, a
  // quarter has no grain here: all unreadable without a guess.
  return null;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const parsePeriod: PlannerModule['parsePeriod'] = (raw) => {
  const p = parsePeriodDetailed(raw);
  return p ? iso(p.y, p.m, p.d) : null;
};

/** First day of the KPI's grain period, or null when the source is coarser
 *  than the grain (a month figure cannot be a day's or a week's reading). */
function alignToGrain(p: ParsedPeriod, grain: string): string | null {
  if (grain === 'day') return p.precision === 'day' ? iso(p.y, p.m, p.d) : null;
  if (grain === 'week') {
    if (p.precision !== 'day') return null;
    // ISO week: periods start on Monday.
    const t = Date.UTC(p.y, p.m - 1, p.d);
    const dow = new Date(t).getUTCDay();
    const monday = new Date(t - ((dow + 6) % 7) * 86_400_000);
    return iso(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  }
  return iso(p.y, p.m, 1); // 'month' and the default
}

/** The reading date a run would give this period cell/header for a KPI of
 *  this grain, or null when a run would skip it. The design-time risk check
 *  (mapping/mappingRisk) uses THIS, so what an admin approves is what runs write. */
export function periodStartFor(raw: string, grain: string = 'month'): string | null {
  const parsed = parsePeriodDetailed(raw);
  return parsed ? alignToGrain(parsed, grain) : null;
}

// ── The plan ──────────────────────────────────────────────────────────────

/** Counts per field + a few real examples, so an anomaly names what to fix. */
class Tally {
  private readonly m = new Map<string, { n: number; ex: string[] }>();
  add(field: string, example?: string): void {
    const e = this.m.get(field) ?? { n: 0, ex: [] };
    e.n += 1;
    if (example !== undefined && e.ex.length < MAX_EXAMPLES && !e.ex.includes(example)) e.ex.push(example);
    this.m.set(field, e);
  }
  entries(): Array<[string, { n: number; ex: string[] }]> { return [...this.m.entries()]; }
}

interface Candidate {
  kpiKey: string;
  periodStart: string;
  dimensionKey: string;
  value: string;
  sourceKey: string;
  cells: number;
  conflict: boolean;
}

export const planKpiReadings: PlannerModule['planKpiReadings'] = (
  records, approvedRows, defs, existing, policy = 'abnormal',
): KpiPlan => {
  const defsByKey = new Map<string, PlannerKpiDef>((defs as PlannerKpiDef[]).map((d) => [d.kpiKey, d]));
  const plan: KpiPlan = {
    readings: [], unchanged: 0, blanks: 0, skipped: 0, subjectsAffected: 0, anomalies: [], failure: null,
  };

  // Unconfigured target ⇒ the whole run fails, before anything is planned.
  const failures: string[] = [];
  for (const row of approvedRows) {
    const key = row.targetKey.slice('kpi:'.length);
    const def = defsByKey.get(key);
    if (key.startsWith('new:')) {
      failures.push(`The approved field "${row.sourceField}" still points at an unsaved new KPI (${key.slice(4)}).`);
    } else if (!def) {
      failures.push(`The approved field "${row.sourceField}" feeds the KPI "${key}", which is no longer in the KPI catalogue.`);
    } else if (!def.isActive) {
      failures.push(`The approved field "${row.sourceField}" feeds the KPI "${def.label}" (${key}), which is switched off.`);
    }
  }
  if (failures.length) {
    plan.failure = failures.join(' ');
    return plan;
  }

  const candidates = new Map<ReadingKey, Candidate>();
  const blankAlerts = new Tally();
  const invalid = new Tally();
  const badPeriods = new Tally();
  const badDims = new Tally();

  const consider = (kpiKey: string, periodStart: string, dimensionKey: string, value: string, sourceKey: string) => {
    const k = readingKey(kpiKey, periodStart, dimensionKey);
    const c = candidates.get(k);
    if (!c) {
      candidates.set(k, { kpiKey, periodStart, dimensionKey, value, sourceKey, cells: 1, conflict: false });
      return;
    }
    c.cells += 1;
    if (c.value !== value) c.conflict = true;
  };

  /** Classifies one cell; returns the value or null (already counted). */
  const valueOf = (cell: string | undefined, field: string, rowNo: number): string | null => {
    const v = classifyValue(cell ?? '', policy);
    if (v.kind === 'ok') return v.value;
    if (v.kind === 'blank_expected') { plan.blanks += 1; return null; }
    if (v.kind === 'blank_alert') { plan.blanks += 1; blankAlerts.add(field, `row ${rowNo}`); return null; }
    plan.skipped += 1;
    invalid.add(field, (cell ?? '').trim());
    return null;
  };

  /** '' (the total) or `<field>=<cell>`; null = skip this record (counted). */
  const dimensionOf = (rec: Record<string, string>, field: string | undefined): string | null => {
    if (!field) return '';
    const cell = (rec[field] ?? '').trim();
    if (!cell || cell.length > MAX_DIMENSION_LEN) {
      plan.skipped += 1;
      badDims.add(field, cell ? `${cell.slice(0, 37)}...` : '(blank)');
      return null;
    }
    return `${field}=${cell}`;
  };

  for (const row of approvedRows) {
    const kpiKey = row.targetKey.slice('kpi:'.length);
    const grain = String(defsByKey.get(kpiKey)?.grain ?? 'month');
    const t = row.transform;

    if (t.mode === 'long') {
      records.forEach((rec, i) => {
        const rowNo = i + 2; // row 1 of the sheet is the header
        const value = valueOf(rec[t.valueField], t.valueField, rowNo);
        if (value === null) return;
        const rawPeriod = (rec[t.periodField] ?? '').trim();
        const parsed = parsePeriodDetailed(rawPeriod);
        const periodStart = parsed ? alignToGrain(parsed, grain) : null;
        if (!periodStart) {
          plan.skipped += 1;
          badPeriods.add(t.periodField, rawPeriod || '(blank)');
          return;
        }
        const dim = dimensionOf(rec, t.dimensionField);
        if (dim === null) return;
        consider(kpiKey, periodStart, dim, value, `row ${rowNo} › ${t.valueField}`);
      });
      continue;
    }

    // wide: the period is each column's HEADER. A header that is not a period
    // is never guessed at — its column is not read and the admin is told.
    for (const col of t.columns) {
      const parsed = parsePeriodDetailed(col);
      const periodStart = parsed ? alignToGrain(parsed, grain) : null;
      if (!periodStart) {
        plan.anomalies.push(parsed
          ? `Column ${quote(col)} is a ${parsed.precision === 'month' ? 'month' : 'date'}, but the KPI "${kpiKey}" is kept per ${grain} — its cells were not read.`
          : `Column ${quote(col)} is not a period Nexeo can read without guessing — its cells were not read for "${kpiKey}".`);
        for (const rec of records) {
          if (classifyValue(rec[col] ?? '', 'normal').kind === 'ok') plan.skipped += 1;
        }
        continue;
      }
      records.forEach((rec, i) => {
        const rowNo = i + 2;
        const value = valueOf(rec[col], col, rowNo);
        if (value === null) return;
        const dim = dimensionOf(rec, t.dimensionField);
        if (dim === null) return;
        consider(kpiKey, periodStart, dim, value, `row ${rowNo} › ${col}`);
      });
    }
  }

  // Conflicting values for one reading: none is written (no guess).
  const conflicts: string[] = [];
  const touched = new Set<ReadingKey>();
  for (const [k, c] of candidates) {
    if (c.conflict) {
      plan.skipped += c.cells;
      if (conflicts.length < MAX_EXAMPLES) conflicts.push(`${c.kpiKey} ${c.periodStart}${c.dimensionKey ? ` ${c.dimensionKey}` : ''}`);
      continue;
    }
    const prior = existing.get(k);
    const before = prior == null ? null : (parseNumber(prior) ?? prior);
    if (before !== null && before === c.value) { plan.unchanged += 1; continue; }
    const reading: PlannedReading = {
      kpiKey: c.kpiKey, periodStart: c.periodStart, dimensionKey: c.dimensionKey,
      value: c.value, sourceKey: c.sourceKey, before,
    };
    plan.readings.push(reading);
    touched.add(k);
  }
  plan.subjectsAffected = touched.size;

  const conflictCount = [...candidates.values()].filter((c) => c.conflict).length;
  if (conflictCount) {
    plan.anomalies.push(`${conflictCount} reading(s) have more than one different value in the sheet (e.g. ${conflicts.join('; ')}) — none of those values was written.`);
  }
  for (const [field, { n, ex }] of blankAlerts.entries()) {
    plan.anomalies.push(`${n} blank cell(s) in "${field}" (${ex.join(', ')}${n > ex.length ? ', …' : ''}) — the existing figures were kept.`);
  }
  for (const [field, { n, ex }] of invalid.entries()) {
    plan.anomalies.push(`${n} cell(s) in "${field}" are not numbers (e.g. ${ex.map(quote).join(', ')}) — skipped.`);
  }
  for (const [field, { n, ex }] of badPeriods.entries()) {
    plan.anomalies.push(`${n} row(s) have a "${field}" that is not a readable period (e.g. ${ex.map(quote).join(', ')}) — skipped.`);
  }
  for (const [field, { n, ex }] of badDims.entries()) {
    plan.anomalies.push(`${n} row(s) have no usable "${field}" (e.g. ${ex.map(quote).join(', ')}) — skipped.`);
  }
  return plan;
};

// ── Change cap ────────────────────────────────────────────────────────────

/** integration_runs.change_percent is DECIMAL(6,2): a larger value would
 *  overflow the run's close and leave the row RUNNING (the mutex held). */
export const MAX_CHANGE_PCT = 9999.99;

/** vm changeCapTripped (P:919). owned 0 is a first load and never trips.
 *  `changed` = rewrites of readings that already exist (never inserts). */
export const changeCapVerdict: PlannerModule['changeCapVerdict'] = (changed, owned, capPct): CapVerdict => {
  if (owned <= 0) return { wouldTrip: false, pct: 0, cap: capPct };
  const raw = Math.round((changed / owned) * 1000) / 10;
  return { wouldTrip: raw > capPct, pct: Math.min(raw, MAX_CHANGE_PCT), cap: capPct };
};

// ── Schedule (time-zone aware, no library: Intl only) ─────────────────────

const RUN_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;
/** Enough days to find any monthly slot (incl. a clamped 31st / -1) twice over. */
const SEARCH_DAYS = 64;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    // Throws RangeError on an unknown zone — deliberately: a schedule in a zone
    // we cannot read must not silently run on some other clock.
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of `ms` in `tz`, as a UTC epoch (i.e. ms + offset). */
function wallAsUtc(ms: number, tz: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(tz).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** The instant the wall clock in `tz` reads y-m-d hh:mm. */
function zonedToInstant(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = wallAsUtc(guess, tz) - guess;
  let t = guess - off1;
  const off2 = wallAsUtc(t, tz) - t;
  if (off2 !== off1) t = guess - off2; // crossed a DST change
  return new Date(t);
}

/** Calendar day number (days since epoch) of `at` on the wall clock of `tz`. */
function localDayNumber(at: Date, tz: string): number {
  return Math.floor(wallAsUtc(Math.floor(at.getTime() / 1000) * 1000, tz) / DAY_MS);
}

/** The slot on local day `dn`, or null when the schedule has none that day. */
function slotOnDay(s: ScheduleConfig, dn: number, tz: string): Date | null {
  const rt = RUN_TIME_RE.exec(s.runTime ?? '');
  if (!rt) return null;
  const day = new Date(dn * DAY_MS);
  const y = day.getUTCFullYear(); const m = day.getUTCMonth() + 1; const d = day.getUTCDate();
  if (s.frequency === 'weekly') {
    if (s.dayOfWeek == null || day.getUTCDay() !== s.dayOfWeek) return null;
  } else if (s.frequency === 'monthly') {
    if (s.dayOfMonth == null) return null;
    const dim = daysInMonth(y, m);
    // -1 = last day; 29–31 clamp to a shorter month's last day (vm rule).
    const target = s.dayOfMonth === -1 ? dim : Math.min(s.dayOfMonth, dim);
    if (s.dayOfMonth !== -1 && s.dayOfMonth < 1) return null;
    if (d !== target) return null;
  } else if (s.frequency !== 'daily') {
    return null; // 'once' and anything unknown: never scheduled
  }
  return zonedToInstant(y, m, d, Number(rt[1]), Number(rt[2]), tz);
}

/**
 * The most recent slot at or before `now`, if not yet claimed and not before
 * activation. Missed slots collapse to the latest one: a server that was down
 * for three days runs once, not three times (vm's runaway was 151 runs/day).
 */
export const isDue: PlannerModule['isDue'] = (schedule, now, lastSlotAt, activatedAt, tz) => {
  if (schedule.frequency === 'once' || !activatedAt) return null;
  const today = localDayNumber(now, tz);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const slot = slotOnDay(schedule, today - i, tz);
    if (!slot || slot.getTime() > now.getTime()) continue;
    // "Turning on never runs anything": a slot before activation is not owed.
    if (slot.getTime() < activatedAt.getTime()) return null;
    if (lastSlotAt && lastSlotAt.getTime() >= slot.getTime()) return null;
    return slot;
  }
  return null;
};

export const nextScheduledRun: PlannerModule['nextScheduledRun'] = (schedule, after, tz) => {
  if (schedule.frequency === 'once') return null;
  const start = localDayNumber(after, tz);
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const slot = slotOnDay(schedule, start + i, tz);
    if (slot && slot.getTime() > after.getTime()) return slot;
  }
  return null;
};

export const planner: PlannerModule = {
  classifyValue, parseNumber, parsePeriod, planKpiReadings, changeCapVerdict, isDue, nextScheduledRun,
};
