/**
 * CLOSED-LOOP SCENARIO MATRIX — 15 cases, derived from the owner's two
 * multi-user scenarios on 2026-08-05/06.
 *
 * HOW TO READ THIS FILE
 *
 * `it.fails(...)` marks a defect that is REAL TODAY. Vitest passes when the
 * body fails, so the suite stays green while the defect is documented. The
 * moment someone fixes it the test errors with "expected to fail but passed",
 * which forces this file to be updated. A known defect therefore cannot be
 * silently fixed OR silently forgotten.
 *
 * `it(...)` is behaviour that works and must keep working.
 * `it.todo(...)` is a case I could not verify honestly from static reading.
 *
 * The matrix exists because two hand-walked scenarios found six defects that
 * months of green tests had not. Every test below is a question the owner
 * asked, not one I invented.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ACTIVE_THREAD_STATES } from '../src/services/delegation/delegationThreadService';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const INBOUND = strip(read('services/whatsapp/WhatsAppInbound.ts'));
const CAPTURE = strip(read('services/delegation/delegationCaptureService.ts'));
const QUEUE = strip(read('services/brainPrompts/brainPromptQueueService.ts'));

describe('S1 · DEF-067 — the counterpart is also a Nexeo user', () => {
  it.fails('a registered user replying to a delegation is correlated', () => {
    // Basit delegates to Haseeb, who IS a user. Haseeb replies from his own
    // WhatsApp, resolveRegisteredWhatsAppUser matches him, and the message is
    // handled as Haseeb chatting with HIS OWN assistant. captureDelegationReply
    // lives inside `if (!resolvedIdentity)` so it never runs.
    //
    // Basit never learns Haseeb answered. In a company this size, delegating to
    // a colleague who is also a user is the NORMAL case — which is why testing
    // with Hamna (not a user) made the loop look like it worked.
    const guard = INBOUND.indexOf('if (!resolvedIdentity)');
    const capture = INBOUND.indexOf('captureDelegationReply');
    const guardEnds = INBOUND.indexOf('\n  }', guard);
    expect(capture > guardEnds || capture < guard,
      'capture must run for registered senders too').toBe(true);
  });
});

describe('S2/S5 · DEF-068 — a reply after the ask is closed or cancelled', () => {
  it('confirms resolved and cancelled are not active states', () => {
    expect(ACTIVE_THREAD_STATES).not.toContain('resolved');
    expect(ACTIVE_THREAD_STATES).not.toContain('cancelled');
  });

  it.fails('a late reply is still attributed to the person and the old item', () => {
    // Correlation only searches ACTIVE_THREAD_STATES, so once the owner closes
    // the item — or cancels the ask — the counterpart's reply matches nothing
    // and arrives as "a stranger messaged you". The answer still matters; it
    // just must not reopen anything.
    // Precise: the result union has no closed-thread outcome, so there is no
    // way for the caller to distinguish "unknown person" from "known person,
    // finished conversation". (An earlier version of this test matched
    // 'resolved' inside 'resolved_pending_owner' and wrongly passed.)
    const union = CAPTURE.slice(CAPTURE.indexOf('outcome?:'), CAPTURE.indexOf('outcome?:') + 160);
    expect(union, 'needs a closed/late-reply outcome').toMatch(/closed|late_reply/);
  });
});

describe('S3 · DEF-069 — the counterpart asks a question back', () => {
  it('confirms an unknown classification is deliberately silent', () => {
    expect(CAPTURE).toMatch(/outcome === 'unknown' \? 'unrelated'/);
    expect(CAPTURE).toMatch(/unrelated → deliberately silent|unrelated/);
  });

  it.fails('"why do you need this?" reaches the owner', () => {
    // Classified `unknown` → `unrelated` → no notifyOwner branch. So Majid
    // asking a reasonable question is discarded: he gets no answer and the
    // owner never learns he asked. Under the owner's Rule 1 this must surface —
    // and Brain must NOT answer it itself.
    const notifyBranches = CAPTURE.slice(CAPTURE.indexOf("outcome === 'completed'"));
    expect(notifyBranches, "a question back must notify the owner")
      .toMatch(/question_back|asked_a_question|counterpart_question/);
  });
});

describe('S4 · a bare "ok" is not an answer', () => {
  it('low confidence notifies rather than being treated as an answer', () => {
    expect(CAPTURE).toMatch(/low_confidence[\s\S]{0,200}notifyOwner/);
  });

  it.fails('Rule 1 — Brain clarifies before reporting an empty answer', () => {
    // Owner ruling 2026-08-06: "AI should not carry or forward any incomplete
    // or info with ambiguity." A bare "ok" is incomplete; Brain should ask once.
    expect(CAPTURE).toMatch(/clarif/i);
  });
});

describe('S6 · DEF-070 — a commitment in the reply', () => {
  it.fails('"I\'ll send it Friday" schedules a follow-up for Friday', () => {
    // nextFollowupAt exists on the thread but nothing derives it from what the
    // counterpart actually said, so a promise is recorded as prose and the
    // date passes unwatched.
    expect(CAPTURE).toMatch(/nextFollowupAt[\s\S]{0,200}interpretation/);
  });
});

describe('S7 · voice reply from a counterpart', () => {
  it.todo('an Urdu voice note reply is transcribed, stored, and summarised in English');
});

describe('S8 · reply from a different number', () => {
  it('is an accepted limit — no thread, so it is triaged, not misattributed', () => {
    // Messaging +A and replying from +B cannot correlate. Correct behaviour is
    // to treat it as unknown rather than guess, which is what happens.
    expect(CAPTURE).toMatch(/counterpartKey/);
  });
});

describe('S9 · DEF-061 — two owners, same counterpart, same question', () => {
  it.fails('correlation is scoped by owner before any recency tie-break', () => {
    // Both Ali and Kashif ask Majid for the same status. He answers once.
    // The candidate query filters clientNumber + counterpartKey + channel +
    // state — but NOT ownerUserId — so the recency tie-break can hand Ali's
    // answer to Kashif. Before DEF-047 this refused; my change made it pick,
    // which turned a safe refusal into a cross-user disclosure.
    // Precise: assert on the WHERE clause only. `ownerUserId` also appears in
    // the SELECT list, which made a looser version of this test wrongly pass.
    const q = CAPTURE.slice(CAPTURE.indexOf('const candidates = await prisma.delegationThread.findMany'));
    const whereClause = q.slice(q.indexOf('where: {'), q.indexOf('select:'));
    expect(whereClause, 'the candidate WHERE must constrain ownerUserId')
      .toMatch(/ownerUserId/);
  });
});

describe('S10 · one owner asks one person two things', () => {
  it('resolves by recency and discloses the inference', () => {
    expect(CAPTURE).toMatch(/correlationInferredOver/);
    expect(CAPTURE).toMatch(/delegation_reply_correlation_inferred/);
  });
});

describe('S11 · a quoted reply beats recency', () => {
  it('quoted provider id is tried before any candidate scan', () => {
    const quoted = CAPTURE.indexOf('quotedProviderId');
    const scan = CAPTURE.indexOf('const candidates = await prisma.delegationThread.findMany');
    expect(quoted).toBeGreaterThan(-1);
    expect(quoted, 'exact beats inferred').toBeLessThan(scan);
  });
});

describe('S12 · duplicate webhook', () => {
  it('dedups on the provider source id', () => {
    expect(CAPTURE).toMatch(/inboundSourceId/);
    expect(CAPTURE).toMatch(/duplicate_event/);
  });
});

describe('S13 · DEF-064 — reply lands mid-dispatch', () => {
  it.fails('a CAS failure re-reads and retries instead of dropping to triage', () => {
    // appendEventWithTransition compares against a state read a moment earlier.
    // If an outbound moves the thread between read and write, the CAS fails and
    // the code returns no_thread — so a simultaneous send and receive makes a
    // real reply look like a stranger.
    const consume = CAPTURE.slice(CAPTURE.indexOf('const consumed = await appendEventWithTransition'));
    expect(consume.slice(0, 600), 'a lost CAS must retry, not discard')
      .toMatch(/retry|re-read|refetch/i);
  });
});

describe('S14 · cross-tenant isolation', () => {
  it('every correlation read is scoped by clientNumber', () => {
    const q = CAPTURE.slice(CAPTURE.indexOf('const candidates = await prisma.delegationThread.findMany'));
    expect(q.slice(0, 400)).toMatch(/clientNumber: input\.clientNumber/);
  });
});

describe('S15 · DEF-071 — the reply mentions a different item', () => {
  it.fails('"also, EXIM is done" is not filed against the asked-about item', () => {
    // The whole reply is interpreted against the thread's own open item, so a
    // fact about a DIFFERENT item is either lost or misattributed. Same shape
    // as DEF-017: a compound message treated as being about one thing.
    expect(CAPTURE).toMatch(/secondary_item|other_item|additional_items/);
  });
});

describe('DEF-063 — an informational update must not take the conversational lock', () => {
  // FIXED 2026-08-06. Flipped from it.fails() because it started passing —
  // which is the whole point of the marker: a defect cannot be quietly fixed
  // and left documented as broken.
  it('only prompts that expect an answer set awaiting_reply', () => {
    expect(QUEUE).toMatch(/expectsReply/);
  });

  it('a notice is closed immediately after sending, so it never holds the lock', () => {
    // Babar answered at 10:30 and the notice took the lock; Farooq's 10:45
    // answer waited behind it until expireStalePrompts deleted it. The owner
    // got one of two figures and never learned they disagreed — which was the
    // only thing worth telling him.
    expect(QUEUE).toMatch(/promptExpectsReply/);
    expect(QUEUE).toMatch(/state: 'answered'/);
  });

  it("uses an EXISTING state — no new enum value against a CHECK constraint", () => {
    // DEF-060 was exactly this mistake: 'normal' was not a valid criticality
    // and every insert died with Postgres 23514, silently, for five days.
    const states = [...QUEUE.matchAll(/state: '([a-z_]+)'/g)].map((m) => m[1]);
    for (const st of states) {
      expect(['queued', 'awaiting_reply', 'answered', 'expired', 'skipped'],
        `'${st}' must already exist in the schema`).toContain(st);
    }
  });

  it('defaults to expecting a reply, so existing callers are unchanged', () => {
    expect(QUEUE).toMatch(/input\.expectsReply !== false/);
  });

  it('a delegatee reply and a delivery notice are both marked as notices', () => {
    const capture = strip(read('services/delegation/delegationCaptureService.ts'));
    const ack = strip(read('services/whatsapp/outboundAckService.ts'));
    expect(capture).toMatch(/expectsReply: false/);
    expect(ack).toMatch(/expectsReply: false/);
  });
});
