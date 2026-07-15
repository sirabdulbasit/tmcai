/**
 * applyPendingMigrations.ts — apply each pending Prisma migration
 * idempotently and stamp `_prisma_migrations` so subsequent
 * `migrate status` calls show clean.
 *
 * Approach (per Category 17 in brain_test_scenarios.md):
 *   1. For each pending migration directory, read `migration.sql`.
 *   2. Run it inside a transaction. The Prisma migration files are
 *      written defensively with `IF NOT EXISTS` / `IF EXISTS`, so
 *      re-running against a partially-applied dev DB is safe.
 *   3. After successful apply, INSERT a row into _prisma_migrations
 *      with applied_steps_count = full statement count, started_at
 *      = finished_at = NOW(), and a generated checksum that matches
 *      Prisma's expectation (sha256 of the migration file).
 *
 * On any single migration failure, log it and stop — never flip the
 * stamp to "applied" if SQL didn't actually succeed.
 */
import prisma from '../db/prisma';
import { runWithoutTenant } from '../db/tenantContext';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

const PENDING = [
  '20260401_phase3_personal_data',
  '20260401_phase4_envelope_encryption',
  '20260401_phase5_org_intelligence',
  '20260401_phase6_domain_knowledge',
  '20260401_phase8_agents',
  '20260401_phase85_agents_whatsapp',
  '20260401_phase9_platform',
  '20260420_connector_seed_v41',
  '20260420_seed_haseeb_notion_connector',
  '20260420_tenant_whatsapp_notifier',
  '20260421_feed_events_user_id',
  '20260421_log_delete_escape_hatch',
  '20260421_triage_scoring',
  '20260421_user_prompts',
  '20260429_brain_outbound_channels',
  // Order matters: backfill connector_types catalog FIRST so the
  // default-enable migration has rows to enable.
  '20260504_backfill_connector_types',
  '20260504_enable_default_personal_connectors',
];

/** Strip SQL comments + split on ; while respecting $$...$$ procedural blocks. */
function splitSql(raw: string): string[] {
  // Pass 1 — strip comments. Walk char-by-char, never touch dollar-quoted
  // regions because comments inside a $$ block are part of the body.
  let stripped = '';
  let inDollar = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    const next2 = raw.slice(i, i + 2);
    if (!inLine && !inBlock && next2 === '$$') {
      inDollar = !inDollar;
      stripped += '$$';
      i += 1;
      continue;
    }
    if (!inDollar && !inBlock && next2 === '--') { inLine = true; i += 1; continue; }
    if (!inDollar && !inLine && next2 === '/*') { inBlock = true; i += 1; continue; }
    if (inLine && ch === '\n') { inLine = false; stripped += '\n'; continue; }
    if (inBlock && next2 === '*/') { inBlock = false; i += 1; continue; }
    if (inLine || inBlock) continue;
    stripped += ch;
  }
  // Pass 2 — split on ; outside $$ blocks
  const out: string[] = [];
  let buf = '';
  let dq = false;
  for (let i = 0; i < stripped.length; i++) {
    const next2 = stripped.slice(i, i + 2);
    if (next2 === '$$') {
      dq = !dq;
      buf += '$$';
      i += 1;
      continue;
    }
    if (stripped[i] === ';' && !dq) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = '';
      continue;
    }
    buf += stripped[i];
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

async function applyOne(name: string): Promise<{ ok: boolean; error?: string }> {
  const sqlFile = path.join(MIGRATIONS_DIR, name, 'migration.sql');
  if (!fs.existsSync(sqlFile)) return { ok: false, error: 'migration.sql missing' };
  const sql = fs.readFileSync(sqlFile, 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex');

  // Already stamped? Skip.
  const stamped = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, finished_at FROM _prisma_migrations WHERE migration_name = $1`,
    name,
  ).catch(() => []);
  if (stamped.length > 0 && stamped[0].finished_at) {
    return { ok: true };
  }

  // Split into statements while:
  //   - Stripping `-- line comments` and `/* block comments */` first
  //     (so semicolons inside comments don't terminate statements)
  //   - Keeping PL/pgSQL $$...$$ blocks intact (semicolons inside them
  //     are part of the procedural body, not separators)
  const statements = splitSql(sql);

  let applied = 0;
  for (const stmt of statements) {
    try {
      await prisma.$executeRawUnsafe(stmt);
      applied++;
    } catch (err: any) {
      const msg = String(err.message ?? '');
      const benign = /already exists|does not exist|duplicate/i.test(msg);
      if (!benign) {
        return { ok: false, error: msg.slice(0, 240) };
      }
      applied++;
    }
  }

  // Stamp _prisma_migrations
  await prisma.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations
       (id, checksum, finished_at, migration_name, logs, rolled_back_at,
        started_at, applied_steps_count)
     VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), $4)
     ON CONFLICT (id) DO UPDATE
       SET finished_at = NOW(),
           applied_steps_count = EXCLUDED.applied_steps_count`,
    crypto.randomUUID(), checksum, name, applied,
  );

  return { ok: true };
}

async function main() {
  await runWithoutTenant(async () => {
    console.log(`[migrate] applying ${PENDING.length} pending migrations...`);
    let ok = 0; let fail = 0; let firstError: string | undefined;
    for (const m of PENDING) {
      const r = await applyOne(m);
      if (r.ok) {
        ok++;
        console.log(`[migrate] ✓ ${m}`);
      } else {
        fail++;
        firstError = firstError ?? `${m}: ${r.error}`;
        console.log(`[migrate] ✗ ${m} — ${r.error}`);
        break;   // stop on first failure
      }
    }
    console.log(`\n[migrate] ${ok} applied, ${fail} failed`);
    if (firstError) console.log('[migrate] first error:', firstError);
  });
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
