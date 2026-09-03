/**
 * DEF-305 / CL-052 — a message sent to Brain's number is FOR BRAIN, and Brain decides.
 *
 * Owner ruling, 2026-09-03, verbatim:
 *
 *   "since brain knows his own number so the message sent to this number is the message for
 *    brain (not for user), brain will analyze and see to whom it is relevant to notify or not,
 *    brain will decide what to do with messages receiving, if something really important to
 *    notify user then do (but brain should know to which user he should notify)"
 *
 * This reverses Section 35 (owner ruling 2026-08-04), which relayed every allowed sender's
 * message unconditionally and worded it "X messaged YOU on WhatsApp".
 *
 * THE TENSION THESE TESTS EXIST TO HOLD, and it is his own. On the SAME DAY he also said "i also
 * often see that someone has sent messaged to brain but it didnt notify". So the fix has to make
 * fewer notifications without making missed messages, and the tests that matter most here are
 * the ones asserting that every failure path still notifies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRawUnsafe = vi.fn();
const executeRawUnsafe = vi.fn(async () => 1);
vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: (...a: unknown[]) => queryRawUnsafe(...a),
    $executeRawUnsafe: (...a: unknown[]) => executeRawUnsafe(...a),
  },
}));

const scoreCriticality = vi.fn();
vi.mock('../src/services/triage/criticalityEngineService', () => ({
  scoreCriticality: (...a: unknown[]) => scoreCriticality(...a),
}));

import {
  recordInboundToBrain, recordDecision, resolveRelevantUser, decideSubstantive,
  recentInboxForContext,
} from '../src/services/whatsapp/brainInboxService';

const CN = 'TMC-0001';
const SYNTHETIC = '+255043747987458';   // @lid-derived, ruled useless to him twice
const REAL = '+923134199294';

beforeEach(() => {
  queryRawUnsafe.mockReset();
  executeRawUnsafe.mockReset();
  executeRawUnsafe.mockResolvedValue(1);
  scoreCriticality.mockReset();
});

describe('DEF-305 — recording is unconditional and comes first', () => {
  it('records the message and returns its id', async () => {
    queryRawUnsafe.mockResolvedValue([{ id: 42n }]);
    const rec = await recordInboundToBrain({ clientNumber: CN, body: 'hello', senderPhone: REAL });
    expect(rec?.id).toBe('42');
  });

  it('never stores the @lid synthetic in a column called sender_phone', async () => {
    // He has ruled twice that this value must not appear anywhere owner-facing (DEF-293,
    // DEF-298). A column named `sender_phone` is exactly where a future reader would trust it.
    queryRawUnsafe.mockResolvedValue([{ id: 1n }]);
    await recordInboundToBrain({ clientNumber: CN, body: 'x', senderPhone: SYNTHETIC });
    expect(queryRawUnsafe.mock.calls[0]).toContain(null);
    expect(queryRawUnsafe.mock.calls[0]).not.toContain(SYNTHETIC);
  });

  it('keeps a real number', async () => {
    queryRawUnsafe.mockResolvedValue([{ id: 1n }]);
    await recordInboundToBrain({ clientNumber: CN, body: 'x', senderPhone: REAL });
    expect(queryRawUnsafe.mock.calls[0]).toContain(REAL);
  });

  it('returns null instead of throwing when the write fails', async () => {
    // An inbound must not be lost because an audit write failed, and nothing downstream may
    // depend on this having worked.
    queryRawUnsafe.mockRejectedValue(new Error('db down'));
    await expect(recordInboundToBrain({ clientNumber: CN, body: 'x' })).resolves.toBeNull();
  });
});

describe('DEF-305 — the decision is stored, so a withheld message is explainable', () => {
  it('writes the recipient, the reason and the decision', async () => {
    await recordDecision({
      id: '7', relevantUserId: 2, relevanceReason: 'contact of this user',
      decision: 'withheld_not_substantive', notifyReason: 'small talk',
    });
    const args = executeRawUnsafe.mock.calls[0];
    expect(args).toContain('withheld_not_substantive');
    expect(args).toContain('small talk');
    expect(args).toContain(2);
  });

  it('does nothing when there is no row to update, rather than throwing', async () => {
    await recordDecision({ id: null, decision: 'notified' });
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('a failed audit write does not throw into the messaging path', async () => {
    // The decision has already been acted on by the time this runs.
    executeRawUnsafe.mockRejectedValue(new Error('nope'));
    await expect(recordDecision({ id: '1', decision: 'notified' })).resolves.toBeUndefined();
  });
});

describe('DEF-305 — routing: which user does this concern', () => {
  it('routes to the user who owns the sender as a contact', async () => {
    queryRawUnsafe.mockResolvedValueOnce([{ userId: 3, title: 'Hamna Latif Bhutta' }]);
    const r = await resolveRelevantUser({ clientNumber: CN, senderPhone: REAL });
    expect(r.userId).toBe(3);
    expect(r.reason).toContain('contact of this user');
  });

  it('falls through to the user whose open item names the sender', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([])                                     // no contact
      .mockResolvedValueOnce([{ userId: 5, title: 'InDrive kickoff' }]);
    const r = await resolveRelevantUser({ clientNumber: CN, senderPhone: REAL });
    expect(r.userId).toBe(5);
    expect(r.reason).toContain('open item');
  });

  it('uses the only active user when there is exactly one, and SAYS that is what it did', async () => {
    // The honesty requirement: this tenant has one active user today, so routing almost always
    // takes this branch. The reason string must not imply an attribution that did not happen.
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 2 }]);
    const r = await resolveRelevantUser({ clientNumber: CN, senderPhone: '+15550001111' });
    expect(r.userId).toBe(2);
    expect(r.reason).toContain('only active user');
    expect(r.reason).toContain('not an attribution');
  });

  it('returns no user when several are active and nothing ties the sender to one', async () => {
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 2 }, { id: 3 }]);
    const r = await resolveRelevantUser({ clientNumber: CN, senderPhone: '+15550001111' });
    expect(r.userId).toBeNull();
  });

  it('never lets the message text choose the recipient', async () => {
    // A routing decision movable by what a stranger writes is a routing decision a stranger
    // controls. Every signal is a stored relationship, and the body is not even passed in.
    //
    // My first version of this test asserted `Object.keys` of an object literal I had written
    // in the test itself, which can never fail. Asserting on the real function's source can.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(
      join(__dirname, '..', 'src', 'services', 'whatsapp', 'brainInboxService.ts'), 'utf-8');
    const fn = src.slice(
      src.indexOf('export async function resolveRelevantUser'),
      src.indexOf('export interface Substance'));
    const code = fn.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/\bbody\b/);
    expect(code).toContain('senderPhone');
  });

  it('falls back to a recipient rather than withholding when routing throws', async () => {
    queryRawUnsafe.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce([{ id: 2 }]);
    const r = await resolveRelevantUser({ clientNumber: CN, senderPhone: REAL });
    expect(r.userId).toBe(2);
    expect(r.reason).toContain('rather than withholding');
  });
});

describe('DEF-305 — importance: is it worth interrupting them', () => {
  it('reuses scoreCriticality rather than judging for itself', async () => {
    scoreCriticality.mockResolvedValue({ substantive: true, substantiveWhy: 'asks about a live item', band: 'high' });
    const r = await decideSubstantive({ clientNumber: CN, userId: 2, senderLabel: 'X', body: 'is the deck ready?' });
    expect(scoreCriticality).toHaveBeenCalledTimes(1);
    expect(scoreCriticality.mock.calls[0][0]).toMatchObject({ itemType: 'whatsapp', userId: 2 });
    expect(r.substantive).toBe(true);
    expect(r.why).toBe('asks about a live item');
  });

  it('withholds when the engine says it is not substantive', async () => {
    scoreCriticality.mockResolvedValue({ substantive: false, substantiveWhy: 'social chit-chat', band: 'low' });
    const r = await decideSubstantive({ clientNumber: CN, userId: 2, senderLabel: 'X', body: 'salam' });
    expect(r.substantive).toBe(false);
    expect(r.why).toBe('social chit-chat');
  });

  it('NOTIFIES when scoring throws — undecided is not withheld', async () => {
    // The single most important assertion in this file. He complained the same day that a real
    // message did not notify him; "Brain decides" must never become "Brain went quiet because
    // the scorer broke". DEF-060 lost five days of real messages behind one swallowed error.
    scoreCriticality.mockRejectedValue(new Error('llm unavailable'));
    const r = await decideSubstantive({ clientNumber: CN, userId: 2, senderLabel: 'X', body: 'urgent' });
    expect(r.substantive).toBe(true);
    expect(r.why).toContain('could not judge importance');
  });

  it('NOTIFIES when the engine omits the field entirely', async () => {
    // An older or partial result must not read as "not substantive" by absence.
    scoreCriticality.mockResolvedValue({ band: 'medium' });
    const r = await decideSubstantive({ clientNumber: CN, userId: 2, senderLabel: 'X', body: 'hi' });
    expect(r.substantive).toBe(true);
  });
});

describe('DEF-305 — the context read includes what Brain did NOT forward', () => {
  it('reads the inbox, not the notification log', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    await recentInboxForContext({ clientNumber: CN });
    const sql = String(queryRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('brain_inbox_messages');
    expect(sql).not.toContain('brain_user_messages');
  });

  it('carries the decision and its reason, so "it arrived but I held it" is sayable', async () => {
    queryRawUnsafe.mockResolvedValue([]);
    await recentInboxForContext({ clientNumber: CN });
    const sql = String(queryRawUnsafe.mock.calls[0][0]);
    expect(sql).toContain('notify_decision');
    expect(sql).toContain('notify_reason');
  });

  it('does not filter by decision — a withheld message still arrived', async () => {
    // If this ever filtered to `notified`, "did anybody message you" would answer from the
    // wrong set and DEF-270 would be back by a new route.
    queryRawUnsafe.mockResolvedValue([]);
    await recentInboxForContext({ clientNumber: CN });
    expect(String(queryRawUnsafe.mock.calls[0][0])).not.toContain("notify_decision = 'notified'");
  });

  it('returns an empty list rather than throwing when the read fails', async () => {
    queryRawUnsafe.mockRejectedValue(new Error('db down'));
    await expect(recentInboxForContext({ clientNumber: CN })).resolves.toEqual([]);
  });
});
