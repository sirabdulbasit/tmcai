/**
 * DEF-313 — the referent may not be a stranger's message.
 *
 * CL-055 / Chat 27, 2026-09-04. He asked one item's background three times and got three
 * different origins, the last being *"Hamna Latif Bhutta ... 'Apn Ghar hi'"* — a third party's
 * WhatsApp message, relayed, with no connection to the item he was asking about. His words:
 * *"brain is not corelating things correttly / brain don't know the proper background"*.
 *
 * Brain invented nothing and DID obey its instructions. The interaction list was correctly
 * time-ordered (DEF-293) and its top line was the Hamna relay; the rule beside it said "its TOP
 * line is the default reading of what he means". The rule was right. **The set it ranged over
 * was wrong** — it mixed what Brain told him with what other people told Brain and ranked them
 * against each other by time.
 *
 * These tests render the REAL block and assert on the string the model receives, because that
 * is the only artefact that decides the answer.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ prompts: [] as any[], items: [] as any[], feeds: [] as any[] }));

vi.mock('../src/db/prisma', () => {
  const p: any = new Proxy({
    brainPromptQueue: { findMany: async () => state.prompts },
    itemStatusHistory: { findMany: async () => [] },
    openItem: { findMany: async () => state.items },
    feedEvent: { findMany: async () => state.feeds },
    brainActionArtifact: { findMany: async () => [] },
    $queryRaw: async () => [], $queryRawUnsafe: async () => [],
  }, {
    get: (t: any, k: string) => (k in t ? t[k] : {
      findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
      count: async () => 0, create: async () => ({}), update: async () => ({}),
    }),
  });
  return { __esModule: true, default: p, prisma: p };
});

import { buildDispatchLedgerBlock } from '../src/services/knowledge/dispatchLedgerService';

const HOUR = 3600_000;
/** The exact shape that broke: a relayed counterpart reply, no item, NEWEST of all. */
const hamnaRelay = {
  id: 900n, question: 'Hamna Latif Bhutta replied: "Apn Ghar hi"',
  openItemId: null, sentAt: null, queuedAt: new Date(Date.now() - 1 * HOUR),
  answeredAt: null, answerText: null, state: 'queued',
  metadata: { source: 'unattached_counterpart_reply', provenance: 'quoted_third_party', from: '+239487846228094' },
};
/** The item he was actually asking about — OLDER than the relay, exactly as on 09-04. */
const planSession = {
  id: 800n, question: 'Hi, just a reminder that "Plan session for Thursday" is due soon.',
  openItemId: 'item-1', sentAt: new Date(Date.now() - 4 * HOUR), queuedAt: new Date(Date.now() - 5 * HOUR),
  answeredAt: null, answerText: null, state: 'expired',
  metadata: { source: 'preactive_due_nudge', openItemId: 'item-1', expectsReply: true },
};

const itemSection = (s: string) => s.slice(
  s.indexOf('## Your recent interactions'),
  s.indexOf('ALSO IN THE WINDOW') >= 0 ? s.indexOf('ALSO IN THE WINDOW') : undefined,
);

beforeEach(() => {
  state.prompts = [hamnaRelay, planSession];
  state.items = [{
    id: 'item-1', title: 'Plan session for Thursday', sourceFeed: 'gmail',
    sourceRef: '1a05c0a81b72ea73', createdAt: new Date('2026-09-02T13:05:00Z'),
    sourceFeedEventId: 'fe-1',
  }];
  state.feeds = [{
    id: 'fe-1', senderName: null,
    senderEmail: 'Basit Ahmed <basit.ahmed@tmcltd.com>', eventAt: new Date('2026-09-01T08:16:00Z'),
  }];
});

describe('DEF-313 — a stranger\'s relayed message can never be the referent', () => {
  it('keeps the Hamna relay OUT of the item list even though it is the newest line', async () => {
    // The whole defect in one assertion. Mutation: drop the `isReferentCandidate` filter and
    // this dies — the relay returns to the list the referent rule ranges over, at the top,
    // exactly as on 2026-09-04.
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(itemSection(block)).not.toContain('Hamna Latif Bhutta');
    expect(block).toContain('Hamna Latif Bhutta');           // still present, as background
  });

  it('puts the item he asked about at the TOP of the item list', async () => {
    const items = itemSection(await buildDispatchLedgerBlock(2, 'TMC-0001'));
    expect(items).toContain('Plan session for Thursday');
  });

  it('never renders a relayed message as something Brain said', async () => {
    // `- ... you asked, re nothing on the item list: "Hamna Latif Bhutta replied ..."` is how a
    // stranger's words came to read as Brain's own under a heading saying "your interactions".
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    const line = block.split('\n').find((l) => l.includes('Hamna Latif Bhutta'))!;
    expect(line).toContain("SOMEONE ELSE'S WORDS");
    expect(line).not.toContain('you asked');
  });

  it('forbids the background block as a referent source, in the rule beside the data', async () => {
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('THE REFERENT IS IN THE ITEM LIST ABOVE');
    expect(block).toContain('NEVER take the referent from the background block');
  });
});

describe('DEF-313 — the background answer he never got', () => {
  it('names WHO the item came from, not just the channel', async () => {
    // "came in via gmail" alone was the whole of provenance before this, which is why
    // "to whom with i did this chat?" had no answer while the record held one.
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('from Basit Ahmed <basit.ahmed@tmcltd.com>');
  });

  it('separates when it was SENT from when Brain recorded it', async () => {
    // He was told "September 2nd" — Brain's ingest date — for an email written on the 1st.
    // Mutation: render only createdAt and this dies.
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('sent 09-01');
    expect(block).toContain('which I first recorded 09-02');
  });

  it('refuses to present an opaque provider id as a person', async () => {
    // All 25 live gchat items store their sender as `users/<digits>`. Rendering that as a name
    // is DEF-121's mistake: a fabricated-looking identifier reads as actionable.
    state.feeds = [{ id: 'fe-1', senderName: 'users/112401471047118061862', senderEmail: null, eventAt: new Date('2026-08-27T21:35:00Z') }];
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('NOT yet identified');
    expect(block).toContain('users/112401471047118061862');
    expect(block).not.toContain('from users/112401471047118061862,');
  });
});
