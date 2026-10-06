/**
 * DEF-332 — Brain's outbound email is recognized by IDENTITY, not costume.
 *
 * DEF-287's guard matched a `[brain*]` subject prefix — an enumeration that
 * already missed `[open_item_draft_ask]` echoes, and the reason internal
 * kind-tags sit in owner-visible subjects (DEF-324). Now the email leg
 * records Gmail's own message id on the outbound audit row, and ingestion
 * correlates `feedEvent.sourceId` (which IS the gmail message id) against
 * those records: the two sides cannot disagree, whatever the subject says.
 *
 * Under test:
 *  - a recorded id matches, tenant-scoped;
 *  - an unrecorded id does not (the owner's self-notes still ingest);
 *  - a missing/blank sourceId never matches (no key, no claim);
 *  - a lookup failure fails OPEN — the mail ingests (a missed echo is
 *    recoverable; a dropped human email is not).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  recorded: new Set<string>(),
  lastWhere: null as any,
  throwOnLookup: false,
}));

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const brainUserMessage = {
    findFirst: async ({ where }: any) => {
      state.lastWhere = where;
      if (state.throwOnLookup) throw new Error('db down');
      const id = where?.metadata?.equals;
      return state.recorded.has(id) && where?.clientNumber ? { id: 'bum-1' } : null;
    },
  };
  const p: any = new Proxy(
    { brainUserMessage },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

import { isRecordedOutboundEmail } from '../src/services/feed/feedIngestionService';

beforeEach(() => {
  state.recorded = new Set(['gmail-msg-777']);
  state.lastWhere = null;
  state.throwOnLookup = false;
});

describe('DEF-332 — echo recognition by recorded gmail message id', () => {
  it('a recorded outbound id is recognized, and the read is tenant-scoped', async () => {
    await expect(isRecordedOutboundEmail('TMC-0001', 'gmail-msg-777')).resolves.toBe(true);
    expect(state.lastWhere.clientNumber).toBe('TMC-0001');
    expect(state.lastWhere.metadata.path).toEqual(['gmailMessageId']);
  });

  it("an unrecorded id does not match — the owner's self-notes still ingest", async () => {
    await expect(isRecordedOutboundEmail('TMC-0001', 'gmail-msg-888')).resolves.toBe(false);
  });

  it('a blank or missing sourceId never matches — no key, no claim', async () => {
    await expect(isRecordedOutboundEmail('TMC-0001', '')).resolves.toBe(false);
    await expect(isRecordedOutboundEmail('TMC-0001', null)).resolves.toBe(false);
    expect(state.lastWhere).toBeNull(); // no query was even issued
  });

  it('a lookup failure fails OPEN — the mail ingests rather than being dropped', async () => {
    state.throwOnLookup = true;
    await expect(isRecordedOutboundEmail('TMC-0001', 'gmail-msg-777')).resolves.toBe(false);
  });
});
