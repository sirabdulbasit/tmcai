/**
 * DEF-243 — a claim about a FEED needs the feed's receipt.
 *
 * The measured fixture, verbatim from production (S23, 2026-08-22): the owner
 * asked "Derive actionable or open items from each email arrive and add them";
 * Brain replied "I automatically review incoming emails to identify tasks, and
 * I add them to your list" — while `feed_events` held gmail 2608 received,
 * 0 EVER processed. Nothing in the prompt could contradict the claim, because
 * nothing in the prompt said what actually happens to a channel.
 *
 * Under test: `channelIngestSection` derives per-channel received/processed
 * counts from `feed_events` and licenses the "automatic processing" claim
 * ONLY where processed > 0; unreadable state licenses nothing; and the
 * section survives the conservative (discovery-failed) path, where an
 * unchecked claim would be most dangerous.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const state = {
  groupByRows: [] as Array<{ sourceType: string; status: string; _count: { _all: number } }>,
  groupByThrows: false,
  registryThrows: true, // default: exercise the conservative path
};

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    {
      feedEvent: {
        groupBy: async () => {
          if (state.groupByThrows) throw new Error('db down');
          return state.groupByRows;
        },
      },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/knowledge/actionRegistryService', () => ({
  __esModule: true,
  listActiveActions: async () => {
    if (state.registryThrows) throw new Error('registry down');
    return [];
  },
}));

// The S23 production shape: a flood received, none ever processed.
const GMAIL_DEAD = [
  { sourceType: 'gmail', status: 'new', _count: { _all: 298 } },
  { sourceType: 'whatsapp', status: 'processed', _count: { _all: 854 } },
  { sourceType: 'whatsapp', status: 'new', _count: { _all: 22 } },
];

describe('DEF-243 — channelIngestSection derives the licensed claim from feed_events', () => {
  beforeEach(() => {
    state.groupByRows = [];
    state.groupByThrows = false;
    state.registryThrows = true;
  });

  it('the S23 fixture: gmail 298/0 renders as receive-only; whatsapp 876/854 as processed', async () => {
    state.groupByRows = GMAIL_DEAD;
    const { channelIngestSection } = await import('../src/services/knowledge/brainCapabilityLive');
    const s = await channelIngestSection('TMC-0001');
    expect(s).toContain('- gmail: 298 received, 0 processed automatically');
    expect(s).toContain('- whatsapp: 876 received, 854 processed automatically');
    // The rule that makes the S23 sentence unlicensable over a 0-processed channel.
    expect(s).toContain('RECEIVE-ONLY');
    expect(s).toContain('never tell the user you "automatically review"');
    expect(s).toContain('ONLY for a channel whose processed count above is greater than zero');
  });

  it('an unreadable feed licenses NOTHING — fail-closed against fabrication', async () => {
    state.groupByThrows = true;
    const { channelIngestSection } = await import('../src/services/knowledge/brainCapabilityLive');
    const s = await channelIngestSection('TMC-0001');
    expect(s).toContain('unreadable');
    expect(s).toContain('Do not claim any automatic channel processing');
    expect(s).not.toContain('received,');
  });

  it('an empty window is stated as absence, not silence', async () => {
    state.groupByRows = [];
    const { channelIngestSection } = await import('../src/services/knowledge/brainCapabilityLive');
    const s = await channelIngestSection('TMC-0001');
    expect(s).toContain('no events recorded on any channel');
    expect(s).toContain('Do not claim any automatic channel processing');
  });

  it('the section survives the CONSERVATIVE path — discovery failure does not silence it', async () => {
    state.groupByRows = GMAIL_DEAD;
    state.registryThrows = true;
    const { renderCapabilityBlockLive, clearCapabilityBlockCache } = await import('../src/services/knowledge/brainCapabilityLive');
    clearCapabilityBlockCache();
    const block = await renderCapabilityBlockLive('TMC-0001', 2);
    // Discovery failed → conservative block, AND the channel truth still rides.
    expect(block).toContain('- gmail: 298 received, 0 processed automatically');
    expect(block).toContain('RECEIVE-ONLY');
  });
});
