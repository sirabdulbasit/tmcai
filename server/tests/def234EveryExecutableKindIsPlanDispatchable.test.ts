/**
 * DEF-234 — a kind the composer can execute is dispatchable from a confirmed plan.
 *
 * Owner ruling, 2026-08-19 (`BRAIN_VISION.md`, "How the nine are governed"): *"we will govern
 * all capabilities through LLM where we will have some guardrail (like tenant and user scope
 * etc will decide later in detail)"* — and a guardrail is an invariant about ANY action, never
 * a list of which actions are allowed.
 *
 * `DISPATCHABLE_PLAN_STEP_KINDS` was such a list: 15 hand-written strings beside 18 kinds the
 * composer could actually execute. The four in the gap — set_contact_scope,
 * mark_contact_inactive, archive_wiki_page, delete_wiki_page — worked when asked for directly
 * and died with "no dispatcher for this action in a confirmed plan" the moment they appeared
 * in a plan the owner had confirmed. That is the sentence he read 16 times, and DEF-232 had
 * already closed it once for four OTHER kinds by adding them to the list. Closing a class by
 * hand, one member at a time, is what the ruling ends.
 *
 * The gate is now DERIVED from `COMPOSER_DISPATCHED_TYPES`, so the omission is no longer
 * expressible. These tests exist to keep it that way: the first would have failed on every
 * revision from DEF-023 to DEF-232, and it is the one that matters.
 */
import { describe, it, expect } from 'vitest';
import {
  COMPOSER_DISPATCHED_TYPES, DISPATCHABLE_PLAN_STEP_KINDS,
} from '../src/services/knowledge/brainComposer';

const THE_FOUR = [
  'set_contact_scope', 'mark_contact_inactive', 'archive_wiki_page', 'delete_wiki_page',
] as const;

describe('DEF-234 — the gate cannot omit an executable kind', () => {
  it('every kind the composer can execute is plan-dispatchable', () => {
    const missing = [...COMPOSER_DISPATCHED_TYPES]
      .filter((k) => !DISPATCHABLE_PLAN_STEP_KINDS.has(k));
    // The failure message names the kinds, because "expected 4 to be 0" would send the next
    // reader back to the source to work out which capability the owner just lost.
    expect(missing, `executable but refused in a confirmed plan: ${missing.join(', ')}`)
      .toEqual([]);
  });

  it('the four kinds that were in the gap are now dispatchable', () => {
    for (const kind of THE_FOUR) {
      expect(DISPATCHABLE_PLAN_STEP_KINDS.has(kind), `${kind} must be plan-dispatchable`)
        .toBe(true);
    }
  });

  it('the gate adds NOTHING beyond the executable set', () => {
    // A kind allowed here that CANNOT execute is the mirror-image defect: the owner is asked
    // to confirm something that dies after his "yes".
    const extra = [...DISPATCHABLE_PLAN_STEP_KINDS]
      .filter((k) => !COMPOSER_DISPATCHED_TYPES.has(k));
    expect(extra).toEqual([]);
  });

  it('nested plans are still rejected, and now for free', () => {
    // `action_plan` is the container plans arrive in, never an inline act, so it is absent
    // from the executable set and the derivation excludes it without a special case. Worth
    // its own assertion: my first derivation ADDED it back, because an audit regex read the
    // old literal's comment `// 'action_plan' is deliberately absent` as a member.
    expect(COMPOSER_DISPATCHED_TYPES.has('action_plan')).toBe(false);
    expect(DISPATCHABLE_PLAN_STEP_KINDS.has('action_plan')).toBe(false);
  });

  it('is derived, not copied — adding to the executable set carries into the gate', () => {
    // Proves the relationship holds by CONSTRUCTION rather than by two lists that happen to
    // agree today. If someone reverts the gate to a literal, this fails.
    expect(DISPATCHABLE_PLAN_STEP_KINDS.size).toBe(COMPOSER_DISPATCHED_TYPES.size);
  });

  it('the executors the four kinds need all exist and are callable', async () => {
    const mod = await import('../src/services/knowledge/internalActionExecutors');
    for (const name of [
      'executeSetContactScope', 'executeMarkContactInactive',
      'executeArchiveWikiPage', 'executeDeleteWikiPage',
    ] as const) {
      expect(typeof (mod as any)[name], `${name} must be exported`).toBe('function');
    }
  });

  it('the four are declared to the model, which is the point of the ruling', async () => {
    // Governance direction: the model decides. A capability it cannot express is a capability
    // Brain does not have, whatever the dispatcher can do.
    // Read through CAPABILITY_HINTS, which is the registry's OWN normalisation of its
    // handles: one row can cover several kinds with a slash-joined handle
    // ('archive_wiki_page / delete_wiki_page'), and re-implementing that split in a test is
    // how a second interpretation of one convention gets born. Two earlier versions of this
    // assertion failed for exactly that reason — first by guessing the export shape, then by
    // reading raw handles.
    const { CAPABILITY_HINTS } = await import('../src/services/knowledge/brainCapabilityRegistry');
    const handles = new Set(Object.keys(CAPABILITY_HINTS));
    for (const kind of THE_FOUR) {
      expect(handles.has(kind), `${kind} must be declared in the capability registry`).toBe(true);
    }
  });
});
