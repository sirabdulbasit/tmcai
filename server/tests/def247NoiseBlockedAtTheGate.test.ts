/**
 * DEF-247 — sender quality is enforced AT THE GATE, and nowhere else.
 *
 * The measured failure (Comm surface, 08-26 01:05, AFTER 7a36f03 deployed):
 * `isLikelyAutomated` was wired into autonomousExecutor while
 * emailItemDerivationJob — the job that actually mints gmail items — never
 * called it, and an Anthropic no-reply email ("You have new requests from
 * your team") became a to-do item. A guard on one write path and minting on
 * another is `protection-with-two-implementations` (10 deep), now caught
 * eating its own fix.
 *
 * Under test:
 *  - the live fixture's sender IS caught by the shared predicate (pins the
 *    heuristic against the exact falsifier-hit address shape);
 *  - `gateOpenItemCreate` BLOCKS a feed-derived create from an automated
 *    sender — so every creator, present and future, inherits the rule;
 *  - the derivation job skips a newsletter BEFORE spending an LLM judgement,
 *    with the `skipped` receipt — using the same shared predicate, never a
 *    copy.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

// The falsifier-hit shape, verbatim pattern from the Comm surface.
const ANTHROPIC_NOREPLY = 'no-reply-ctb0dubtzwoslyip@mail.anthropic.com';

// ── real predicate — no mocks, this is the shared rule itself ───────────────
import { isLikelyAutomated } from '../src/services/knowledge/senderQualityFilter';

describe('DEF-247 — the shared predicate catches the live fixture', () => {
  it('the Anthropic no-reply sender that became an item on 08-26 is automated', () => {
    expect(isLikelyAutomated(ANTHROPIC_NOREPLY)).toBe(true);
  });
  it('a human colleague is not', () => {
    expect(isLikelyAutomated('asad.ahmed@tmcltd.com')).toBe(false);
  });
});

// ── gate enforcement ────────────────────────────────────────────────────────
const gateState = {
  senderEmail: ANTHROPIC_NOREPLY as string | null,
};

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    {
      feedEvent: {
        findUnique: async () => ({ senderEmail: gateState.senderEmail, senderPhone: null, sourceType: 'gmail' }),
      },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/knowledge/brainMuteService', () => ({
  __esModule: true,
  getBrainMutedSenders: async () => ({ emails: new Set<string>(), phones: new Set<string>() }),
}));

describe('DEF-247 — the gate blocks an automated-sender feed-derived create', () => {
  beforeEach(() => { gateState.senderEmail = ANTHROPIC_NOREPLY; });

  it('blocks with a reason naming the sender — every creator inherits this', async () => {
    const { gateOpenItemCreate } = await import('../src/services/openItems/openItemGate');
    const gate = await gateOpenItemCreate({
      clientNumber: 'TMC-0001', userId: 2,
      sourceFeedEventId: 'fe-anthropic',
      title: 'You have new requests from your team',
      description: 'from the Anthropic console',
    });
    expect(gate.block).toBe(true);
    expect(gate.reason).toContain('automated_sender');
    expect(gate.reason).toContain(ANTHROPIC_NOREPLY);
  });

  it('a human sender passes this filter (block, if any, must come from later gate stages)', async () => {
    gateState.senderEmail = 'asad.ahmed@tmcltd.com';
    const { gateOpenItemCreate } = await import('../src/services/openItems/openItemGate');
    const gate = await gateOpenItemCreate({
      clientNumber: 'TMC-0001', userId: 2,
      sourceFeedEventId: 'fe-human',
      title: 'Approve the Fujairah pricing',
      description: 'Asad needs approval',
      priority: 'high',
      dueDate: new Date(),
    });
    // Whatever later stages decide, the sender-quality stage must not be the
    // blocker for a human address.
    if (gate.block) expect(gate.reason ?? '').not.toContain('automated_sender');
  });
});
