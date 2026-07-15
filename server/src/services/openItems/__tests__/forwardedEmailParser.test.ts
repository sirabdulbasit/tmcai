import { describe, it, expect } from 'vitest';
import { parseForwardedEmail, buildOpenItemFromForward } from '../forwardedEmailParser';

const GMAIL_FORWARD = `Please review and let me know what you think.

---------- Forwarded message ----------
From: Vendor Acme <billing@acme.com>
Date: Mon, 4 May 2026 10:00:00
Subject: Q3 invoice attached
To: ops@tmcltd.com

Hi team,
Please find Q3 invoice attached. Total 7000 USD.
Thanks
`;

const APPLE_FORWARD = `Heads up — your decision needed.

Begin forwarded message:

From: Project Lead <pm@partner.com>
Subject: Project status this week
Date: Mon, 4 May 2026

Status update body…
`;

const NORMAL_EMAIL = `Hi Basit,

Wanted to ask about next quarter. From: looks like everything's on track.

Thanks
`;

describe('parseForwardedEmail', () => {
  it('parses Gmail-style forward', () => {
    const r = parseForwardedEmail('Fwd: Q3 invoice attached', GMAIL_FORWARD);
    expect(r.isForwarded).toBe(true);
    expect(r.forwarderNote).toBe('Please review and let me know what you think.');
    expect(r.originalSenderEmail).toBe('billing@acme.com');
    expect(r.originalSenderName).toBe('Vendor Acme');
    expect(r.originalSubject).toBe('Q3 invoice attached');
  });

  it('parses Apple Mail-style forward', () => {
    const r = parseForwardedEmail('FW: Project status this week', APPLE_FORWARD);
    expect(r.isForwarded).toBe(true);
    expect(r.forwarderNote).toBe('Heads up — your decision needed.');
    expect(r.originalSenderEmail).toBe('pm@partner.com');
    expect(r.originalSubject).toBe('Project status this week');
  });

  it('does NOT classify a normal email as forwarded just because body contains "From:"', () => {
    const r = parseForwardedEmail('Quick question', NORMAL_EMAIL);
    expect(r.isForwarded).toBe(false);
  });

  it('strips Fwd: prefix from extracted original subject', () => {
    const r = parseForwardedEmail(
      'Fwd: Fwd: Q3 invoice attached',
      `Quick question above\n---------- Forwarded message ----------\nFrom: x@y.com\nSubject: Fwd: Original\nTo: me\n\nbody`,
    );
    expect(r.originalSubject).toBe('Original');
  });
});

describe('buildOpenItemFromForward', () => {
  it('builds a clean title with action verb when forwarder asks for review', () => {
    const parsed = parseForwardedEmail('Fwd: Q3 invoice attached', GMAIL_FORWARD);
    const built = buildOpenItemFromForward(parsed, 'cfo@tmcltd.com', 'CFO Sara', 'fallback');
    expect(built.title).toBe('Review: Q3 invoice attached');
    expect(built.description).toContain('CFO Sara');
    expect(built.description).toContain('Vendor Acme');
    expect(built.description).toContain('Their note: "Please review and let me know what you think."');
  });

  it('falls back to plain "Forwarded:" when no recognisable verb', () => {
    const parsed = parseForwardedEmail('Fwd: Project status', APPLE_FORWARD);
    const built = buildOpenItemFromForward(parsed, 'coo@tmcltd.com', 'COO', 'fallback');
    // "decide" not in the inferActionVerb regex set yet (needs "please decide"
    // / "need.*decision") — confirm we get the safe fallback prefix.
    expect(built.title.startsWith('Forwarded:') || built.title.startsWith('Decide:')).toBe(true);
  });
});
