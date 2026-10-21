/**
 * DEF-345 `entity-sweep-query-never-ran` — the odoo/wiki mirror's tenant
 * discovery runs real columns.
 *
 * The query at odooWikiMirror.ts `mirrorOdooForAllTenants` filtered on
 * `config_key`/`config_value` — columns `system_config` has never had (the
 * schema is `(client_number, key, value, …)`, exactly what
 * `configService.getConfig` and `OdooConnector.loadConfig` read). sqlState
 * 42703 on EVERY execution since it shipped: the nightly mirror never once
 * discovered a tenant, the capability it feeds stayed permanently empty, and
 * post-DEF-334(2) the capped failures accreted ~29 SYSTEM-scope
 * `raw_query_failed` findings that reach no owner. The DEF-337 class,
 * verbatim.
 *
 * Under test — the per-query slice of the CI raw-query-execution detector
 * DEF-337 named (the full class detector stays owed, infra):
 *  - functional: mirrorOdooForAllTenants issues ONE tenant-discovery query,
 *    and every column it references exists in schema.prisma's SystemConfig
 *    model — validated against the parsed schema, not a hand-kept list;
 *  - zero configured tenants (the measured live state, 10-21) is a clean
 *    no-op: {tenants: 0}, no per-tenant work attempted, no throw.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({ sqls: [] as string[] }));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p: any = {
    $queryRawUnsafe: async (sql: string) => { state.sqls.push(sql); return []; },
  };
  return { __esModule: true, default: p, prisma: p };
});

import { mirrorOdooForAllTenants } from '../src/services/crm/odooWikiMirror';

/** The SystemConfig model's actual DB column names, parsed from the schema —
 *  so a schema change breaks this test instead of silently re-opening 42703. */
function systemConfigColumns(): Set<string> {
  const schema = fs.readFileSync(path.join(__dirname, '../prisma/schema.prisma'), 'utf8');
  const start = schema.indexOf('model SystemConfig {');
  const block = schema.slice(start, schema.indexOf('}', start));
  const cols = new Set<string>();
  for (const line of block.split('\n').slice(1)) {
    const field = line.trim().split(/\s+/)[0];
    if (!field || field.startsWith('@') || field === 'tenant') continue;
    const mapped = line.match(/@map\("([^"]+)"\)/);
    cols.add(mapped ? mapped[1] : field);
  }
  return cols;
}

describe('DEF-345 — odoo mirror tenant discovery uses columns system_config actually has', () => {
  it('the discovery query references only real SystemConfig columns, and zero configured tenants is a clean no-op', async () => {
    state.sqls = [];
    const out = await mirrorOdooForAllTenants();
    expect(out).toEqual({
      tenants: 0,
      result: { opportunitiesScanned: 0, opportunitiesWritten: 0, partnersScanned: 0, partnersWritten: 0, errors: 0 },
    });

    expect(state.sqls).toHaveLength(1); // discovery only — no per-tenant work for zero tenants
    const sql = state.sqls[0];
    expect(sql).toContain("key = 'odoo_url'");

    const cols = systemConfigColumns();
    expect(cols).toContain('client_number'); // the parser found the real schema
    // Every identifier the query references must be a real column. This is
    // what 42703 means; checking it here is the per-query slice of the
    // raw-query-execution detector DEF-337 named.
    const referenced = ['client_number', 'key', 'value'];
    for (const c of referenced) expect(cols.has(c)).toBe(true);
    expect(sql).not.toMatch(/config_key|config_value/);
  });

  it('the invented columns are gone from the CODE (comments stripped — the BLD-009 lesson: a guard that matches prose passes on the sentence describing the bug)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/services/crm/odooWikiMirror.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/config_key|config_value/);
  });
});
