/**
 * DEF-144 — a successful action threw away the answer that asked the question.
 *
 * B04 in the capability benchmark is the worst single case in the report, and it
 * fails four criteria at once: **C6 = 75, C5 = 80, C3 = 85, C4 = 90.**
 *
 *   User (previous turn): Brain asked for a priority AND a deadline.
 *   User: "Priority high."
 *   Owner received: `Updated "Define rules for Brain's responsiveness to new
 *                    vs. existing contacts": priority=high.`
 *
 * The judge, on that reply: *"Brain only addressed half of its outstanding
 * question. It should have prompted for the deadline without making the user
 * repeat themselves"* (C5), and *"did not explicitly ask for the 'deadline' or
 * state why it wasn't handled"* (C6).
 *
 * But Brain DID ask. The iteration-01 composer log caught both strings on the
 * same turn:
 *
 *   compose.parsed  answerHead: "Got it. I've set the priority to high.
 *                                Do you have a deadline for this?"
 *   validateBeforeRender  originalHead: `Updated "Define rules ...": priority=high.`
 *
 * Between those two lines, `brainComposer`'s update branch ran
 * `answer = actionResult.message` and replaced a correct, continuing,
 * human-sounding reply with a string built from field names. Four criteria lost
 * to one assignment — and it is also a hardcoded English sentence presented as
 * Brain's voice, which invariant #4 forbids (the sanctioned deterministic form
 * is a bracketed `[marker]` rendered by `answerSanitizer`; this is not one).
 *
 * The overwrite was defending something real, which is why DEF-144 is a
 * predicate and not a deletion: the receipt guaranteed the owner saw what
 * ACTUALLY changed. `update_open_item` silently drops a priority word it cannot
 * normalise, so "I've set it to urgent" could otherwise stand as a false
 * completion claim (invariant #5). The receipt therefore still wins whenever a
 * field the model asked for was not applied.
 *
 * The tests that matter here are the two that drive the REAL `compose()`
 * through its dispatch branch. The predicate tests below them are the cheap
 * half; DEF-134 shipped dead because its proof lived in the cheap half.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ITEM_TITLE = "Define rules for Brain's responsiveness to new vs. existing contacts";

/** Captures what the composer actually wrote to the row. */
const updates: any[] = [];

vi.mock('../src/db/prisma', () => {
  const openItem = {
    findMany: async () => [{
      id: 'item-b04',
      title: ITEM_TITLE,
      status: 'DRAFT',
      priority: 'medium',
      dueDate: null,
    }],
    findUnique: async () => null,
    findFirst: async (args: any) => (args?.where?.id === 'item-b04'
      ? { id: 'item-b04', title: ITEM_TITLE, status: 'DRAFT', priority: 'medium', dueDate: null }
      : null),
    update: async (args: any) => { updates.push(args); return { id: 'item-b04' }; },
  };
  const model = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({}),
    createMany: async () => ({ count: 0 }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
    count: async () => 0,
    aggregate: async () => ({}),
    groupBy: async () => [],
    deleteMany: async () => ({ count: 0 }),
  };
  const p: any = new Proxy(
    {
      openItem,
      $queryRaw: async () => [],
      $queryRawUnsafe: async () => [],
      $executeRaw: async () => 0,
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(p) : []),
    },
    { get: (t: any, k: string) => (k in t ? t[k] : model) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/knowledge/brainPersonaService', () => ({
  __esModule: true,
  getBrainPersona: async () => ({
    addressAs: 'Sir',
    userFirstName: 'Basit',
    userFullName: 'Basit Ahmed',
    userEmail: 'basit.ahmed@tmcltd.ai',
    systemPreamble: 'test persona',
    brainName: 'Suzi',
    userGender: 'male',
  }),
}));

vi.mock('../src/services/knowledge/promptBlockService', () => ({
  __esModule: true,
  getApplicableBlocks: async () => [{ name: 'communication_contract', content: '# contract (stub)' }],
}));

/** What the legacy composer's single LLM seam returns this turn. */
const llm = { answer: '', action: null as any };

vi.mock('../src/services/llmRouter', () => ({
  __esModule: true,
  callLLM: async () => ({
    text: JSON.stringify({ answer: llm.answer, cites: [], gaps: [], action: llm.action }),
    provider: 'test',
    model: 'test',
  }),
}));

import {
  compose,
  brainAnswerSurvivesReceipt,
  MIN_ANSWER_CHARS_OVER_RECEIPT,
} from '../src/services/knowledge/brainComposer';

/** Brain's real reply on the B04 turn, verbatim from the iteration-01 log. */
const THE_DISCARDED_ANSWER = "Got it. I've set the priority to high. Do you have a deadline for this?";

async function composeUpdateTurn(answer: string, priority: string, extra: any = {}) {
  llm.answer = answer;
  // `normaliseAction` drops an update_open_item without an openItemId, so the
  // legacy path needs the id — passing titleRef alone would silently emit no
  // action at all and the test would pass for the wrong reason.
  llm.action = { type: 'update_open_item', openItemId: 'item-b04', priority, ...extra };
  updates.length = 0;
  return compose(
    'TMC-0001', 2, 'Priority high.',
    { intent: 'action', queries: [], scopeLean: 'personal' } as any,
    [], [],
    { useReasoning: false, channel: 'web' } as any,
  );
}

describe('DEF-144 — the receipt is the audit record, not the answer', () => {
  beforeEach(() => { updates.length = 0; });

  describe('through the real compose() dispatch branch', () => {
    it('keeps Brain\'s answer — including the deadline question B04 lost', async () => {
      const r = await composeUpdateTurn(THE_DISCARDED_ANSWER, 'high');

      // The assertion that would have failed before this commit.
      expect(r.answer).toBe(THE_DISCARDED_ANSWER);
      expect(r.answer, 'the deadline follow-up is what C5=80 and C6=75 were about')
        .toContain('deadline');
      // And the machine syntax the judge marked on C4 is gone.
      expect(r.answer).not.toContain('priority=high');
      expect(r.answer).not.toContain('Updated "');
    });

    it('still applies the update and still keeps the receipt as the audit record', async () => {
      // The fix must not trade truthfulness for tone: the row is written and
      // the deterministic record survives where the ledger reads it.
      const r = await composeUpdateTurn(THE_DISCARDED_ANSWER, 'high');
      expect(updates.length, 'the item must still be updated').toBe(1);
      expect(updates[0].data.priority).toBe('high');
      expect(r.actionResult?.ok).toBe(true);
      expect(r.actionResult?.message).toContain('priority=high');
      expect((r.actionResult as any)?.artifactId).toBe('item-b04');
    });

    it('mints a verified-prose token so the WhatsApp renderer honours it', async () => {
      // DEF-146 made the receipt the default at the renderer, so this token is
      // the ONLY thing carrying DEF-144's decision to the surface the owner
      // reads. Without this assertion, dropping it regresses B04 on WhatsApp
      // and no test notices — found by mutation, which is why it is here.
      const r = await composeUpdateTurn(THE_DISCARDED_ANSWER, 'high');
      expect((r.actionResult as any)?.verifiedProse).toBeTruthy();
    });

    it('mints NO token when a requested field was dropped', async () => {
      const r = await composeUpdateTurn(
        "Got it. I've set the priority to urgent and added your note.",
        'urgent',
        { note: 'owner context' },
      );
      expect((r.actionResult as any)?.verifiedProse).toBeNull();
    });

    it('falls BACK to the receipt when a requested field was silently dropped', async () => {
      // The case that exercises the predicate's false branch on the LIVE path:
      // the note IS applied, so the success branch runs and builds a receipt,
      // but "urgent" is not in the normalisable set so no priority was written.
      // Brain's "I've set the priority to urgent" would be a false completion
      // claim (invariant #5), so the receipt must win.
      const r = await composeUpdateTurn(
        "Got it. I've set the priority to urgent and added your note.",
        'urgent',
        { note: 'owner asked for this' },
      );
      expect(updates.length, 'the note is a real field, so a write happens').toBe(1);
      expect(updates[0].data.priority, 'an unnormalisable priority is dropped').toBeUndefined();
      expect(r.answer).not.toContain('urgent');
      expect(r.answer).toContain('Updated "');
    });

    it('emits an honest marker — not Brain\'s false claim — when NOTHING applied', async () => {
      // "urgent" alone leaves `data` empty, so no success receipt is ever
      // built. This is the pre-existing branch and it is already correct: a
      // bracketed marker, which answerSanitizer renders. I expected the
      // receipt here and was wrong; recording the real behaviour rather than
      // bending the assertion to my guess.
      const r = await composeUpdateTurn("Got it. I've set the priority to urgent.", 'urgent');
      expect(updates.length, 'nothing normalised, so no write at all').toBe(0);
      expect(r.answer).not.toContain('urgent');
      expect(r.answer).toBe('[update_open_item: no recognised fields to update]');
    });
  });

  describe('brainAnswerSurvivesReceipt — when prose may stand in for the record', () => {
    it('keeps a real sentence when everything requested was applied', () => {
      expect(brainAnswerSurvivesReceipt(THE_DISCARDED_ANSWER, { appliedFields: ['priority'] })).toBe(true);
    });

    it('yields to the receipt when any requested field was not applied', () => {
      expect(brainAnswerSurvivesReceipt(THE_DISCARDED_ANSWER, { requestedButNotApplied: ['priority'] })).toBe(false);
    });

    it('yields to the receipt for an empty or fragmentary answer', () => {
      expect(brainAnswerSurvivesReceipt('', {})).toBe(false);
      expect(brainAnswerSurvivesReceipt('   ', {})).toBe(false);
      expect(brainAnswerSurvivesReceipt('Done.', {})).toBe(false);
      expect('Done.'.length).toBeLessThan(MIN_ANSWER_CHARS_OVER_RECEIPT);
    });

    it('yields to the receipt for a bracketed system marker', () => {
      // A marker is answerSanitizer's to render; it must never suppress the
      // receipt by looking like prose.
      expect(brainAnswerSurvivesReceipt('[update_open_item: no recognised fields to update]', {}))
        .toBe(false);
    });
  });
});
