/**
 * DEF-212 — the receipt stays the FACT and stops being the sentence.
 * DEF-220 — and stops being English at all.
 *
 * `B04-outstanding-question-ignored` came back in `iter-06-post-build.json` as:
 *
 *     Updated "Define rules for Brain's responsiveness to new vs. existing
 *     contacts": priority=high.
 *
 * Field names and an equals sign — the exact string DEF-144 and DEF-145 were
 * written about, and it also drops whichever half of Brain's own earlier
 * question is still unanswered (DEF-209). The path is `brainComposer`'s update
 * branch: when `verifyUpdateProse` cannot positively justify the composed
 * answer it did `answer = actionResult.message`.
 *
 * That fail-closed judgement is RIGHT and is untouched here: unverifiable prose
 * still loses, because the receipt is true by construction — it lists what the
 * database actually received.
 *
 * DEF-212 moved the receipt into a marker payload. DEF-220 finishes the job it
 * left half done: the payload is now the FIELDS AND VALUES, and the sentence is
 * composed from the shared `APPLIED_FIELDS` vocabulary. The old marker quoted
 * the receipt verbatim, so with nothing outstanding the curated meaning WAS the
 * receipt and he read the field names anyway — and DEF-219 made that the common
 * branch rather than the rare one.
 *
 * The other half of the fix is the `protection-with-two-implementations` tell
 * DEF-145 documented: `channelRenderer` re-decides the same question on
 * WhatsApp, which is the surface the benchmark and the owner both use. A marker
 * the policy calls "not usable prose" is silently replaced by the raw receipt
 * one layer down, so the token below is what lets the marker win.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { actionAppliedMarker, appliedChanges } from '../src/services/knowledge/actionReceipt';
import {
  isUsableBrainProse,
  verifyAppliedMarker,
  receiptWins,
} from '../src/services/knowledge/answerReceiptPolicy';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { isSystemMarker, stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const TITLE = "Define rules for Brain's responsiveness";
/** The audit receipt the composer still builds — kept here to assert it never ships. */
const RECEIPT = `Updated "${TITLE}": priority=high.`;
const APPLIED = [{ f: 'priority', v: 'high' }];

const meaningOf = (marker: string) => curatedMarkerMeaning(stripMarkerEnvelope(marker));

const marker = (over: Partial<Parameters<typeof actionAppliedMarker>[0]> = {}) =>
  actionAppliedMarker({ title: TITLE, applied: APPLIED, ...over });

describe('DEF-220 — the fact is composed from fields, never from a rendered string', () => {
  it('states the item and what it now is, in words', () => {
    expect(meaningOf(marker())).toBe(
      `The open item "${TITLE}" was updated: its priority is now high.`);
  });

  it('THE REGRESSION, pinned: no field name, no equals sign, and not the receipt', () => {
    const fact = meaningOf(marker())!;
    expect(fact).not.toContain('priority=');
    expect(fact).not.toContain(RECEIPT);
    // The whole B04 shape in one assertion: `word=value` anywhere in the fact.
    expect(fact).not.toMatch(/\b[a-zA-Z]+=[^ ]/);
  });

  it('joins several applied fields as prose', () => {
    const fact = meaningOf(marker({
      applied: [{ f: 'priority', v: 'high' }, { f: 'dueDate', v: '2026-08-20' }],
    }))!;
    expect(fact).toContain('its priority is now high, and it is now due on 20 Aug 2026');
  });

  it('says a date the way a person does, without ever constructing an instant', () => {
    // DEF-214's lesson: a calendar date put through `new Date` can move by a day
    // when a zone is applied. `2026-01-01` is the case that would show it.
    expect(meaningOf(marker({ applied: [{ f: 'dueDate', v: '2026-01-01' }] }))!)
      .toContain('it is now due on 1 Jan 2026');
    // Anything that is not a calendar date is passed through rather than guessed.
    expect(meaningOf(marker({ applied: [{ f: 'dueDate', v: 'sometime' }] }))!)
      .toContain('it is now due on sometime');
  });

  it('says the draft transition in his words, not the schema\'s', () => {
    const fact = meaningOf(marker({ applied: [{ f: 'status', v: 'NEW' }] }))!;
    expect(fact).toContain('it is now a live item rather than a draft');
    expect(fact, 'NEW is a schema word').not.toContain('NEW');
  });

  it('mentions a note without quoting it — a fact that prints a paragraph IS the reply', () => {
    const fact = meaningOf(marker({
      applied: [{ f: 'description', v: 'a very long note '.repeat(10).trim() }],
    }))!;
    expect(fact).toContain('its note has been updated');
    expect(fact).not.toContain('a very long note a very long note');
  });
});

describe('DEF-220 — the change list comes from the database payload', () => {
  it('reads the Prisma payload, converting a Date to its calendar date', () => {
    expect(appliedChanges({ priority: 'high', dueDate: new Date('2026-08-20T00:00:00Z') }))
      .toEqual([{ f: 'priority', v: 'high' }, { f: 'dueDate', v: '2026-08-20' }]);
  });

  it('an empty or absent value is NOT an applied change', () => {
    expect(appliedChanges({ priority: '', dueDate: null, title: '   ' })).toEqual([]);
    expect(appliedChanges(null)).toEqual([]);
  });

  it('ignores payload fields with no owner-facing meaning', () => {
    // `metadata` is the cleared draft block — internal, and saying "its metadata
    // is now {}" would be a machine describing its inside (DEF-213).
    expect(appliedChanges({ metadata: { draft: null }, priority: 'low' }))
      .toEqual([{ f: 'priority', v: 'low' }]);
  });
});

describe('DEF-212 — the outstanding half, unchanged', () => {
  it('names what is still unanswered after it', () => {
    const fact = meaningOf(marker({ outstanding: ['dueDate'] }))!;
    expect(fact).toContain('its priority is now high');
    expect(fact).toContain('the due date');
    expect(fact).toContain('still unanswered');
  });

  it('lists two outstanding slots as prose', () => {
    const fact = meaningOf(marker({ outstanding: ['priority', 'dueDate'] }))!;
    expect(fact).toContain('the priority and the due date');
    expect(fact).toContain('are still unanswered');
  });

  it('the BUILDER drops a slot key outside the shared vocabulary', () => {
    expect(meaningOf(marker({ outstanding: ['notASlot' as string] })))
      .not.toContain('still unanswered');
  });

  it('the PARSER rejects one too — the builder filtering it is not the same guarantee', () => {
    // Caught by mutation on DEF-212: every marker in these tests goes through
    // the builder, which filters unknown keys, so the parser's own check was
    // never exercised. A hand-built payload is the only way to reach it.
    const payload = '{"title":"x","applied":[{"f":"priority","v":"high"}],"outstanding":["notASlot"]}';
    // The payload must PARSE, or this test would pass for the wrong reason —
    // which is what happened on the first attempt at DEF-212 (an escaped quote
    // made it invalid JSON, so the parser returned null before the check).
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(curatedMarkerMeaning(`[applied: ${payload}]`)).toBeNull();
  });
});

describe('DEF-220 — the parser rejects what the constructor could not make', () => {
  it('rejects a malformed or impossible payload', () => {
    expect(curatedMarkerMeaning('[applied: not json]')).toBeNull();
    expect(curatedMarkerMeaning('[applied: {"applied":[{"f":"priority","v":"h"}],"outstanding":[]}]'),
      'no title').toBeNull();
    expect(curatedMarkerMeaning('[applied: {"title":"x","applied":[],"outstanding":[]}]'),
      'an update that changed nothing is not a receipt').toBeNull();
    expect(curatedMarkerMeaning('[applied: {"title":"x","applied":[{"f":"secretHash","v":"h"}],"outstanding":[]}]'),
      'a field outside the vocabulary').toBeNull();
    expect(curatedMarkerMeaning('[applied: {"title":"x","applied":[{"f":"priority","v":""}],"outstanding":[]}]'),
      'an empty value').toBeNull();
    expect(curatedMarkerMeaning('[applied: {"title":"x","applied":[{"f":"priority"}],"outstanding":[]}]'),
      'a missing value').toBeNull();
    expect(curatedMarkerMeaning('[applied: {"title":"x","applied":[{"f":"priority","v":"h"}]}]'),
      'no outstanding array').toBeNull();
  });

  it('carries provenance and a JSON body, so a title containing brackets cannot break out', () => {
    const m = marker({ title: 'a] b' });
    expect(isSystemMarker(m)).toBe(true);
    expect(meaningOf(m)).toContain('"a] b"');
  });
});

describe('DEF-212 — the marker is not silently replaced one layer down', () => {
  it('a stamped marker is usable prose BECAUSE the sentinel precedes the bracket', () => {
    expect(marker().startsWith('['), 'the sentinel comes first — this is why it passes').toBe(false);
    expect(isUsableBrainProse(marker())).toBe(true);
    expect(isUsableBrainProse('[see attached]'), 'DEF-169: shape is not provenance').toBe(false);
    expect(isUsableBrainProse('ok'), 'still too short to beat a receipt').toBe(false);
  });

  it('the token lets the marker win over the raw receipt at the channel renderer', () => {
    const m = marker({ outstanding: ['dueDate'] });
    const token = verifyAppliedMarker(m, {
      receipt: RECEIPT, artifactId: 'i1', title: TITLE, applied: APPLIED,
    });
    expect(token).not.toBeNull();
    expect(receiptWins(
      { ok: true, message: RECEIPT, artifactId: 'i1', verifiedProse: token }, m,
    )).toBe(false);
  });

  it('without the token the receipt still wins — fail-closed is unchanged', () => {
    expect(receiptWins({ ok: true, message: RECEIPT, artifactId: 'i1' }, marker())).toBe(true);
  });

  it('the token cannot be replayed onto a different marker, receipt or artifact', () => {
    const m = marker();
    const token = verifyAppliedMarker(m, {
      receipt: RECEIPT, artifactId: 'i1', title: TITLE, applied: APPLIED,
    });
    const other = marker({ title: 'Other' });
    expect(receiptWins({ ok: true, message: RECEIPT, artifactId: 'i1', verifiedProse: token }, other))
      .toBe(true);
    expect(receiptWins(
      { ok: true, message: 'Updated "Other": priority=low.', artifactId: 'i1', verifiedProse: token },
      m)).toBe(true);
    expect(receiptWins({ ok: true, message: RECEIPT, artifactId: 'i2', verifiedProse: token }, m))
      .toBe(true);
  });

  it('DEF-220 — refuses to mint for a marker carrying different VALUES, not just a different title', () => {
    // The old binding was a substring test on the rendered receipt. Two updates
    // to the same item whose receipts happened to render alike were
    // indistinguishable; the fingerprint is over the values themselves.
    const m = marker();
    expect(verifyAppliedMarker(m, {
      receipt: RECEIPT, title: TITLE, applied: [{ f: 'priority', v: 'low' }],
    }), 'same item, different value').toBeNull();
    expect(verifyAppliedMarker(m, {
      receipt: RECEIPT, title: 'Other item', applied: APPLIED,
    }), 'different item').toBeNull();
    expect(verifyAppliedMarker(m, { receipt: RECEIPT, title: TITLE, applied: [] }),
      'nothing applied cannot be verified').toBeNull();
    expect(verifyAppliedMarker('not a marker', { receipt: RECEIPT, title: TITLE, applied: APPLIED }))
      .toBeNull();
    expect(verifyAppliedMarker(m, { receipt: '   ', title: TITLE, applied: APPLIED })).toBeNull();
  });
});

describe('DEF-220 — the composer stopped handing over the bare receipt', () => {
  const code = (() => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/services/knowledge/brainComposer.ts'), 'utf8');
    // Comments stripped: a guard must read code, not prose about it (DEF-195).
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  })();

  it('builds the marker from the applied CHANGES, not from the receipt string', () => {
    expect(code).toMatch(/const applied = appliedChanges\(data as unknown as Record<string, unknown>\)/);
    expect(code).toMatch(/actionAppliedMarker\(\{\s*title: existing\.title,\s*applied,/);
    expect(code, 'the receipt is no longer the payload').not.toMatch(/actionAppliedMarker\(\{\s*receipt:/);
    expect(code).toMatch(/answer = appliedMarker;/);
  });

  it('computes outstanding from what the DATABASE received, never from what was asked', () => {
    // `data` is the Prisma payload actually written. Using `act` — the model's
    // request — would report a slot as filled that was silently dropped.
    expect(code).toMatch(/outstanding: outstandingSlots\(\s*lastBrainQuestion\(history\),\s*data as unknown/);
    expect(code).not.toMatch(/outstanding: outstandingSlots\([^)]*\bact\b/);
  });

  it('mints the token from the item and the values that were actually written', () => {
    expect(code).toMatch(
      /verifyAppliedMarker\(appliedMarker, \{\s*receipt: actionResult\.message as string,\s*artifactId: existing\.id,\s*title: existing\.title,\s*applied,/);
  });

  it('falls back to the receipt when NO owner-facing field was written', () => {
    // An uncurated marker has no curated meaning and would reach him as the
    // neutral fallback — which says less than the true-by-construction receipt.
    expect(code).toMatch(/if \(applied\.length === 0\) \{\s*answer = actionResult\.message as string;/);
  });
});
