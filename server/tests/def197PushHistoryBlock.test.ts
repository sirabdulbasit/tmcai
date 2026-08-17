/**
 * DEF-197 / C-3 — Brain's own push history reaches the composer.
 *
 * The defect these tests pin: benchmark case `B12-reminder-referent` asks
 * *"Why did you remind me about that one twice?"* and Brain answered "It looks
 * like my reminder job ran twice for that item… I don't have a specific reason
 * recorded" — an invented mechanism, scored down on C1 (fabrication), C2
 * (ungrounded) and C4 (canned). C-3 increment 1 already computed the true
 * answer from `brain_prompt_queue` and handed it to a CLI script, so it never
 * reached the surface where the owner asks.
 *
 * ── WHAT THESE TESTS ARE BUILT TO CATCH, FROM THIS PROJECT'S OWN SCARS ──────
 *
 * 1. **A false zero.** DEF-085's row: *a read that failed is not "no noise"*.
 *    A failed read must produce UNAVAILABLE, never a block saying nothing was
 *    sent — otherwise Brain denies a push that happened.
 * 2. **One-path wiring.** DEF-165 exists because the sibling `dispatchLedger`
 *    block was wired to the reasoning composer only, leaving the legacy path
 *    answering from the transcript. Reasoning is default-ON, so that stayed
 *    invisible. The last test reads the composer SOURCE and fails if either
 *    path loses the block.
 * 3. **A guard that passes by reading its own prose.** DEF-195's invariant test
 *    went green because it matched the comments describing the old code. The
 *    source assertions here STRIP COMMENTS before matching.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  renderPushHistoryBlock,
  renderPushHistoryUnavailable,
} from '../src/services/selfpruning/pushHistoryBlock';
import type { NoiseSummary, SubjectGroup } from '../src/services/selfpruning/inboundNoiseLedger';

function subject(over: Partial<SubjectGroup> & { subjectKey: string; reached: number }): SubjectGroup {
  return {
    producers: [], acted: 0, ignored: 0, ignoredShare: 0,
    firstAt: new Date('2026-08-17T09:00:00Z'), lastAt: new Date('2026-08-17T10:48:00Z'),
    spanMinutes: 108, burst: false, samples: [],
    ...over,
  } as SubjectGroup;
}

function summary(over: Partial<NoiseSummary> = {}): NoiseSummary {
  return {
    clientNumber: 'TMC-0001', userId: 2, windowHours: 36,
    since: new Date('2026-08-16T00:00:00Z'), until: new Date('2026-08-17T12:00:00Z'),
    totalReached: 0, totalActed: 0, totalIgnored: 0,
    truncated: false, canonicalisationFailed: false, unresolvedSubjects: [],
    burstMaxSpanMinutes: 1440, subjects: [], bursts: [], unattributed: [], floods: [],
    ...over,
  } as NoiseSummary;
}

describe('DEF-197 — the push-history block answers "why twice?" from rows', () => {
  it('names the count, the producers and the times for a repeat-pushed subject', () => {
    const out = renderPushHistoryBlock(summary({
      totalReached: 2, totalActed: 0,
      subjects: [subject({
        subjectKey: 'item:cmqauv4xx', reached: 2, acted: 0, ignored: 2,
        producers: [
          { producer: 'preactive_due_nudge', reached: 1, acted: 0 },
          { producer: 'delegation_followup', reached: 1, acted: 0 },
        ],
      })],
    }));
    // The three facts B12 could not state: how many, by what, and when.
    expect(out).toContain('item:cmqauv4xx');
    expect(out).toContain('2 pushes delivered');
    expect(out).toContain('preactive_due_nudge 1×');
    expect(out).toContain('delegation_followup 1×');
    expect(out).toContain('spanning 108 min');
    expect(out).toContain('2026-08-17 09:00');
  });

  it('does not list single-push subjects individually, but does report that they exist', () => {
    const out = renderPushHistoryBlock(summary({
      totalReached: 4, totalActed: 1,
      subjects: [
        subject({ subjectKey: 'item:once-a', reached: 1 }),
        subject({ subjectKey: 'item:once-b', reached: 1 }),
        subject({ subjectKey: 'item:once-c', reached: 1 }),
      ],
    }));
    expect(out).not.toContain('item:once-a');
    expect(out).toContain('No subject was pushed to him more than once');
    expect(out).toContain('3 further subject(s) were pushed exactly once');
  });

  it('instructs Brain to CONTRADICT a false repeat premise instead of agreeing with it', () => {
    // The owner can misremember. If his subject is absent from the block the
    // record shows at most one push, and agreeing that it went twice would be a
    // new fabrication wearing this block as evidence.
    const out = renderPushHistoryBlock(summary());
    expect(out).toMatch(/absent below, your record shows at most one push/);
    expect(out).toMatch(/rather than agreeing that it went twice/);
  });

  it('forbids inventing a cause — "I don\'t know" is the sanctioned answer', () => {
    const out = renderPushHistoryBlock(summary());
    expect(out).toMatch(/Never invent a cause for a duplicate/);
    expect(out).toMatch(/a plausible mechanism you cannot\s+read is a fabrication/);
  });

  it('carries increment 1\'s honesty flags so a FLOOR is never read as a total', () => {
    const out = renderPushHistoryBlock(summary({
      totalReached: 9000, truncated: true, canonicalisationFailed: true,
      unresolvedSubjects: ['thread:t1', 'thread:t2'],
      subjects: [subject({ subjectKey: 'item:x', reached: 4 })],
    }));
    expect(out).toContain('TRUNCATED');
    expect(out).toContain('FLOOR, not a total');
    expect(out).toContain('thread→item lookup failed');
    expect(out).toContain('2 thread identities did not resolve');
  });

  it('UNAVAILABLE is explicitly not "nothing was sent" — the DEF-085 property', () => {
    const out = renderPushHistoryUnavailable('connection reset');
    expect(out).toContain('UNAVAILABLE');
    expect(out).toContain('connection reset');
    expect(out).toContain('NOT the same as "nothing was sent"');
    // The fatal wording would be a claim of zero. It must not appear.
    expect(out).not.toMatch(/0 pushes delivered/);
    expect(out).not.toMatch(/No subject was pushed/);
  });
});

describe('DEF-197 — a failed read degrades to UNAVAILABLE, never to a false zero', () => {
  beforeEach(() => { vi.resetModules(); });

  it('returns the UNAVAILABLE block when the summariser throws', async () => {
    vi.doMock('../src/services/selfpruning/inboundNoiseLedger', () => ({
      summariseInboundNoise: async () => { throw new Error('relation does not exist'); },
    }));
    const { buildPushHistoryBlock } = await import('../src/services/selfpruning/pushHistoryBlock');
    const out = await buildPushHistoryBlock(2, 'TMC-0001');
    expect(out).toContain('UNAVAILABLE');
    expect(out).toContain('relation does not exist');
    // It must not throw: a broken push record cannot be allowed to take the
    // owner's whole turn down.
    expect(out).not.toBe('');
  });

  it('renders the real summary when the read succeeds', async () => {
    vi.doMock('../src/services/selfpruning/inboundNoiseLedger', () => ({
      summariseInboundNoise: async () => summary({
        totalReached: 3, totalActed: 1,
        subjects: [subject({
          subjectKey: 'item:live', reached: 3, acted: 1,
          producers: [{ producer: 'preactive_due_nudge', reached: 3, acted: 1 }],
        })],
      }),
    }));
    const { buildPushHistoryBlock } = await import('../src/services/selfpruning/pushHistoryBlock');
    const out = await buildPushHistoryBlock(2, 'TMC-0001');
    expect(out).toContain('item:live');
    expect(out).toContain('3 pushes delivered');
    expect(out).not.toContain('UNAVAILABLE');
  });
});

describe('DEF-197 — BOTH composer paths receive the block (the DEF-165 guard)', () => {
  /** Comments stripped first: a guard that matches prose about the code is the
   *  DEF-195 failure, and this file must not repeat it. */
  function codeOf(rel: string): string {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments, keeping URLs intact
  }

  it('brainComposer builds the block at TWO call sites, one per path', () => {
    const code = codeOf('src/services/knowledge/brainComposer.ts');
    const calls = code.match(/buildPushHistoryBlock\(\s*userId\s*,\s*clientNumber\s*\)/g) ?? [];
    // Reasoning path + legacy path. One is DEF-165 rebuilt under a new name.
    expect(calls.length).toBe(2);
  });

  it('the reasoning path passes it as dataBlocks.pushHistory', () => {
    const code = codeOf('src/services/knowledge/brainComposer.ts');
    expect(code).toMatch(/pushHistory:\s*pushHistoryBlock/);
  });

  it('the legacy path passes it into assembleSystemPrompt', () => {
    const code = codeOf('src/services/knowledge/brainComposer.ts');
    expect(code).toMatch(/pushHistoryBlock:\s*legacyPushHistoryBlock/);
    // …and assembleSystemPrompt actually emits it, rather than accepting and
    // dropping it, which would be a guard-below-early-return in prompt form.
    expect(code).toMatch(/parts\.push\(pushHistoryBlock\)/);
  });

  it('the reasoning composer emits the slot it declares', () => {
    const code = codeOf('src/services/knowledge/reasoningCompose.ts');
    expect(code).toMatch(/pushHistory\?:\s*string/);
    expect(code).toMatch(/parts\.push\(input\.dataBlocks\.pushHistory\)/);
  });
});

describe('DEF-197 — read-only', () => {
  it('the module names no write operation', () => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/services/selfpruning/pushHistoryBlock.ts'), 'utf8');
    for (const verb of ['.create(', '.createMany(', '.update(', '.updateMany(',
      '.upsert(', '.delete(', '.deleteMany(', '$executeRaw']) {
      expect(raw).not.toContain(verb);
    }
  });
});

/**
 * DEF-198 — the block supplies counts for the subject HE means, and absence is
 * only evidence when the page is complete.
 *
 * Both properties are pinned against the same measured failure: benchmark case
 * `B12-reminder-referent`, which after DEF-197 still scored C1/C2/C3/C6 = 60
 * because the answer named the wrong item. DEF-197 closed the invented-cause
 * member of that case; these close the referent member and the unsound-absence
 * member.
 */
describe('DEF-198 — the conversation chooses the subject, not this block', () => {
  const twoRepeats = () => summary({
    subjects: [
      subject({ subjectKey: 'item:shireme-portal', reached: 4 }),
      subject({ subjectKey: 'item:fujairah-pricing', reached: 2 }),
    ],
  });

  it('tells Brain to resolve the referent from the conversation BEFORE reading the list', () => {
    const out = renderPushHistoryBlock(twoRepeats());
    expect(out).toMatch(/resolve it BEFORE you read the list/i);
    expect(out).toMatch(/Resolve that referent from the conversation FIRST/);
    // Mutation: deleting the referent paragraph dies here.
    expect(out).toMatch(/look THAT subject up below/);
  });

  it('FORBIDS answering about a different subject just because it is the one listed', () => {
    // This is the B12 mechanism in one sentence: two subjects are listed, he
    // asks about "that one", and the block must not let the composer pick.
    const out = renderPushHistoryBlock(twoRepeats());
    expect(out).toMatch(/NEVER answer about a different subject because it is the one listed here/);
    expect(out).toMatch(/switching subjects is worse than admitting you cannot find his/);
  });

  it('puts the referent rule BEFORE the "answer from the rows" instruction', () => {
    // Order is the mechanism, not decoration: the first version led with
    // "answer from THIS block", which is what outranked the conversation.
    const out = renderPushHistoryBlock(twoRepeats());
    const referentAt = out.indexOf('THE SUBJECT IS HIS');
    const rowsAt = out.indexOf('These are rows with timestamps');
    expect(referentAt).toBeGreaterThan(-1);
    expect(rowsAt).toBeGreaterThan(-1);
    // Mutation: swapping the two paragraphs dies here.
    expect(referentAt).toBeLessThan(rowsAt);
  });
});

describe('DEF-198 — absence is evidence only when the page is complete', () => {
  const withSubjects = (over: Partial<NoiseSummary> = {}, n = 2) => summary({
    subjects: Array.from({ length: n }, (_, i) =>
      subject({ subjectKey: `item:s${i}`, reached: 3 })),
    ...over,
  });

  it('authorises the "at most one push" read when nothing degraded the list', () => {
    const out = renderPushHistoryBlock(withSubjects());
    expect(out).toMatch(/absent below, your record shows at most one push/);
    expect(out).not.toMatch(/THIS LIST IS INCOMPLETE/);
  });

  for (const [label, over] of [
    ['rows were truncated', { truncated: true }],
    ['a subject key failed to canonicalise', { canonicalisationFailed: true }],
    ['a thread never resolved to an item', { unresolvedSubjects: ['thread:t1'] }],
  ] as Array<[string, Partial<NoiseSummary>]>) {
    it(`REFUSES that read when ${label}`, () => {
      const out = renderPushHistoryBlock(withSubjects(over));
      // Mutation: making the rules unconditional again dies on every one of
      // these three — the block would assert a count nobody read.
      expect(out).toMatch(/THIS LIST IS INCOMPLETE/);
      expect(out).toMatch(/Absence proves NOTHING here/);
      expect(out).toMatch(/You may NOT say "at most one push"/);
      expect(out).not.toMatch(/your record shows at most one push/);
    });
  }

  it('REFUSES that read when the list itself was sliced to the line cap', () => {
    // The fourth way to be short, and the one with no ⚠ flag of its own: more
    // repeat-pushed subjects exist than the renderer prints.
    const out = renderPushHistoryBlock(withSubjects({}, 40));
    expect(out).toMatch(/more repeat-pushed subject\(s\) not listed/);
    expect(out).toMatch(/THIS LIST IS INCOMPLETE/);
    expect(out).not.toMatch(/your record shows at most one push/);
  });

  it('still forbids inventing a cause in BOTH states', () => {
    for (const out of [renderPushHistoryBlock(withSubjects()),
      renderPushHistoryBlock(withSubjects({ truncated: true }))]) {
      expect(out).toMatch(/Never invent a cause for a duplicate/);
      expect(out).toMatch(/a plausible mechanism you cannot\s+read is a fabrication/);
    }
  });
});
