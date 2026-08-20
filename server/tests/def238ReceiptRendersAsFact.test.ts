/**
 * DEF-238 — the receipt renders as a FACT, never as the neutral fallback.
 *
 * Measured on production, 2026-08-19 (owner sessions S35/S36):
 *
 *   20:09  "delete this one also" (the DRAFT item)
 *          → executor: `[remove_open_item: not removed — current status DRAFT …]`
 *          → owner:    "I couldn't put together an answer I trust for that one."
 *   22:23  "delete all open items"
 *          → open_items row cmsotakwf0006rts1bdsrjjkj CANCELLED at 22:23:40.059 — SUCCESS
 *          → executor: `[removed: "Define rules for Brain's responsiveness…"]`
 *          → owner:    "I couldn't put together an answer I trust for that one."
 *
 * Both died the same way: `internalActionExecutors` hand-wrote nine receipt
 * strings and `curatedMarkerMeaning` had a rule for none of them, so success
 * and refusal alike were swallowed by NEUTRAL_MARKER_FALLBACK. Two
 * hand-maintained lists that can disagree — `protection-with-two-
 * implementations`, and the 9th recorded `guard-destroys-the-answer`.
 *
 * The class fix under test: receipts are CONSTRUCTED by `itemOutcomeMarker`
 * and rendered by `itemOutcomeMeaning`, which live in the SAME module and
 * share one payload — renderable by construction. A payload the constructor
 * could not have minted is rejected, not repaired (the DEF-175 rule).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

import { itemOutcomeMarker, itemOutcomeMeaning } from '../src/services/knowledge/actionReceipt';
import { NEUTRAL_MARKER_FALLBACK } from '../src/services/knowledge/systemMarker';

// ── steerable state, same idiom as def232 ───────────────────────────────────
const state = {
  itemById: null as any,
  titleMatches: [] as any[],
  transitionResult: { ok: true } as { ok: boolean; error?: string },
};

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0,
  };
  const p: any = new Proxy(
    {
      openItem: {
        findFirst: async () => state.itemById,
        findMany: async () => state.titleMatches,
      },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/itemLifecycle/lifecycleService', () => ({
  __esModule: true,
  transitionStatus: async () => state.transitionResult,
}));

// The measured production fixture, verbatim.
const TITLE_506 = "Define rules for Brain's responsiveness to new vs. existing conversations";
const DRAFT_REFUSAL = 'current status DRAFT is not in the v15 lifecycle — migrate first';

describe('DEF-238 — constructor and renderer share one vocabulary', () => {
  it('a SUCCESS receipt renders the fact, naming the item — never the fallback', async () => {
    const { curatedMarkerMeaning } = await import('../src/services/knowledge/answerSanitizer');
    const { stripMarkerEnvelope } = await import('../src/services/knowledge/systemMarker');
    const marker = itemOutcomeMarker({ verb: 'removed', ok: true, title: TITLE_506 });
    const meaning = curatedMarkerMeaning(stripMarkerEnvelope(marker));
    expect(meaning).not.toBeNull();
    expect(meaning).toContain(TITLE_506);
    // The fact carries reversibility — CANCELLED, not deleted (DEF-106/129).
    expect(meaning).toContain('restored');
    expect(meaning).not.toBe(NEUTRAL_MARKER_FALLBACK);
  });

  it('the 22:23 swallow is dead: the whole sanitized answer names the removal', async () => {
    const { sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    const out = sanitizeAnswerForUser(itemOutcomeMarker({ verb: 'removed', ok: true, title: TITLE_506 }));
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
    expect(out).toContain(TITLE_506);
  });

  it('the 20:09 swallow is dead: a refusal carries the reason he can act on', async () => {
    const { sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    const out = sanitizeAnswerForUser(
      itemOutcomeMarker({ verb: 'removed', ok: false, title: 'Draft item', why: DRAFT_REFUSAL }),
    );
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
    expect(out).toContain(DRAFT_REFUSAL);
    expect(out).toContain('did not happen');
    expect(out).toContain('nothing was changed');
  });

  it('a failure with no recorded reason says so — never an invented one', async () => {
    const { stripMarkerEnvelope } = await import('../src/services/knowledge/systemMarker');
    const meaning = itemOutcomeMeaning(
      stripMarkerEnvelope(itemOutcomeMarker({ verb: 'closed', ok: false, title: 'X' })),
    );
    expect(meaning).toContain('the system recorded no reason');
  });

  it('rejects payloads the constructor could not have minted', () => {
    expect(itemOutcomeMeaning('[item_outcome: {"verb":"deleted","ok":true,"title":"X"}]')).toBeNull();
    expect(itemOutcomeMeaning('[item_outcome: {"verb":"removed","ok":true}]')).toBeNull();          // success must name its target
    expect(itemOutcomeMeaning('[item_outcome: {"verb":"removed","ok":false}]')).toBeNull();         // failure must carry a reason
    expect(itemOutcomeMeaning(`[item_outcome: {"verb":"removed","ok":false,"why":${JSON.stringify('x'.repeat(301))}}]`)).toBeNull();
    expect(itemOutcomeMeaning('[item_outcome: not json]')).toBeNull();
  });

  it('the OLD hand-written receipt has no meaning — the defect this closes, pinned', async () => {
    const { curatedMarkerMeaning, sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    // Exactly what the executor returned at 22:23. Legacy-shaped, no provenance,
    // no curated rule: the sanitizer can only ship the fallback. This assertion
    // documents WHY hand-writing receipt strings is forbidden in that file.
    const old = '[removed: "Define rules for Brain\'s responsiveness…"]';
    expect(curatedMarkerMeaning(old)).toBeNull();
    expect(sanitizeAnswerForUser(old)).toBe(NEUTRAL_MARKER_FALLBACK);
  });
});

describe('DEF-238 — the executors mint renderable receipts (the live fixtures)', () => {
  beforeEach(() => {
    state.itemById = null;
    state.titleMatches = [];
    state.transitionResult = { ok: true };
  });

  it('successful remove → a receipt the sanitizer renders with the title (the 22:23 case)', async () => {
    state.itemById = { id: 'cmsotakwf0006rts1bdsrjjkj', title: TITLE_506, status: 'DRAFT' };
    state.transitionResult = { ok: true };
    const { executeRemoveOpenItem } = await import('../src/services/knowledge/internalActionExecutors');
    const { sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    const r = await executeRemoveOpenItem('TMC-0001', 2, { openItemId: 'cmsotakwf0006rts1bdsrjjkj' });
    expect(r.ok).toBe(true);
    const out = sanitizeAnswerForUser(r.message);
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
    expect(out).toContain(TITLE_506);
  });

  it('refused remove → the refusal reason reaches the rendered fact (the 20:09 case)', async () => {
    state.itemById = { id: 'draft1', title: 'Draft item', status: 'DRAFT' };
    state.transitionResult = { ok: false, error: DRAFT_REFUSAL };
    const { executeRemoveOpenItem } = await import('../src/services/knowledge/internalActionExecutors');
    const { sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    const r = await executeRemoveOpenItem('TMC-0001', 2, { openItemId: 'draft1' });
    expect(r.ok).toBe(false);
    const out = sanitizeAnswerForUser(r.message);
    expect(out).toContain(DRAFT_REFUSAL);
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
  });

  it('ambiguous title → the candidates are IN the rendered fact, so he can act', async () => {
    state.titleMatches = [
      { id: 'a', title: 'Call Asad', status: 'NEW' },
      { id: 'b', title: 'Call Asad Sheikh', status: 'NEW' },
    ];
    const { executeRemoveOpenItem } = await import('../src/services/knowledge/internalActionExecutors');
    const { sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    // 'Call' exact-matches neither title, so the DEF-103 rescue is ambiguous.
    const r = await executeRemoveOpenItem('TMC-0001', 2, { titleRef: 'Call' });
    expect(r.ok).toBe(false);
    const out = sanitizeAnswerForUser(r.message);
    expect(out).toContain('"Call Asad"');
    expect(out).toContain('"Call Asad Sheikh"');
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
  });

  it('refused mark-done → the transition error reaches the rendered fact', async () => {
    state.itemById = { id: 'x1', title: 'Send quote', status: 'IN_PROGRESS' };
    state.transitionResult = { ok: false, error: 'guard failed' };
    const { executeMarkOpenItemDone } = await import('../src/services/knowledge/internalActionExecutors');
    const { sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    const r = await executeMarkOpenItemDone('TMC-0001', 2, { openItemId: 'x1' });
    expect(r.ok).toBe(false);
    const out = sanitizeAnswerForUser(r.message);
    expect(out).toContain('guard failed');
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
  });
});
