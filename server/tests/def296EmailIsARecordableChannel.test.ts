/**
 * DEF-296 — the email fallback delivered messages that could not be recorded, so the daily cap
 * silently stopped working.
 *
 * Owner, 2026-09-02: *"why i am receiving these emails??"* — 30 `[open_item_draft_ask]` emails in
 * three minutes, against a daily cap of 20.
 *
 * The mechanism was one CHECK constraint. When every WhatsApp channel fails, the service falls
 * back to email and sets `channelsUsed = ['email']`, so the audit write attempted
 * `channel = 'email'` — a value the constraint did not permit. The INSERT threw and **no row was
 * written**. 31 `audit insert failed` errors sat in the error log; the evidence was there and
 * nobody read it, me included.
 *
 * Losing that row is not bookkeeping. **The daily cap, the per-kind rate limiter and dedup all
 * read that table.** With nothing written, `sentToday` never rose — so the cap stopped bounding
 * anything the moment WhatsApp failed, which is precisely when the channel it protects was
 * already failing. The throttle broke at the worst possible time and looked fine.
 *
 * Two halves, and both are needed: 'email' is now a permitted value, so a real delivery is
 * recorded truthfully; and an unrecognised channel degrades to one the schema accepts rather than
 * taking the ledger down with it.
 */
import { describe, it, expect } from 'vitest';

const src = () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(__dirname, '..', 'src', 'services', 'notifications', 'brainOutboundService.ts'), 'utf-8');
};
const migration = () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(__dirname, '..', 'prisma', 'migrations', '20260903_email_is_a_channel', 'migration.sql'), 'utf-8');
};
const noComments = (s: string) =>
  s.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('--') && !t.startsWith('*'); }).join('\n');

describe('DEF-296 — an email delivery is recorded, and counts', () => {
  it('the schema permits email as a channel', () => {
    const sql = noComments(migration());
    expect(sql).toContain("'email'");
    expect(sql).toContain('brain_user_messages_channel_check');
  });

  it('the migration is idempotent — re-running it must not fail', () => {
    // Project rule: hand-written idempotent migrations only.
    expect(noComments(migration())).toContain('DROP CONSTRAINT IF EXISTS');
  });

  it('keeps every channel that was already permitted', () => {
    // Narrowing the constraint would break the 28,954 existing rows' worth of behaviour.
    const sql = noComments(migration());
    for (const ch of ['text', 'voicenote', 'call_cta', 'call_business', 'auto']) {
      expect(sql, ch).toContain(`'${ch}'`);
    }
  });

  it('email is recordable in the type as well as the schema', () => {
    // A widened constraint with a narrow type just moves the failure to compile time.
    expect(noComments(src())).toMatch(/channel\?:[^;]*'email'/);
  });
});

describe('DEF-296 — an unknown channel can never break the ledger again', () => {
  it('coerces an unrecognised channel instead of writing it', () => {
    const code = noComments(src());
    expect(code).toContain('AUDIT_CHANNELS');
    const at = code.indexOf('const channelForAudit');
    expect(at).toBeGreaterThan(0);
    const decl = code.slice(at, code.indexOf(';', code.indexOf('rawChannel) ? rawChannel', at)));
    expect(decl).toContain("'auto'");
  });

  it('says so loudly, because a coercion means code and schema have drifted', () => {
    // Silence here is what let this run for a month. A log line nobody reads is still better
    // than none — but it must be at a level production keeps, which is why it is `error`.
    const code = noComments(src());
    const at = code.indexOf('channelForAudit !== rawChannel');
    expect(at).toBeGreaterThan(0);
    expect(code.slice(at, at + 220)).toContain('log.error');
  });

  it('the permitted list matches the schema exactly', () => {
    // If these drift, the coercion silently starts rejecting a value the database would accept,
    // or lets through one it would not. Both are this defect again.
    const code = noComments(src());
    const list = code.slice(code.indexOf('const AUDIT_CHANNELS'));
    const inCode = (list.slice(0, list.indexOf(']')).match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
    const sql = noComments(migration());
    const inSql = (sql.slice(sql.indexOf('CHECK (channel IN')).match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
    expect([...inCode].sort()).toEqual([...inSql].sort());
  });
});
