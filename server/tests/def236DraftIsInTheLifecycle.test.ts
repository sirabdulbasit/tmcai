/**
 * DEF-236 — DRAFT was a live status the lifecycle had never heard of.
 *
 * Owner, 2026-08-20, on a red deck row: "Couldn't delete the draft item, with no reason he
 * could act on" — 3 occurrences, 2 of them AFTER a fix shipped, which is what turns a row red.
 * Brain had told him "one of the items was a draft, and my removal process has a bug", and I
 * flagged that as possibly fabricated. It was not: `isValidStatus('DRAFT')` returned false, so
 * `lifecycleService` refused every transition with "current status DRAFT is not in the v15
 * lifecycle — migrate first". His most-repeated request — delete all open items — died there.
 *
 * The tempting fix was the one that error invites: migrate the one row away. That would have
 * hidden the class. `openItemDraftAskJob` runs DAILY over exactly these items to fill their
 * slots over WhatsApp, and `update_open_item` is documented as "typically used to complete
 * DRAFT items". The gate creates them on purpose. DRAFT is a product concept; the matrix was
 * simply missing it, and the next draft would have failed identically.
 */
import { describe, it, expect } from 'vitest';
import {
  ALL_STATUSES, TRANSITIONS, isValidStatus, findTransition,
} from '../src/services/itemLifecycle/transitionMatrix';

/** A transition is legal iff the matrix declares it. `findTransition` is the matrix's own
 *  accessor — asserting through it rather than re-scanning TRANSITIONS means the test checks
 *  what the lifecycle actually consults. */
const isAllowed = (from: any, to: any) => Boolean(findTransition(from, to));

describe('DEF-236 — DRAFT is a first-class status', () => {
  it('is a valid status, which is the whole defect', () => {
    // This single assertion fails on every revision before this one, and it is the one the
    // owner's request died on.
    expect(isValidStatus('DRAFT')).toBe(true);
    expect(ALL_STATUSES).toContain('DRAFT');
  });

  it('can be REMOVED — the owner asking to delete a draft now has a legal path', () => {
    expect(isAllowed('DRAFT', 'CANCELLED')).toBe(true);
  });

  it('ABANDON is cancelled, never closed; COMPLETION closes with evidence — DEF-251 split the two cases', () => {
    // This test used to pin `isAllowed('DRAFT','CLOSED') === false` — the DEF-129 rule
    // read as "a draft can never close". S23 (2026-08-27) proved the enumeration wrong
    // from the other side: the payroll work WAS done ("I replied to Arshad") and the
    // record could not say so — "I wasn't able to close the item… because it's still in
    // draft". The rule's real content is narrower and survives: an ABANDON must never be
    // written as completion. DEF-251 encodes exactly that: DRAFT→CLOSED now exists but
    // demands `resolution_reason` (completion evidence), while DRAFT→CANCELLED remains
    // the evidence-free abandon path.
    expect(isAllowed('DRAFT', 'CLOSED')).toBe(true);
    const t = TRANSITIONS.find((x) => x.from === 'DRAFT' && x.to === 'CLOSED');
    expect(t?.guards).toContain('resolution_reason');
    const abandon = TRANSITIONS.find((x) => x.from === 'DRAFT' && x.to === 'CANCELLED');
    expect(abandon?.guards ?? []).not.toContain('resolution_reason');
  });

  it('can graduate to a real item once its slots are filled', () => {
    // What openItemDraftAskJob is for.
    expect(isAllowed('DRAFT', 'TRIAGED')).toBe(true);
  });

  it('can be picked up directly, skipping the slot-filling', () => {
    expect(isAllowed('DRAFT', 'IN_PROGRESS')).toBe(true);
  });

  it('has NO way IN — a draft is where a life starts, not a phase of one', () => {
    // If some path ever needs to demote an item back to DRAFT, that is a product decision and
    // belongs in this matrix with a description, not as a quiet raw UPDATE.
    const into = TRANSITIONS.filter((t) => t.to === 'DRAFT');
    expect(into, `unexpected ways into DRAFT: ${into.map((t) => t.from).join(', ')}`)
      .toEqual([]);
  });

  it('exits to exactly four states, all of them declared', () => {
    // DEF-251 added the fourth: CLOSED, evidence-guarded — "three, and only
    // three" missed the case where the work gets DONE while the item is still
    // a draft (S23, the payroll item).
    const out = TRANSITIONS.filter((t) => t.from === 'DRAFT').map((t) => t.to).sort();
    expect(out).toEqual(['CANCELLED', 'CLOSED', 'IN_PROGRESS', 'TRIAGED']);
    for (const t of TRANSITIONS.filter((x) => x.from === 'DRAFT')) {
      expect(t.description.length, `${t.from}->${t.to} needs a description`).toBeGreaterThan(20);
    }
  });

  it('every status in ALL_STATUSES is reachable or terminal — no orphans but DRAFT', () => {
    // A status with neither an entry nor an exit is dead config. DRAFT is the one legitimate
    // exception (created by the gate, not transitioned into), and naming it here means a
    // FUTURE orphan cannot hide behind it.
    for (const st of ALL_STATUSES) {
      const hasIn = TRANSITIONS.some((t) => t.to === st);
      const hasOut = TRANSITIONS.some((t) => t.from === st);
      if (st === 'DRAFT') { expect(hasOut).toBe(true); continue; }
      expect(hasIn || hasOut, `${st} has no transitions at all`).toBe(true);
    }
  });
});
