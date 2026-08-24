/**
 * DEF-034(b) — read back before ANY state claim ships, in BOTH directions.
 *
 * Diagnosed 2026-08-05 14:41, built here after 21 recorded occurrences and
 * three intervening reworders: the completion gate intercepted a claim and
 * replaced it with "nothing was executed" ONE SECOND after Brain had
 * successfully delegated three items. The denial was as fabricated as the
 * claim it replaced, because the gate had no eyes on the dispatch ledger.
 *
 * The class fix under test: when the gate intercepts AND the caller-supplied
 * ledger shows a dispatch that COMPLETED in the last minutes, the replacement
 * is the RECEIPT (`ledger_readback` marker — constructor and renderer in one
 * module, DEF-238's contract), never the denial. With no receipt, the three
 * pre-existing intercept behaviours are byte-identical.
 *
 * Guardrail enforced: no-claim-without-a-receipt — no "done" without one, and
 * no "nothing ran" against one.
 */
import { describe, it, expect } from 'vitest';

import {
  shouldInterceptCompletionClaim,
  completionInterceptMarker,
} from '../src/services/knowledge/brainComposer';
import { ledgerReadbackMarker, ledgerReadbackMeaning } from '../src/services/knowledge/actionReceipt';
import { NEUTRAL_MARKER_FALLBACK, stripMarkerEnvelope, isSystemMarker } from '../src/services/knowledge/systemMarker';
import { curatedMarkerMeaning, sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';

// The diagnosed production fixture: send #2 one second after send #1
// dispatched three delegations.
const RECEIPT = {
  actionType: 'delegate_open_item',
  at: new Date().toISOString(),
  status: 'succeeded',
  summary: '3 items delegated to Hamna',
};
const MUTATION_ASK = 'send it to hamna now';
const CLAIM = 'Done — I have delegated all three items to Hamna.';

describe('DEF-034(b) — the gate reads back before it denies', () => {
  it('mutation-turn claim + completed receipt → intercepted WITH the receipt, not the denial', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: MUTATION_ASK,
      answer: CLAIM,
      emittedAction: false,
      actionResult: null,
      recentDispatches: [RECEIPT],
    });
    expect(v.intercept).toBe(true);
    expect(v.failureType).toBe('completion_claim_has_recent_receipt');
    expect(v.recentReceipt?.actionType).toBe('delegate_open_item');
  });

  it('same claim, NO receipt → the pre-(b) denial, byte-identical', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: MUTATION_ASK,
      answer: CLAIM,
      emittedAction: false,
      actionResult: null,
      recentDispatches: [],
    });
    expect(v.intercept).toBe(true);
    expect(v.failureType).toBe('fabricated_completion_on_action_turn');
    expect(completionInterceptMarker(v.failureType!, v.recentReceipt))
      .toBe('[no action dispatched — the assistant claimed completion but no action ran]');
  });

  it('a receipt whose dispatch FAILED licenses nothing — the DEF-237 rule survives (b)', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: MUTATION_ASK,
      answer: CLAIM,
      emittedAction: false,
      actionResult: null,
      recentDispatches: [{ ...RECEIPT, status: 'failed' }],
    });
    expect(v.intercept).toBe(true);
    expect(v.failureType).toBe('fabricated_completion_on_action_turn');
    expect(v.recentReceipt).toBeUndefined();
  });

  it('read-only ungrounded current-turn claim + receipt → the receipt grounds it too', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'did you send it?',
      answer: 'I just sent it a moment ago.',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: false,
      recentDispatches: [RECEIPT],
    });
    expect(v.intercept).toBe(true);
    expect(v.failureType).toBe('completion_claim_has_recent_receipt');
  });

  it('a confirmed dispatch THIS turn still passes untouched — (b) only fires on intercepts', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: MUTATION_ASK,
      answer: CLAIM,
      emittedAction: true,
      actionResult: { ok: true },
      recentDispatches: [RECEIPT],
    });
    expect(v.intercept).toBe(false);
  });
});

describe('DEF-034(b) — the readback marker renders as the FACT, never the fallback', () => {
  it('carries provenance, a curated meaning naming the action, and survives the sanitizer', () => {
    const marker = completionInterceptMarker('completion_claim_has_recent_receipt', RECEIPT);
    expect(isSystemMarker(marker)).toBe(true);
    const meaning = curatedMarkerMeaning(stripMarkerEnvelope(marker));
    expect(meaning).not.toBeNull();
    expect(meaning).toContain('delegate');                    // actionPhrase renders the kind
    expect(meaning).toContain('3 items delegated to Hamna');  // the summary travels
    expect(meaning).toContain('already ran');
    const out = sanitizeAnswerForUser(marker);
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
  });

  it('rejects payloads the constructor could not have minted', () => {
    expect(ledgerReadbackMeaning('[ledger_readback: {"action":"x","at":"not-a-date"}]')).toBeNull();
    expect(ledgerReadbackMeaning('[ledger_readback: {"at":"2026-08-24T04:12:00Z"}]')).toBeNull();
    expect(ledgerReadbackMeaning(`[ledger_readback: {"action":${JSON.stringify('x'.repeat(61))},"at":"2026-08-24T04:12:00Z"}]`)).toBeNull();
    expect(ledgerReadbackMeaning('[ledger_readback: not json]')).toBeNull();
  });

  it('round-trips through the constructor without a summary', () => {
    const meaning = ledgerReadbackMeaning(
      stripMarkerEnvelope(ledgerReadbackMarker({ actionType: 'send_email', at: '2026-08-05T14:41:00Z' })),
    );
    expect(meaning).toContain('2026-08-05 14:41');
    expect(meaning).toContain('do not deny the recorded one');
  });
});
