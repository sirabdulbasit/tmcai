/**
 * DEF-048 — "ask Hamna whether she is coming to office tomorrow".
 *
 * The owner's end-to-end test, and the thing the system could not express.
 * `DelegationThread.openItemId` is NOT NULL, so a question with no open item
 * had nowhere to be recorded — and without a thread there is nothing to
 * correlate her reply against, so no answer could ever come back.
 *
 * Owner's decision (2026-08-05), chosen over making the column nullable: route
 * the ask through open-item creation. An unanswered question genuinely IS an
 * open item — it gets a status and a follow-up cadence for free, instead of a
 * second tracking concept every reader would have to learn.
 *
 * That requires `add_open_item` to carry an optional delegatee, because
 * chaining add → delegate as two plan steps cannot work: the second step needs
 * the id of an item that does not exist when the plan is built.
 *
 * Two consequences this file pins down:
 *   1. Assignment logic has ONE implementation shared with delegate_open_item.
 *      Copying it is what produced DEF-039, DEF-041, DEF-044 and DEF-045 in a
 *      single day.
 *   2. An add_open_item carrying a delegatee is NO LONGER internal. It reaches
 *      a human, so it must not skip the human-facing gate on the strength of
 *      its type alone.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { verifyActionTargets } from '../src/services/knowledge/actionTargetGuard';
import {
  IMMEDIATE_INTERNAL_ACTION_TYPES, actionReachesACounterpart,
} from '../src/services/knowledge/brainComposer';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('DEF-048 — an addressed item is not an internal item', () => {
  it('a plain open item stays internal and applies immediately', () => {
    expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('add_open_item')).toBe(true);
    expect(actionReachesACounterpart({ type: 'add_open_item', title: 'Buy milk' } as any)).toBe(false);
  });

  it('an item carrying a delegatee reaches a person, by candidate or by email', () => {
    expect(actionReachesACounterpart({
      type: 'add_open_item', title: 'Ask Hamna about tomorrow', delegateeCandidateId: 'cand_1',
    } as any)).toBe(true);
    expect(actionReachesACounterpart({
      type: 'add_open_item', title: 'Ask Hamna', delegateeAdHocEmail: 'hamna.latif@tmcltd.com',
    } as any)).toBe(true);
  });

  it('the human-facing gate reads the SLOTS, not just the type', () => {
    // Judging externality by type alone would let an outbound message skip the
    // gate entirely — the same silently-false classification as DEF-045.
    expect(CODE).toMatch(
      /IMMEDIATE_INTERNAL_ACTION_TYPES\.has\(act\.type\)\s*&&\s*!actionReachesACounterpart\(act\)/);
  });

  it('other internal actions are untouched by the change', () => {
    for (const t of ['record_preference', 'update_contact', 'update_open_item', 'set_brain_name']) {
      expect(actionReachesACounterpart({ type: t } as any), `${t} must stay internal`).toBe(false);
    }
  });
});

describe('DEF-048 — an unreachable ask is refused before anything is created', () => {
  const ctx = { userId: 2, clientNumber: 'TMC-0001' };

  it('a plain item needs no target and is allowed', async () => {
    const v = await verifyActionTargets('add_open_item', { title: 'Buy milk' }, ctx.userId, ctx.clientNumber);
    expect(v.ok).toBe(true);
  });

  it('BLOCKS an ask addressed to someone who does not ground', async () => {
    const v = await verifyActionTargets(
      'add_open_item',
      { title: 'Ask Hamna about tomorrow', delegateeCandidateId: 'does_not_exist' },
      ctx.userId, ctx.clientNumber,
    );
    expect(v.ok, 'creating an item nobody will ever answer is not a success').toBe(false);
    expect(v.marker).toContain('who to ask');
  });

  it('OK with a valid ad-hoc email', async () => {
    const v = await verifyActionTargets(
      'add_open_item',
      { title: 'Ask Hamna about tomorrow', delegateeAdHocEmail: 'hamna.latif@tmcltd.com' },
      ctx.userId, ctx.clientNumber,
    );
    expect(v.ok).toBe(true);
  });

  it('BLOCKS an invalid ad-hoc email rather than creating a dead item', async () => {
    const v = await verifyActionTargets(
      'add_open_item',
      { title: 'Ask Hamna', delegateeAdHocEmail: 'not-an-email' },
      ctx.userId, ctx.clientNumber,
    );
    expect(v.ok).toBe(false);
  });
});

describe('DEF-048 — assignment has exactly one implementation', () => {
  it('delegate_open_item and add_open_item both call the shared helper', () => {
    const calls = [...CODE.matchAll(/assignItemToCounterpart\(/g)]
      .filter((m) => !CODE.slice(Math.max(0, m.index! - 30), m.index!).includes('async function'));
    expect(
      calls.length,
      'both dispatch paths must route through the one helper — a second copy is '
      + 'how DEF-039, DEF-041, DEF-044 and DEF-045 all happened',
    ).toBe(2);
  });

  it('the helper names the item by title, never by raw record id (DEF-044)', () => {
    const body = CODE.slice(CODE.indexOf('async function assignItemToCounterpart'));
    expect(body).toContain('titleHint');
    expect(body).toMatch(/Delegated "\$\{[^}]*titleHint/);
  });

  it('a created-but-unassigned item reports failure, not a clean success', () => {
    // The owner's ask was "get me an answer". An item created without an
    // assignee will never produce one, so it must not read as done.
    expect(CODE).toMatch(/could not assign it/);
    expect(CODE).toMatch(/ok:\s*false[\s\S]{0,200}could not assign it/);
  });
});
