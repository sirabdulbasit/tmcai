/**
 * DEF-156 — ten pushes from one sender become one notice.
 *
 * CL-033, 09:05 to 12:26: **ten separate WhatsApp notifications from a single
 * unknown number**, each carrying the same parenthetical, for a social
 * conversation in Roman-Urdu including fragments that carry no information at all
 * ("Gsus", "Okby", "Man ni ke cl"). `notifyOwnerOfUnattachedReply` enqueued one
 * prompt per inbound, keyed `unattached_reply:${sourceId}`, so every distinct
 * message id became its own push.
 *
 * DEF-155 made the WORDS of that surface scorable and the slice found them
 * wanting — C4 = 70 on the window, *"A human would likely summarize or state this
 * once … not repeat it verbatim six times."* But Codex was right that the slice
 * measured a renderer and the build log called it end-to-end: **the defect is the
 * decision, and the decision was invisible.**
 *
 * So `decideUnattachedReply` is a pure seam called by BOTH the job and the
 * benchmark, returning `{action, reason, renderedMessage, covers}`. What ships and
 * what is scored are now the same function.
 *
 * ── THE LINE THIS FILE DEFENDS MOST CAREFULLY ───────────────────────────────
 *
 * **Volume is decided here; MEANING is not.** Counting messages and subtracting
 * timestamps is structural. Whether "Okby" deserves the owner's attention is a
 * judgement about substance, and invariant #3 is explicit that those are
 * LLM-with-context and that a regex may pre-filter but never decide. The seam
 * therefore takes a relevance verdict as an INPUT, and with none supplied it never
 * suppresses on content — fail-open for judgement, fail-closed for volume.
 * Dropping the owner's messages on a guess is worse than one message too many.
 */
import { describe, it, expect } from 'vitest';
import {
  decideUnattachedReply,
  UNATTACHED_WINDOW_MS,
} from '../src/services/notifications/proactiveDecision';
import {
  renderUnattachedDigest,
  renderUnattachedReply,
} from '../src/services/notifications/proactiveMessageText';

const WHO = '+923001234567';
const T0 = 1_000_000;

/** CL-033's burst, at the 5-minute polling cadence the timestamps show. */
const BURST = [
  'Gsus',
  'Hello, peace be upon you. How are you? Are you okay?',
  'First, you have blocked me on all numbers, she is telling me.',
  'Q Kya hwo',
  'Ni bat karn to ok',
  'Okby',
  'Man ni ke cl',
  'Passy nhi aya',
  'Asi numr',
  'Kon',
];

describe('DEF-156 — one notice per sender-window, not one per message', () => {
  describe('the burst from CL-033', () => {
    /** Replays the ten inbounds through the seam the way the job does: each tick
     *  sees what the previous ticks already sent. */
    function replay(fragments: readonly string[]) {
      const sent: string[] = [];
      const seen: Array<{ body: string; atMs: number }> = [];
      let notified = false;
      for (let i = 0; i < fragments.length; i++) {
        const atMs = T0 + i * 5 * 60_000;
        const d = decideUnattachedReply({
          who: WHO,
          body: fragments[i],
          atMs,
          earlierFromSender: [...seen],
          alreadyNotifiedInWindow: notified,
        });
        if (d.action === 'send' && d.renderedMessage) {
          sent.push(d.renderedMessage);
          notified = true;
        }
        seen.push({ body: fragments[i], atMs });
      }
      return sent;
    }

    it('ten fragments produce exactly ONE owner message', () => {
      // Codex's success criterion, verbatim: "ten fragments → zero or one
      // justified owner message, not a prettier repeated parenthetical."
      const sent = replay(BURST);
      expect(sent.length, 'the owner received ten; he should receive one').toBe(1);
    });

    it('the one message is the FIRST one, so he is told promptly', () => {
      // Batching must not mean waiting. He hears about the sender immediately;
      // what he does not get is nine more of them.
      const sent = replay(BURST);
      expect(sent[0]).toContain('Gsus');
    });

    it('every later fragment is suppressed with an auditable reason', () => {
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0 + 25 * 60_000,
        earlierFromSender: [{ body: 'Gsus', atMs: T0 + 20 * 60_000 }],
        alreadyNotifiedInWindow: true,
      });
      expect(d.action).toBe('suppress');
      expect(d.renderedMessage).toBeNull();
      // A silent drop is not acceptable; the reason names the sender and window.
      expect(d.reason).toContain('already told you');
      expect(d.reason).toMatch(/20 minutes/);
    });

    it('a genuinely new burst after the window is a new event', () => {
      // Suppression is bounded. Someone messaging again two hours later is news.
      const d = decideUnattachedReply({
        who: WHO, body: 'Are you there?', atMs: T0 + 3 * 60 * 60_000,
        earlierFromSender: [{ body: 'Gsus', atMs: T0 }],
        alreadyNotifiedInWindow: false,
      });
      expect(d.action).toBe('send');
      expect(d.covers, 'the old message is outside the window').toBe(1);
      expect(d.renderedMessage).not.toContain('Gsus');
    });
  });

  describe('the notice covers what actually arrived', () => {
    it('a single message reads exactly as it always did', () => {
      // No behaviour change for the common case, and asserted against the
      // production wording rather than a paraphrase.
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0, earlierFromSender: [], alreadyNotifiedInWindow: false,
      });
      expect(d.renderedMessage).toBe(renderUnattachedReply({ who: WHO, body: 'Okby' }));
      expect(d.covers).toBe(1);
    });

    it('several messages arrive as one digest that quotes each of them', () => {
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0 + 10 * 60_000,
        earlierFromSender: [
          { body: 'Gsus', atMs: T0 },
          { body: 'Q Kya hwo', atMs: T0 + 5 * 60_000 },
        ],
        alreadyNotifiedInWindow: false,
      });
      expect(d.covers).toBe(3);
      expect(d.renderedMessage).toBe(renderUnattachedDigest({
        who: WHO, bodies: ['Gsus', 'Q Kya hwo', 'Okby'],
      }));
      // Their words stay verbatim — DEF-140 classified this producer
      // `quoted_third_party` and the address boundary must not rewrite them.
      for (const q of ['"Gsus"', '"Q Kya hwo"', '"Okby"']) {
        expect(d.renderedMessage).toContain(q);
      }
      // And the parenthetical appears ONCE, which is the C4=70 complaint.
      expect(d.renderedMessage!.match(/already closed or waiting on you/g)!.length).toBe(1);
    });

    it('the digest states the count so a glance is enough', () => {
      const d = decideUnattachedReply({
        who: 'Hamna Latif Bhutta', body: 'c', atMs: T0 + 2,
        earlierFromSender: [{ body: 'a', atMs: T0 }, { body: 'b', atMs: T0 + 1 }],
        alreadyNotifiedInWindow: false,
      });
      expect(d.renderedMessage).toContain('Hamna Latif Bhutta sent 3 messages');
    });
  });

  describe('meaning is never judged here (invariant #3)', () => {
    it('with no relevance verdict, nothing is suppressed on content', () => {
      // Fail-open for judgement. "Okby" carries no information and is still
      // delivered, because deciding otherwise from the text would be exactly the
      // hardcoded judgement the invariant forbids.
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0, earlierFromSender: [], alreadyNotifiedInWindow: false,
      });
      expect(d.action).toBe('send');
    });

    it('a SUPPLIED verdict is honoured, and its reason is carried through', () => {
      // The hook exists and is exercised; production does not populate it yet,
      // which the source states rather than implies.
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0, earlierFromSender: [], alreadyNotifiedInWindow: false,
        relevance: { worthSurfacing: false, reason: 'social chatter, no open work with this number' },
      });
      expect(d.action).toBe('suppress');
      expect(d.reason).toContain('social chatter');
    });

    it('a verdict that says yes does not override the volume rule', () => {
      // Order matters: already-notified wins over an enthusiastic classifier, or
      // a relevance model could reopen the ten-push defect.
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0 + 60_000,
        earlierFromSender: [{ body: 'Gsus', atMs: T0 }],
        alreadyNotifiedInWindow: true,
        relevance: { worthSurfacing: true, reason: 'looks urgent' },
      });
      expect(d.action).toBe('suppress');
      expect(d.reason).toContain('already told you');
    });

    it('the window is a constant the caller may override, not a hidden default', () => {
      expect(UNATTACHED_WINDOW_MS).toBe(20 * 60 * 1000);
      const d = decideUnattachedReply({
        who: WHO, body: 'b', atMs: T0 + 60_000,
        earlierFromSender: [{ body: 'a', atMs: T0 }],
        alreadyNotifiedInWindow: false,
        windowMs: 30_000, // tighter than the gap, so the earlier one drops out
      });
      expect(d.covers).toBe(1);
    });
  });

  describe('production calls this seam', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const capture = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'delegation', 'delegationCaptureService.ts'),
      'utf8',
    );

    it('the capture service decides before it enqueues', () => {
      expect(capture).toContain('decideUnattachedReply({');
      // And it sends the seam's text, not its own — one implementation.
      expect(capture).toContain('question: decision.renderedMessage');
      expect(capture).toContain("if (decision.action === 'suppress'");
    });

    it('it reads the window from the queue it writes to, not from memory', () => {
      // In-process state resets on restart (gap G5), so the next tick must be
      // able to see what the last one sent. The ledger is the memory.
      expect(capture).toContain('brainPromptQueue.findMany');
      expect(capture).toContain('UNATTACHED_WINDOW_MS');
      expect(capture).toContain("source === 'unattached_counterpart_reply'");
    });

    it('it stores the body so a later digest can quote it', () => {
      expect(capture).toContain('body: input.body.slice(0, 300)');
    });
  });
});
