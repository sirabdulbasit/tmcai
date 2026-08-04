/**
 * brain_pending_actions unique-constraint repair (2026-08-04).
 *
 * Production kept throwing "Unique constraint failed on the fields:
 * (userid,channel,status)" from startPending, killing whole action plans —
 * a confirmed task on 08-03 and three priority+deadline updates on 08-04.
 * The 20260522 migration meant to fix it dropped a HAND-PICKED constraint
 * name, so on a Prisma-created constraint it matched nothing and IF EXISTS
 * swallowed the miss: the migration reported success and changed nothing.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIG = fs.readFileSync(
  path.join(__dirname, '..', 'prisma', 'migrations', '20260804_pending_unique_any_name', 'migration.sql'),
  'utf8',
);

/** SQL comments explain the old broken statement; only executable SQL counts.
 *  (Third time a source-guard matched its own explanatory prose — strip first.) */
const SQL = MIG.replace(/^\s*--.*$/gm, '');

describe('the repair migration finds the constraint by SHAPE, not name', () => {
  it('matches the column set instead of a literal name', () => {
    expect(SQL).toContain("ARRAY['channel','status','user_id']");
    // The old approach — a guessed name — must not be how this one works.
    expect(SQL).not.toMatch(/DROP CONSTRAINT IF EXISTS brain_pending_actions_user_channel_status_uq/);
  });
  it('handles BOTH constraints and bare unique indexes', () => {
    expect(MIG).toContain('pg_constraint');
    expect(MIG).toContain('pg_index');
    expect(MIG).toMatch(/contype = 'u'/);
  });
  it('never touches partial indexes — the intended one must survive', () => {
    expect(MIG).toContain('i.indpred IS NULL');
  });
  it('recreates the intended partial unique index idempotently', () => {
    expect(MIG).toContain('CREATE UNIQUE INDEX IF NOT EXISTS brain_pending_actions_user_channel_active_uq');
    expect(MIG).toMatch(/WHERE status IN \('collecting_slots', 'preview_shown', 'confirmed'\)/);
  });
  it('is idempotent overall (safe to re-run)', () => {
    expect(MIG).toMatch(/IF NOT EXISTS|IF EXISTS/);
    expect(MIG).not.toMatch(/DROP TABLE|DELETE FROM/i);
  });
});

describe('startPending survives the constraint even if the schema fix no-ops again', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'pendingActionService.ts'), 'utf8',
  );
  it('catches the collision instead of letting the action plan die', () => {
    const fn = SRC.slice(SRC.indexOf('export async function startPending'));
    expect(fn).toMatch(/try\s*\{[\s\S]*updateMany[\s\S]*\}\s*catch/);
  });
  it('falls back to deleting the stale active rows so the user’s work survives', () => {
    const fn = SRC.slice(SRC.indexOf('export async function startPending'));
    const catchBlock = fn.slice(fn.indexOf('} catch'));
    expect(catchBlock).toContain('deleteMany');
    expect(catchBlock).toContain('ACTIVE_STATUSES');
  });
  it('logs the collision — a silent swallow is what hid this for months', () => {
    const fn = SRC.slice(SRC.indexOf('export async function startPending'));
    expect(fn).toContain('legacy unique constraint');
  });
});
