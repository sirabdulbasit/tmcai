/**
 * DEF-108 — Brain denied its own sends because nothing fed the ledger.
 *
 * Production, 2026-08-10:
 *
 *   14:57  owner: "can you read last 24hr messages you sent to anyone and if
 *                  any one has responded you?"
 *          brain: "Sir, I haven't sent any messages in the last 24 hours, so
 *                  there are no replies to check for."
 *   14:59  owner: "you are wrong, you sent messages to Hamna and Yousaf
 *                  yesterday, i have seen it"
 *
 * The owner was right. At that moment:
 *
 *   brain_user_messages         14 sent in 24h
 *   delegation_thread_events     8 outbound in 48h
 *   brain_action_artifacts       0     <-- the table Brain actually reads
 *
 * brain_action_artifacts held 20 rows in its entire life, newest 2026-08-08,
 * and the only recent entries were `previewed` — which dispatchLedgerService
 * correctly excludes (TERMINAL_OK = succeeded/completed/sent).
 *
 * DEF-037 was right that "did I do X?" must be a ledger query rather than a
 * transcript read. The defect is that the send paths never wrote to it. Its own
 * header predicted this: "It was not lying. It genuinely could not see its own
 * past."
 *
 * These tests pin the two send paths to the ledger, and pin the one rule that
 * makes the ledger trustworthy: only real outcomes are recorded. Writing a
 * suppressed or rate-limited message as `succeeded` would be exactly the
 * fabrication the ledger exists to prevent.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.join(__dirname, '..', 'src');
const OUTBOUND = fs.readFileSync(path.join(SRC, 'services/notifications/brainOutboundService.ts'), 'utf8');
const THREADS = fs.readFileSync(path.join(SRC, 'services/delegation/delegationThreadService.ts'), 'utf8');
const LEDGER = fs.readFileSync(path.join(SRC, 'services/knowledge/dispatchLedgerService.ts'), 'utf8');

describe('the owner-facing send path feeds the ledger', () => {
  it('records an artifact from brainContactsUser', () => {
    expect(OUTBOUND).toContain('recordArtifact');
    expect(OUTBOUND).toContain('DEF-108');
  });

  it('records ONLY real outcomes — never suppressed or rate-limited', () => {
    const at = OUTBOUND.indexOf('DEF-108');
    const block = OUTBOUND.slice(at, at + 3200);
    // The guard that keeps the ledger honest.
    expect(block).toMatch(/o\.status === 'sent' \|\| o\.status === 'partial' \|\| o\.status === 'failed'/);
    expect(block).not.toMatch(/'suppressed'/);
    expect(block).not.toMatch(/'rate_limited'/);
  });

  it('maps a failed send to failed, not to succeeded', () => {
    const at = OUTBOUND.indexOf('DEF-108');
    const block = OUTBOUND.slice(at, at + 3200);
    expect(block).toMatch(/o\.status === 'failed' \? 'failed' : 'succeeded'/);
  });

  it('never lets bookkeeping break a delivered send', () => {
    const at = OUTBOUND.indexOf('DEF-108');
    const block = OUTBOUND.slice(at, at + 3200);
    expect(block).toContain('catch');
    // …but the miss must be audible, since a silent one is how it went empty.
    expect(block).toMatch(/will not remember this send/);
  });
});

describe('the counterpart send path feeds the ledger', () => {
  it('records an artifact on an accepted outbound receipt', () => {
    expect(THREADS).toContain('recordArtifact');
    expect(THREADS).toContain('DEF-108');
  });

  it('records on accepted only — a failed receipt is not a send', () => {
    const at = THREADS.indexOf('DEF-108');
    const block = THREADS.slice(at, at + 2000);
    expect(block).toMatch(/input\.status === 'accepted'/);
  });

  it('selects the fields the artifact needs, so it cannot write a blank payload', () => {
    expect(THREADS).toMatch(/ownerUserId: true/);
    expect(THREADS).toMatch(/counterpartKey: true/);
  });

  it('distinguishes email from whatsapp in the recorded action type', () => {
    const at = THREADS.indexOf('DEF-108');
    const block = THREADS.slice(at, at + 2000);
    expect(block).toMatch(/'send_email' : 'notify_via_whatsapp'/);
  });
});

describe('the ledger still only reports terminal success', () => {
  it('TERMINAL_OK is unchanged — previewed must never read as done', () => {
    // If this ever widens to include 'previewed', Brain would claim work it
    // only proposed, which is the DEF-041 fabrication in reverse.
    expect(LEDGER).toMatch(/TERMINAL_OK\s*=\s*new Set\(\['succeeded',\s*'completed',\s*'sent'\]\)/);
  });

  it('reads brain_action_artifacts, so feeding that table is the right fix', () => {
    expect(LEDGER).toContain('brainActionArtifact');
  });
});
