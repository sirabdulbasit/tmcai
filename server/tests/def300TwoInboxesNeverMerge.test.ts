/**
 * DEF-300 / DEF-302 — the two WhatsApp populations, told apart, and Brain no longer counted as
 * one of the people who messaged him.
 *
 * He asked for this twice in one hour, in his own words:
 *
 *   "The way i am communicating you people are also doing communication with you, u should know
 *    what they are talking to you and what u talk to me. Secondly u may have access of my
 *    WhatsApp to read it, dont confused with it"
 *
 *   "So the message u read from that whatsapp should not be messup with those message you
 *    received directly on your number"
 *
 * Brain answered "Noted: … distinguish them from our conversations" both times — a preference
 * recorded where a fact was needed, which is why he had to repeat it. His ruling on how to build
 * it (2026-09-03) was: stamp the provenance and render two labelled sections.
 *
 * DEF-302 came out of the same work and is the more serious half. Measured over all 876
 * `source_type='whatsapp'` feed_events: NOT ONE carries a `fromMe` key, so the query's
 * `COALESCE(…, FALSE)` defaulted every row to inbound; 149 rows carry Brain's OWN connected
 * number as the sender and 75 carry the sender name "Nexeo". Asked who had messaged him, Brain
 * could name itself — DEF-287's shape (its own voice returning through a connector) on the
 * WhatsApp path, and the likely source of CL-050's wrong name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRawUnsafe = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: (...a: unknown[]) => queryRawUnsafe(...a) },
}));
vi.mock('../src/services/knowledge/systemCapabilitiesService', () => ({
  getSystemCapabilities: () => Promise.resolve({ waIdentity: { brainNumber: '+923274572102' } }),
  renderCapabilitiesBlock: () => '',
}));
// DEF-305 moved the "sent to my number" data out of `brain_user_messages` and into Brain's own
// inbox, so it is stubbed at the service rather than by matching SQL.
const inboxRows = { current: [] as any[] };
vi.mock('../src/services/whatsapp/brainInboxService', () => ({
  recentInboxForContext: () => Promise.resolve(inboxRows.current),
}));

import { buildRecentWhatsAppBlock } from '../src/services/knowledge/brainComposer';

/** The block issues its reads in a fixed order; answer them by SQL shape, not position. */
function stub(opts: {
  personalStatus?: string;
  feedRows?: any[];
  latest?: Date | null;
  relays?: any[];
} = {}) {
  queryRawUnsafe.mockReset();
  queryRawUnsafe.mockImplementation((sql: string) => {
    if (sql.includes("ct.slug = 'whatsapp_personal'")) {
      return Promise.resolve([{ status: opts.personalStatus ?? 'disconnected', error_message: null, metadata: {} }]);
    }
    if (sql.includes('max(created_at)')) return Promise.resolve([{ latest: opts.latest ?? null }]);
    if (sql.includes("source_type = 'whatsapp'")) return Promise.resolve(opts.feedRows ?? []);
    return Promise.resolve([]);
  });
  inboxRows.current = opts.relays ?? [];
}

describe('DEF-300 — provenance is stamped on both populations', () => {
  beforeEach(() => stub());

  it('labels the feed block as READ FROM his own WhatsApp, not as messages he received', async () => {
    // The old header was "Recent WhatsApp messages", which reads as "messages you received"
    // while the rows underneath are his own conversations. That ambiguity IS the defect.
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain("READ FROM the user's own WhatsApp");
    expect(block).toContain('NOT sent to me');
  });

  it('labels the relay block as sent TO Brain\'s own number', async () => {
    stub({ relays: [{ receivedAt: new Date(), senderName: null, senderPhone: null, body: 'hi', decision: 'withheld_not_substantive', notifyReason: 'chit-chat', relevantUserId: 2 }] });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain('sent TO MY OWN number');
    expect(block).toContain('DIFFERENT population');
  });

  it('tells the model which question each population answers', async () => {
    // Whitespace collapsed: the header hard-wraps, so a phrase can span a newline. Matching on
    // the wrapped form would make this test about line width rather than about the rule.
    const block = (await buildRecentWhatsAppBlock('TMC-0001', 2)).replace(/\s+/g, ' ');
    expect(block).toMatch(/who messaged HIM, these count/);
    expect(block).toMatch(/who messaged ME, they do not/);
  });

  it('never merges them into one section', async () => {
    stub({
      feedRows: [{ sender_phone: '+923028000553', sender_name: 'Muhammad Yousaf', raw_payload: { body: 'salam' }, created_at: new Date() }],
      relays: [{ receivedAt: new Date(), senderName: 'Yousaf', senderPhone: '+923028000553', body: 'hello', decision: 'notified', notifyReason: 'asked about a live item', relevantUserId: 2 }],
    });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    const a = block.indexOf("READ FROM the user's own WhatsApp");
    const b = block.indexOf('sent TO MY OWN number');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });
});

describe('DEF-300 — an empty block says WHY it is empty', () => {
  it('names the newest message it has ever read, so silence is not read as "no messages"', async () => {
    // DEF-019's lesson: a status is READ, never inferred from absence. "No messages in the last
    // 24 hours" is true of the store and misleading about the world when the connector is not
    // reading at all.
    stub({ latest: new Date('2026-08-07T13:12:18Z') });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain('2026-08-07');
    expect(block).toMatch(/not\s+reading his WhatsApp right now/);
  });

  it('says so plainly when it has never read anything', async () => {
    stub({ latest: null });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain('never read any message from his personal WhatsApp');
  });
});

describe('DEF-300 — the reading claim matches the connector status', () => {
  it('does not claim to be reading his WhatsApp while the connector is disconnected', async () => {
    // My own first version of this header asserted "connected for reading" unconditionally,
    // reintroducing the exact `fabricated-status` over-claim DEF-299 had just avoided one block
    // away. Found by rendering the block and reading it.
    stub({ personalStatus: 'disconnected' });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain('it is currently disconnected');
    expect(block).not.toContain('is connected for reading');
  });

  it('does claim it when the connector really is connected', async () => {
    stub({ personalStatus: 'connected' });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain('is connected for reading');
  });
});

describe('DEF-302 — Brain is not one of the people who messaged him', () => {
  it('excludes its own number at the query, by number rather than display name', async () => {
    stub();
    await buildRecentWhatsAppBlock('TMC-0001', 2);
    const call = queryRawUnsafe.mock.calls.find((c) => String(c[0]).includes("source_type = 'whatsapp'"))!;
    // The exclusion is a bound parameter carrying Brain's own number, compared digits-only.
    expect(String(call[0])).toContain("regexp_replace(COALESCE(sender_phone,'')");
    expect(call).toContain('+923274572102');
    // Identity, not display name: a real person could be called Nexeo.
    expect(String(call[0])).not.toContain("'Nexeo'");
  });

  it('passes an empty exclusion rather than dropping the filter when the number is unknown', async () => {
    // Fails OPEN on purpose here: with no known number there is nothing to exclude, and
    // suppressing every row would hide real messages to fix a bug about Brain's own.
    const { buildRecentWhatsAppBlock: build } = await import('../src/services/knowledge/brainComposer');
    stub();
    await build('TMC-0001', 2);
    const call = queryRawUnsafe.mock.calls.find((c) => String(c[0]).includes("source_type = 'whatsapp'"))!;
    expect(String(call[0])).toContain("$4 = ''");
  });
});

describe('DEF-305/DEF-295 — the sender count is never a false zero', () => {
  it('counts distinct senders from the raw id, which every row has', async () => {
    // Rendered against real backfilled data this said "17 messages from 0 distinct senders",
    // because the count came from name-or-phone and a backfilled row has neither. A false zero
    // is worse than no count, and DEF-295 is the row about exactly this: state how many PEOPLE
    // rather than leaving the model to infer it from the message count.
    stub({
      relays: [
        { receivedAt: new Date(), rawSenderId: 'a@lid', senderName: null, senderPhone: null, body: 'one', decision: 'notified', notifyReason: null, relevantUserId: 2 },
        { receivedAt: new Date(), rawSenderId: 'a@lid', senderName: null, senderPhone: null, body: 'two', decision: 'notified', notifyReason: null, relevantUserId: 2 },
        { receivedAt: new Date(), rawSenderId: 'b@lid', senderName: null, senderPhone: null, body: 'three', decision: 'notified', notifyReason: null, relevantUserId: 2 },
      ],
    });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain('3 messages from 2 distinct senders');
    expect(block).not.toContain('0 distinct');
  });

  it('renders a withheld message as arrived, with the reason', async () => {
    // The property the whole ruling depends on: a message Brain chose not to forward is still
    // a message it received, and it must be able to say so.
    stub({
      relays: [{ receivedAt: new Date(), rawSenderId: 'a@lid', senderName: null, senderPhone: null, body: 'salam', decision: 'withheld_not_substantive', notifyReason: 'social chit-chat', relevantUserId: 2 }],
    });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).toContain('[not forwarded: social chit-chat]');
    expect(block).toMatch(/ALL of these count, including the ones I did not/);
  });

  it('never prints a 13+ digit synthetic, even though it counts with one', async () => {
    stub({
      relays: [{ receivedAt: new Date(), rawSenderId: '255043747987458@lid', senderName: null, senderPhone: null, body: 'x', decision: 'notified', notifyReason: null, relevantUserId: 2 }],
    });
    const block = await buildRecentWhatsAppBlock('TMC-0001', 2);
    expect(block).not.toContain('255043747987458');
    expect(block).toContain('whose number WhatsApp did not share');
  });
});
