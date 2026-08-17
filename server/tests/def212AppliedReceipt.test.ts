/**
 * DEF-212 — the receipt stays the FACT and stops being the sentence.
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
 * database actually received. What changes is that the receipt travels as the
 * PAYLOAD of a marker whose curated meaning states it verbatim and then names
 * what is still outstanding, so `sanitizeAnswerInBrainVoice` can say it in
 * Brain's words.
 *
 * The second half of the fix is the one that would otherwise have made this a
 * no-op, and it is the `protection-with-two-implementations` tell DEF-145
 * documented: `channelRenderer` re-decides the same question on WhatsApp, which
 * is the surface the benchmark and the owner both use. A marker that the policy
 * calls "not usable prose" is silently replaced by the raw receipt one layer
 * down.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { actionAppliedMarker } from '../src/services/knowledge/actionReceipt';
import {
  isUsableBrainProse,
  verifyAppliedMarker,
  receiptWins,
} from '../src/services/knowledge/answerReceiptPolicy';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { isSystemMarker, stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const RECEIPT = 'Updated "Define rules for Brain\'s responsiveness": priority=high.';

const meaningOf = (marker: string) => curatedMarkerMeaning(stripMarkerEnvelope(marker));

describe('DEF-212 — the receipt survives verbatim', () => {
  it('is quoted exactly, not reworded — this parser must not restate a fact it did not establish', () => {
    const fact = meaningOf(actionAppliedMarker({ receipt: RECEIPT }));
    expect(fact).toBe(RECEIPT);
  });

  it('names what is still unanswered after it', () => {
    const fact = meaningOf(actionAppliedMarker({ receipt: RECEIPT, outstanding: ['dueDate'] }))!;
    expect(fact).toContain(RECEIPT);
    expect(fact).toContain('the due date');
    expect(fact).toContain('still unanswered');
  });

  it('lists two outstanding slots as prose', () => {
    const fact = meaningOf(actionAppliedMarker({
      receipt: RECEIPT, outstanding: ['priority', 'dueDate'],
    }))!;
    expect(fact).toContain('the priority and the due date');
    expect(fact).toContain('are still unanswered');
  });

  it('the BUILDER drops a slot key outside the shared vocabulary', () => {
    const marker = actionAppliedMarker({ receipt: RECEIPT, outstanding: ['notASlot' as string] });
    expect(meaningOf(marker)).toBe(RECEIPT);
  });

  it('the PARSER rejects one too — the builder filtering it is not the same guarantee', () => {
    // Caught by mutation: every marker in these tests goes through the builder,
    // which filters unknown keys, so the parser's own check was never exercised.
    // A hand-built payload is the only way to reach it.
    const payload = '{"receipt":"Updated the item: priority=high.","outstanding":["notASlot"]}';
    // The payload must PARSE, or this test would pass for the wrong reason —
    // which is exactly what happened on the first attempt (an escaped quote made
    // it invalid JSON, so the parser returned null before reaching the check).
    expect(() => JSON.parse(payload)).not.toThrow();
    expect(curatedMarkerMeaning(`[applied: ${payload}]`)).toBeNull();
  });

  it('carries provenance and a JSON body, so a receipt containing brackets cannot break out', () => {
    const marker = actionAppliedMarker({ receipt: 'Updated "a] b": priority=high.' });
    expect(isSystemMarker(marker)).toBe(true);
    expect(meaningOf(marker)).toBe('Updated "a] b": priority=high.');
  });

  it('rejects a payload the constructor could not have produced', () => {
    expect(curatedMarkerMeaning('[applied: not json]')).toBeNull();
    expect(curatedMarkerMeaning('[applied: {"outstanding":[]}]'), 'no receipt').toBeNull();
    expect(curatedMarkerMeaning('[applied: {"receipt":"x"}]'), 'no outstanding array').toBeNull();
    expect(curatedMarkerMeaning('[applied: {"receipt":"x","outstanding":[1]}]')).toBeNull();
  });
});

describe('DEF-212 — the marker is not silently replaced one layer down', () => {
  it('a stamped marker is usable prose BECAUSE the sentinel precedes the bracket', () => {
    const marker = actionAppliedMarker({ receipt: RECEIPT });
    expect(marker.startsWith('['), 'the sentinel comes first — this is why it passes').toBe(false);
    expect(isUsableBrainProse(marker)).toBe(true);
    expect(isUsableBrainProse('[see attached]'), 'DEF-169: shape is not provenance').toBe(false);
    expect(isUsableBrainProse('ok'), 'still too short to beat a receipt').toBe(false);
  });

  it('the token lets the marker win over the raw receipt at the channel renderer', () => {
    const marker = actionAppliedMarker({ receipt: RECEIPT, outstanding: ['dueDate'] });
    const token = verifyAppliedMarker(marker, { receipt: RECEIPT, artifactId: 'i1' });
    expect(token).not.toBeNull();
    expect(receiptWins(
      { ok: true, message: RECEIPT, artifactId: 'i1', verifiedProse: token }, marker,
    )).toBe(false);
  });

  it('without the token the receipt still wins — fail-closed is unchanged', () => {
    const marker = actionAppliedMarker({ receipt: RECEIPT });
    expect(receiptWins({ ok: true, message: RECEIPT, artifactId: 'i1' }, marker)).toBe(true);
  });

  it('the token cannot be replayed onto a different marker, receipt or artifact', () => {
    const marker = actionAppliedMarker({ receipt: RECEIPT });
    const token = verifyAppliedMarker(marker, { receipt: RECEIPT, artifactId: 'i1' });
    const other = actionAppliedMarker({ receipt: 'Updated "Other": priority=low.' });
    expect(receiptWins({ ok: true, message: RECEIPT, artifactId: 'i1', verifiedProse: token }, other))
      .toBe(true);
    expect(receiptWins(
      { ok: true, message: 'Updated "Other": priority=low.', artifactId: 'i1', verifiedProse: token },
      marker)).toBe(true);
    expect(receiptWins({ ok: true, message: RECEIPT, artifactId: 'i2', verifiedProse: token }, marker))
      .toBe(true);
  });

  it('refuses to mint for a marker that does not carry the receipt it claims', () => {
    const marker = actionAppliedMarker({ receipt: 'Updated "A": priority=high.' });
    expect(verifyAppliedMarker(marker, { receipt: 'Updated "B": priority=low.' })).toBeNull();
    expect(verifyAppliedMarker('not a marker', { receipt: RECEIPT })).toBeNull();
    expect(verifyAppliedMarker(marker, { receipt: '   ' })).toBeNull();
  });
});

describe('DEF-212 — the composer stopped handing over the bare receipt', () => {
  const code = (() => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '..', 'src/services/knowledge/brainComposer.ts'), 'utf8');
    // Comments stripped: a guard must read code, not prose about it (DEF-195).
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  })();

  it('builds the applied marker instead of assigning the receipt', () => {
    expect(code).toMatch(/answer = appliedMarker;/);
    expect(code).toMatch(/actionAppliedMarker\(\{\s*receipt: actionResult\.message as string,/);
  });

  it('computes outstanding from what the DATABASE received, never from what was asked', () => {
    // `data` is the Prisma payload actually written. Using `act` — the model's
    // request — would report a slot as filled that was silently dropped.
    expect(code).toMatch(/outstanding: outstandingSlots\(\s*lastBrainQuestion\(history\),\s*data as unknown/);
    expect(code).not.toMatch(/outstanding: outstandingSlots\([^)]*\bact\b/);
  });

  it('mints the token from the receipt and the artifact that were actually written', () => {
    expect(code).toMatch(/verifyAppliedMarker\(appliedMarker, \{\s*receipt: actionResult\.message as string,\s*artifactId: existing\.id,/);
  });
});
