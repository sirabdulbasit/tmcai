/**
 * reflectionJob — periodic background extraction of inferred user
 * preferences from recent conversations.
 *
 * Quality Sprint 5c (2026-05-21). Brain notices patterns ("you've
 * changed 'Thanks' to 'Best regards' three times" / "you usually
 * delegate Phoenix items to Asad" / "your meetings tend to be 45
 * minutes") and proposes them as INFERRED memories — stored with
 * confirmedAt=NULL so they're visible in Settings → Brain →
 * Memories for the user to confirm or dismiss.
 *
 * Safety constraint from the third-party review: NO silent learning.
 * Every memory the reflection job creates requires explicit user
 * confirmation before it's injected into the composer prompt.
 *
 * Runs per-user. Bounded: max 50 turns scanned, max 5 candidate
 * preferences proposed per run. Idempotent — skips memories already
 * present (explicit or inferred).
 *
 * Trigger:
 *   - Scheduled: every 6 hours per active user via the existing
 *     job scheduler (or manually via runReflectionForUser).
 *   - Hot-path: NOT called from compose; reflection must never
 *     block a user turn.
 */
import prisma from '../db/prisma';
import { recordInferredMemory, getApplicableMemories } from '../services/knowledge/userMemoryService';
import { callGemini } from '../services/geminiService';

const TURNS_TO_SCAN = 50;
const MAX_PROPOSALS_PER_RUN = 5;
const INFERRED_CONFIDENCE = 0.65;

interface ProposedPreference {
  key: string;
  value: unknown;
  rationale: string;
  evidence_excerpt: string;
}

/** Run reflection for a single user. Returns count of new inferred
 *  memories proposed (existing ones are skipped, not duplicated). */
export async function runReflectionForUser(
  userId: number,
  clientNumber: string,
): Promise<{ proposedCount: number; skippedCount: number }> {
  // Pull recent turns from this user's WhatsApp + web sessions.
  // For now, focus on WhatsApp session history (web doesn't yet
  // persist turn-by-turn).
  const sessions = await prisma.$queryRawUnsafe<Array<{ conversation_history: unknown }>>(
    `SELECT conversation_history FROM whatsapp_sessions
     WHERE user_id = $1 AND client_number = $2 AND last_message_at > NOW() - INTERVAL '7 days'
     ORDER BY last_message_at DESC LIMIT 5`,
    userId, clientNumber,
  ).catch(() => [] as any[]);

  const turns: Array<{ role: string; content: string }> = [];
  for (const s of sessions) {
    const hist = (s.conversation_history as any[]) || [];
    for (const h of hist) {
      if (h?.role === 'user' || h?.role === 'assistant') {
        turns.push({ role: h.role, content: String(h.content ?? '') });
      }
    }
  }
  if (turns.length < 6) {
    // Not enough conversation to learn from.
    return { proposedCount: 0, skippedCount: 0 };
  }
  const recentTurns = turns.slice(-TURNS_TO_SCAN);

  // Existing memories (any source) — to avoid re-proposing the same
  // preference and to avoid overriding explicit ones.
  const existing = await getApplicableMemories(userId);
  const existingKeys = new Set(existing.map((m) => m.key));

  // Build a focused prompt that asks Flash to extract candidate
  // preferences with evidence. Output is strict JSON.
  const systemPrompt = `You are a reflection agent for a personal AI assistant. Read the recent conversation and propose up to ${MAX_PROPOSALS_PER_RUN} INFERRED user preferences that would help the assistant in future turns.

Output strictly JSON:
{
  "proposals": [
    {
      "key": "<canonical key from the list below or a free-form snake_case key>",
      "value": <type matches key>,
      "rationale": "<one short sentence>",
      "evidence_excerpt": "<short quote from the conversation>"
    }
  ]
}

Canonical preference keys:
- email_signoff (string)
- email_signature (string)
- email_tone ("formal" | "casual" | "warm")
- default_meeting_duration (integer minutes)
- working_hours ({start: "HH:MM", end: "HH:MM"})
- preferred_channel_for ({"<name lowercase>": "email" | "whatsapp"})
- meeting_notification_lead_min (integer)

Rules:
- ONLY propose preferences that are clearly evidenced by the conversation. Don't guess.
- Skip a key if it's already in the existing-memories list.
- Skip if you have less than 2 instances of supporting evidence (e.g., user changing 'Thanks' to 'Best regards' only once is not enough).
- Output an empty array if nothing solid emerges.
- No prose outside the JSON.

Existing memories (do not propose duplicates):
${existing.length === 0 ? '(none)' : existing.map((m) => `- ${m.key}: ${JSON.stringify(m.value)}`).join('\n')}`;

  const userPayload = recentTurns.map((t, i) =>
    `[${i + 1}] ${t.role}: ${t.content.slice(0, 400)}`,
  ).join('\n');

  let raw: string;
  try {
    raw = await callGemini(systemPrompt, userPayload, {
      maxTokens: 1024,
      flash: true,
      responseMimeType: 'application/json',
    });
  } catch (e: any) {
    console.warn('[reflection] LLM call failed', { userId, error: e?.message });
    return { proposedCount: 0, skippedCount: 0 };
  }

  let parsed: { proposals?: ProposedPreference[] } = {};
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn('[reflection] parse failed', { userId, rawHead: raw.slice(0, 100) });
    return { proposedCount: 0, skippedCount: 0 };
  }
  const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];

  let proposedCount = 0;
  let skippedCount = 0;
  for (const p of proposals.slice(0, MAX_PROPOSALS_PER_RUN)) {
    if (!p || typeof p.key !== 'string' || p.value === undefined || p.value === null) {
      skippedCount++;
      continue;
    }
    if (existingKeys.has(p.key)) {
      skippedCount++;
      continue;
    }
    try {
      await recordInferredMemory({
        clientNumber,
        userId,
        key: p.key,
        value: p.value,
        confidence: INFERRED_CONFIDENCE,
      });
      proposedCount++;
    } catch (e: any) {
      console.warn('[reflection] memory write failed', { userId, key: p.key, error: e?.message });
      skippedCount++;
    }
  }
  console.info('[reflection] done', { userId, proposedCount, skippedCount, scannedTurns: recentTurns.length });
  return { proposedCount, skippedCount };
}

/** Run reflection for every active user. Suitable for a cron tick.
 *  Returns aggregate counts. */
export async function runReflectionForAllUsers(): Promise<{
  usersProcessed: number;
  totalProposed: number;
  totalSkipped: number;
}> {
  const activeUsers = await prisma.user.findMany({
    where: {
      isActive: true,
      // Heuristic: only reflect on users who've actually used Brain recently.
      // Skipping the join makes this fast; we re-filter inside runReflectionForUser
      // by checking conversation_history non-empty.
    },
    select: { id: true, clientNumber: true },
    take: 200, // cap per tick to avoid runaway
  });
  let totalProposed = 0;
  let totalSkipped = 0;
  for (const u of activeUsers) {
    const r = await runReflectionForUser(u.id, u.clientNumber).catch(() => ({ proposedCount: 0, skippedCount: 0 }));
    totalProposed += r.proposedCount;
    totalSkipped += r.skippedCount;
  }
  return {
    usersProcessed: activeUsers.length,
    totalProposed,
    totalSkipped,
  };
}
