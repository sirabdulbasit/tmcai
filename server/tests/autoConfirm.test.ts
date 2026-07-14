import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 1C (2026-07-14) — earned autonomy for confirmation previews.
// Basit: "Nexeo is always in asking mode — how can it learn which is
// to ask before doing, and which should not?" The brain earns the
// right to skip a kind's preview: 10 unmodified approvals → offer →
// explicit user consent → gate skips that kind only. Cancellations
// break the streak; destructive kinds are never eligible; ground-or-
// ask never bypassed (only the confirmation step is removed).

const findManyPendings = vi.fn();
const userFindFirst = vi.fn();
const userUpdate = vi.fn(async () => ({}));

vi.mock('../src/db/prisma', () => ({
  default: {
    brainPendingAction: { findMany: (...a: any[]) => findManyPendings(...a) },
    user: {
      findFirst: (...a: any[]) => userFindFirst(...a),
      update: (...a: any[]) => userUpdate(...a),
    },
  },
}));

import {
  getCleanStreak,
  isAutoConfirmEnabled,
  setAutoConfirm,
  maybeOfferAutoConfirm,
  parseAutoConfirmCommand,
  AUTO_CONFIRM_ELIGIBLE,
  STREAK_THRESHOLD,
} from '../src/services/knowledge/autoConfirmService';
import { sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';

const completed = (n: number) => Array.from({ length: n }, () => ({ status: 'completed' }));

beforeEach(() => {
  vi.clearAllMocks();
  findManyPendings.mockResolvedValue([]);
  userFindFirst.mockResolvedValue({ notificationPreferences: {} });
});

describe('getCleanStreak — the approval ledger', () => {
  it('counts consecutive completed pendings of the kind', async () => {
    findManyPendings.mockResolvedValue(completed(7));
    expect(await getCleanStreak(2, 'send_email')).toBe(7);
  });

  it('a cancellation BREAKS the streak (user still wants previews)', async () => {
    findManyPendings.mockResolvedValue([
      ...completed(3),
      { status: 'cancelled' },
      ...completed(8),
    ]);
    expect(await getCleanStreak(2, 'send_email')).toBe(3);
  });

  it('ineligible kinds always report 0 (delete/cancel never earn autonomy)', async () => {
    findManyPendings.mockResolvedValue(completed(20));
    expect(await getCleanStreak(2, 'delete_wiki_page')).toBe(0);
    expect(await getCleanStreak(2, 'cancel_meeting')).toBe(0);
    expect(await getCleanStreak(2, 'delegate_open_item')).toBe(0);
  });
});

describe('maybeOfferAutoConfirm — the offer', () => {
  it('offers when the streak reaches threshold and nothing is configured', async () => {
    findManyPendings.mockResolvedValue(completed(STREAK_THRESHOLD));
    const offer = await maybeOfferAutoConfirm(2, 'send_email');
    expect(offer).toBe('[auto-send offer: send_email]');
    // Offer timestamp recorded so it never nags.
    expect(userUpdate).toHaveBeenCalled();
  });

  it('does NOT offer below threshold', async () => {
    findManyPendings.mockResolvedValue(completed(STREAK_THRESHOLD - 1));
    expect(await maybeOfferAutoConfirm(2, 'send_email')).toBeNull();
  });

  it('does NOT offer when already enabled', async () => {
    userFindFirst.mockResolvedValue({ notificationPreferences: { brain_channel: { autoConfirm: { send_email: true } } } });
    findManyPendings.mockResolvedValue(completed(20));
    expect(await maybeOfferAutoConfirm(2, 'send_email')).toBeNull();
  });

  it('does NOT re-offer inside the 30-day cooldown', async () => {
    userFindFirst.mockResolvedValue({
      notificationPreferences: { brain_channel: { autoConfirmOfferedAt: { send_email: new Date(Date.now() - 24 * 3600_000).toISOString() } } },
    });
    findManyPendings.mockResolvedValue(completed(20));
    expect(await maybeOfferAutoConfirm(2, 'send_email')).toBeNull();
  });
});

describe('consent + gate wiring', () => {
  it('isAutoConfirmEnabled false by default; true only after explicit consent', async () => {
    expect(await isAutoConfirmEnabled(2, 'send_email')).toBe(false);
    userFindFirst.mockResolvedValue({ notificationPreferences: { brain_channel: { autoConfirm: { send_email: true } } } });
    expect(await isAutoConfirmEnabled(2, 'send_email')).toBe(true);
  });

  it('ineligible kinds can NEVER be auto-confirmed even if prefs claim so', async () => {
    userFindFirst.mockResolvedValue({ notificationPreferences: { brain_channel: { autoConfirm: { delete_wiki_page: true } } } });
    expect(await isAutoConfirmEnabled(2, 'delete_wiki_page')).toBe(false);
  });

  it('setAutoConfirm writes under brain_channel.autoConfirm preserving other prefs', async () => {
    userFindFirst.mockResolvedValue({ notificationPreferences: { brain_channel: { replyLanguage: 'english' } } });
    await setAutoConfirm(2, 'send_email', true);
    const arg = userUpdate.mock.calls[0]![0] as any;
    expect(arg.data.notificationPreferences.brain_channel.replyLanguage).toBe('english');
    expect(arg.data.notificationPreferences.brain_channel.autoConfirm.send_email).toBe(true);
  });
});

describe('parseAutoConfirmCommand — closed grammar, mechanics not judgement', () => {
  it.each([
    ['auto-send emails', 'send_email', true],
    ['auto send email', 'send_email', true],
    ['Auto-send WhatsApp', 'notify_via_whatsapp', true],
    ['auto-send meetings', 'schedule_meeting', true],
    ['always preview emails', 'send_email', false],
    ['always preview whatsapp', 'notify_via_whatsapp', false],
  ] as const)('"%s" → %s enable=%s', (text, kind, enable) => {
    expect(parseAutoConfirmCommand(text)).toEqual({ kind, enable });
  });

  it.each([
    'send the email',
    'auto-send everything',
    'auto-send',
    'always preview',
    'can you auto-send emails for me please', // free text ≠ command; the offer states the exact phrase
  ])('rejects non-command text: "%s"', (text) => {
    expect(parseAutoConfirmCommand(text)).toBeNull();
  });
});

describe('sanitizer rendering', () => {
  it('renders the embedded offer marker as a human offer with exact toggle phrases', () => {
    const out = sanitizeAnswerForUser('Sent email to X — subject: "Y". messageId=m1\n\n[auto-send offer: send_email]');
    expect(out).not.toContain('[auto-send offer');
    expect(out).toContain('approved my last 10 emails previews without changes'.replace('emails previews', 'emails previews')); // offer text present
    expect(out).toContain('"auto-send emails"');
    expect(out).toContain('"always preview emails"');
  });

  it('renders the enable/disable acks', () => {
    expect(sanitizeAnswerForUser('[auto-send enabled: emails]')).toMatch(/without asking for confirmation/);
    expect(sanitizeAnswerForUser('[auto-send disabled: emails]')).toMatch(/ask for your confirmation/);
  });
});

describe('eligibility whitelist', () => {
  it('is exactly the low-regret high-frequency kinds', () => {
    expect([...AUTO_CONFIRM_ELIGIBLE].sort()).toEqual(['notify_via_whatsapp', 'schedule_meeting', 'send_email'].sort());
  });
});
