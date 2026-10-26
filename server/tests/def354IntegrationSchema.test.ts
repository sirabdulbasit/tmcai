/**
 * DEF-354 — Integrations Stage 1 schema contract.
 *
 * Pins three rules of INTEGRATIONS_DESIGN.md §2.1:
 *   1. every timestamp on an Integration* / Kpi* model is TIMESTAMPTZ (vm §5:
 *      a schedule slot compared against a zone-less timestamp drifts by the
 *      server's offset). The ONE exemption is kpi_readings.period_start, a
 *      calendar DATE on purpose — a period is a day, not an instant;
 *   2. the hand-written migration creates every @@map table, and carries the
 *      DB-level invariants (one APPROVED version, one RUNNING run, ACTIVE ⇒
 *      activated + approved, cuid/text run-change id);
 *   3. every new model is in TENANT_SCOPED_MODELS (tenant scoping on every query).
 * Falsifier: drop @db.Timestamptz from any of these DateTimes, rename a table,
 * remove a partial unique index or a registry entry — this file goes red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const migrationRaw = readFileSync(
  join(ROOT, 'prisma/migrations/20261026_integrations_core/migration.sql'), 'utf8');
/** SQL with `--` comments stripped, so prose ("a BIGINT id cannot…") never satisfies or trips a check. */
const migration = migrationRaw.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

const MODELS = [
  'IntegrationSync', 'IntegrationMappingVersion', 'IntegrationSuggestion',
  'IntegrationRun', 'IntegrationRunChange', 'KpiDefinition', 'KpiReading',
];
/** Calendar dates, not instants. Adding to this list needs a reason in the schema. */
const DATE_EXEMPT = new Set(['KpiReading.periodStart']);

function modelBody(name: string): string {
  const m = schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (!m) throw new Error(`model ${name} not found in schema.prisma`);
  return m[1];
}

describe('DEF-354 integrations schema', () => {
  it('declares all seven models', () => {
    for (const name of MODELS) expect(() => modelBody(name)).not.toThrow();
  });

  it('every DateTime on an Integration*/Kpi* model is @db.Timestamptz (period_start is the only DATE)', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const name of MODELS) {
      for (const line of modelBody(name).split('\n')) {
        const f = line.trim().match(/^(\w+)\s+DateTime\??\s(.*)$/);
        if (!f) continue;
        seen++;
        const id = `${name}.${f[1]}`;
        if (DATE_EXEMPT.has(id)) {
          if (!/@db\.Date\b/.test(f[2])) offenders.push(`${id} (exempt but not @db.Date)`);
          continue;
        }
        if (!/@db\.Timestamptz\(6\)/.test(f[2])) offenders.push(id);
      }
    }
    expect(seen).toBeGreaterThan(15);
    expect(offenders).toEqual([]);
  });

  it('the migration creates every @@map table, and declares no bare TIMESTAMP', () => {
    for (const name of MODELS) {
      const map = modelBody(name).match(/@@map\("([a-z_]+)"\)/);
      expect(map, `${name} has @@map`).toBeTruthy();
      expect(migration).toContain(`CREATE TABLE IF NOT EXISTS ${map![1]} (`);
    }
    expect(migration).not.toMatch(/\bTIMESTAMP\b(?!TZ)/i);
  });

  it('carries the DB-level invariants', () => {
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS integration_mapping_versions_one_approved\s+ON integration_mapping_versions \(integration_id\) WHERE status = 'APPROVED'/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS integration_runs_one_running\s+ON integration_runs \(integration_id\) WHERE status = 'RUNNING'/);
    expect(migration).toMatch(/CHECK \(status <> 'ACTIVE' OR \(activated_at IS NOT NULL AND approved_version_id IS NOT NULL\)\)/);
    expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS kpi_readings_tenant_key_period_dim_key\s+ON kpi_readings \(client_number, kpi_key, period_start, dimension_key\)/);
    // critique #16: a BigInt id cannot be JSON-serialised.
    expect(modelBody('IntegrationRunChange')).toMatch(/id\s+String\s+@id @default\(cuid\(\)\)/);
    expect(migration).not.toMatch(/BIGSERIAL|BIGINT/i);
  });

  it('is idempotent: every constraint is guarded, every CREATE is IF NOT EXISTS', () => {
    const adds = migration.match(/ADD CONSTRAINT/g) ?? [];
    const guards = migration.match(/EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;/g) ?? [];
    expect(adds.length).toBeGreaterThan(0);
    expect(guards.length).toBe(adds.length);
    expect(migration).not.toMatch(/CREATE (UNIQUE )?(TABLE|INDEX) (?!IF NOT EXISTS)/);
  });

  it('every client_number column is VARCHAR(20) NOT NULL and every model carries clientNumber', () => {
    for (const name of MODELS) expect(modelBody(name)).toMatch(/clientNumber\s+String\s+@map\("client_number"\) @db\.VarChar\(20\)/);
    const cols = migration.match(/^\s*client_number\s+.*$/gm) ?? [];
    expect(cols.length).toBe(MODELS.length);
    for (const c of cols) expect(c).toMatch(/VARCHAR\(20\)\s+NOT NULL/);
  });

  it('every new model is in TENANT_SCOPED_MODELS and is a real generated model', async () => {
    const { TENANT_SCOPED_MODELS } = await import('../src/db/prisma');
    const { Prisma } = await import('@prisma/client');
    const generated = new Set(Object.values(Prisma.ModelName) as string[]);
    for (const name of MODELS) {
      expect(TENANT_SCOPED_MODELS.has(name), `${name} in TENANT_SCOPED_MODELS`).toBe(true);
      expect(generated.has(name), `${name} generated (run npx prisma generate)`).toBe(true);
    }
  });
});
