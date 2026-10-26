/**
 * DEF-362 — Integrations Stage 1b schema contract (spec §2b).
 *
 * Pins:
 *  1. the additive migration adds every Stage 1b column with ADD COLUMN IF NOT
 *     EXISTS and declares no bare TIMESTAMP (secret_set_at is TIMESTAMPTZ);
 *  2. the widened CHECKs: source_kind ('gsheet','api'); suggestion target_kind
 *     ('kpi','context','filter') each bound to its key form; run-change op
 *     'stale' for context pages — and every widening is idempotent (DROP IF
 *     EXISTS + guarded ADD), so a re-apply is safe;
 *  3. there is no plaintext secret column, and the stored secret must be the
 *     v1 envelope;
 *  4. schema.prisma carries the same columns, and the shared contract keeps
 *     the secret and approved_filter OUT of the client whitelist.
 * Falsifier: drop a column, narrow a CHECK back, add a `secret` column, or put
 * 'approvedFilter' in INTEGRATION_INPUT_KEYS — this file goes red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { INTEGRATION_INPUT_KEYS, SOURCE_KINDS, TARGET_KINDS } from '../src/services/integrations/types';

const ROOT = join(__dirname, '..');
const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(join(ROOT, 'prisma/migrations/20261026b_integrations_api/migration.sql'), 'utf8')
  .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

function modelBody(name: string): string {
  const m = schema.match(new RegExp(`^model ${name} \\{([\\s\\S]*?)^\\}`, 'm'));
  if (!m) throw new Error(`model ${name} not found`);
  return m[1];
}

const SYNC_COLS: Array<[string, string, RegExp]> = [
  ['api_doc_name', 'apiDocName', /VARCHAR\(255\)/],
  ['api_doc_text', 'apiDocText', /TEXT/],
  ['api_doc_reading', 'apiDocReading', /JSONB/],
  ['filter_instructions', 'filterInstructions', /TEXT/],
  ['connect_instructions', 'connectInstructions', /TEXT/],
  ['api_config', 'apiConfig', /JSONB/],
  ['secret_enc', 'secretEnc', /TEXT/],
  ['secret_set_at', 'secretSetAt', /TIMESTAMPTZ\(6\)/],
  ['approved_filter', 'approvedFilter', /JSONB/],
];

describe('DEF-362 integrations schema (Stage 1b)', () => {
  it('adds every integration_syncs column, idempotently, matching schema.prisma', () => {
    const body = modelBody('IntegrationSync');
    for (const [col, field, type] of SYNC_COLS) {
      const line = migration.match(new RegExp(`ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS ${col}\\s+(.*);`));
      expect(line, col).toBeTruthy();
      expect(line![1], col).toMatch(type);
      expect(body, field).toMatch(new RegExp(`\\b${field}\\s+\\S+\\s+@map\\("${col}"\\)`));
    }
    expect(body).toMatch(/secretSetAt\s+DateTime\?\s+@map\("secret_set_at"\) @db\.Timestamptz\(6\)/);
    expect(modelBody('IntegrationSuggestion')).toMatch(/\bfollowed\s+String\?/);
    expect(migration).toMatch(/ALTER TABLE integration_suggestions ADD COLUMN IF NOT EXISTS followed TEXT;/);
    expect(migration).not.toMatch(/\bTIMESTAMP\b(?!TZ)/i);
    expect(migration).not.toMatch(/ADD COLUMN (?!IF NOT EXISTS)/);
  });

  it('never has a plaintext secret column; a stored secret must be the v1 envelope', () => {
    expect(migration).not.toMatch(/ADD COLUMN IF NOT EXISTS (secret|api_key|password|token)\s/i);
    expect(modelBody('IntegrationSync')).not.toMatch(/^\s*(secret|apiKey|password|token)\s/m);
    expect(migration).toMatch(/CHECK \(secret_enc IS NULL OR \(secret_enc LIKE 'v1:%' AND secret_set_at IS NOT NULL\)\)/);
  });

  it('widens the CHECKs (and keeps every Stage 1 value valid)', () => {
    expect(migration).toMatch(/source_kind IN \('gsheet','api'\)/);
    expect(migration).toMatch(/target_kind IN \('kpi','context','filter'\)/);
    expect(migration).toMatch(/target_kind = 'kpi'\s+AND target_key LIKE 'kpi:%'/);
    expect(migration).toMatch(/target_kind = 'context' AND target_key IN \('context:per_record','context:table'\)/);
    expect(migration).toMatch(/target_kind = 'filter'\s+AND target_key = 'filter'/);
    expect(migration).toMatch(/target_kind IN \('kpi','context'\) AND op IN \('create','update','stale'\)/);
    expect(migration).toMatch(/status IN \('DRAFT','ACTIVE','PAUSED'\)/);
    expect([...SOURCE_KINDS]).toEqual(['gsheet', 'api']);
    expect([...TARGET_KINDS]).toEqual(['kpi', 'context', 'filter']);
  });

  it('every widened constraint is dropped-if-exists then guarded-added; every other add is guarded', () => {
    const adds = migration.match(/ADD CONSTRAINT/g) ?? [];
    const guards = migration.match(/EXCEPTION WHEN duplicate_object THEN NULL; END;?/g) ?? [];
    expect(adds.length).toBe(4);
    expect(guards.length).toBe(adds.length);
    for (const name of ['integration_syncs_enums_check', 'integration_suggestions_enums_check', 'integration_run_changes_enums_check']) {
      expect(migration).toContain(`DROP CONSTRAINT IF EXISTS ${name};`);
    }
    expect(migration).not.toMatch(/CREATE (UNIQUE )?(TABLE|INDEX) (?!IF NOT EXISTS)/);
    expect(migration).not.toMatch(/kpi_readings/);
  });

  it('the client whitelist carries the API fields but never the secret or the approved filter', () => {
    const keys = new Set<string>(INTEGRATION_INPUT_KEYS as readonly string[]);
    for (const k of ['apiConfig', 'filterInstructions', 'connectInstructions']) expect(keys.has(k), k).toBe(true);
    for (const k of ['secret', 'secretEnc', 'approvedFilter', 'apiDocText', 'apiDocReading', 'hasSecret']) expect(keys.has(k), k).toBe(false);
  });
});
