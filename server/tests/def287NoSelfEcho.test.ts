/**
 * DEF-287 — Brain read its own voice and reported it as someone else's.
 *
 * 2026-09-02 17:12, owner-reported: *"I did see a notification that Hamna Latif Bhutta sent an
 * email with the subject 'Hlo' at 11:53 AM today."* **Hamna sent no email.** The 11:53 row is:
 *
 *   from:    Basit Ahmed <basit.ahmed@tmcltd.com>
 *   to:      basit.ahmed@tmcltd.com
 *   subject: [brain_prompt] Hamna Latif Bhutta replied: "Hlo"
 *
 * Brain's own notification, delivered by email, re-collected by the Gmail connector, stored as an
 * inbound `feed_event`, and hours later cited back to him as evidence of an incoming message from
 * a named person. A closed loop.
 *
 * That is **invariant #5** — the owner told in confident prose that someone he knows wrote words
 * they never wrote — and the DEF-159 class arriving by a route nothing was watching. 14 such rows
 * since 08-03, of 145 gmail events whose sender is the owner himself.
 *
 * The two conditions below are both required. Neither is decoration: the stamp alone would catch
 * a forwarded notification from a third party (a real inbound event), and self-addressing alone
 * would catch the owner's genuine notes to himself, which are common.
 */
import { describe, it, expect } from 'vitest';
import { isOwnOutboundEcho } from '../src/services/feed/feedIngestionService';

const THE_ONE = {
  from: 'Basit Ahmed <basit.ahmed@tmcltd.com>',
  to: 'basit.ahmed@tmcltd.com',
  subject: '[brain_prompt] Hamna Latif Bhutta replied: "Hlo"',
};

describe('DEF-287 — Brain does not ingest its own notifications', () => {
  it('refuses the exact payload that misattributed an email to Hamna', () => {
    expect(isOwnOutboundEcho(THE_ONE)).toBe(true);
  });

  it('matches the address inside angle brackets, not the display name', () => {
    expect(isOwnOutboundEcho({ ...THE_ONE, to: '"Basit" <basit.ahmed@tmcltd.com>' })).toBe(true);
    expect(isOwnOutboundEcho({ ...THE_ONE, from: 'basit.ahmed@tmcltd.com' })).toBe(true);
  });

  it('is case-insensitive about the address, as SMTP is', () => {
    expect(isOwnOutboundEcho({ ...THE_ONE, from: 'BASIT.AHMED@TMCLTD.COM' })).toBe(true);
  });

  it('keeps a genuine email that merely carries the stamp — a forward is real inbound', () => {
    // Stamp without self-addressing: somebody actually sent this to him.
    expect(isOwnOutboundEcho({ ...THE_ONE, from: 'hamna@tmcltd.ai' })).toBe(false);
  });

  it('keeps the owner\'s own notes to himself — self-addressing without the stamp', () => {
    expect(isOwnOutboundEcho({
      from: 'basit.ahmed@tmcltd.com', to: 'basit.ahmed@tmcltd.com',
      subject: 'Reminder: call the bank',
    })).toBe(false);
  });

  it('keeps a human REPLY to a notification — that is a real message', () => {
    // "Re: [brain_prompt] …" must not match. Someone answering Brain is an inbound event, and
    // dropping it would be a worse defect than the one being fixed.
    expect(isOwnOutboundEcho({ ...THE_ONE, subject: 'Re: [brain_prompt] Hamna Latif Bhutta replied' })).toBe(false);
    expect(isOwnOutboundEcho({ ...THE_ONE, subject: 'Fwd: [brain_prompt] something' })).toBe(false);
  });

  it('survives a payload with pieces missing rather than throwing', () => {
    // Ingest runs on every email; a malformed payload must not take the connector down.
    for (const p of [null, undefined, {}, { subject: '[brain_prompt] x' }, { from: 'a@b.c' }]) {
      expect(() => isOwnOutboundEcho(p as any)).not.toThrow();
      expect(isOwnOutboundEcho(p as any)).toBe(false);
    }
  });

  it('covers other brain-stamped kinds, not just brain_prompt', () => {
    expect(isOwnOutboundEcho({ ...THE_ONE, subject: '[brain_health_alert] disk' })).toBe(true);
    expect(isOwnOutboundEcho({ ...THE_ONE, subject: '[brain] anything' })).toBe(true);
  });

  it('does not match a bracketed subject that is not ours', () => {
    expect(isOwnOutboundEcho({ ...THE_ONE, subject: '[URGENT] invoice' })).toBe(false);
    expect(isOwnOutboundEcho({ ...THE_ONE, subject: '[jira] TICKET-1' })).toBe(false);
  });
});
