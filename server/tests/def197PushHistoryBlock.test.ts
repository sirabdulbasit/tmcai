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
  selectSubjectsForConversation,
  questionIsAboutPushes,
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
    const calls = code.match(/buildPushHistoryBlock\(\s*userId\s*,\s*clientNumber\s*,/g) ?? [];
    // Reasoning path + legacy path. One is DEF-165 rebuilt under a new name.
    expect(calls.length).toBe(2);
    // DEF-200 — and BOTH must pass the conversation, or the resolver is off on
    // that path and the block reverts to offering candidates. A path wired
    // without it is the DEF-165 shape again, one argument deeper.
    const scoped = code.match(/buildPushHistoryBlock\(\s*userId\s*,\s*clientNumber\s*,\s*conversationTextForPushHistory\(question,\s*history\),\s*question\s*,?\s*\)/g) ?? [];
    // DEF-203 — and BOTH must pass the QUESTION, or the relevance gate is off on
    // that path and the block returns to every turn, which is the B03 regression.
    expect(scoped.length).toBe(2);
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

/**
 * DEF-199 — the subject key is JOINED to a title, or it is explicitly unnameable.
 *
 * Why DEF-198 could not work: the block printed `item:cmqauv4xx` — a real count,
 * a real timestamp, and a name the model cannot pronounce. Asked for a human
 * sentence it took a TITLE from another block and attached these counts to it,
 * which is how B12 answered about "ShireMe Recruiting Portal Application
 * Testing" and then, next run, "Vision Metric's service sales package video".
 * Rules about choosing the right subject cannot fix a join that is absent.
 */
describe('DEF-199 — a subject is named from the record, or not named at all', () => {
  const oneSubject = () => summary({
    totalReached: 2,
    subjects: [subject({ subjectKey: 'item:abc123', reached: 2 })],
  });

  it('prints the owner\'s own title next to the key when the join resolves', () => {
    const out = renderPushHistoryBlock(oneSubject(),
      new Map([['item:abc123', 'Send the revised Fujairah pricing to Latif']]));
    expect(out).toContain('"Send the revised Fujairah pricing to Latif" (item:abc123)');
    // The key stays, so the row remains traceable to the record.
    expect(out).toContain('2 pushes delivered');
    // The marker must not appear on the SUBJECT LINE (it legitimately appears
    // in the standing rules, which explain what an unresolved subject means).
    const line = out.split('\n').find((l) => l.startsWith('- ')) ?? '';
    expect(line).not.toContain('TITLE UNRESOLVED');
  });

  it('marks a subject the join could NOT resolve as unnameable, rather than leaving a bare key', () => {
    // The bare key was the third state that produced the defect: nameless but
    // answerable-looking. Mutation: dropping the marker restores it.
    const out = renderPushHistoryBlock(oneSubject(), new Map());
    expect(out).toContain('item:abc123 [TITLE UNRESOLVED — never name this item]');
    expect(out).toContain('2 pushes delivered');   // the count is still true
  });

  it('forbids borrowing a title from another block — the exact observed fusion', () => {
    const out = renderPushHistoryBlock(oneSubject(), new Map([['item:abc123', 'A real item']]));
    expect(out).toMatch(/NAME AN ITEM ONLY FROM A TITLE PRINTED IN THIS LIST/);
    expect(out).toMatch(/do NOT take a title from another block/);
    expect(out).toMatch(/a true count becomes a false statement/);
    expect(out).toMatch(/TITLE UNRESOLVED has no name you may use/);
  });
});

describe('DEF-199 — the title join is tenant AND user scoped, and read-only', () => {
  const findMany = vi.fn(async () => [{ id: 'abc123', title: 'Real title' }]);
  beforeEach(() => { vi.resetModules(); findMany.mockClear(); });

  async function load() {
    vi.doMock('../src/db/prisma', () => ({
      default: { openItem: { findMany: (...a: any[]) => findMany(...(a as [])) } },
    }));
    return import('../src/services/selfpruning/pushHistoryBlock');
  }

  it('constrains the read by id AND clientNumber AND userId', async () => {
    const { resolveSubjectTitles } = await load();
    await resolveSubjectTitles(['item:abc123'], 'TMC-0001', 2);
    const where = (findMany.mock.calls[0][0] as any).where;
    // A title is owner data and openItem is a user-owned model. Mutation:
    // dropping either scope key dies here.
    expect(where.clientNumber).toBe('TMC-0001');
    expect(where.userId).toBe(2);
    expect(where.id).toEqual({ in: ['abc123'] });
  });

  it('ignores non-item subject keys and never queries for them', async () => {
    const { resolveSubjectTitles } = await load();
    const out = await resolveSubjectTitles(['thread:t1', 'event:e1'], 'TMC-0001', 2);
    expect(out.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();   // no pointless query
  });

  it('de-duplicates ids so one subject repeated is one lookup', async () => {
    const { resolveSubjectTitles } = await load();
    await resolveSubjectTitles(['item:a', 'item:a', 'item:b'], 'TMC-0001', 2);
    expect((findMany.mock.calls[0][0] as any).where.id).toEqual({ in: ['a', 'b'] });
  });

  it('drops a row with an empty title rather than mapping the key to nothing', async () => {
    findMany.mockImplementationOnce(async () => [{ id: 'abc123', title: '' }] as any);
    const { resolveSubjectTitles } = await load();
    const out = await resolveSubjectTitles(['item:abc123'], 'TMC-0001', 2);
    // An empty title must render as UNRESOLVED, not as `""`.
    expect(out.has('item:abc123')).toBe(false);
  });

  it('a FAILED title read degrades to unnameable subjects, never to a guess or a lost count', async () => {
    findMany.mockImplementationOnce(async () => { throw new Error('db down'); });
    vi.doMock('../src/services/selfpruning/inboundNoiseLedger', () => ({
      summariseInboundNoise: async () => ({
        clientNumber: 'TMC-0001', userId: 2, windowHours: 36,
        since: new Date('2026-08-16T00:00:00Z'), until: new Date('2026-08-17T12:00:00Z'),
        totalReached: 2, totalActed: 0, totalIgnored: 2,
        truncated: false, canonicalisationFailed: false, unresolvedSubjects: [],
        burstMaxSpanMinutes: 1440, bursts: [], unattributed: [], floods: [],
        subjects: [{
          subjectKey: 'item:abc123', producers: [], reached: 2, acted: 0, ignored: 2,
          ignoredShare: 1, firstAt: new Date('2026-08-17T09:00:00Z'),
          lastAt: new Date('2026-08-17T10:48:00Z'), spanMinutes: 108, burst: false, samples: [],
        }],
      }),
    }));
    const { buildPushHistoryBlock } = await load();
    const out = await buildPushHistoryBlock(2, 'TMC-0001');
    expect(out).toContain('TITLE UNRESOLVED');
    expect(out).toContain('2 pushes delivered');      // the count survives
    expect(out).not.toContain('UNAVAILABLE');         // not the whole-block failure
  });
});

/**
 * DEF-200 — Codex's iteration-2 findings on DEF-198, both of which were correct.
 *
 * 1. *"The code does not resolve or pass a subject identity. It merely adds
 *    instructions telling the model to resolve one."* — the mechanism was still
 *    `examples-outvote-the-instruction`.
 * 2. *"`NoiseSummary` also contains `unattributed` and `floods` … A repeated
 *    unattributed push can therefore exist while the block authorizes 'your
 *    record shows at most one push.'"*
 *
 * The collision below is the one the directive named: the conversation is about
 * the Fujairah pricing task, the push record contains ShireMe.
 */
describe('DEF-200 — the resolver runs in code, and the collision is the test', () => {
  const FUJAIRAH = 'Send the revised Fujairah pricing to Latif';
  const SHIREME = 'ShireMe Recruiting Portal Application Testing';
  const collision = () => summary({
    totalReached: 2,
    subjects: [subject({ subjectKey: 'item:shireme', reached: 2 })],
  });
  const titles = new Map([['item:shireme', SHIREME]]);

  it('THE MEASURED CASE — conversation names Fujairah, record holds ShireMe: the record is withheld', () => {
    const conversation = `Remind me to ${FUJAIRAH}\nWhy did you remind me about that one twice?`;
    const out = renderPushHistoryBlock(collision(), titles, conversation);

    // The candidate is GONE from the prompt. It cannot outvote the dialogue if
    // it is not there — this is the structural half DEF-198 lacked.
    expect(out).not.toContain(SHIREME);
    expect(out).not.toContain('item:shireme');
    expect(out).toContain('YOUR PUSH RECORD HAS NO ENTRY FOR THE ITEM UNDER DISCUSSION');
    expect(out).toMatch(/no\s+repeat-push\s+record for it/);
  });

  it('renders ONLY the matched subject when the conversation does name it', () => {
    const conversation = `About "${SHIREME}" — why did you remind me twice?`;
    const out = renderPushHistoryBlock(collision(), titles, conversation);
    expect(out).toContain(SHIREME);
    expect(out).toContain('2 pushes delivered');
    expect(out).toContain('The subject(s) from THIS conversation');
    expect(out).not.toContain('YOUR PUSH RECORD HAS NO ENTRY FOR');
  });

  it('withholds a NON-matching subject even while another one matches', () => {
    const s = summary({
      totalReached: 4,
      subjects: [
        subject({ subjectKey: 'item:shireme', reached: 2 }),
        subject({ subjectKey: 'item:other', reached: 2 }),
      ],
    });
    const t = new Map([['item:shireme', SHIREME], ['item:other', 'Quarterly board pack for Dubai']]);
    const out = renderPushHistoryBlock(s, t, `About "${SHIREME}" — why twice?`);
    expect(out).toContain(SHIREME);
    // Mutation: rendering allRepeats instead of the matched set dies here.
    expect(out).not.toContain('Quarterly board pack for Dubai');
  });

  it('an UNNAMEABLE subject can never be "the one he means"', () => {
    // No title -> no way to match it to his words -> it must not be offered.
    const out = renderPushHistoryBlock(collision(), new Map(), 'why did you remind me twice?');
    expect(out).toContain('YOUR PUSH RECORD HAS NO ENTRY FOR');
    expect(out).not.toContain('item:shireme');
  });

  it('refuses a short, non-distinctive title rather than matching it loosely', () => {
    // A false match re-creates the very defect this closes, so the bar is
    // distinctiveness. Mutation: dropping MIN_DISTINCTIVE_TITLE dies here.
    const s = summary({ subjects: [subject({ subjectKey: 'item:c', reached: 2 })] });
    const out = renderPushHistoryBlock(s, new Map([['item:c', 'Call']]), 'call him about the call');
    expect(out).toContain('YOUR PUSH RECORD HAS NO ENTRY FOR');
  });

  it('matches across punctuation and case, because his words are not the stored string', () => {
    expect(selectSubjectsForConversation(
      [subject({ subjectKey: 'item:x', reached: 2 })],
      new Map([['item:x', 'Fujairah  pricing—REVISED']]),
      'about the fujairah pricing revised item, why twice?',
    )).toHaveLength(1);
  });

  it('leaves the unscoped record intact when no conversation is supplied', () => {
    // Scripts and digests have no dialogue; they must still get the record.
    const out = renderPushHistoryBlock(collision(), titles);
    expect(out).toContain(SHIREME);
    expect(out).not.toContain('YOUR PUSH RECORD HAS NO ENTRY FOR');
  });
});

describe('DEF-200 — absence is not evidence when identity-less pushes exist', () => {
  const withRepeat = (over: Partial<NoiseSummary> = {}) => summary({
    subjects: [subject({ subjectKey: 'item:a', reached: 3 })], ...over,
  });

  it('REFUSES the "at most one push" read when unattributed pushes exist', () => {
    // Codex's finding 2, verbatim: a repeated push with no identity lands in
    // `unattributed`, never reaches `s.subjects`, and so is absent from the list
    // while the block used to authorise a count nobody read.
    const out = renderPushHistoryBlock(withRepeat({
      unattributed: [{ senderKey: 'unknown:+92300', subjectClass: 'nudge' }] as any,
    }));
    expect(out).toMatch(/THIS LIST IS INCOMPLETE/);
    expect(out).not.toMatch(/your record shows at most one push/);
  });

  it('REFUSES it when floods exist', () => {
    const out = renderPushHistoryBlock(withRepeat({ floods: [{ senderKey: 'x' }] as any }));
    expect(out).toMatch(/THIS LIST IS INCOMPLETE/);
    expect(out).not.toMatch(/your record shows at most one push/);
  });

  it('still authorises it when the record is genuinely complete', () => {
    const out = renderPushHistoryBlock(withRepeat());
    expect(out).toMatch(/absent below, your record shows at most one push/);
  });
});

/**
 * DEF-201 — remediation attempt 2 of Codex's iteration-2 review.
 *
 * Three items were still open against HEAD after DEF-200, because my previous
 * read of that review was truncated before its numbered risks:
 *   MEDIUM 3   — the degraded-page rule said "see the ⚠ flags above" in the one
 *                case that renders no ⚠ (a line-cap slice).
 *   directive 4 — "at most one push" was authorised without binding the claim to
 *                the 36-hour window it actually came from.
 *   directive 2 — the fixture below is Codex's, verbatim: "conversation says
 *                Fujairah, push history also contains ShireMe and Vision Metric
 *                repeats", now driven through the REAL builder and title join
 *                rather than a hand-built map.
 */
describe('DEF-201 — Codex\'s exact fixture, through the real builder', () => {
  const FUJAIRAH = 'Send the revised Fujairah pricing to Latif';
  const SHIREME = 'ShireMe Recruiting Portal Application Testing';
  const VISION = "Vision Metric's service sales package video";

  const findMany = vi.fn(async () => [
    { id: 'shireme', title: SHIREME },
    { id: 'vision', title: VISION },
  ]);
  beforeEach(() => { vi.resetModules(); findMany.mockClear(); });

  async function build(conversation: string) {
    vi.doMock('../src/db/prisma', () => ({
      default: { openItem: { findMany: (...a: any[]) => findMany(...(a as [])) } },
    }));
    vi.doMock('../src/services/selfpruning/inboundNoiseLedger', () => ({
      summariseInboundNoise: async () => ({
        clientNumber: 'TMC-0001', userId: 2, windowHours: 36,
        since: new Date('2026-08-16T00:00:00Z'), until: new Date('2026-08-17T12:00:00Z'),
        totalReached: 4, totalActed: 0, totalIgnored: 4,
        truncated: false, canonicalisationFailed: false, unresolvedSubjects: [],
        burstMaxSpanMinutes: 1440, bursts: [], unattributed: [], floods: [],
        subjects: [
          { subjectKey: 'item:shireme', producers: [{ producer: 'preactive_due_nudge', reached: 2, acted: 0 }],
            reached: 2, acted: 0, ignored: 2, ignoredShare: 1,
            firstAt: new Date('2026-08-17T06:01:00Z'), lastAt: new Date('2026-08-17T10:11:00Z'),
            spanMinutes: 250, burst: false, samples: [] },
          { subjectKey: 'item:vision', producers: [{ producer: 'preactive_due_nudge', reached: 2, acted: 0 }],
            reached: 2, acted: 0, ignored: 2, ignoredShare: 1,
            firstAt: new Date('2026-08-17T06:01:00Z'), lastAt: new Date('2026-08-17T10:11:00Z'),
            spanMinutes: 250, burst: false, samples: [] },
        ],
      }),
    }));
    const { buildPushHistoryBlock } = await import('../src/services/selfpruning/pushHistoryBlock');
    return buildPushHistoryBlock(2, 'TMC-0001', conversation);
  }

  it('THE ACCEPTANCE CASE — neither unrelated title nor its counts reach the prompt', async () => {
    const out = await build(
      `Remind me to ${FUJAIRAH}\nWhy did you remind me about that one twice?`,
    );
    // Codex's assertion, verbatim: neither unrelated title/count appears.
    expect(out).not.toContain(SHIREME);
    expect(out).not.toContain(VISION);
    expect(out).not.toContain('item:shireme');
    expect(out).not.toContain('item:vision');
    expect(out).not.toContain('2 pushes delivered');   // no count to misattach
    expect(out).not.toContain('06:01');
    expect(out).toContain('YOUR PUSH RECORD HAS NO ENTRY FOR THE ITEM UNDER DISCUSSION');
  });

  it('still answers correctly when the conversation DOES name a held subject', async () => {
    const out = await build(`About "${VISION}" — why did you remind me twice?`);
    expect(out).toContain(VISION);
    expect(out).toContain('2 pushes delivered');
    expect(out).not.toContain(SHIREME);          // the other one stays withheld
  });
});

describe('DEF-201 — the incompleteness reason names itself, and the claim is window-bound', () => {
  it('does NOT point at ⚠ flags when the only degradation is the line cap', () => {
    // Codex MEDIUM 3: a slice renders no ⚠, so "see the ⚠ flags above" sent the
    // model to a warning that is not there — weakest exactly when the list was cut.
    const many = summary({
      subjects: Array.from({ length: 20 }, (_, i) => subject({ subjectKey: `item:s${i}`, reached: 3 })),
    });
    const out = renderPushHistoryBlock(many);
    expect(out).toMatch(/THIS LIST IS INCOMPLETE, for a reason that is stated rather than implied/);
    expect(out).toMatch(/the list was cut to 12 lines and 8 repeat-pushed subject\(s\) are not shown/);
    // Mutation: restoring the blanket "see the ⚠ flags above" dies here.
    expect(out).not.toMatch(/INCOMPLETE — see the ⚠ flags above/);
  });

  it('names the identity-less collections explicitly when they are the reason', () => {
    const out = renderPushHistoryBlock(summary({
      subjects: [subject({ subjectKey: 'item:a', reached: 3 })],
      unattributed: [{ senderKey: 'unknown:+92300', subjectClass: 'nudge' }] as any,
    }));
    expect(out).toMatch(/1 push group\(s\) carry no item\/thread identity at all/);
  });

  it('BINDS the "at most one" claim to the window it came from', () => {
    // Codex directive 4: the rows support a claim about the last N hours. An
    // unqualified "I only sent it once" is a lifetime claim the record cannot make.
    const out = renderPushHistoryBlock(summary({
      windowHours: 36, subjects: [subject({ subjectKey: 'item:a', reached: 3 })],
    }));
    expect(out).toMatch(/BOUND THAT CLAIM TO THE WINDOW/);
    expect(out).toMatch(/covers the last 36h only/);
    expect(out).toMatch(/IN THE LAST 36 HOURS/);
    // Mutation: dropping the window qualification dies here.
    expect(out).toMatch(/never an unqualified "I only sent it once"/);
  });
});

/**
 * DEF-203 — the regression guard fired on `B03-pronoun-followup`, and it was my
 * change that caused it.
 *
 * Asked *"And what about the second one?"* about a Q3 headcount plan Brain had
 * itself named one turn earlier, Brain answered *"I'm not finding anything under
 * \"Q3 headcount plan\". Could you give me a different name for it?"*
 * Mean 98.1 -> 68.8; C3 90 -> 30; C6 100 -> 50; C7 100 -> 60.
 *
 * DEF-200's no-match branch was correct for B12 and catastrophic here: a block
 * answering ONE question was injected on EVERY turn, and its push-record miss
 * was read as the ITEM not existing. That is `guard-destroys-the-answer`, 8 in
 * chart §3, and I built the ninth.
 */
describe('DEF-203 — a block that answers one question must not be present for all of them', () => {
  it('is NOT built at all when the question is not about pushes — the B03 shape', async () => {
    // The whole fix in one assertion: an absent block cannot deny anything.
    vi.resetModules();
    const findMany = vi.fn(async () => { throw new Error('must not be reached'); });
    vi.doMock('../src/db/prisma', () => ({ default: { openItem: { findMany } } }));
    vi.doMock('../src/services/selfpruning/inboundNoiseLedger', () => ({
      summariseInboundNoise: async () => { throw new Error('must not be reached'); },
    }));
    const { buildPushHistoryBlock } = await import('../src/services/selfpruning/pushHistoryBlock');
    const out = await buildPushHistoryBlock(
      2, 'TMC-0001', 'Q3 headcount plan is at risk\nAnd what about the second one?',
      'And what about the second one?',
    );
    expect(out).toBe('');
    // Mutation: removing the gate makes the summariser run and this throws.
    expect(findMany).not.toHaveBeenCalled();
  });

  it('gates on the QUESTION, not the conversation — history mentions reminders constantly', async () => {
    // Caught by mutation testing: gating on the conversation text passed every
    // other test here, because the B03 fixture has no push words on either side.
    // It is still wrong — a history that merely MENTIONS a reminder would
    // re-inject the block on an unrelated question, which is the B03 failure
    // returning by another door.
    vi.resetModules();
    vi.doMock('../src/db/prisma', () => ({ default: { openItem: { findMany: async () => [] } } }));
    vi.doMock('../src/services/selfpruning/inboundNoiseLedger', () => ({
      summariseInboundNoise: async () => { throw new Error('must not be reached'); },
    }));
    const { buildPushHistoryBlock } = await import('../src/services/selfpruning/pushHistoryBlock');
    const out = await buildPushHistoryBlock(
      2, 'TMC-0001',
      'I reminded you about the pricing yesterday and pushed it twice\nAnd what about the second one?',
      'And what about the second one?',   // the QUESTION is not about pushes
    );
    expect(out).toBe('');
  });

  it('IS built when he genuinely asks about repeat pushes', () => {
    for (const q of [
      'Why did you remind me about that one twice?',
      'why was I notified again?',
      'how many times did you push me on this?',
      'did you nudge him twice?',
      'that looks like a duplicate reminder',
    ]) expect(questionIsAboutPushes(q)).toBe(true);
  });

  it('is NOT built for ordinary follow-ups that merely reference an item', () => {
    for (const q of [
      'And what about the second one?',
      'what is the status of the Q3 headcount plan?',
      'summarise my day',
      'who is Asad?',
    ]) expect(questionIsAboutPushes(q)).toBe(false);
  });

  it('the no-match text FORBIDS denying the item — the exact sentence B03 produced', () => {
    const out = renderPushHistoryBlock(
      summary({ subjects: [subject({ subjectKey: 'item:x', reached: 2 })] }),
      new Map([['item:x', 'Some other thing entirely']]),
      'And what about the Q3 headcount plan?',
    );
    expect(out).toContain('THIS IS A STATEMENT ABOUT PUSH COUNTS ONLY');
    expect(out).toMatch(/NOT evidence that the item does\s+not exist/);
    // Mutation: dropping the scoping paragraph dies on these three.
    expect(out).toMatch(/NEVER answer "I cannot find that item"/);
    expect(out).toMatch(/ask him to rename it/);
    expect(out).toMatch(/answer from the blocks that hold\s+items and ignore this one entirely/);
  });

  it('still withholds the unrelated subject while doing so', () => {
    const out = renderPushHistoryBlock(
      summary({ subjects: [subject({ subjectKey: 'item:x', reached: 2 })] }),
      new Map([['item:x', 'Some other thing entirely']]),
      'And what about the Q3 headcount plan?',
    );
    expect(out).not.toContain('Some other thing entirely');
  });
});
