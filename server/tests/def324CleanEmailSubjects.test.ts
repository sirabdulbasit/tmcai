/**
 * DEF-324 `bracketed-marker-leak` — internal queue-names in the owner's email
 * subject line (`[open_item_draft_ask] …`, `[brain_prompt] …`), live in his
 * 09-09 feed. The token was load-bearing: DEF-287's echo guard recognized
 * Brain's own outbound by that costume. DEF-332 moved recognition to the
 * recorded gmail message id, so the subject can finally be what the owner
 * should see — the summary, nothing internal.
 *
 * Through the REAL chokepoint with WhatsApp failing (the email-fallback path
 * that wrote the leaking subjects):
 *  - the subject is the summary, with NO bracketed internal token;
 *  - the gmail message id of the send is recorded on the audit row
 *    (DEF-332's receipt — the two commits are one mechanism);
 *  - the kind still rides the audit row, so nothing is lost to the ledger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  created: [] as any[],
  emails: [] as Array<{ to: string; subject: string; body: string }>,
}));

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const brainUserMessage = {
    findFirst: async () => null,
    findMany: async () => [],
    count: async () => 0,
    create: async ({ data }: any) => { state.created.push(data); return { id: `rec-${state.created.length}` }; },
  };
  const model = {
    findUnique: async (args: any) => (args?.where?.clientNumber
      ? { name: 'TMC', domain: 'tmcltd.com' }
      : {
        id: 2, name: 'Basit', email: 'b@tmcltd.ai', clientNumber: 'TMC-0001',
        isActive: true, contactNumber: '+923000000000',
        notificationPreferences: {
          profile: { preferredTitle: 'Sir' },
          brain_channel: { outboundEnabled: true, outboundPaused: false, timezone: 'UTC' },
        },
      }),
    findFirst: async (args: any) => (
      args?.where?.id === 2 && args?.where?.clientNumber === 'TMC-0001'
        ? (await model.findUnique({ where: { id: 2 } } as any)) : null),
    findMany: async () => [], create: async () => ({ id: 'x' }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), upsert: async () => ({}), count: async () => 0,
    aggregate: async () => ({}), groupBy: async () => [],
  };
  const p: any = new Proxy(
    { brainUserMessage, $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRaw: async () => 0, $executeRawUnsafe: async () => 0 },
    { get: (t: any, k: string) => (k in t ? t[k] : model) },
  );
  return { __esModule: true, default: p, prisma: p };
});

// WhatsApp is DOWN — the exact condition under which the leaking subjects
// were written (the DEF-296 email fallback).
vi.mock('../src/services/notifications/tenantWhatsappSender', () => ({
  sendTenantWhatsAppText: async () => ({ ok: false, error: 'wa session dead' }),
  sendTenantWhatsAppVoiceNote: async () => ({ ok: false, error: 'wa session dead' }),
}));

vi.mock('../src/services/gmailService', () => ({
  sendUserEmail: async (_userId: number, to: string, subject: string, body: string) => {
    state.emails.push({ to, subject, body });
    return { success: true, messageId: 'gm-sent-42', rfc822MessageId: '<nexeo-fixed@tmcltd.ai>' };
  },
}));

vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => {
    if (key === 'notify.office_start_hour') return 0;
    if (key === 'notify.office_end_hour') return 24;
    if (key === 'notify.office_days_mask') return 127;
    if (key === 'selfpruning.daily_rollup_enabled') return 0;
    if (key === 'selfpruning.burst_rollup_enabled') return 0;
    return 50;
  },
}));

vi.mock('../src/services/llmRouter', () => ({
  callLLM: async () => ({ text: 'rendered' }),
}));

import { brainContactsUser } from '../src/services/notifications/brainOutboundService';

beforeEach(() => {
  state.created = [];
  state.emails = [];
});

describe('DEF-324 — the owner-facing subject carries no internal token', () => {
  it('THE LEAK, closed: the fallback email subject is the summary — no [kind] prefix', async () => {
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001',
      kind: 'open_item_draft_ask', urgency: 'normal',
      summary: 'What deadline for the Fujairah pricing?',
      body: 'What deadline should I put on this?',
      dedupKey: `draft-ask-${Math.floor(Math.random() * 1e9)}`,
    });
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].subject).toBe('What deadline for the Fujairah pricing?');
    expect(state.emails[0].subject).not.toMatch(/^\[/);
    expect(state.emails[0].subject).not.toContain('open_item_draft_ask');
    expect(res.channelsUsed).toContain('email');
  });

  it("DEF-332's receipt rides the same send: the gmail id is on the audit row, and the kind is not lost", async () => {
    await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001',
      kind: 'brain_prompt', urgency: 'normal',
      summary: 'Hamna Latif Bhutta replied',
      body: 'Hamna replied to your note.',
      dedupKey: `bp-${Math.floor(Math.random() * 1e9)}`,
    });
    const sent = state.created.find((d) => d?.metadata?.gmailMessageId);
    expect(sent).toBeTruthy();
    expect(sent.metadata.gmailMessageId).toBe('gm-sent-42');
    expect(sent.metadata.rfc822MessageId).toBe('<nexeo-fixed@tmcltd.ai>'); // the copy-invariant key rides the same row
    expect(sent.kind).toBe('brain_prompt'); // the ledger keeps the kind; only the subject lost it
  });
});
