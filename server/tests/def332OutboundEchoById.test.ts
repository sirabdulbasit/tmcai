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
  recordedRfc: new Set<string>(),
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
      if (!where?.clientNumber) return null;
      const conds = where.OR ?? [{ metadata: where.metadata }];
      for (const c of conds) {
        const path = c?.metadata?.path?.[0];
        const val = c?.metadata?.equals;
        if (path === 'gmailMessageId' && state.recorded.has(val)) return { id: 'bum-1' };
        if (path === 'rfc822MessageId' && state.recordedRfc.has(val)) return { id: 'bum-2' };
      }
      return null;
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
  state.recordedRfc = new Set(['<nexeo-abc123@tmcltd.ai>']);
  state.lastWhere = null;
  state.throwOnLookup = false;
});

describe('DEF-332 — echo recognition by recorded gmail message id', () => {
  it('a recorded outbound id is recognized, and the read is tenant-scoped', async () => {
    await expect(isRecordedOutboundEmail('TMC-0001', 'gmail-msg-777')).resolves.toBe(true);
    expect(state.lastWhere.clientNumber).toBe('TMC-0001');
    expect(state.lastWhere.OR[0].metadata.path).toEqual(['gmailMessageId']);
  });

  it('HARDENING: the minted RFC 5322 Message-ID matches even when the per-mailbox API id differs (the Codex it-77 §3 failure scenario)', async () => {
    await expect(
      isRecordedOutboundEmail('TMC-0001', 'a-DIFFERENT-inbox-copy-id', '<nexeo-abc123@tmcltd.ai>'),
    ).resolves.toBe(true);
  });

  it('an unrecorded Message-ID with an unrecorded id still ingests — a real inbound carrying someone else\'s Message-ID is untouched', async () => {
    await expect(
      isRecordedOutboundEmail('TMC-0001', 'unknown-id', '<someone-else@example.com>'),
    ).resolves.toBe(false);
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
