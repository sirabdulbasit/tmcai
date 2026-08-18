/**
 * DEF-147 — the flag claimed entailment and checked two lexical conditions.
 *
 * DEF-146 put `proseGrounded?: boolean` on the action result and wrote into the
 * type contract that it meant the branch had "compared the visible prose against
 * the structured outcome and found the prose entailed by it". What it actually
 * checked was whether a requested priority failed to normalise, and whether one
 * deadline regex was compatible with the list of written field NAMES
 * (`Object.keys(data)`). It never inspected a single field VALUE, or which item
 * had been updated.
 *
 * Codex's iteration-9 HIGH, verbatim in effect:
 *
 *     Prisma updates Project Beta to `high`. The model says "I've set Project
 *     Alpha to critical. It still needs a due date." Priority normalised, no
 *     deadline claim → flag true → WhatsApp hid the correct Beta/high receipt
 *     and shipped the false Alpha/critical statement.
 *
 * Two defects in one field. The checks were too weak for the name — and worse,
 * **a boolean is a capability anybody can assert.** Any future branch could have
 * written `proseGrounded: true` to get friendlier prose, compared nothing, and
 * every test in the suite would have stayed green.
 *
 * So: `verifyUpdateProse` is the only thing that can mint a `VerifiedProse`, the
 * token lives in a module-private WeakSet, and `receiptWins` accepts nothing
 * else. A cast, a hand-built object, and a JSON round-trip all fail — the last
 * one correctly, because this decision must be made in the process holding the
 * outcome.
 *
 * The cases below are the ones Codex asked for by name: wrong item, wrong
 * priority, wrong date, false status transition, extra-note completion.
 */
import { describe, it, expect, vi } from 'vitest';

import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

/**
 * What the owner actually reads when the receipt wins.
 *
 * DEF-220 SUPERSEDED the four assertions below, deliberately. They were
 * `expect(body).toContain('priority=high')` — and `priority=high` is the
 * field-name string DEF-144, DEF-145 and DEF-212 were all written about. It
 * passed because the rendered receipt was embedded verbatim in the marker's
 * JSON payload; the marker now carries the FIELDS, and the sentence is composed
 * from them. The property this file defends — unverifiable prose loses, and the
 * true-by-construction outcome ships instead — is unchanged, and each case now
 * asserts it through the real sanitizer rather than on a JSON substring.
 */
const owner = (body: string) => curatedMarkerMeaning(stripMarkerEnvelope(String(body)));

const ITEM_TITLE = "Define rules for Brain's responsiveness to new vs. existing contacts";
const OTHER_TITLE = 'Vision Metric Integration';

const updates: any[] = [];

vi.mock('../src/db/prisma', () => {
  // Literal, not the module const: vi.mock factories are hoisted, so touching a
  // top-level binding here is a TDZ error at import time.
  const row = {
    id: 'item-b04',
    title: "Define rules for Brain's responsiveness to new vs. existing contacts",
    status: 'DRAFT', priority: 'medium', dueDate: null,
  };
  const openItem = {
    findMany: async () => [row],
    findUnique: async () => null,
    findFirst: async (args: any) => (args?.where?.id === 'item-b04' ? row : null),
    update: async (args: any) => { updates.push(args); return { id: 'item-b04' }; },
  };
  const model = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), upsert: async () => ({}), count: async () => 0,
    aggregate: async () => ({}), groupBy: async () => [], deleteMany: async () => ({ count: 0 }),
  };
  const p: any = new Proxy(
    { openItem, $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRaw: async () => 0,
      $transaction: async (a: any) => (typeof a === 'function' ? a(p) : []) },
    { get: (t: any, k: string) => (k in t ? t[k] : model) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/knowledge/brainPersonaService', () => ({
  __esModule: true,
  getBrainPersona: async () => ({
    addressAs: 'Sir', userFirstName: 'Basit', userFullName: 'Basit Ahmed',
    userEmail: 'b@x.com', systemPreamble: 'p', brainName: 'Suzi', userGender: 'male',
  }),
}));
vi.mock('../src/services/knowledge/promptBlockService', () => ({
  __esModule: true, getApplicableBlocks: async () => [{ name: 'communication_contract', content: '#' }],
}));

const llm = { answer: '', action: null as any };
vi.mock('../src/services/llmRouter', () => ({
  __esModule: true,
  callLLM: async () => ({
    text: JSON.stringify({ answer: llm.answer, cites: [], gaps: [], action: llm.action }),
    provider: 't', model: 't',
  }),
}));

import { compose } from '../src/services/knowledge/brainComposer';
import { renderForChannel } from '../src/services/knowledge/channelRenderer';
import { verifyUpdateProse, receiptWins, __isIssuedToken } from '../src/services/knowledge/answerReceiptPolicy';

/** Drive the real composer, then the real renderer — the chain Codex asked the
 *  assertions to run through, rather than a hand-built result. */
async function composeThenRender(answer: string, action: any): Promise<string> {
  llm.answer = answer;
  llm.action = { type: 'update_open_item', openItemId: 'item-b04', ...action };
  updates.length = 0;
  const result = await compose(
    'TMC-0001', 2, 'Priority high.',
    { intent: 'action', queries: [], scopeLean: 'personal' } as any,
    [], [], { useReasoning: false, channel: 'web' } as any,
  );
  return renderForChannel(result as any, 'whatsapp').body;
}

const OUTCOME = {
  artifactTitle: ITEM_TITLE,
  appliedPriority: 'high',
  appliedDueDate: false,
  appliedStatus: null,
  requestedButNotApplied: [] as string[],
};

describe('DEF-147 — only the verifier can mint the token, and it checks values', () => {
  describe('compose → renderer, with the claims Codex named', () => {
    it('the honest B04 continuation reaches WhatsApp', async () => {
      const prose = "Got it. I've set the priority to high. Is there a deadline for this?";
      expect(await composeThenRender(prose, { priority: 'high' })).toBe(prose);
    });

    it('WRONG PRIORITY VALUE — "critical" claimed, "high" written → receipt', async () => {
      // The half of Codex's scenario that is lexically catchable.
      const body = await composeThenRender(
        "Got it. I've set it to critical. Is there a deadline?", { priority: 'high' },
      );
      expect(owner(body)).toContain('its priority is now high');
      expect(body).not.toContain('critical');
    });

    it('WRONG ITEM, quoted — a different title than the row updated → receipt', async () => {
      const body = await composeThenRender(
        `I've set "${OTHER_TITLE}" to high priority for you.`, { priority: 'high' },
      );
      expect(owner(body)).toContain('its priority is now high');
      expect(body).not.toContain(OTHER_TITLE);
    });

    it('WRONG DATE — a deadline claimed with none written → receipt', async () => {
      const body = await composeThenRender(
        "Done — priority is high and I've set the deadline to Friday.", { priority: 'high' },
      );
      expect(owner(body)).toContain('its priority is now high');
      expect(body).not.toContain('Friday');
    });

    it('FALSE STATUS — claiming the item is done → receipt', async () => {
      // `update_open_item` never closes an item, so this is false by
      // construction no matter what the model believes.
      const body = await composeThenRender(
        "I've marked it done and set the priority to high.", { priority: 'high' },
      );
      expect(owner(body)).toContain('its priority is now high');
      expect(body).not.toMatch(/marked it done/i);
      // DEF-220 — and the field-name string is not in the marker either.
      expect(body).not.toContain('priority=high');
    });

    it('the quoted CORRECT title is allowed through', async () => {
      const prose = `I've set "${ITEM_TITLE}" to high. Any deadline?`;
      expect(await composeThenRender(prose, { priority: 'high' })).toBe(prose);
    });
  });

  describe('the token cannot be forged', () => {
    it('rejects a cast boolean, a bare object, and a JSON round-trip', () => {
      expect(__isIssuedToken(true)).toBe(false);
      expect(__isIssuedToken({})).toBe(false);
      expect(__isIssuedToken({ verified: true })).toBe(false);
      const real = verifyUpdateProse('A sentence long enough to pass the floor.', OUTCOME);
      expect(__isIssuedToken(real)).toBe(true);
      expect(__isIssuedToken(JSON.parse(JSON.stringify(real)))).toBe(false);
    });

    it('a token is minted per verification, not shared', () => {
      const a = verifyUpdateProse('One sentence that is long enough.', OUTCOME);
      const b = verifyUpdateProse('Another sentence that is long enough.', OUTCOME);
      expect(a).not.toBe(b);
      expect(__isIssuedToken(a) && __isIssuedToken(b)).toBe(true);
    });
  });

  // ── DEF-154: the token is a proof about ONE sentence, not a bearer pass. ──
  describe('DEF-154 — a genuine token cannot be replayed', () => {
    const HONEST = 'Priority is high. What deadline would you like?';
    const FABRICATED = 'Project Alpha is critical and due Friday.';
    const RECEIPT = 'Updated "the item": priority=high.';

    function mint(prose: string, receipt = RECEIPT, artifactId: string | null = 'item-b04') {
      return verifyUpdateProse(prose, { ...OUTCOME, artifactId, receipt });
    }

    it('THE REPLAY: a token minted for honest prose, attached to fabricated prose, loses', () => {
      // Codex's iteration-10 HIGH, as an executable. Before DEF-154 the WeakSet
      // answered "was this object issued?" and never "issued for WHAT?", so this
      // exact swap shipped the fabrication.
      const token = mint(HONEST);
      expect(__isIssuedToken(token), 'the token is genuine — that is the point').toBe(true);
      expect(
        receiptWins({ ok: true, message: RECEIPT, artifactId: 'item-b04', verifiedProse: token }, FABRICATED),
        'a genuine token must not launder a different sentence',
      ).toBe(true);
      // …and still works for the sentence it was actually minted for.
      expect(receiptWins(
        { ok: true, message: RECEIPT, artifactId: 'item-b04', verifiedProse: token }, HONEST,
      )).toBe(false);
    });

    it('mutating the RECEIPT after minting fails closed', () => {
      // The applied values are rendered into the receipt string, so a changed
      // receipt is a changed outcome.
      const token = mint(HONEST);
      expect(receiptWins(
        { ok: true, message: 'Updated "the item": priority=critical.', artifactId: 'item-b04', verifiedProse: token },
        HONEST,
      )).toBe(true);
    });

    it('mutating the ARTIFACT after minting fails closed', () => {
      const token = mint(HONEST);
      expect(receiptWins(
        { ok: true, message: RECEIPT, artifactId: 'a-different-item', verifiedProse: token },
        HONEST,
      )).toBe(true);
    });

    it('a whitespace-level change to the prose fails closed', () => {
      // Exact-string binding, deliberately. Anything looser invites the replay
      // back in through paraphrase.
      const token = mint(HONEST);
      expect(receiptWins(
        { ok: true, message: RECEIPT, artifactId: 'item-b04', verifiedProse: token }, HONEST + ' ',
      )).toBe(true);
    });

    it('the binding survives the real compose → renderer path', () => {
      // Guards against the binding being technically correct and practically
      // unusable: if the renderer compared the stripped body against a token
      // minted on the raw answer, every markdown answer would silently revert
      // to the receipt.
      const prose = "Got it. I've set the priority to high. **Any deadline?**";
      return composeThenRender(prose, { priority: 'high' }).then((body) => {
        expect(body).toBe('Got it. I\'ve set the priority to high. *Any deadline?*');
      });
    });
  });

  describe('the verifier, directly', () => {
    it('refuses when a requested field was dropped', () => {
      expect(verifyUpdateProse("I've set the priority.", { ...OUTCOME, requestedButNotApplied: ['priority'] }))
        .toBeNull();
    });

    it('accepts the model\'s vocabulary for the same level', () => {
      // "urgent" is what a person says; the server stores "critical". Punishing
      // vocabulary would send honest prose to the receipt for no reason.
      expect(verifyUpdateProse("I've marked it urgent for you.", { ...OUTCOME, appliedPriority: 'critical' }))
        .not.toBeNull();
      expect(verifyUpdateProse("I've marked it normal for you.", { ...OUTCOME, appliedPriority: 'medium' }))
        .not.toBeNull();
    });

    it('still refuses a genuinely different level', () => {
      expect(verifyUpdateProse("I've marked it low for you.", { ...OUTCOME, appliedPriority: 'high' }))
        .toBeNull();
    });

    it('refuses a priority claim when no priority was written', () => {
      expect(verifyUpdateProse("I've set it to high.", { ...OUTCOME, appliedPriority: null }))
        .toBeNull();
    });

    it('allows a deadline claim when a due date WAS written', () => {
      expect(verifyUpdateProse("I've set the deadline to Friday.", { ...OUTCOME, appliedDueDate: true, appliedPriority: null }))
        .not.toBeNull();
    });

    it('is not confused by apostrophes — the bug this file found', () => {
      // With `'` in the quoted-title class, "I've … It's" parsed as a quoted
      // title and every contraction went to the receipt. Item titles here
      // contain apostrophes too, so this had to be right.
      const prose = "Got it. I've set the priority to high. It's still missing a due date if you have one.";
      expect(verifyUpdateProse(prose, OUTCOME)).not.toBeNull();
    });
  });
});
