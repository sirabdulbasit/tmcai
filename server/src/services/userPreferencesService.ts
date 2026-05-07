/**
 * Per-user UI preferences. Backed by users.preferences JSONB column.
 *
 * Currently keys:
 *   attentionWindowDays — how far back My Attention surfaces unattended
 *                         items. Range 7..90, default 30.
 *   briefWindowDays      — Brief audit trail window. Range 1..30,
 *                         default 7.
 *
 * Falls back to env defaults (ATTENTION_WINDOW_DAYS / BRIEF_WINDOW_DAYS)
 * when the user hasn't set anything. Per-user always wins over env.
 */
import prisma from '../db/prisma';

export interface UserUIPreferences {
  attentionWindowDays: number;  // 7..90
  briefWindowDays: number;      // 1..30
}

const ATT_MIN = 7;
const ATT_MAX = 90;
const BRIEF_MIN = 1;
const BRIEF_MAX = 30;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function envDefault(key: string, fallback: number): number {
  const v = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * Resolve effective preferences for a user. Per-user values win; missing
 * keys fall back to env defaults; env defaults fall back to baked-in
 * values (30 / 7).
 */
export async function getUserPreferences(userId: number): Promise<UserUIPreferences> {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { preferences: true } as any,
  }).catch(() => null);
  const stored: any = (user as any)?.preferences ?? {};

  const attEnv = envDefault('ATTENTION_WINDOW_DAYS', 30);
  const briefEnv = envDefault('BRIEF_WINDOW_DAYS', 7);

  const attUser = typeof stored.attentionWindowDays === 'number' ? stored.attentionWindowDays : null;
  const briefUser = typeof stored.briefWindowDays === 'number' ? stored.briefWindowDays : null;

  return {
    attentionWindowDays: clamp(attUser ?? attEnv, ATT_MIN, ATT_MAX),
    briefWindowDays: clamp(briefUser ?? briefEnv, BRIEF_MIN, BRIEF_MAX),
  };
}

export async function updateUserPreferences(
  userId: number,
  patch: Partial<UserUIPreferences>,
): Promise<UserUIPreferences> {
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { preferences: true } as any,
  });
  const current: any = (user as any)?.preferences ?? {};
  const next: any = { ...current };

  if (patch.attentionWindowDays !== undefined) {
    next.attentionWindowDays = clamp(patch.attentionWindowDays, ATT_MIN, ATT_MAX);
  }
  if (patch.briefWindowDays !== undefined) {
    next.briefWindowDays = clamp(patch.briefWindowDays, BRIEF_MIN, BRIEF_MAX);
  }

  await prisma.user.update({
    where: { id: userId },
    data: { preferences: next } as any,
  });

  return getUserPreferences(userId);
}
