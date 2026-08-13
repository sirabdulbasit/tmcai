/**
 * DEF-159 — one resolved identity, used by routing AND by what the owner reads.
 *
 * Sixth recurrence of the `@lid` class (chart §3). It arrived as: the routing knew
 * who she was and the message to the owner named somebody else.
 *
 * ── WHAT ITERATION 16 FIXED, AND WHAT IT LEFT ───────────────────────────────
 *
 * DEF-075 fixed *routing*: a synthetic `'+' + lid` resolves through a stored
 * LID↔contact alias. The owner-facing notice never used that binding — it took
 * `fromIdentifier`'s last nine digits and substring-matched them against
 * `entity.phone`. For a synthetic identifier those digits are not a phone number,
 * so any saved number containing that run wins and the owner is told, in plain
 * confident prose, that a person he knows wrote words they never wrote.
 *
 * Iteration 16 removed that lookup. It did NOT remove the shape: routing resolved
 * identity in one function and the notice resolved it again in another, so the two
 * could still disagree. Codex's iteration-16 review found three ways they do, and
 * **one was a regression iteration 16 introduced** — a first-time LID whose upstream
 * mapping SUCCEEDED was reported as an unsaved contact, because the kind-check
 * refused to look at the real phone sitting in `fromIdentifier`.
 *
 * `protection-with-two-implementations` has eight recorded occurrences here. Making
 * both copies agree is not the fix; having one copy is. So `resolveSenderIdentity`
 * returns a `SenderIdentity`, `captureDelegationReply` resolves it once, and
 * `notifyOwnerOfUnattachedReply` takes it as an ARGUMENT — it cannot re-derive what
 * it is not allowed to look up.
 *
 * ── WHY THE END-TO-END CASES CARRY THE WEIGHT ───────────────────────────────
 *
 * Five turns running, the correction came from Codex in the same shape: a falsifier
 * written about a path that was never exercised. A test on the resolver alone would
 * pass on a build where routing and display disagree, because disagreement is a
 * property of the two callers, not of either function. Every divergence case below
 * therefore goes through the real `captureDelegationReply` and asserts on the text
 * handed to `enqueueBrainPrompt`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Hamna, with the alias DEF-075 bound. The steady state after a first reply. */
const HAMNA = {
  id: 'ent-hamna', name: 'Hamna Latif Bhutta', phone: '+923134199294',
  clientNumber: 'TMC-0001', entityType: 'contact',
  metadata: { waLid: '255043747987458@lid' },
};

/**
 * The collision. An ordinary saved mobile whose digits happen to contain
 * `747987458`, the last nine of the LID — so the old substring match returned HIM
 * for HER messages.
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
/** Codex HIGH #2: the alias write is best-effort. This makes it fail. */
let entityUpdateFails = false;
let storeBroken = false;

vi.mock('../src/db/prisma', () => {
  const boom = () => Promise.reject(new Error('database unavailable'));
  const project = (hit: any, select: any) =>
    select ? Object.fromEntries(Object.keys(select).map((k) => [k, hit[k]])) : hit;

  const entity = {
    findFirst: async ({ where, select }: any) => {
      if (storeBroken) return boom();
      const hit = entities.find((e) => {
        if (where.clientNumber && e.clientNumber !== where.clientNumber) return false;
        if (where.entityType && e.entityType !== where.entityType) return false;
        if (where.metadata) {
          const [key] = where.metadata.path;           // { path: ['waLid'], equals }
          if ((e.metadata ?? {})[key] !== where.metadata.equals) return false;
        }
        if (where.phone?.contains && !String(e.phone ?? '').includes(where.phone.contains)) return false;
        if (where.email?.equals
            && String(e.email ?? '').toLowerCase() !== String(where.email.equals).toLowerCase()) return false;
        return true;
      });
      return hit ? project(hit, select) : null;
    },
    update: async ({ where, data }: any) => {
      if (entityUpdateFails) return boom();
      const row = entities.find((e) => e.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
  };

  const delegationThread = {
    findMany: async ({ where }: any) => {
      if (storeBroken) return boom();
      return threads.filter((t) => {
        if (t.clientNumber !== where.clientNumber) return false;
        // Correlation asks by counterpartKey; the DEF-075 bootstrap asks for any
        // recent thread with a canonical counterpart and no key filter at all.
        if (where.counterpartKey) return t.counterpartKey === where.counterpartKey;
        if (where.counterpartNumberCanonical) return t.counterpartNumberCanonical != null;
        return true;
      });
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
  // The DEF-064 condition under test: her threads are active but none can take a
  // reply, which is what routes this inbound to the owner notice.
  canConsumeReply: () => false,
  appendEventWithTransition: async () => ({ ok: true }),
}));

// The bootstrap window is behaviour-configured; injected so the test does not
// depend on config lookups (D-8's standing rule about clock/config in tests).
vi.mock('../src/services/behaviorConfig', () => ({
  __esModule: true, getBehaviorValue: async () => 6,
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
  resolveSenderIdentity, captureDelegationReply,
} from '../src/services/delegation/delegationCaptureService';

const LID = '255043747987458@lid';
/** What WebjsProvider hands us when the mapping API is down: '+' + the LID. */
const SYNTHETIC = '+255043747987458';

/** A thread of hers that is active but cannot consume a reply. */
const closedThread = (counterpartKey: string) => ({
  id: 'thr-1', clientNumber: 'TMC-0001', counterpartKey,
  counterpartNumberCanonical: counterpartKey.replace('wa:', ''),
  state: 'awaiting_owner', ownerUserId: 2, openItemId: 'oi-1',
  activeIntentEventId: 'evt-1', updatedAt: new Date(),
});

/** The one question every case here asks: what did the owner end up reading? */
const noticeText = () => String(enqueued[0]?.question ?? '');

beforeEach(() => {
  entities = [structuredClone(HAMNA), structuredClone(COLLIDER), structuredClone(OTHER_TENANT)];
  threads = [];
  enqueued.length = 0;
  entityUpdateFails = false;
  storeBroken = false;
});

describe('DEF-159 — routing and display cannot disagree, because there is one answer', () => {
  describe('resolution, by how we came to know', () => {
    it('a stored alias is exact, and reports itself as such', async () => {
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(id.source).toBe('stored_alias');
      expect(id.display).toBe('Hamna Latif Bhutta');
      // Routing keys off her REAL number, not the synthetic one.
      expect(id.counterpartKey).toBe('wa:+923134199294');
      expect(id.bindingDurable).toBe(true);
    });

    it('honours a real phone the provider DID map, alias or not', async () => {
      // Codex iteration-16 HIGH #1, and a regression iteration 16 introduced.
      // Upstream resolved the LID to Hamna's real number; nothing is bound yet.
      // Refusing to look at what we were given is not failing closed, it is
      // failing blind.
      entities = [structuredClone(HAMNA), structuredClone(COLLIDER)];
      delete (entities[0] as any).metadata.waLid;

      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: '+923134199294', rawSenderId: LID,
      });
      expect(id.source).toBe('upstream_phone');
      expect(id.display).toBe('Hamna Latif Bhutta');
      expect(id.counterpartKey).toBe('wa:+923134199294');
    });

    it('never lets a LID\'s digits reach a phone comparison', async () => {
      // The original defect. With no alias and no upstream mapping, the only
      // thing left is the coincidence — and it must not be taken.
      entities = [structuredClone(COLLIDER)];
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(id.display, 'a substring collision must never become a name').not.toContain('Imran');
      expect(id.source).toBe('unknown');
    });

    it('fails closed on an unknown LID without dressing it as a phone number', async () => {
      entities = [];
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(id.source).toBe('unknown');
      expect(id.display).toContain('unsaved');
      // `+255043747987458` reads as a number he could ring. The bare id, labelled
      // as an id, still tells two unknown senders apart.
      expect(id.display, 'a synthetic number must not look like a phone').not.toContain('+');
      expect(id.display).toContain('255043747987458');
      // The KEY is still the synthetic token — opaque, and dropping it would
      // silently discard the reply (invariant #6). Routing may use something it
      // cannot explain; the owner is never shown a name we do not have.
      expect(id.counterpartKey).toBe(`wa:${SYNTHETIC}`);
    });

    it('does not read a binding from another tenant', async () => {
      entities = [structuredClone(OTHER_TENANT)];
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(id.display).not.toContain('Another Company');
      expect(id.source).toBe('unknown');
    });

    it('still resolves an ordinary phone as a phone', async () => {
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: '+923134199294', rawSenderId: null,
      });
      expect(id).toMatchObject({
        kind: 'phone', source: 'upstream_phone', display: 'Hamna Latif Bhutta',
      });
    });

    it('shows an unknown REAL number as itself — that one is honest', async () => {
      entities = [];
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: '+923001112223', rawSenderId: null,
      });
      expect(id.display).toBe('+923001112223');
      expect(id.source).toBe('unknown');
    });

    it('never throws when the store is down', async () => {
      storeBroken = true;
      await expect(resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
      })).resolves.toMatchObject({ source: 'unknown' });
    });
  });

  describe('DEF-164 — an email address is not a phone number', () => {
    // Codex iteration-17 HIGH #1. Every non-LID identifier went to
    // `contactByPhone`, so an address containing a digit run was matched as a
    // nine-digit phone fragment: routing keys off the address while display
    // names an unrelated contact. The same coincidence DEF-159 removed from
    // LIDs, on a different channel.
    const DIGITY = 'accounts2026123456789@example.com';

    it('never names a contact whose PHONE contains digits from the address', async () => {
      entities = [{
        id: 'ent-collide', name: 'Imran Sheikh', phone: '+923002026123456789',
        clientNumber: 'TMC-0001', entityType: 'contact', metadata: {},
      }];
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'email',
        fromIdentifier: DIGITY, rawSenderId: null,
      });
      expect(id.kind).toBe('email');
      expect(id.display, 'an address digit-run must never become a name').not.toContain('Imran');
      expect(id.display).toBe(DIGITY);
      expect(id.source).toBe('unknown');
      expect(id.phone, 'and no second identity is attached').toBeNull();
    });

    it('resolves an email sender by ADDRESS when we have them', async () => {
      entities = [{
        id: 'ent-vendor', name: 'Latif Traders', phone: null,
        email: 'accounts2026123456789@example.com',
        clientNumber: 'TMC-0001', entityType: 'contact', metadata: {},
      }];
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'email',
        fromIdentifier: DIGITY, rawSenderId: null,
      });
      expect(id).toMatchObject({ kind: 'email', source: 'upstream_email', display: 'Latif Traders' });
    });

    it('does not read an email contact from another tenant', async () => {
      entities = [{
        id: 'ent-other-t', name: 'Another Company Person', phone: null,
        email: DIGITY, clientNumber: 'TMC-0002', entityType: 'contact', metadata: {},
      }];
      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'email',
        fromIdentifier: DIGITY, rawSenderId: null,
      });
      expect(id.display).toBe(DIGITY);
      expect(id.source).toBe('unknown');
    });
  });

  describe('the two answers, through the real capture path', () => {
    it('tells the owner it was HER, not the contact her LID collides with', async () => {
      threads = [closedThread('wa:+923134199294')];
      const res = await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
        body: 'Yes, the payment went out this morning.',
        sourceId: 'wamid.HER1',
      });

      expect(res.outcome, 'the DEF-064 relay is the path under test').toBe('consumed');
      expect(enqueued.length, 'the owner was told nothing at all').toBe(1);
      expect(noticeText()).toContain('Hamna Latif Bhutta');
      expect(noticeText(), 'the notice named the wrong person').not.toContain('Imran');
      expect(noticeText(), 'and never the synthetic number').not.toContain('255043747987458');
      // Her words are relayed verbatim (DEF-140); a name fix must not touch them.
      expect(noticeText()).toContain('the payment went out this morning');
    });

    it('a mapped real phone reaches the owner as a NAME, not "unsaved"', async () => {
      // Codex HIGH #1 end-to-end: routing correlated her correctly off the mapped
      // number while the notice called her an unsaved contact.
      entities = [structuredClone(HAMNA)];
      delete (entities[0] as any).metadata.waLid;
      threads = [closedThread('wa:+923134199294')];

      await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: '+923134199294', rawSenderId: LID,
        body: 'Sending it now',
        sourceId: 'wamid.MAPPED',
      });

      expect(enqueued.length).toBe(1);
      expect(noticeText()).toContain('Hamna Latif Bhutta');
      expect(noticeText(), 'a name we HAD was thrown away').not.toContain('unsaved');
    });

    it('a failed alias write does not produce two answers', async () => {
      // Codex HIGH #2. Bootstrap infers her from the single recent thread, the
      // `entity.update` that would make it permanent fails, and routing attaches
      // the reply to her thread regardless. The notice must say what routing did.
      entities = [structuredClone(HAMNA)];
      delete (entities[0] as any).metadata.waLid;
      threads = [closedThread('wa:+923134199294')];
      entityUpdateFails = true;

      const id = await resolveSenderIdentity({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
      });
      expect(id.source).toBe('bootstrap');
      expect(id.counterpartKey, 'routing still commits to her').toBe('wa:+923134199294');
      expect(id.bindingDurable, 'and records that it will have to infer again').toBe(false);

      await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
        body: 'Hlo',
        sourceId: 'wamid.BOOT',
      });
      expect(enqueued.length).toBe(1);
      expect(noticeText(), 'display must not re-read the alias that was never written')
        .toContain('Hamna Latif Bhutta');
      expect(noticeText()).not.toContain('unsaved');
    });

    it('a saved contact with no name is identified by its number, not called unsaved', async () => {
      // Codex MEDIUM #3: routing accepted `known.phone` while display required
      // `known.name`, so a nameless-but-saved contact routed correctly and was
      // reported as a stranger. One display policy: name, else number, else label.
      entities = [{
        id: 'ent-noname', name: null, phone: '+923134199294',
        clientNumber: 'TMC-0001', entityType: 'contact', metadata: { waLid: LID },
      }];
      threads = [closedThread('wa:+923134199294')];

      await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
        body: 'ok',
        sourceId: 'wamid.NONAME',
      });

      expect(enqueued.length).toBe(1);
      expect(noticeText()).toContain('+923134199294');
      expect(noticeText(), 'we know exactly who this is').not.toContain('unsaved');
    });

    it('the exact LID from owner report R-2', async () => {
      // From the owner's transcript, 13/08/2026 09:08:33:
      //
      //   Nexeo: +239487846228094 replied: "Is dafa passy nhi bjy apny"
      //   (Not attached to an open request …)
      //
      // and at 09:10:33 in the SAME transcript:
      //
      //   Nexeo: Hamna Latif Bhutta replied about "Vision Metric's …"
      //
      // Two minutes apart, one a name and the other a provider id wearing a `+`.
      // That is the two-answers defect as he saw it: *"i don't know who is sending
      // message (although sender number and his name is saved in my contacts)"*.
      const REPORTED = '239487846228094@lid';
      entities = [{
        id: 'ent-r2', name: 'Arslan Tariq', phone: '+923214455667',
        clientNumber: 'TMC-0001', entityType: 'contact', metadata: { waLid: REPORTED },
      }];
      threads = [closedThread('wa:+923214455667')];

      await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: '+239487846228094', rawSenderId: REPORTED,
        body: 'Is dafa passy nhi bjy apny',
        sourceId: 'wamid.R2',
      });

      expect(enqueued.length).toBe(1);
      expect(noticeText(), 'the saved contact he means').toContain('Arslan Tariq');
      expect(noticeText()).not.toContain('239487846228094');
    });

    it('says "unsaved contact" rather than a wrong name when we truly do not know', async () => {
      // The collider is still sitting there, ready to be picked, and must not be.
      // No thread of hers exists on the synthetic key either, so this also pins
      // that an unresolved LID does not get keyed and silently correlated.
      entities = [structuredClone(COLLIDER)];
      threads = [closedThread(`wa:${SYNTHETIC}`)];

      const res = await captureDelegationReply({
        clientNumber: 'TMC-0001', channel: 'whatsapp',
        fromIdentifier: SYNTHETIC, rawSenderId: LID,
        body: 'Assalam o alaikum',
        sourceId: 'wamid.UNKNOWN1',
      });

      // The reply is NOT dropped — it correlates on the synthetic token and the
      // owner still hears about it. He is simply not told a name.
      expect(res.outcome).toBe('consumed');
      expect(enqueued.length).toBe(1);
      expect(noticeText()).toContain('unsaved');
      expect(noticeText(), 'the collider was sitting right there').not.toContain('Imran');
      // And no alias was persisted off the collision, which is the durable harm.
      expect((entities[0] as any).metadata.waLid, 'a wrong bind is permanent').toBeUndefined();
    });
  });
});
