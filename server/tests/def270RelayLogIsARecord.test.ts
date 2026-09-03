/**
 * DEF-270 — Brain announced eight messages and then said none had arrived.
 *
 * Owner, 2026-09-01 (CL-043), fourteen minutes after a relay:
 *   *"id any body sent message me in last 30mins?"* → *"I don't see any new messages in the last hour."*
 *   *"no body sent you any message in last hour?"* → *"Correct, Sir… I haven't received any new
 *    messages for you. The last notification I sent you was at 12:58 PM about a WhatsApp message
 *    from an unknown sender."*
 *
 * It held the receipt and denied the item, in one sentence.
 *
 * THIS WAS NOT BROKEN CODE. It is two of the owner's own rulings colliding:
 *
 *   2026-06-10  "anyone who sends message to brain through whatsapp will not be saved or
 *               entertain if user is not registered"  → bodies stay OUT of whatsapp_messages,
 *               whatsapp_sessions and feed_events, and WhatsAppInbound returns before any write.
 *   2026-08-04  Section 35: "no more silent drop… relay to owner"  → those same messages are
 *               ANNOUNCED.
 *
 * The retrieval block read only feed_events — 0 rows — so it truthfully reported "no recent
 * WhatsApp" about a store deliberately never written to.
 *
 * The owner chose the resolution that satisfies BOTH rulings: keep not storing the inbound, and
 * let the retrieval path read the RELAY LOG — Brain's own outbound, which that table already
 * audits. These tests pin that the relays are read, labelled as arrived, and never dropped
 * because feed_events happens to be empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const TRIAGE = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'senderTriage.ts'), 'utf8');

/** The block, with comments stripped — BLD-009: source guards must not match their own prose. */
const codeOnly = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const block = codeOnly.slice(
  codeOnly.indexOf('async function buildRecentWhatsAppBlock'),
  codeOnly.indexOf('async function buildContactProvenanceBlock'));

describe('DEF-270 — the relay log counts as messages received', () => {
  it('reads what ARRIVED, not only feed_events', () => {
    // DEF-305 moved the source. This used to assert `brain_user_messages` /
    // `kind = 'wa_counterpart_message'` — i.e. Brain's own NOTIFICATIONS — which was a fine
    // proxy for "what arrived" only while every message was forwarded unconditionally. Now
    // Brain decides what to forward, so the notification log is no longer the record and the
    // block reads `brain_inbox_messages` instead. The INTENT of this test is unchanged and is
    // what matters: messages from unregistered senders must reach the block, not only
    // feed_events. The 129 rows of relay history were backfilled so this did not become a gap.
    expect(block).toContain('recentInboxForContext');
    expect(block).not.toContain("kind = 'wa_counterpart_message'");
  });

  it('surfaces relays even when feed_events is EMPTY — the exact failing case', () => {
    // 0 feed_events + 8 relays was the state when he was told "no messages". The early return
    // must not swallow the relays.
    const earlyReturn = block.slice(block.indexOf('if (rows.length === 0)'));
    expect(earlyReturn).toContain('relayBlock');
    // And it must not still claim nothing arrived when relays exist.
    expect(block).toContain('which DID arrive');
  });

  it('appends relays on the NON-empty path too, so they are never dropped', () => {
    // Registered-sender traffic must not hide unregistered relays.
    const tail = block.slice(block.lastIndexOf('completenessLine'));
    expect(tail).toContain('relayBlock');
  });

  it('tells the model a suppressed relay still means the message ARRIVED', () => {
    // 6 of the 8 were suppressed by the daily budget (DEF-271). "Suppressed" describes the
    // notification, not the message — reading it as "nothing arrived" reproduces the defect.
    expect(SRC).toContain('NOT that nothing arrived');
  });

  it('records the relayed body in metadata, not only in a dedup key', () => {
    // The text used to survive only inside `wa_counterpart:<id>:<first 40 chars>`. Building on a
    // parsed dedup key is the accident this avoids.
    expect(TRIAGE).toContain('relayedBody');
  });

  it('does NOT store the inbound — the June ruling is untouched', () => {
    // The fix must not have quietly started writing sender bodies to the message stores.
    const inbound = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'WhatsAppInbound.ts'), 'utf8');
    // Scope to the UNREGISTERED branch only, and strip comments. Slicing to end-of-file caught
    // the registered path's own writes, and the branch's comment names the very tables it keeps
    // messages out of — BLD-009 twice over, in one assertion.
    const code = inbound.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const start = code.indexOf('if (!resolvedIdentity) {');
    const gate = code.slice(start, code.indexOf('\n  const userId = resolvedIdentity.userId'));
    expect(start).toBeGreaterThan(-1);
    // The branch still ends by returning, having written the message to no store.
    expect(gate).toContain('return;');
    expect(gate).not.toContain('whatsapp_messages');
    expect(gate).not.toContain('feed_events');
    expect(gate).not.toContain('prisma.whatsAppMessage.create');
  });

  it('declares a legacy relay body as truncated rather than passing it off as whole', () => {
    // The recovery-from-dedup-key fallback moved from the READ path to the backfill, because
    // the inbox now stores the body properly and only the historical rows ever needed
    // recovering. The honesty requirement travelled with it: 100 of the 129 backfilled rows
    // were recovered from a 40-char dedup key and say so in the body itself.
    const fsMod = require('node:fs') as typeof import('node:fs');
    const migration = fsMod.readFileSync(
      path.join(__dirname, '..', 'prisma', 'migrations', '20260903_brain_own_inbox', 'migration.sql'),
      'utf8');
    expect(migration).toContain('truncated at 40 chars');
    expect(migration).toContain('wa_counterpart:');
  });

  it('renders relay times in the owner\'s zone, not UTC (DEF-268 holds here too)', () => {
    expect(block).toContain('formatTimeInZone(relayTz');
    expect(block).not.toContain("+ ' UTC'");
  });
});
