/**
 * DEF-354 §2.8 — Brain's `fetch_kpis` tool: Brain sees the numbers Integrations
 * import, and only the numbers it is entitled to see.
 *
 * Rules pinned here (each assertion fails when the rule is weakened):
 *  - TENANT SCOPING: readings, definitions AND the integration name are read
 *    for ctx.clientNumber only (AGENTS tenant rule; raw SQL is not covered by
 *    the Prisma tenant extension, so the binding must be in the statement).
 *  - EMPTY STATE: no readings ⇒ the explicit "(no KPI readings yet — none have
 *    been imported)", never zeros (spec §1: a missing reading is no row).
 *  - LATEST-PERIODS DEFAULT: no range ⇒ the latest 3 periods per KPI; a range
 *    ⇒ every period in it. Max 60 lines.
 *  - INACTIVE DEFINITIONS EXCLUDED: a retired KPI is not a current fact.
 *  - A FAILED lookup is a tool error, never "none imported" (DEF-108b).
 *
 * The fake `$queryRawUnsafe` below evaluates the rows in JS and applies each
 * guard ONLY IF the SQL text still contains it (same approach as
 * def354IntegrationFakeDb.ts), so deleting a guard from the statement turns
 * the matching test red instead of passing on a mocked answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Def { client_number: string; kpi_key: string; label: string; unit: string | null; grain: string; is_active: boolean }
interface Reading { client_number: string; kpi_key: string; period_start: string; dimension_key: string; value: string; integration_id: string; written_at: Date }
interface Integ { id: string; client_number: string; name: string }

const db = vi.hoisted(() => ({
  defs: [] as any[],
  readings: [] as any[],
  integs: [] as any[],
  calls: [] as Array<{ sql: string; params: any[] }>,
  fail: false,
}));

function evalMain(sql: string, p: any[]): any[] {
  const [cn, key, from, toEx, dim, useLatest, rankN, limit] = p;
  const has = (s: string) => sql.includes(s);
  const joined: any[] = [];
  for (const d of db.defs as Def[]) {
    if (has('d.client_number = $1') && d.client_number !== cn) continue;
    if (has('d.is_active = TRUE') && !d.is_active) continue;
    if (has('d.kpi_key = $2') && key != null && d.kpi_key !== key) continue;
    for (const r of db.readings as Reading[]) {
      if (r.kpi_key !== d.kpi_key) continue;
      if (has('r.client_number = d.client_number') && r.client_number !== d.client_number) continue;
      if (has('r.period_start >= $3') && from != null && r.period_start < from) continue;
      if (has('r.period_start <  $4') && toEx != null && r.period_start >= toEx) continue;
      if (has("r.dimension_key ILIKE '%' || $5") && dim != null
        && !r.dimension_key.toLowerCase().includes(String(dim).toLowerCase())) continue;
      const i = (db.integs as Integ[]).find((x) => x.id === r.integration_id
        && (!has('i.client_number = r.client_number') || x.client_number === r.client_number));
      joined.push({ ...d, ...r, kpi_key: d.kpi_key, integration_name: i?.name ?? null });
    }
  }
  // DENSE_RANK per kpi_key by period_start DESC.
  const periodsByKey = new Map<string, string[]>();
  for (const j of joined) {
    const arr = periodsByKey.get(j.kpi_key) ?? [];
    if (!arr.includes(j.period_start)) arr.push(j.period_start);
    periodsByKey.set(j.kpi_key, arr);
  }
  for (const arr of periodsByKey.values()) arr.sort().reverse();
  let out = joined.map((j) => ({ ...j, period_rank: periodsByKey.get(j.kpi_key)!.indexOf(j.period_start) + 1 }));
  if (has('x.period_rank <= $7') && useLatest) out = out.filter((j) => j.period_rank <= rankN);
  out.sort((a, b) => a.label.localeCompare(b.label) || a.kpi_key.localeCompare(b.kpi_key)
    || b.period_start.localeCompare(a.period_start) || a.dimension_key.localeCompare(b.dimension_key));
  return out.slice(0, limit);
}

function evalKeys(sql: string, p: any[]): any[] {
  const [cn] = p;
  const seen = new Map<string, any>();
  for (const d of db.defs as Def[]) {
    if (sql.includes('d.client_number = $1') && d.client_number !== cn) continue;
    if (sql.includes('d.is_active = TRUE') && !d.is_active) continue;
    if (!(db.readings as Reading[]).some((r) => r.kpi_key === d.kpi_key && r.client_number === d.client_number)) continue;
    seen.set(d.kpi_key, { kpi_key: d.kpi_key, label: d.label });
  }
  return [...seen.values()];
}

vi.mock('../src/db/prisma', () => {
  const p: any = {
    $queryRawUnsafe: async (sql: string, ...params: any[]) => {
      db.calls.push({ sql, params });
      if (db.fail) throw new Error('relation "kpi_readings" does not exist');
      return sql.includes('SELECT DISTINCT') ? evalKeys(sql, params) : evalMain(sql, params);
    },
  };
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/views', () => ({ getOpenItems: async () => [], getTodayCalendar: async () => [] }));

import { BRAIN_TOOLS, executeBrainTool, renderToolCatalogue } from '../src/services/knowledge/brainTools';

const A = 'TMC-0001';
const B = 'TMC-0002';
const CTX = { userId: 2, clientNumber: A };
const tool = () => BRAIN_TOOLS.find((t) => t.name === 'fetch_kpis')!;
const W = new Date('2026-10-20T09:00:00Z');

function def(cn: string, key: string, label: string, extra: Partial<Def> = {}): Def {
  return { client_number: cn, kpi_key: key, label, unit: 'PKR', grain: 'month', is_active: true, ...extra };
}
function rd(cn: string, key: string, period: string, value: string, dimension_key = '', integration_id = 'int-a'): Reading {
  return { client_number: cn, kpi_key: key, period_start: period, dimension_key, value, integration_id, written_at: W };
}

beforeEach(() => {
  db.defs = []; db.readings = []; db.integs = []; db.calls = []; db.fail = false;
  db.integs.push({ id: 'int-a', client_number: A, name: 'Sales sheet' });
});

describe('registration', () => {
  it('is in BRAIN_TOOLS and the rendered catalogue, read-only shape', () => {
    expect(tool()).toBeDefined();
    expect(renderToolCatalogue()).toContain('**fetch_kpis**');
    const props = Object.keys(tool().inputSchema.properties);
    expect(props.sort()).toEqual(['dimension', 'kpi_key', 'period_from', 'period_to']);
    expect(tool().inputSchema.required ?? []).toEqual([]);
  });

  it('its description tells the model when to use it (business numbers by period/region)', () => {
    const d = tool().description.toLowerCase();
    for (const w of ['revenue', 'sales', 'receivables', 'target', 'month', 'region']) expect(d).toContain(w);
  });
});

describe('tenant scoping', () => {
  it('never returns another tenant\'s readings, definitions or integration name', async () => {
    db.defs.push(def(A, 'revenue', 'Revenue'), def(B, 'revenue', 'Revenue'), def(B, 'secret_margin', 'Secret margin'));
    db.integs.push({ id: 'int-b', client_number: B, name: 'Other tenant sheet' });
    db.readings.push(
      rd(A, 'revenue', '2026-09-01', '100.000000'),
      rd(B, 'revenue', '2026-09-01', '999999.000000', '', 'int-b'),
      rd(B, 'secret_margin', '2026-09-01', '42.000000', '', 'int-b'),
    );
    const out = await tool().handler({}, CTX);
    expect(out).toContain('Revenue (revenue) · 2026-09 · total: 100 PKR');
    expect(out).not.toContain('999,999');
    expect(out).not.toContain('Secret margin');
    expect(out).not.toContain('Other tenant sheet');
    expect(db.calls[0].params[0]).toBe(A);
  });

  it('an integration id belonging to another tenant does not lend its name', async () => {
    db.defs.push(def(A, 'revenue', 'Revenue'));
    db.integs.length = 0;
    db.integs.push({ id: 'int-x', client_number: B, name: 'Foreign sheet' });
    db.readings.push(rd(A, 'revenue', '2026-09-01', '5', '', 'int-x'));
    const out = await tool().handler({}, CTX);
    expect(out).not.toContain('Foreign sheet');
    expect(out).toContain('source: integration (since deleted)');
  });

  it('the no-match key list is tenant-scoped too', async () => {
    db.defs.push(def(A, 'revenue', 'Revenue'), def(B, 'secret_margin', 'Secret margin'));
    db.readings.push(rd(A, 'revenue', '2026-09-01', '5'), rd(B, 'secret_margin', '2026-09-01', '1', '', 'int-b'));
    const out = await tool().handler({ kpi_key: 'collections' }, CTX);
    expect(out).toContain('no KPI readings match');
    expect(out).toContain('Revenue (revenue)');
    expect(out).not.toContain('secret_margin');
  });
});

describe('empty state', () => {
  it('says explicitly that none have been imported — never zeros', async () => {
    const out = await tool().handler({}, CTX);
    expect(out).toBe('# Business KPIs\n(no KPI readings yet — none have been imported)');
  });

  it('definitions without readings are still "none imported"', async () => {
    db.defs.push(def(A, 'revenue', 'Revenue'));
    const out = await tool().handler({ kpi_key: 'revenue' }, CTX);
    expect(out).toContain('(no KPI readings yet — none have been imported)');
  });

  it('a FAILED lookup is a tool error, not "none imported" (DEF-108b)', async () => {
    db.fail = true;
    const out = await executeBrainTool('fetch_kpis', {}, CTX);
    expect(out).toMatch(/^# Tool error \(fetch_kpis\)/);
    expect(out).not.toContain('none have been imported');
  });
});

describe('latest-periods default and ranges', () => {
  beforeEach(() => {
    db.defs.push(def(A, 'revenue', 'Revenue'));
    for (const m of ['05', '06', '07', '08', '09']) {
      db.readings.push(rd(A, 'revenue', `2026-${m}-01`, `${Number(m)}000.500000`));
      db.readings.push(rd(A, 'revenue', `2026-${m}-01`, `${Number(m)}00`, 'region=North'));
    }
  });

  it('no range ⇒ the latest 3 periods per KPI (every dimension of each), newest first', async () => {
    const out = await tool().handler({}, CTX);
    expect(out).toContain('latest 3 periods per KPI');
    expect(out).toContain('2026-09 · total: 9,000.5 PKR');
    expect(out).toContain('2026-09 · region=North: 900 PKR');
    expect(out).toContain('2026-07');
    expect(out).not.toContain('2026-06');
    expect(out).not.toContain('2026-05');
    expect(out.indexOf('2026-09')).toBeLessThan(out.indexOf('2026-07'));
    expect(out).toContain('source: integration Sales sheet, written 2026-10-20');
  });

  it('the default window is PER KPI, not global', async () => {
    db.defs.push(def(A, 'receivables', 'Receivables', { unit: null }));
    db.readings.push(rd(A, 'receivables', '2025-01-01', '7'));
    const out = await tool().handler({}, CTX);
    expect(out).toContain('Receivables (receivables) · 2025-01 · total: 7');
  });

  it('a range ⇒ every period inside it, bounds inclusive', async () => {
    const out = await tool().handler({ period_from: '2026-05', period_to: '2026-06' }, CTX);
    expect(out).toContain('2026-05');
    expect(out).toContain('2026-06');
    expect(out).not.toContain('2026-07');
  });

  it('dimension filter narrows to the matching breakdown', async () => {
    const out = await tool().handler({ dimension: 'north' }, CTX);
    expect(out).toContain('region=North');
    expect(out).not.toContain('· total:');
  });

  it('caps output at 60 lines and says more exist', async () => {
    db.readings.length = 0;
    for (let i = 0; i < 70; i++) db.readings.push(rd(A, 'revenue', '2026-09-01', String(i), `branch=${String(i).padStart(3, '0')}`));
    const out = await tool().handler({}, CTX);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(60);
    expect(out).toContain('more exist');
  });

  it('rejects a malformed period or key instead of guessing', async () => {
    expect(await tool().handler({ period_from: 'Sept' }, CTX)).toContain('invalid period');
    expect(await tool().handler({ kpi_key: 'Revenue; DROP' }, CTX)).toContain('invalid kpi_key');
    expect(db.calls).toHaveLength(0);
  });
});

describe('inactive definitions excluded', () => {
  it('a retired KPI\'s readings are not reported', async () => {
    db.defs.push(def(A, 'revenue', 'Revenue'), def(A, 'old_margin', 'Old margin', { is_active: false }));
    db.readings.push(rd(A, 'revenue', '2026-09-01', '10'), rd(A, 'old_margin', '2026-09-01', '3'));
    const out = await tool().handler({}, CTX);
    expect(out).toContain('Revenue');
    expect(out).not.toContain('Old margin');
  });

  it('only inactive KPIs with readings ⇒ "none imported", not their numbers', async () => {
    db.defs.push(def(A, 'old_margin', 'Old margin', { is_active: false }));
    db.readings.push(rd(A, 'old_margin', '2026-09-01', '3'));
    expect(await tool().handler({}, CTX)).toContain('none have been imported');
  });
});
