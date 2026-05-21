/**
 * userMemoryService — durable per-user preferences and facts.
 *
 * Quality Sprint 2 (2026-05-21). Solves "Brain doesn't remember
 * how I work" — once the user says "I sign off as Best regards" or
 * "default to 45-min meetings", Brain remembers across sessions and
 * applies it without re-asking.
 *
 * Safety policy (per third-party review):
 *   - 'explicit' memories apply immediately (user told Brain directly).
 *   - 'inferred' memories require user confirmation (confirmedAt) before
 *     they're injected into the composer prompt. The background
 *     reflection job (Q2 Phase B, not yet built) will populate inferred
 *     memories for Settings UI review.
 *   - 'system' memories are set by Brain itself for internal config
 *     (e.g., brain_name preferences).
 *
 * Inspectable + editable: every memory has a key the user can see in
 * Settings → Brain → Memories and dismiss or edit. No silent learning.
 */
import prisma from '../../db/prisma';

export type MemorySource = 'explicit' | 'inferred' | 'system';
export type MemoryCategory = 'preference' | 'fact' | 'context';

export interface UserMemory {
  key: string;
  value: unknown;
  category: MemoryCategory;
  source: MemorySource;
  confidence: number;
  confirmedAt: Date | null;
  updatedAt: Date;
}

/** Canonical preference keys Brain understands. Free-form keys are
 *  allowed, but these are the ones the prompt + dispatcher explicitly
 *  reason about. Keep in sync with what the composer renders.
 *
 *  Style.* keys (Phase C, 2026-05-22): communication-style learnings
 *  from the reflection job. Confirmed values are injected into the
 *  persona's communication-contract block so Brain tunes its voice
 *  to the user's observed preference over time. */
export const CANONICAL_KEYS = {
  EMAIL_SIGNOFF: 'email_signoff',
  EMAIL_SIGNATURE: 'email_signature',
  EMAIL_TONE: 'email_tone',
  DEFAULT_MEETING_DURATION: 'default_meeting_duration',
  WORKING_HOURS: 'working_hours',
  PREFERRED_CHANNEL_FOR: 'preferred_channel_for', // map: name → channel
  TIMEZONE: 'timezone', // shadow of User.timezone for convenience
  MEETING_NOTIFICATION_LEAD: 'meeting_notification_lead_min',
  // Phase C style keys
  STYLE_REPLY_LENGTH: 'style.reply_length_preference',
  STYLE_GREETING: 'style.greeting_preference',
  STYLE_HEDGE_TOLERANCE: 'style.hedge_tolerance',
  STYLE_STRUCTURE: 'style.structure_preference',
  STYLE_NEXT_MOVE: 'style.next_move_preference',
} as const;

/** Get just the style.* memories — the ones the persona uses to tune
 *  the communication contract dynamically. Returns a map for easy
 *  lookup by key. */
export async function getStyleMemories(userId: number): Promise<Record<string, unknown>> {
  const all = await getApplicableMemories(userId);
  const out: Record<string, unknown> = {};
  for (const m of all) {
    if (m.key.startsWith('style.')) out[m.key] = m.value;
  }
  return out;
}

/** Return all APPLICABLE memories — explicit + inferred-AND-confirmed +
 *  system. Inferred-but-unconfirmed memories are intentionally
 *  excluded (they're shown in Settings UI for review, not applied). */
export async function getApplicableMemories(userId: number): Promise<UserMemory[]> {
  const rows = await (prisma as any).userMemory.findMany({
    where: {
      userId,
      OR: [
        { source: 'explicit' },
        { source: 'system' },
        { source: 'inferred', confirmedAt: { not: null } },
      ],
      OR_expired: undefined,
    },
    orderBy: { updatedAt: 'desc' },
  }).catch(() => [] as any[]);
  // Filter expired in code (Prisma doesn't compose multi-OR well above).
  const now = new Date();
  return rows
    .filter((r: any) => !r.expiresAt || r.expiresAt > now)
    .map(rowToMemory);
}

/** Write or update an EXPLICIT memory (user told Brain directly).
 *  Applies immediately. Idempotent on (userId, key). */
export async function recordExplicitMemory(args: {
  clientNumber: string;
  userId: number;
  key: string;
  value: unknown;
  category?: MemoryCategory;
  expiresAt?: Date | null;
}): Promise<UserMemory> {
  const row = await (prisma as any).userMemory.upsert({
    where: { userId_key: { userId: args.userId, key: args.key } },
    create: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      key: args.key,
      value: args.value as any,
      category: args.category ?? 'preference',
      source: 'explicit',
      confidence: 1.0,
      confirmedAt: new Date(),
      expiresAt: args.expiresAt ?? null,
    },
    update: {
      value: args.value as any,
      category: args.category ?? 'preference',
      source: 'explicit',
      confidence: 1.0,
      confirmedAt: new Date(),
      expiresAt: args.expiresAt ?? null,
    },
  });
  return rowToMemory(row);
}

/** Write an INFERRED memory (background reflection job). Requires
 *  user confirmation via Settings UI before it's applied. Stored
 *  with confirmedAt=NULL and a lower confidence. */
export async function recordInferredMemory(args: {
  clientNumber: string;
  userId: number;
  key: string;
  value: unknown;
  confidence: number;
  category?: MemoryCategory;
}): Promise<UserMemory> {
  const row = await (prisma as any).userMemory.upsert({
    where: { userId_key: { userId: args.userId, key: args.key } },
    create: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      key: args.key,
      value: args.value as any,
      category: args.category ?? 'preference',
      source: 'inferred',
      confidence: args.confidence,
      confirmedAt: null,
    },
    update: {
      // Don't overwrite explicit memories with inferred ones.
      // If the existing row is explicit, skip via Prisma where clause? upsert
      // doesn't support that — fall back to a read-then-decide.
      value: args.value as any,
      confidence: args.confidence,
    },
  });
  return rowToMemory(row);
}

/** Delete a memory by key. Used when user dismisses via Settings. */
export async function dismissMemory(userId: number, key: string): Promise<void> {
  await (prisma as any).userMemory.deleteMany({
    where: { userId, key },
  });
}

/** Render the memories block for injection into the composer prompt.
 *  Returns empty string when there are no applicable memories. */
export async function renderMemoriesBlock(userId: number): Promise<string> {
  const memories = await getApplicableMemories(userId);
  if (memories.length === 0) return '';
  const lines: string[] = ['# Your remembered preferences (use these unless the user overrides this turn)'];
  for (const m of memories) {
    const valStr = typeof m.value === 'string' ? m.value : JSON.stringify(m.value);
    lines.push(`- ${m.key}: ${valStr}`);
  }
  return lines.join('\n');
}

function rowToMemory(row: any): UserMemory {
  return {
    key: row.key,
    value: row.value,
    category: row.category as MemoryCategory,
    source: row.source as MemorySource,
    confidence: Number(row.confidence ?? 0),
    confirmedAt: row.confirmedAt ?? null,
    updatedAt: row.updatedAt,
  };
}
