/**
 * DEF-299 / DEF-300 — Brain knows the number people reach it on, and tells the two inboxes apart.
 *
 * Asked *"What is ur number?"*, Brain answered *"I'm Suzi, Sir. I don't have a personal phone
 * number."* The number was in `whatsapp_config.connected_number` the whole time — `+923274572102`
 * — and appears in the log on every reconnect. Not missing data: data absent from the reasoning
 * context, the same shape as DEF-260.
 *
 * The owner then made the harder ask twice in one hour: *"the message u read from that whatsapp
 * should not be messup with those message you received directly on your number"*. Brain replied
 * *"Noted: … distinguish them from our conversations"* both times — a preference recorded where a
 * fact was needed, which is exactly why he had to repeat it.
 *
 * SCOPE, stated honestly: this closes DEF-299 and gives DEF-300 its factual foundation. It does
 * NOT close DEF-300, which needs the two populations separated at the source and is his product
 * decision to make.
 */
import { describe, it, expect } from 'vitest';
import { renderCapabilitiesBlock } from '../src/services/knowledge/systemCapabilitiesService';

const base = {
  userConnectors: [], tenantConnectors: [], feedCounts30d: {},
  wikiStats: {
    orgDocs: 0, projects: 0, policies: 0, senderHistories: 0,
    senderTopics: 0, entities: 0, gaps: 0, answers: 0,
  },
  promptQueue: {
    queued: 0, awaitingReplyTitle: null, awaitingReplySentAt: null,
    sentLast24h: 0, answeredLast7d: 0,
  },
};

const render = (waIdentity: any) => renderCapabilitiesBlock({ ...base, waIdentity } as any);

describe('DEF-299 — Brain states its own WhatsApp number', () => {
  it('names the number people message it on', () => {
    const block = render({
      brainNumber: '+923274572102', brainStatus: 'connected',
      ownerPersonalNumber: null, ownerPersonalStatus: null,
    });
    expect(block).toContain('+923274572102');
  });

  it('says the number is its OWN, not just that a number exists', () => {
    // "I don't have a personal phone number" was the failure. A bare number in a list of
    // connectors would not have prevented it — the model has to be told whose it is.
    const block = render({
      brainNumber: '+923274572102', brainStatus: 'connected',
      ownerPersonalNumber: null, ownerPersonalStatus: null,
    });
    expect(block).toMatch(/MY OWN WhatsApp number/);
    expect(block).toMatch(/message ME on/);
  });

  it('says plainly when it has no number, rather than staying silent', () => {
    // Silence is what the model filled in with a guess the first time.
    const block = render({
      brainNumber: null, brainStatus: null,
      ownerPersonalNumber: null, ownerPersonalStatus: null,
    });
    expect(block).toContain('do not currently have a WhatsApp number');
  });
});

describe('DEF-300 — the two inboxes are told apart as a fact', () => {
  it('marks a message on its own number as sent TO it', () => {
    const block = render({
      brainNumber: '+923274572102', brainStatus: 'connected',
      ownerPersonalNumber: null, ownerPersonalStatus: null,
    });
    expect(block).toMatch(/sent TO me/);
  });

  it('when the owner WhatsApp is connected, marks it as read-not-received and a separate population', () => {
    const block = render({
      brainNumber: '+923274572102', brainStatus: 'connected',
      ownerPersonalNumber: '+971562746723', ownerPersonalStatus: 'connected',
    });
    expect(block).toContain('+971562746723');
    expect(block).toMatch(/READ/);
    expect(block).toMatch(/NOT sent to me/);
    expect(block).toMatch(/never merge the two/);
  });

  it('says it is reading NOTHING when that connector is disconnected', () => {
    // The live state today for both users. Naming the number without the status would license
    // exactly the over-claim — "I read your WhatsApp" — that is not true, which is the
    // `fabricated-status` class, nine occurrences deep.
    const block = render({
      brainNumber: '+923274572102', brainStatus: 'connected',
      ownerPersonalNumber: null, ownerPersonalStatus: 'disconnected',
    });
    expect(block).toMatch(/reading NOTHING from his personal WhatsApp/);
    expect(block).toMatch(/must not claim or imply otherwise/);
  });

  it('does not invent a second inbox when no personal connector exists at all', () => {
    const block = render({
      brainNumber: '+923274572102', brainStatus: 'connected',
      ownerPersonalNumber: null, ownerPersonalStatus: null,
    });
    expect(block).not.toMatch(/personal WhatsApp/);
  });
});
