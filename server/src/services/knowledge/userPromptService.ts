/**
 * MyOS Knowledge — user-authored prompts.
 *
 * Loads active prompts for a given scope and returns them as a single
 * block to prepend onto Brain's system prompts. Scope defaults:
 *   - 'triage'       — when classifying new feed_events
 *   - 'draft_reply'  — when composing replies
 *   - 'delegation'   — when writing forward cover-notes
 *   - 'global'       — always applied (adds to all three)
 *
 * Cached 60s per (user, scope) to avoid a DB hit on every LLM call.
 */
import prisma from '../../db/prisma';

type Scope = 'triage' | 'draft_reply' | 'delegation' | 'whatsapp_reply' | 'global';

interface CacheEntry { text: string; fetchedAt: number }
const cache = new Map<string, CacheEntry>();
const TTL_MS = 60 * 1000;

export async function activePromptsFor(userId: number, scope: Scope): Promise<string> {
  const key = `${userId}:${scope}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.text;

  const rows = await prisma.userPrompt.findMany({
    where: {
      userId, isActive: true,
      scope: { in: ['global', scope] },
    },
    orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    select: { text: true },
  }).catch(() => [] as Array<{ text: string }>);

  const text = rows.length === 0
    ? ''
    : rows.map((r, i) => `${i + 1}. ${r.text.trim()}`).join('\n');
  cache.set(key, { text, fetchedAt: Date.now() });
  return text;
}

/** Wrap a system prompt with the user's active rules for this scope. */
export async function withUserPrompts(basePrompt: string, userId: number, scope: Scope): Promise<string> {
  // A0-email (2026-07-09): this is the chokepoint every specialized
  // composer (forward notes, deadline inquiries, chases, WA replies,
  // triage) already calls — so it now also carries the brain voice
  // context: standing instructions, learned preferences, governed
  // memories. Previously those applied in Brain chat but NOT in the
  // emails Brain wrote in the user's voice — the two-brains fork,
  // email edition. Tone samples stay per-channel at each call site;
  // this adds only what Brain KNOWS, never how it sounds.
  const [userRules, voiceContext] = await Promise.all([
    activePromptsFor(userId, scope),
    (async () => {
      const { renderBrainVoiceContext } = await import('./brainVoiceContext');
      return renderBrainVoiceContext(userId);
    })().catch(() => ''),
  ]);
  let out = basePrompt;
  if (userRules) out += `\n\n# User's own rules (follow these exactly; they override defaults where they conflict)\n${userRules}`;
  if (voiceContext) out += `\n\n${voiceContext}`;
  return out;
}
