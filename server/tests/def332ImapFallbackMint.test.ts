/**
 * DEF-332 hardening, second half (Codex it-78 §6.1) — the IMAP/SMTP fallback
 * was the ONE send route with no echo key, and it is the route that is
 * ACTIVE while the Gmail API is down (exactly the current billing outage):
 * an IMAP-routed Brain email would land with a foreign Message-ID and, on
 * billing restore, re-ingest as a new inbound — the DEF-287 "a named person
 * emailed you" misattribution.
 *
 * Now `sendUserEmail` mints ONE Message-ID before the provider branch and
 * both routes carry it: the Gmail raw-MIME path (already pinned by
 * def332OutboundEchoById + def324 suites) and the IMAP path under test here.
 *
 * Under test:
 *  - when the Gmail client is unavailable, the IMAP send receives the minted
 *    `<nexeo-…@tmcltd.ai>` Message-ID;
 *  - the caller gets `rfc822MessageId` back, so the outbound audit row can
 *    record the same copy-invariant key the echo guard matches on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  imapCalls: [] as any[],
}));

vi.mock('../src/services/integrationService', () => ({
  getAuthenticatedClient: async () => ({ client: null, error: 'no gmail oauth' }),
}));

vi.mock('../src/services/imapSmtpService', () => ({
  sendEmail: async (args: any) => {
    state.imapCalls.push(args);
    return { ok: true, messageId: args.messageId ?? '<nodemailer-minted@local>' };
  },
}));

import { sendUserEmail } from '../src/services/gmailService';

beforeEach(() => {
  state.imapCalls = [];
});

describe('DEF-332 — the IMAP fallback carries the same minted echo key', () => {
  it('the IMAP send receives the minted Message-ID, and the caller gets it back as rfc822MessageId', async () => {
    const r = await sendUserEmail(2, 'haseeb@tmcltd.com', 'Daily summary', '<p>held 3 items</p>');
    expect(r.success).toBe(true);
    expect(state.imapCalls).toHaveLength(1);
    const minted = state.imapCalls[0].messageId;
    expect(minted).toMatch(/^<nexeo-[0-9a-f-]+@tmcltd\.ai>$/);
    expect((r as any).rfc822MessageId).toBe(minted);
  });

  it('the subject passed to IMAP is untouched — no bracket is reintroduced on this route (DEF-324 holds here too)', async () => {
    await sendUserEmail(2, 'haseeb@tmcltd.com', 'What deadline for the Fujairah pricing?', '<p>…</p>');
    expect(state.imapCalls[0].subject).toBe('What deadline for the Fujairah pricing?');
    expect(state.imapCalls[0].subject).not.toMatch(/^\[/);
  });
});
