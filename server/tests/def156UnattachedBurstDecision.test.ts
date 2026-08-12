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
    /**
     * Replays the burst the way the JOB does, which is the correction DEF-157
     * makes to this file.
     *
     * The old helper pushed EVERY fragment into `seen` regardless of whether it was
     * sent. Production only has a row for a fragment it sent — a suppressed one is
     * written nowhere — so the old helper fed the seam a history production cannot
     * produce, and its "one message" assertion was measuring a state that never
     * occurs. That is the same unreachable-fixture error as the benchmark's P05,
     * in the test that was supposed to catch it.
     */
    function replay(fragments: readonly string[], retained = false) {
      const sent: string[] = [];
      const persisted: Array<{ body: string; atMs: number }> = [];
      for (let i = 0; i < fragments.length; i++) {
        const atMs = T0 + i * 5 * 60_000;
        const d = decideUnattachedReply({
          who: WHO,
          body: fragments[i],
          atMs,
          earlierFromSender: [...persisted],
          alreadyNotifiedInWindow: persisted.length > 0,
          retained,
        });
        if (d.action === 'send' && d.renderedMessage) {
          sent.push(d.renderedMessage);
          persisted.push({ body: fragments[i], atMs });
        }
      }
      return sent;
    }

    it('NO FRAGMENT IS EVER LOST — the property DEF-156 broke', () => {
      // This is the assertion that should have existed one iteration ago. DEF-156
      // suppressed on volume alone while `delegationCaptureService` returned before
      // persisting, so the owner got "Gsus" and the other nine vanished. Ten noisy
      // pushes is a nuisance; losing "urgent: the server is down" because a social
      // message arrived two minutes earlier is not.
      const sent = replay(BURST);
      const delivered = sent.join('\n');
      for (const fragment of BURST) {
        expect(delivered, `"${fragment}" reached the owner nowhere`).toContain(fragment);
      }
    });

    it('so with nothing retaining them, ten fragments produce ten notices', () => {
      // The DEF-139 defect, back and VISIBLE. That is the correct trade until a
      // burst ledger exists: noise the owner can scroll past beats silence he
      // cannot detect. Invariant #6 — visible degradation, never silent success.
      expect(replay(BURST).length).toBe(BURST.length);
    });

    it('and ONCE something retains them, the same burst collapses to one', () => {
      // The mechanism is right; only its precondition was missing. With
      // `retained: true` the very first later fragment is suppressed, which is what
      // the next turn's ledger unlocks.
      const sent = replay(BURST, true);
      expect(sent.length).toBe(1);
      expect(sent[0]).toContain('Gsus');
    });

    it('a suppression states that the message was retained', () => {
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0 + 25 * 60_000,
        earlierFromSender: [{ body: 'Gsus', atMs: T0 + 20 * 60_000 }],
        alreadyNotifiedInWindow: true,
        retained: true,
      });
      expect(d.action).toBe('suppress');
      expect(d.renderedMessage).toBeNull();
      expect(d.reason).toContain('already told you');
      expect(d.reason, 'a suppression must say where the message went').toContain('retained');
    });

    it('WITHOUT retention the same input sends instead of suppressing', () => {
      // One field decides whether a message can be withheld, which is what makes
      // the data-loss regression impossible to reintroduce by accident.
      const d = decideUnattachedReply({
        who: WHO, body: 'urgent: the server is down', atMs: T0 + 60_000,
        earlierFromSender: [{ body: 'Gsus', atMs: T0 }],
        alreadyNotifiedInWindow: true,
        retained: false,
      });
      expect(d.action).toBe('send');
      expect(d.renderedMessage).toContain('urgent: the server is down');
      expect(d.reason).toContain('nothing retains');
    });

    it('a genuinely new burst after the window is a new event', () => {
      // Suppression is bounded. Someone messaging again two hours later is news.
      const d = decideUnattachedReply({
        who: WHO, body: 'Are you there?', atMs: T0 + 3 * 60 * 60_000,
        earlierFromSender: [{ body: 'Gsus', atMs: T0 }],
        alreadyNotifiedInWindow: false,
        retained: true,
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
        retained: true,
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
        retained: true,
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
        retained: true,
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
        retained: true,
      });
      expect(d.action).toBe('send');
    });

    it('a SUPPLIED verdict is honoured, and its reason is carried through', () => {
      // The hook exists and is exercised; production does not populate it yet,
      // which the source states rather than implies.
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0, earlierFromSender: [], alreadyNotifiedInWindow: false,
        retained: true,
        relevance: { worthSurfacing: false, reason: 'social chatter, no open work with this number' },
      });
      expect(d.action).toBe('suppress');
      expect(d.reason).toContain('social chatter');
    });

    it('an URGENT verdict overrides the volume rule (reversed by DEF-157)', () => {
      // This test asserted the opposite one iteration ago: that already-notified
      // beat an enthusiastic classifier, so a relevance model could not reopen the
      // ten-push defect. Codex's iteration-13 MEDIUM #4 is right that the priority
      // was backwards — a classifier deciding the second message is critical must
      // not be outvoted by "we already mentioned this sender". Volume is a
      // courtesy; urgency is not. Recorded as a reversal rather than edited
      // quietly, because the earlier assertion was a considered choice and it was
      // wrong.
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0 + 60_000,
        earlierFromSender: [{ body: 'Gsus', atMs: T0 }],
        alreadyNotifiedInWindow: true,
        retained: true,
        relevance: { worthSurfacing: true, reason: 'looks urgent' },
      });
      expect(d.action).toBe('send');
      expect(d.renderedMessage).toContain('Okby');
    });

    it('a NOT-worth-surfacing verdict still cannot drop an unretained message', () => {
      // Found by mutation: removing the retention gate from the CONTENT branch
      // broke nothing, because only the volume branch was tested. The same rule
      // has to hold on both — a message judged uninteresting is still the owner's
      // to see if we were wrong about it, and "we thought it was boring" is not a
      // licence to delete.
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0, earlierFromSender: [],
        alreadyNotifiedInWindow: false,
        retained: false,
        relevance: { worthSurfacing: false, reason: 'social chatter' },
      });
      expect(d.action).toBe('send');
      expect(d.renderedMessage).toContain('Okby');
    });

    it('and suppresses it once something does retain it', () => {
      const d = decideUnattachedReply({
        who: WHO, body: 'Okby', atMs: T0, earlierFromSender: [],
        alreadyNotifiedInWindow: false,
        retained: true,
        relevance: { worthSurfacing: false, reason: 'social chatter' },
      });
      expect(d.action).toBe('suppress');
      expect(d.reason).toContain('retained');
    });

    it('the window is a constant the caller may override, not a hidden default', () => {
      expect(UNATTACHED_WINDOW_MS).toBe(20 * 60 * 1000);
      const d = decideUnattachedReply({
        who: WHO, body: 'b', atMs: T0 + 60_000,
        earlierFromSender: [{ body: 'a', atMs: T0 }],
        alreadyNotifiedInWindow: false,
        retained: true,
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
