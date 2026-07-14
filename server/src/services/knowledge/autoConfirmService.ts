/**
 * autoConfirmService — earned autonomy for confirmation previews
 * (Phase 1C, 2026-07-14).
 *
 * Basit: "Nexeo is always in asking mode — how can it learn which is
 * to ask before doing, and which should not?"
 *
 * Three kinds of asking exist; only ONE is learnable:
 *   - clarification asks  → already reduced by clarificationMemory
 *   - grounding asks      → the safety net (wrong-recipient class);
 *                           never removed, self-heals as data completes
 *   - CONFIRMATION previews → this module. The brain earns the right
 *     to skip them, per action kind, per user:
 *
 *       1. LEDGER — count the user's consecutive unmodified approvals
 *          of a kind (from brainPendingAction history: 'completed'
 *          rows going backwards until a 'cancelled'/'failed' breaks
 *          the streak). No new table — the history already exists.
 *       2. OFFER — at 10 clean approvals, the brain PROPOSES skipping
 *          that kind's preview (once per 30 days, never nags). It
 *          NEVER flips the switch itself — same consent design as the
 *          trust-promotion job (D2).
 *       3. CONSENT — the user replies with an exact toggle command
 *          ("auto-send emails" / "always preview emails"). Closed
 *          command grammar = mechanics, not regex judgement.
 *       4. GATE — gateHumanFacingAction consults the stored consent
 *          and skips the preview for that kind only. Ground-or-ask
 *          and per-verb target resolution still run on every dispatch
 *          — auto-send removes the CONFIRMATION step, never the
 *          safety checks.
 *
 * Only low-regret, high-frequency kinds are eligible. Destructive or
 * rare actions (delete_wiki_page, cancel_meeting, delegations) always
 * preview, regardless of streaks.
 */
import prisma from '../../db/prisma';

export const AUTO_CONFIRM_ELIGIBLE = ['send_email', 'notify_via_whatsapp', 'schedule_meeting'] as const;
export type AutoConfirmKind = typeof AUTO_CONFIRM_ELIGIBLE[number];

export const STREAK_THRESHOLD = 10;
const OFFER_COOLDOWN_MS = 30 * 24 * 3600_000;

/** Human words used in offers/toggles per kind. */
export const KIND_WORDS: Record<AutoConfirmKind, string> = {
  send_email: 'emails',
  notify_via_whatsapp: 'WhatsApp messages',
  schedule_meeting: 'meeting invites',
};

function isEligible(kind: string): kind is AutoConfirmKind {
  return (AUTO_CONFIRM_ELIGIBLE as readonly string[]).includes(kind);
}

/** Consecutive most-recent 'completed' pendings of `kind` — a
 *  'cancelled' or 'failed' row breaks the streak (the user stopped or
 *  the send failed; both mean the preview still earns its keep). */
export async function getCleanStreak(userId: number, kind: string): Promise<number> {
  if (!isEligible(kind)) return 0;
  const rows = await (prisma as any).brainPendingAction.findMany({
    where: { userId, actionKind: kind, status: { in: ['completed', 'cancelled', 'failed'] } },
    orderBy: { updatedAt: 'desc' },
    take: STREAK_THRESHOLD + 5,
    select: { status: true },
  }).catch(() => [] as Array<{ status: string }>);
  let streak = 0;
  for (const r of rows) {
    if (r.status === 'completed') streak += 1;
    else break;
  }
  return streak;
}

async function readBrainChannelPrefs(userId: number): Promise<Record<string, any>> {
  const u = await prisma.user.findFirst({
    where: { id: userId },
    select: { notificationPreferences: true } as any,
  }).catch(() => null);
  return ((u as any)?.notificationPreferences?.brain_channel ?? {}) as Record<string, any>;
}

async function writeBrainChannelPrefs(userId: number, patch: Record<string, unknown>): Promise<void> {
  const u = await prisma.user.findFirst({
    where: { id: userId },
    select: { notificationPreferences: true } as any,
  }).catch(() => null);
  const prefs = ((u as any)?.notificationPreferences ?? {}) as Record<string, any>;
  const brainChannel = { ...(prefs.brain_channel ?? {}), ...patch };
  await prisma.user.update({
    where: { id: userId },
    data: { notificationPreferences: { ...prefs, brain_channel: brainChannel } as any },
  });
}

/** Has the user consented to skipping previews for this kind? */
export async function isAutoConfirmEnabled(userId: number, kind: string): Promise<boolean> {
  if (!isEligible(kind)) return false;
  const bc = await readBrainChannelPrefs(userId);
  return bc?.autoConfirm?.[kind] === true;
}

export async function setAutoConfirm(userId: number, kind: AutoConfirmKind, on: boolean): Promise<void> {
  const bc = await readBrainChannelPrefs(userId);
  await writeBrainChannelPrefs(userId, {
    autoConfirm: { ...(bc.autoConfirm ?? {}), [kind]: on },
  });
}

/** Decide whether to append the auto-send OFFER after a successful
 *  confirmed dispatch. Fires only when: kind eligible + streak at
 *  threshold + not already enabled + not offered in the last 30 days.
 *  Records the offer timestamp so the brain never nags. */
export async function maybeOfferAutoConfirm(userId: number, kind: string): Promise<string | null> {
  if (!isEligible(kind)) return null;
  const bc = await readBrainChannelPrefs(userId);
  if (bc?.autoConfirm?.[kind] === true) return null;
  const lastOffered = bc?.autoConfirmOfferedAt?.[kind];
  if (lastOffered && Date.now() - new Date(lastOffered).getTime() < OFFER_COOLDOWN_MS) return null;
  // Threshold is user/tenant-tunable (behaviorConfig key
  // 'auto_confirm.streak_threshold') with a clamped safety floor of 5 —
  // no configuration can drop below it. Eligibility allowlist above
  // stays a hard invariant regardless of any threshold.
  const { getBehaviorValue } = await import('../behaviorConfig');
  const threshold = await getBehaviorValue('auto_confirm.streak_threshold', { userId }).catch(() => STREAK_THRESHOLD);
  const streak = await getCleanStreak(userId, kind);
  if (streak < threshold) return null;
  await writeBrainChannelPrefs(userId, {
    autoConfirmOfferedAt: { ...(bc.autoConfirmOfferedAt ?? {}), [kind]: new Date().toISOString() },
  }).catch(() => { /* best-effort; worst case we offer again */ });
  // Machine marker — answerSanitizer renders the human sentence with
  // the exact toggle phrases (no hardcoded Brain prose at this layer).
  return `[auto-send offer: ${kind}]`;
}

/** Closed command grammar for consent/revocation. The offer message
 *  states these exact phrases; matching them is mechanics (like
 *  "send"), not judgement. Returns null for anything else. */
export function parseAutoConfirmCommand(text: string): { kind: AutoConfirmKind; enable: boolean } | null {
  const t = (text ?? '').trim().toLowerCase().replace(/[.!]+$/, '');
  const kindOf = (word: string): AutoConfirmKind | null =>
    /^e-?mails?$/.test(word) ? 'send_email'
    : /^whatsapps?$/.test(word) || word === 'whatsapp messages' ? 'notify_via_whatsapp'
    : /^meetings?$/.test(word) || word === 'meeting invites' ? 'schedule_meeting'
    : null;
  let m = /^auto[- ]?send (.+)$/.exec(t);
  if (m) {
    const kind = kindOf(m[1]!.trim());
    return kind ? { kind, enable: true } : null;
  }
  m = /^always preview (.+)$/.exec(t);
  if (m) {
    const kind = kindOf(m[1]!.trim());
    return kind ? { kind, enable: false } : null;
  }
  return null;
}
