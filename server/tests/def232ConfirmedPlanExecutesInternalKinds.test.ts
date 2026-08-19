/**
 * DEF-232 — `no-dispatcher-in-confirmed-plan`: the owner's confirmed plan
 * died at a register three other registers contradicted.
 *
 * His words (S33, 2026-08-19 12:16–17): "delete all open items" → "confirm
 * delete all 7 items" → **"step 1 (remove_open_item): no dispatcher for this
 * action in a confirmed plan."** ~14 owner-facing hits over 11 days: S32
 * ("Yes remove every item from open items list"), S14 ("Remove all the
 * meaningless kind of actionable items" — died on `mark_open_item_done`),
 * S15 ("Chase everyone … don't ask for permission" — died on
 * `record_preference`).
 *
 * The gate was NOT lying: `DISPATCHABLE_PLAN_STEP_KINDS` mirrors
 * `dispatchPendingDirect`'s switch exactly (planStepDispatchability.test.ts,
 * DEF-023, both directions). The SWITCH was missing the four kinds whose
 * working implementations ran inline in `compose` the whole time — DEF-023's
 * own defect shape, for the kinds DEF-023 left out when it extracted only
 * `update_open_item`.
 *
 * The class fix is one implementation, two callers: the inline branches and
 * the confirmed-plan cases now call the SAME `internalActionExecutors`
 * functions. And the invariant that produced all fourteen failures is pinned
 * here: a kind that dispatches immediately can NEVER be refused in a
 * confirmed plan.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// ── steerable state for the executor behaviour tests ────────────────────────
const state = {
  itemById: null as any,
  titleMatches: [] as any[],
  transitions: [] as Array<{ id: string; to: string; reason?: string }>,
  transitionResult: { ok: true } as { ok: boolean; error?: string },
  savedPrefs: [] as any[],
  savedName: undefined as string | null | undefined,
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
  transitionStatus: async (id: string, to: string, opts: any) => {
    state.transitions.push({ id, to, reason: opts?.reason });
    return state.transitionResult;
  },
}));

vi.mock('../src/services/knowledge/userMemoryService', () => ({
  __esModule: true,
  recordExplicitMemory: async (row: any) => { state.savedPrefs.push(row); },
}));

vi.mock('../src/services/knowledge/brainPersonaService', () => ({
  __esModule: true,
  setBrainName: async (_userId: number, name: string | null) => { state.savedName = name; return name; },
}));

import {
  DISPATCHABLE_PLAN_STEP_KINDS,
  IMMEDIATE_INTERNAL_ACTION_TYPES,
} from '../src/services/knowledge/brainComposer';
import {
  executeRemoveOpenItem,
  executeMarkOpenItemDone,
  executeRecordPreference,
  executeSetBrainName,
} from '../src/services/knowledge/internalActionExecutors';

const COMPOSER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8',
);
/** Comments stripped — a source guard must read code, not prose about it. */
const CODE = COMPOSER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

beforeEach(() => {
  state.itemById = null;
  state.titleMatches = [];
  state.transitions = [];
  state.transitionResult = { ok: true };
  state.savedPrefs = [];
  state.savedName = undefined;
});

describe('DEF-232 — THE INVARIANT that produced all fourteen failures', () => {
  it('every immediately-dispatchable kind is plan-dispatchable', () => {
    // This is the class, not the instance: `update_open_item` (DEF-023),
    // then `remove_open_item`/`mark_open_item_done`/`record_preference`
    // (DEF-232) each fell through this exact gap one at a time. A kind the
    // composer will execute on a bare instruction must never be refused
    // after an explicit confirmation — confirmation only ADDS authority.
    for (const kind of IMMEDIATE_INTERNAL_ACTION_TYPES) {
      expect(
        DISPATCHABLE_PLAN_STEP_KINDS.has(kind),
        `${kind} executes inline but a confirmed plan would refuse it`,
      ).toBe(true);
    }
  });

  it("the owner's three dead requests are now dispatchable in a confirmed plan", () => {
    // S33/S32: "delete all open items" · S14: "remove all the meaningless
    // kind of actionable items" · S15: "don't ask for permission for this".
    for (const kind of ['remove_open_item', 'mark_open_item_done', 'record_preference']) {
      expect(DISPATCHABLE_PLAN_STEP_KINDS.has(kind), kind).toBe(true);
    }
    expect(DISPATCHABLE_PLAN_STEP_KINDS.has('set_brain_name')).toBe(true);
  });

  it('nested plans stay undispatchable — the one deliberate exclusion', () => {
    expect(DISPATCHABLE_PLAN_STEP_KINDS.has('action_plan')).toBe(false);
  });
});

describe('DEF-232 — one implementation, two callers', () => {
  it('the confirmed-plan switch has a real case for each kind', () => {
    // planStepDispatchability.test.ts enforces gate ⊆ cases already; this
    // pins the four by name so a revert of one case names the owner request
    // it kills.
    const start = CODE.indexOf('async function dispatchPendingDirect');
    const end = CODE.indexOf('Unknown pending action kind', start);
    const body = CODE.slice(start, end);
    for (const kind of ['remove_open_item', 'mark_open_item_done', 'record_preference', 'set_brain_name']) {
      expect(body).toContain(`case '${kind}':`);
    }
  });

  it('both paths call the SAME executors — the module is imported, the bodies are gone', () => {
    expect(CODE).toContain("await import('./internalActionExecutors')");
    // The single-implementation proof: the ambiguity question and the
    // closure-summary header now live ONLY in internalActionExecutors. A
    // second copy reappearing in the composer is the drift this class is
    // made of (protection-with-two-implementations, 10 recorded).
    expect(CODE).not.toContain('matches ${matches.length} items');
    expect(CODE).not.toContain('let summary = `Marked');
    expect(CODE).not.toContain('recordExplicitMemory');
  });
});

describe('DEF-232 — executeRemoveOpenItem (the S33 request)', () => {
  it('removes by id through the lifecycle matrix, CANCELLED not deleted', async () => {
    state.itemById = { id: 'it-1', title: 'Fujairah pricing', status: 'NEW' };
    const r = await executeRemoveOpenItem('TMC-0001', 2, { openItemId: 'it-1' });
    expect(r.ok).toBe(true);
    expect(r.artifactId).toBe('it-1');
    expect(r.message).toBe('[removed: "Fujairah pricing"]');
    expect(state.transitions).toEqual([
      { id: 'it-1', to: 'CANCELLED', reason: 'Removed via Brain Chat' },
    ]);
  });

  it('a stale id with a title falls back to the name he actually said', async () => {
    state.itemById = null;
    state.titleMatches = [{ id: 'it-9', title: 'Exam solution', status: 'NEW' }];
    const r = await executeRemoveOpenItem('TMC-0001', 2, { openItemId: 'gone', titleRef: 'Exam solution' });
    expect(r.ok).toBe(true);
    expect(state.transitions[0]).toMatchObject({ id: 'it-9', to: 'CANCELLED' });
  });

  it('ambiguity is a question, never a guess — and nothing transitions', async () => {
    // NB: an EXACT title match wins even with fuzzy siblings (DEF-103), so
    // the ambiguous case is a fragment matching several titles exactly-never.
    state.titleMatches = [
      { id: 'a', title: 'Call Asad', status: 'NEW' },
      { id: 'b', title: 'Call Asad Sheikh', status: 'NEW' },
    ];
    const r = await executeRemoveOpenItem('TMC-0001', 2, { titleRef: 'Call' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('matches 2 items');
    expect(r.message).toContain('"Call Asad"');
    expect(r.message).toContain('"Call Asad Sheikh"');
    expect(state.transitions).toHaveLength(0);
  });

  it('a refused transition is a refusal, never a fabricated removal (DEF-128 family)', async () => {
    state.itemById = { id: 'it-1', title: 'X', status: 'NEW' };
    state.transitionResult = { ok: false, error: 'approval required' };
    const r = await executeRemoveOpenItem('TMC-0001', 2, { openItemId: 'it-1' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not removed — approval required');
  });
});

describe('DEF-232 — executeMarkOpenItemDone (the S14 request)', () => {
  it('closes through the matrix and reads the result', async () => {
    state.itemById = { id: 'it-2', title: 'Send quote', status: 'NEW', delegateeName: null };
    const r = await executeMarkOpenItemDone('TMC-0001', 2, { openItemId: 'it-2' });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Marked "Send quote" done.');
    expect(state.transitions[0]).toMatchObject({ id: 'it-2', to: 'CLOSED' });
  });

  it('an already-closed item is refused, not re-completed', async () => {
    state.itemById = { id: 'it-2', title: 'Send quote', status: 'CLOSED' };
    const r = await executeMarkOpenItemDone('TMC-0001', 2, { openItemId: 'it-2' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('already closed');
    expect(state.transitions).toHaveLength(0);
  });

  it('a refused transition is reported as a refusal (DEF-128, verbatim behaviour)', async () => {
    state.itemById = { id: 'it-2', title: 'Send quote', status: 'NEW' };
    state.transitionResult = { ok: false, error: 'guard failed' };
    const r = await executeMarkOpenItemDone('TMC-0001', 2, { openItemId: 'it-2' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not closed — guard failed');
  });
});

describe('DEF-232 — executeRecordPreference (the S15 request) and executeSetBrainName', () => {
  it('persists the preference and confirms it in the same words as before', async () => {
    const r = await executeRecordPreference('TMC-0001', 2, {
      key: 'skip_confirmation_on_direct_instruction', value: true,
    });
    expect(r.ok).toBe(true);
    expect(r.artifactId).toBe('pref:skip_confirmation_on_direct_instruction');
    expect(r.message).toContain('"skip_confirmation_on_direct_instruction" as true');
    expect(state.savedPrefs).toEqual([{
      clientNumber: 'TMC-0001', userId: 2,
      key: 'skip_confirmation_on_direct_instruction', value: true,
    }]);
  });

  it('keeps the email_max_age_days special wording', async () => {
    const r = await executeRecordPreference('TMC-0001', 2, { key: 'email_max_age_days', value: 7 });
    expect(r.message).toContain('most recent 7 days');
  });

  it('sets and clears the name with the original confirmations', async () => {
    const set = await executeSetBrainName(2, { name: 'Friday' });
    expect(set.message).toBe('Got it — from now on you can call me Friday.');
    expect(state.savedName).toBe('Friday');
    const cleared = await executeSetBrainName(2, { name: null });
    expect(cleared.ok).toBe(true);
    expect(cleared.message).toContain('Cleared my custom name');
  });
});

describe('DEF-232 — the preview names what leaves his list', () => {
  it('a remove step shows the item, not a bare verb', async () => {
    // "remove open item" ×7 is unconfirmable — he cannot tell WHAT he is
    // approving. Rendered via the real preview renderer.
    const { renderPlanPreview } = await import('../src/services/knowledge/brainComposer');
    const preview = await renderPlanPreview(
      [
        { kind: 'remove_open_item', slots: { titleRef: 'Exam solution' } },
        { kind: 'record_preference', slots: { key: 'quiet_hours', value: '22:00-07:00' } },
      ],
      2, 'TMC-0001',
    );
    expect(preview).toContain('Remove "Exam solution" from your open items');
    expect(preview).toContain('Remember your preference: quiet_hours = 22:00-07:00');
    expect(preview).not.toMatch(/^\d+\. remove open item$/m);
  });
});
