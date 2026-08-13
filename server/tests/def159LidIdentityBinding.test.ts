/**
 * DEF-159 — the routing knew who she was; the message to the owner named
 * somebody else.
 *
 * Sixth recurrence of the `@lid` class (chart §3), and the first where the
 * damage is not a lost message but a WRONG NAME on a real person's words.
 *
 * DEF-075 fixed *routing*: a synthetic `'+' + lid` is resolved through a stored
 * LID↔contact alias, so Hamna's reply reaches Hamna's thread. But
 * `notifyOwnerOfUnattachedReply` answered "who is this?" a SECOND way — it took
 * `fromIdentifier`'s last nine digits and matched them against `entity.phone`:
 *
 *     const digits = input.fromIdentifier.replace(/[^0-9]/g, '').slice(-9);
 *     …  phone: { contains: digits }  …
 *     who = contact?.name ?? input.fromIdentifier;
 *
 * For a synthetic identifier those digits are not a phone number. They are the
 * tail of a 15-digit provider id, compared as a SUBSTRING against every contact
 * in the tenant. `255043747987458` ends `747987458`; any saved number containing
 * that run matches. The owner is then told, in plain confident prose, that a
 * person he knows wrote something they never wrote.
 *
 * That is worse than the unknown-sender case it was meant to improve, and it is
 * invariant #5 territory: a name we inferred from a coincidence, presented as
 * fact. The unresolved branch was no better — it printed the synthetic
 * `+255043747987458`, which reads as a phone number the owner could ring.
 *
 * ── THE FIX, AND WHY IT IS NOT A SEVENTH FALLBACK ───────────────────────────
 *
 * The chart's containment note on this tag is explicit that *"the next change
 * must remove the dependency, not repair it"*. So the change removes an ANSWER,
 * not adds one: `resolveSenderDisplayName` is the single resolver, both
 * producers use it, and it branches on identifier KIND rather than on fallback
 * order — a LID is only ever resolved through the alias binding, and its digits
 * are never offered to a phone comparison. Unresolved fails closed.
 *
 * The end-to-end case below is the one that matters. It is not a hypothetical:
 * routing resolves the alias correctly and the notice still named the wrong
 * contact, because the two lookups never agreed on what the identifier was.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Hamna's real record, carrying the LID alias DEF-075 bound. */
const HAMNA = {
  id: 'ent-hamna', name: 'Hamna Latif Bhutta', phone: '+923134199294',
  clientNumber: 'TMC-0001', entityType: 'contact',
  metadata: { waLid: '255043747987458@lid' },
};

/**
 * The collision. Nothing about this contact is unusual — a saved Pakistani
 * mobile. Its digits merely happen to contain `747987458`, the last nine of the
 * LID, so the old substring match returned HIM for HER messages.
 */
const COLLIDER = {
  id: 'ent-imran', name: 'Imran Sheikh', phone: '+92300747987458',
  clientNumber: 'TMC-0001', entityType: 'contact', metadata: {},
};

/** Same LID, different tenant. Invariant #1. */
const OTHER_TENANT = {
  id: 'ent-other', name: 'Someone Else At Another Company', phone: '+923009999999',
  clientNumber: 'TMC-0002', entityType: 'contact',
  metadata: { waLid: '255043747987458@lid' },
};

let entities: any[] = [];
let threads: any[] = [];
/** Set to make every prisma read reject, for the never-throws case. */
let storeBroken = false;

vi.mock('../src/db/prisma', () => {
  const boom = () => Promise.reject(new Error('database unavailable'));

  const entity = {
    findFirst: async ({ where, select }: any) => {
      if (storeBroken) return boom();
      const hit = entities.find((e) => {
        if (where.clientNumber && e.clientNumber !== where.clientNumber) return false;
        if (where.entityType && e.entityType !== where.entityType) return false;
        if (where.metadata) {
          // `metadata: { path: ['waLid'], equals: <lid> }`
          const [key] = where.metadata.path;
          if ((e.metadata ?? {})[key] !== where.metadata.equals) return false;
        }
        if (where.phone?.contains) {
          if (!String(e.phone ?? '').includes(where.phone.contains)) return false;
        }
        return true;
      });
      if (!hit) return null;
      if (!select) return hit;
      return Object.fromEntries(Object.keys(select).map((k) => [k, (hit as any)[k]]));
    },
  };

  const delegationThread = {
    findMany: async ({ where }: any) => {
      if (storeBroken) return boom();
      return threads.filter((t) =>
        t.clientNumber === where.clientNumber && t.counterpartKey === where.counterpartKey);
    },
    findFirst: async () => null,
  };

  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    upsert: async () => ({}), count: async () => 0, deleteMany: async () => ({ count: 0 }),
  };

  const p: any = new Proxy(
    { entity, delegationThread, $queryRaw: async () => [] },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/delegation/delegationThreadService', () => ({
  __esModule: true,
  ACTIVE_THREAD_STATES: ['awaiting_owner', 'dispatched', 'reopened'],
  isDelegationCaptureEnabled: async () => true,
  counterpartKeyFor: (_ch: string, dest: unknown) => (dest ? `wa:${String(dest)}` : null),
  // The DEF-064 condition under test: her threads are active but none can take
  // a reply, which is exactly what routes this inbound to the owner notice.
  canConsumeReply: () => false,
  appendEventWithTransition: async () => ({ ok: true }),
}));

vi.mock('../src/services/selfheal/healthFindingService', () => ({
  __esModule: true, recordFinding: async () => 'finding-1',
}));

/** What the owner actually receives. */
const enqueued: any[] = [];
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  __esModule: true,
  enqueueBrainPrompt: async (p: any) => { enqueued.push(p); return { id: 'q1' }; },
}));

import {
  resolveSenderDisplayName, captureDelegationReply,
} from '../src/services/delegation/delegationCaptureService';

const LID = '255043747987458@lid';
/** What WebjsProvider hands us when the mapping API is down: '+' + the LID. */
const SYNTHETIC = '+255043747987458';

beforeEach(() => {
  entities = [HAMNA, COLLIDER, OTHER_TENANT];
  threads = [];
  enqueued.length = 0;
  storeBroken = false;
});

describe('DEF-159 — one answer to "who is this?", and it is the bound one', () => {
  describe('the resolver', () => {
    it('names the contact the LID is BOUND to', async () => {
      const r = await resolveSenderDisplayName({
        clientNumber: 'TMC-0001', fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(r).toEqual({ who: 'Hamna Latif Bhutta', resolved: true });
    });

    it('never names a contact whose PHONE merely contains the LID digits', async () => {
      // The defect, isolated. Remove the alias and the old code had nothing left
      // but the coincidence — and it took it, confidently.
      entities = [COLLIDER];
      const r = await resolveSenderDisplayName({
        clientNumber: 'TMC-0001', fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(r.who, 'a substring collision must never become a name').not.toContain('Imran');
      expect(r.resolved).toBe(false);
    });

    it('fails closed on an unknown LID, and does not dress it as a phone number', async () => {
      entities = [];
      const { who, resolved } = await resolveSenderDisplayName({
        clientNumber: 'TMC-0001', fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(resolved).toBe(false);
      expect(who).toContain('unsaved');
      // `+255043747987458` is the thing to avoid: it reads as a number he could
      // ring. The bare id, labelled as an id, still lets him tell two unknown
      // senders apart.
      expect(who, 'a synthetic number must not be presented as a phone').not.toContain('+');
      expect(who).toContain('255043747987458');
    });

    it('does not read a binding from another tenant', async () => {
      entities = [OTHER_TENANT];
      const r = await resolveSenderDisplayName({
        clientNumber: 'TMC-0001', fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(r.who).not.toContain('Another Company');
      expect(r.resolved).toBe(false);
    });

    it('still resolves an ordinary phone by phone', async () => {
      // The kind check must not cost us the case that always worked.
      const r = await resolveSenderDisplayName({
        clientNumber: 'TMC-0001', fromIdentifier: '+923134199294', rawSenderId: null,
      });
      expect(r).toEqual({ who: 'Hamna Latif Bhutta', resolved: true });
    });

    it('shows an unknown REAL number as itself — that one is honest', async () => {
      entities = [];
      const r = await resolveSenderDisplayName({
        clientNumber: 'TMC-0001', fromIdentifier: '+923001112223', rawSenderId: null,
      });
      expect(r).toEqual({ who: '+923001112223', resolved: false });
    });

    it('never throws when the store is down', async () => {
      // It runs before the try/catch in the notifier, so a throw here would take
      // out the retention path DEF-158 added.
      storeBroken = true;
      await expect(resolveSenderDisplayName({
        clientNumber: 'TMC-0001', fromIdentifier: SYNTHETIC, rawSenderId: LID,
      })).resolves.toEqual({
        who: expect.stringContaining('unsaved'), resolved: false,
      });
    });
  });

  describe('end to end: the reported path', () => {
    beforeEach(() => {
      // Her thread, correctly keyed to her REAL number — DEF-075's alias did its
      // job — but in a state that cannot consume a reply.
      threads = [{
        id: 'thr-1', clientNumber: 'TMC-0001', counterpartKey: 'wa:+923134199294',
        state: 'awaiting_owner', ownerUserId: 2, openItemId: 'oi-1',
        activeIntentEventId: 'evt-1', updatedAt: new Date(),
      }];
    });

    it('tells the owner it was HER, not the contact her LID collides with', async () => {
      const res = await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
        body: 'Yes, the payment went out this morning.',
        sourceId: 'wamid.HER1',
      });

      expect(res.outcome, 'the DEF-064 relay is the path under test').toBe('consumed');
      expect(enqueued.length, 'the owner was told nothing at all').toBe(1);

      const notice = enqueued[0].question as string;
      expect(notice).toContain('Hamna Latif Bhutta');
      // This is the assertion the old code fails. Routing already knew it was
      // Hamna; the notice said Imran, because the second lookup asked a
      // different question about the same identifier.
      expect(notice, 'the notice named the wrong person').not.toContain('Imran');
      expect(notice, 'and never the synthetic number').not.toContain('255043747987458');
      // Her words are relayed verbatim (DEF-140) — the name fix must not touch them.
      expect(notice).toContain('the payment went out this morning');
    });

    it('the exact LID from owner report R-2', async () => {
      // From the owner's transcript, 13/08/2026 09:08:33:
      //
      //   Nexeo: +239487846228094 replied: "Is dafa passy nhi bjy apny"
      //   (Not attached to an open request …)
      //
      // and, at 09:10:33 in the SAME transcript:
      //
      //   Nexeo: Hamna Latif Bhutta replied about "Vision Metric's …"
      //
      // Two minutes apart, one of them a name and the other a provider id
      // wearing a `+`. That is the two-answers defect as the owner saw it:
      // *"i don't know who is sending message (although sender number and his
      // name is saved in my contacts)"*.
      const REPORTED = '239487846228094@lid';
      entities = [{
        id: 'ent-r2', name: 'Arslan Tariq', phone: '+923214455667',
        clientNumber: 'TMC-0001', entityType: 'contact',
        metadata: { waLid: REPORTED },
      }];
      threads[0].counterpartKey = 'wa:+923214455667';

      await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: '+239487846228094', rawSenderId: REPORTED,
        body: 'Is dafa passy nhi bjy apny',
        sourceId: 'wamid.R2',
      });

      expect(enqueued.length).toBe(1);
      expect(enqueued[0].question, 'the saved contact he means').toContain('Arslan Tariq');
      expect(enqueued[0].question).not.toContain('239487846228094');
    });

    it('says "unsaved contact" rather than a wrong name when nothing is bound', async () => {
      // Same inbound, no alias. The honest outcome is that we do not know, and
      // the collider is still sitting there ready to be picked.
      entities = [COLLIDER];
      threads[0].counterpartKey = `wa:${SYNTHETIC}`;

      await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
        body: 'Assalam o alaikum',
        sourceId: 'wamid.UNKNOWN1',
      });

      expect(enqueued.length).toBe(1);
      expect(enqueued[0].question).not.toContain('Imran');
      expect(enqueued[0].question).toContain('unsaved');
    });
  });
});
