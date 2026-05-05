import { describe, it, expect } from 'vitest';
import { isLikelyAutomated, shouldCreateContact } from '../senderQualityFilter';

describe('isLikelyAutomated — exact local-part matches', () => {
  it.each([
    'noreply@anthropic.com',
    'no-reply@example.com',
    'donotreply@bank.com',
    'do-not-reply@vendor.io',
    'mailer-daemon@example.com',
    'postmaster@example.com',
    'bounce@list.com',
    'bounces@list.com',
    'notifications@github.com',
    'notify@slack.com',
    'alerts@datadog.com',
    'newsletter@nyt.com',
    'digest@medium.com',
    'marketing@brand.com',
    'delivery@tracking.com',
    'mailer@mailgun.org',
    'updates@theoasis.com.pk',
    'system@sent-via.netsuite.com',
  ])('rejects %s', (email) => {
    expect(isLikelyAutomated(email)).toBe(true);
  });
});

describe('isLikelyAutomated — prefix patterns (Anthropic-style tracking tokens)', () => {
  it.each([
    'no-reply-dtdehyonk_nsh2a9k_h-da@anthropic.com',
    'noreply-abc123_def456@vendor.com',
    'notification-xyz789@app.io',
    'newsletter-2026q1@brand.co',
    'bounce-1234567@mailer.net',
  ])('rejects prefix %s', (email) => {
    expect(isLikelyAutomated(email)).toBe(true);
  });
});

describe('isLikelyAutomated — token-only local parts', () => {
  it('rejects long alphanumeric with 3+ digits', () => {
    expect(isLikelyAutomated('abc123def456ghi@domain.com')).toBe(true);
    expect(isLikelyAutomated('xk9j2m_p3qrst_a8bz@vendor.io')).toBe(true);
  });

  it('accepts long names without digits (mohtashimjangda case)', () => {
    expect(isLikelyAutomated('mohtashimjangda@tmcltd.ai')).toBe(false);
    expect(isLikelyAutomated('aaddministration@gmail.com')).toBe(false);
    expect(isLikelyAutomated('michaeljacksonworld@example.com')).toBe(false);
  });

  it('accepts names with one or two trailing digits (kirannatasha80 case)', () => {
    expect(isLikelyAutomated('kirannatasha80@gmail.com')).toBe(false);
    expect(isLikelyAutomated('john99@example.com')).toBe(false);
  });

  it('accepts firstname.lastname patterns', () => {
    expect(isLikelyAutomated('john.doe@example.com')).toBe(false);
    expect(isLikelyAutomated('basit.ahmed@tmcltd.ai')).toBe(false);
  });

  it('keeps support/help addresses (real humans often use shared mailboxes)', () => {
    expect(isLikelyAutomated('support@reclaim.ai')).toBe(false);
    expect(isLikelyAutomated('help@stripe.com')).toBe(false);
  });
});

describe('isLikelyAutomated — accepts legitimate addresses', () => {
  it.each([
    'asad@tmcltd.ai',
    'asad.khan@tmcltd.com',
    'haseeb@tmcltd.ai',
    'sales@partner.com',
    'cfo@vendor.com',
    'jane@startup.io',
  ])('accepts %s', (email) => {
    expect(isLikelyAutomated(email)).toBe(false);
  });

  it('handles empty / null gracefully', () => {
    expect(isLikelyAutomated('')).toBe(false);
    expect(isLikelyAutomated(null)).toBe(false);
    expect(isLikelyAutomated(undefined as any)).toBe(false);
    expect(isLikelyAutomated('not-an-email')).toBe(false);
  });
});

describe('shouldCreateContact — signal-based gating', () => {
  it('always creates manual / imported contacts (bypasses filter)', () => {
    expect(shouldCreateContact({ email: 'noreply@anything.com', importSource: 'manual' })).toBe('create');
    expect(shouldCreateContact({ email: 'no-reply-abc@x.com', importSource: 'google_import' })).toBe('create');
    expect(shouldCreateContact({ email: 'newsletter@y.com', importSource: 'microsoft_import' })).toBe('create');
  });

  it('always creates WhatsApp contacts (always personal)', () => {
    expect(shouldCreateContact({ email: 'whoever@x.com', isWhatsApp: true })).toBe('create');
  });

  it('skips automated senders even with no manual flag', () => {
    expect(shouldCreateContact({ email: 'noreply@brand.com' })).toBe('skip');
    expect(shouldCreateContact({ email: 'no-reply-tracking_xyz@anthropic.com', inboundCount: 50 })).toBe('skip');
  });

  it('creates when user has replied (bidirectional)', () => {
    expect(shouldCreateContact({ email: 'partner@vendor.com', hasOutbound: true })).toBe('create');
  });

  it('creates after 3+ inbound messages', () => {
    expect(shouldCreateContact({ email: 'sender@vendor.com', inboundCount: 3 })).toBe('create');
    expect(shouldCreateContact({ email: 'sender@vendor.com', inboundCount: 2 })).toBe('skip');
  });

  it('creates same-domain senders (likely teammates)', () => {
    expect(shouldCreateContact({ email: 'colleague@tmcltd.ai', userDomain: 'tmcltd.ai' })).toBe('create');
    expect(shouldCreateContact({ email: 'asad@tmcltd.com', userDomain: 'tmcltd.ai' })).toBe('skip');
  });

  it('creates calendar attendees', () => {
    expect(shouldCreateContact({ email: 'attendee@x.com', isCalendarAttendee: true })).toBe('create');
  });

  it('skips low-signal one-off senders', () => {
    expect(shouldCreateContact({ email: 'random@once.com', inboundCount: 1 })).toBe('skip');
  });
});
