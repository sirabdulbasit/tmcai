/**
 * DEF-249 — the confirm step derives from the dispatch authority, on the
 * SINGLE-ACTION path.
 *
 * Session 22 (08-26 10:06, the newest live failure): "delegate it to Madeeha
 * Rahat" → preview → the owner confirmed TWICE → dispatch's ground-or-ask
 * guard refused with "who to delegate to — name the exact contact or give a
 * valid email". The preview promised an action the dispatcher could not
 * execute, because `verifyActionTargets` ran only inside
 * `dispatchPendingDirect` — AFTER his "yes". DEF-240 closed exactly this for
 * PLAN steps; the single-action preview kept the old order. This is the
 * class's 11th–14th instance family (`protection-with-two-implementations`):
 * a rule enforced on one path, absent from the sibling that runs.
 *
 * Under test:
 *  - the S22 fixture against the REAL guard: an existing item + an
 *    unresolvable delegatee is refused with the exact by-name ask;
 *  - the composer's single-action preview branch consults the guard BEFORE
 *    persisting a pending (source-order assertion, the DEF-240 test's own
 *    idiom);
 *  - the guard's marker renders as a human ask, never the neutral fallback —
 *    what reaches the owner is "name the contact", BEFORE any confirmation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = {
  itemExists: true,
  candidateResolves: false,
};

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    {
      openItem: {
        findFirst: async () => (state.itemExists ? { id: 'oi-gcp' } : null),
      },
      entity: {
        findFirst: async () => (state.candidateResolves ? { id: 'ent-1' } : null),
      },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

describe('DEF-249 — the S22 fixture against the real guard', () => {
  beforeEach(() => { state.itemExists = true; state.candidateResolves = false; });

  it('an existing item with an unresolvable delegatee is refused with the by-name ask', async () => {
    const { verifyActionTargets } = await import('../src/services/knowledge/actionTargetGuard');
    const v = await verifyActionTargets('delegate_open_item', {
      openItemId: 'oi-gcp',
      delegateeCandidateId: 'ghost-madeeha',   // named a person that does not ground
    }, 2, 'TMC-0001');
    expect(v.ok).toBe(false);
    expect((v as any).marker).toContain('who to delegate to — name the exact contact or give a valid email');
  });

  it('a grounded delegatee passes — the guard blocks only what dispatch would refuse', async () => {
    state.candidateResolves = true;
    const { verifyActionTargets } = await import('../src/services/knowledge/actionTargetGuard');
    const v = await verifyActionTargets('delegate_open_item', {
      openItemId: 'oi-gcp',
      delegateeCandidateId: 'ent-1',
    }, 2, 'TMC-0001');
    expect(v.ok).toBe(true);
  });
});

describe('DEF-249 — the preview branch consults the guard BEFORE minting a pending', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8',
  );

  it('guard-before-startPending, in the single-action preview branch (DEF-240 idiom, one level up)', () => {
    // Anchor on the hoisted kind map that both the guard and the persist share
    // — one lookup, so the two sides cannot cover different kind sets.
    const branchAt = src.indexOf("schedule_meeting: 'schedule_meeting'");
    expect(branchAt).toBeGreaterThan(-1);
    const branch = src.slice(branchAt, branchAt + 6000);
    const guardAt = branch.indexOf('preview refused — target does not ground');
    const persistAt = branch.indexOf('pending.preview persisted');
    expect(guardAt).toBeGreaterThan(-1);
    expect(persistAt).toBeGreaterThan(guardAt);
  });

  it('the refusal returns the marker as the answer with NO action attached', () => {
    const refusal = src.slice(
      src.indexOf('preview refused — target does not ground'),
      src.indexOf('preview refused — target does not ground') + 700,
    );
    expect(refusal).toContain("answer: (verdict as any).marker");
    expect(refusal).toContain('action: null');
    expect(refusal).toContain("message: 'target_unresolved'");
  });
});

describe('DEF-249 — what reaches the owner is a human ask, before any confirmation', () => {
  it('the delegate ask marker renders as prose naming what to provide — never the fallback', async () => {
    const { sanitizeAnswerForUser } = await import('../src/services/knowledge/answerSanitizer');
    const { NEUTRAL_MARKER_FALLBACK } = await import('../src/services/knowledge/systemMarker');
    const out = sanitizeAnswerForUser('[target unresolved: who to delegate to — name the exact contact or give a valid email]');
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
    expect(out.toLowerCase()).toContain('contact');
    expect(out).not.toContain('[target unresolved');
  });
});
