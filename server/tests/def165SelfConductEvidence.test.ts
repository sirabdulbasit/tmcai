/**
 * DEF-165 — the record said WHAT, so the model invented WHY.
 *
 * Codex's iteration-18 HIGH #2. After iteration 18 removed B12's fabricated cure,
 * the remaining answer was:
 *
 *   "That was a system stutter on my end."
 *
 * A different invented cause, in the same slot, with `buildDispatchLedgerBlock`
 * already in the prompt reporting that nothing had been dispatched. Iteration 18's
 * response was a line in `CORE_CONVERSATIONAL_RULES` ("don't diagnose yourself"),
 * and Codex demonstrated it losing.
 *
 * ── WHY IT LOST, WHICH IS THE PART WORTH FIXING ─────────────────────────────
 *
 * The dispatch record is authoritative and the model honours it — it answers "did
 * you send that?" from these rows. But every line of the block was about WHETHER
 * an action happened. Nothing in it said that WHY is unavailable. So a "why"
 * question met an authoritative block with no answer in it, twenty blocks away
 * from a general rule telling it not to guess, and it guessed.
 *
 * `examples-outvote-the-instruction` (DEF-138) is the same lesson pointing the
 * other way: what sits next to the data wins. So the epistemic boundary now lives
 * IN the evidence block — "there is no cause field, and naming one is a fabricated
 * finding even when it sounds technical".
 *
 * ── WHAT THESE TESTS CAN AND CANNOT PROVE ───────────────────────────────────
 *
 * They prove the boundary is in the block on both composer paths, and that it is
 * present in the empty-ledger case, which is the case B12 hits. They CANNOT prove
 * the model obeys it — no unit test can. That half is a prediction, and the score
 * is its only judge. Saying so is the point: iteration 18 claimed a class-level
 * truthfulness mechanism on the strength of a passing regex test, and Codex was
 * right that the claim outran the evidence.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let artifacts: any[] = [];

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), count: async () => 0,
  };
  const p: any = new Proxy(
    {
      brainActionArtifact: { findMany: async () => artifacts },
      whatsAppMessage: { findMany: async () => [] },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/behaviorConfig', () => ({
  __esModule: true, getBehaviorValue: async () => 24,
}));

import { buildDispatchLedgerBlock } from '../src/services/knowledge/dispatchLedgerService';

beforeEach(() => { artifacts = []; });

describe('DEF-165 — the evidence block states what it cannot tell you', () => {
  it('says WHY is not recorded, in the empty-ledger case B12 hits', async () => {
    // B12's history is synthetic: no artifacts. This is precisely the turn where
    // the model had nothing and produced "a system stutter on my end".
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');

    expect(block, 'the empty case must still carry the boundary').toContain('no actions dispatched');
    expect(block).toMatch(/WHY something happened is NOT in this record/i);
    expect(block, 'it must say there is no cause field to read').toMatch(/no\s+cause\s+field/i);
    expect(block, 'and name the required behaviour, not just the prohibition')
      .toMatch(/cause is not recorded/i);
  });

  it('names the euphemisms as guesses rather than banning words', async () => {
    // Codex: "Do not chase glitch/stutter/sync/job synonyms with regex." These
    // appear as EXAMPLES OF GUESSING inside the evidence block, which is a
    // different mechanism from a validator pattern — the model is told why they
    // are wrong, not merely that a string is forbidden. The one it actually
    // produced is among them.
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('stutter on my end');
    expect(block).toMatch(/GUESSES/);
    expect(block, 'the point is that sounding technical is not evidence')
      .toMatch(/fabricated finding/i);
  });

  it('carries the boundary when the ledger is NOT empty', async () => {
    // The failure is not specific to an empty record: a turn can have real
    // dispatches and still be asked why one of them went twice.
    artifacts = [{
      createdAt: new Date('2026-08-13T09:08:00Z'),
      actionType: 'notify_via_whatsapp', status: 'sent',
      // `summarisePayload` reads recipientName BEFORE title, so that is what the
      // line renders — asserted below on what it actually produces.
      payload: { recipientName: 'Hamna Latif Bhutta', title: 'Reminder: Fujairah pricing' },
      artifactExtId: 'wamid.X', errorMessage: null,
    }];
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');

    expect(block, 'the dispatch is still reported').toMatch(/Hamna Latif Bhutta/);
    expect(block).toMatch(/WHY something happened is NOT in this record/i);
  });

  it('still answers "did you" as authoritatively as before', async () => {
    // The added boundary must not soften the existing contract. If the record
    // becomes hedged about WHAT happened, DEF-037 regresses and "did you inform
    // Hamna?" goes back to being a guess.
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('you did NOT do it in this window');
    expect(block).toContain('If it IS listed, you did');
  });
});

describe('DEF-165 — both composer paths receive the record', () => {
  /**
   * The parity gap found while fixing the above: `buildDispatchLedgerBlock` was
   * wired into `reasoningCompose` only. The legacy path assembled its prompt
   * without it, so on that path "did you send that?" had no record to read at all
   * — the DEF-037 failure, still live, on a path reachable by
   * `BRAIN_USE_REASONING=never` or `useReasoning:false`.
   *
   * Asserted on the source because `assembleSystemPrompt` is private and driving
   * a full compose here would need the entire retrieval stack mocked. That makes
   * this a SUPPLEMENT, not proof — it pins the wiring, not the behaviour, and the
   * behavioural claim in the build entry is limited to what the block contains.
   */
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = () => fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');

  it('the legacy assembler accepts and pushes the block', () => {
    const s = src();
    expect(s).toContain('dispatchLedgerBlock?: string;');
    expect(s).toContain('if (dispatchLedgerBlock) parts.push(dispatchLedgerBlock);');
  });

  it('the legacy path builds it from the SAME service the reasoning path uses', () => {
    // Two renderers of one ledger would be the tenth occurrence of
    // `protection-with-two-implementations`.
    const s = src();
    const builders = s.match(/buildDispatchLedgerBlock/g) ?? [];
    expect(builders.length, 'reasoning import, legacy import, and one call each')
      .toBeGreaterThanOrEqual(4);
    expect(s).toContain('dispatchLedgerBlock: legacyDispatchLedgerBlock');
  });
});
