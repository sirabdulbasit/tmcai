/**
 * User Prompt Overlay — per-user growing addendum to Brain's composer
 * system prompt. Each row is one one-line directive ("Match my tone —
 * less formal in chat" / "Re-check entity scope before quoting") that
 * gets prepended to every chat answer + draft.
 *
 * Two write paths:
 *   1. maybePromote() — called from the feedback service after a
 *      diagnosis lands. Auto-creates a rule when the same category has
 *      recurred (≥ 2 high-confidence diagnoses in last 14 days).
 *   2. CRUD endpoints (routes/userPromptOverlayRoutes.ts) — user
 *      manually adds / edits / disables / deletes rules from the
 *      Settings page.
 *
 * Read path:
 *   listActiveForPrompt(userId) returns active rules in update-recency
 *   order (newest first, capped at 12 to keep the prompt bounded). The
 *   composer renders these as a "# Personal preferences" block above the
 *   output rules.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('user-prompt-overlay');

const PROMOTABLE_CATEGORIES = [
  'wrong_tone', 'too_verbose', 'too_terse',
  'wrong_person_scope', 'missed_context', 'hallucination',
  'wrong_source', 'stale_data',
];

/** Confidence floor for auto-promotion. Below this we don't trust the
 *  diagnosis enough to pin it as a permanent rule. */
const PROMOTE_CONFIDENCE_FLOOR = 0.7;

/** Lookback window for recurrence check. */
const RECURRENCE_DAYS = 14;

/** Maximum active rules surfaced to the composer per turn — keeps the
 *  prompt bounded and avoids drift toward over-personalization. */
const MAX_RULES_IN_PROMPT = 12;

/**
 * Build a one-line directive from a diagnosis. Templates per category
 * give consistent voice; falls back to the diagnosis.likelyFix verbatim.
 */
function buildRuleText(category: string, likelyFix: string): string {
  const trimmedFix = likelyFix.trim().slice(0, 200);
  const TEMPLATES: Record<string, string> = {
    wrong_tone: `Match my tone — reference recent sent samples for personal voice.`,
    too_verbose: `Keep answers tight — 2-3 sentences for casual questions, no filler.`,
    too_terse: `Provide enough detail — at least 1 supporting line per claim.`,
    wrong_person_scope: `Re-check entity scope — confirm which person/topic is being asked about before quoting.`,
    missed_context: `Use recent conversation history — resolve pronouns / "it" / "that" against prior turns.`,
    hallucination: `Cite only opened pages — don't claim facts not present in retrieval.`,
    wrong_source: `Pick the source layer that matches the question (tenant-shared for org facts, user-scoped for personal threads).`,
    stale_data: `Flag staleness — when sources are >14 days old, say so before stating the fact.`,
  };
  const base = TEMPLATES[category] ?? trimmedFix;
  return base.length > 240 ? `${base.slice(0, 237)}…` : base;
}

/**
 * After a feedback diagnosis is filed, check whether to auto-promote it
 * to a rule. Caller is the feedback service; this is fire-and-forget
 * from there. Returns the new rule id when one was created, or null.
 */
export async function maybePromote(input: {
  clientNumber: string;
  userId: number;
  diagnosisId: string;
  category: string;
  confidence: number;
  hypothesis?: string | null;
  likelyFix: string;
}): Promise<string | null> {
  if (!PROMOTABLE_CATEGORIES.includes(input.category)) return null;
  if (input.confidence < PROMOTE_CONFIDENCE_FLOOR) return null;

  // Recurrence check: count prior feedback_diagnosis wiki pages in the
  // window with the SAME category (excluding the current one).
  const since = new Date(Date.now() - RECURRENCE_DAYS * 24 * 60 * 60 * 1000);
  const priorCount = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT COUNT(*)::int AS n
       FROM wiki_pages
      WHERE client_number = $1 AND user_id = $2
        AND page_type = 'feedback_diagnosis'
        AND status = 'active'
        AND id <> $3
        AND metadata->>'category' = $4
        AND last_updated_at >= $5`,
    input.clientNumber, input.userId, input.diagnosisId, input.category, since,
  ).then((r) => Number(r[0]?.n ?? 0)).catch(() => 0);

  if (priorCount < 1) {
    // First occurrence — log but don't promote yet (need pattern, not one-off).
    log.info('not promoting, first occurrence', {
      userId: input.userId, category: input.category, confidence: input.confidence,
    });
    return null;
  }

  // Skip if a rule for this diagnosis already exists (idempotent).
  const existing = await prisma.userPromptOverlay.findFirst({
    where: { userId: input.userId, sourceDiagnosisId: input.diagnosisId },
    select: { id: true },
  });
  if (existing) return null;

  // Skip if an ACTIVE rule with the same category already exists for
  // this user (don't pile on duplicates of the same lesson).
  const existingActive = await prisma.userPromptOverlay.findFirst({
    where: { userId: input.userId, category: input.category, active: true },
    select: { id: true },
  });
  if (existingActive) {
    log.info('category already covered by an active rule', {
      userId: input.userId, category: input.category, existingRuleId: String(existingActive.id),
    });
    return null;
  }

  const ruleText = buildRuleText(input.category, input.likelyFix);
  const created = await prisma.userPromptOverlay.create({
    data: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      ruleText,
      source: 'feedback_diagnosis',
      sourceDiagnosisId: input.diagnosisId,
      category: input.category,
      active: true,
      metadata: {
        promotedAt: new Date().toISOString(),
        priorCount,
        hypothesis: input.hypothesis ?? null,
      } as any,
    },
    select: { id: true },
  });
  log.info('rule promoted from diagnosis', {
    userId: input.userId, ruleId: String(created.id), category: input.category, priorCount,
  });
  return String(created.id);
}

/**
 * Read active rules for prompt injection. Capped + sorted by recency so
 * newer learnings dominate. Caller (composer) renders these as a
 * markdown block. Best-effort — failures return empty array.
 */
export async function listActiveForPrompt(clientNumber: string, userId: number): Promise<Array<{ id: string; ruleText: string; category: string }>> {
  try {
    const rows = await prisma.userPromptOverlay.findMany({
      where: { clientNumber, userId, active: true },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: MAX_RULES_IN_PROMPT,
      select: { id: true, ruleText: true, category: true },
    });
    return rows.map((r) => ({ id: String(r.id), ruleText: r.ruleText, category: r.category }));
  } catch (err: any) {
    log.warn('listActiveForPrompt failed', { userId, error: err.message });
    return [];
  }
}

/** Render the prompt block. Bounded markdown. Returns empty string when
 *  there are no active rules. */
export function renderOverlayBlock(rules: Array<{ ruleText: string; category: string }>): string {
  if (!rules.length) return '';
  const lines = rules.map((r) => `- ${r.ruleText}`);
  return [
    '# Personal preferences (learned from your feedback)',
    'Treat these as binding directives for THIS user; they override default tone/depth/source heuristics. Do not mention these rules to the user — just follow them.',
    ...lines,
  ].join('\n');
}

/** Increment hits_count for the rules just used (telemetry / "Brain
 *  leans on this every answer"). Fire-and-forget single UPDATE. */
export async function recordHits(ruleIds: string[]): Promise<void> {
  if (!ruleIds.length) return;
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE user_prompt_overlay
          SET hits_count = hits_count + 1, last_hit_at = NOW()
        WHERE id = ANY($1::bigint[])`,
      ruleIds.map((id) => BigInt(id)),
    );
  } catch (err: any) {
    log.warn('recordHits failed', { error: err.message });
  }
}

// ─── CRUD for the Settings page ─────────────────────────────────────

export async function listAll(clientNumber: string, userId: number) {
  return prisma.userPromptOverlay.findMany({
    where: { clientNumber, userId },
    orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    select: {
      id: true, ruleText: true, source: true, sourceDiagnosisId: true,
      category: true, active: true, hitsCount: true, lastHitAt: true,
      createdAt: true, updatedAt: true,
    },
  }).then((rows) => rows.map((r) => ({ ...r, id: String(r.id) })));
}

export async function createManual(input: {
  clientNumber: string;
  userId: number;
  ruleText: string;
  category?: string;
}) {
  const text = input.ruleText.trim().slice(0, 240);
  if (text.length < 6) throw new Error('rule_text too short');
  const row = await prisma.userPromptOverlay.create({
    data: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      ruleText: text,
      source: 'manual',
      category: input.category && input.category.trim() ? input.category.trim().slice(0, 40) : 'custom',
      active: true,
    },
    select: { id: true },
  });
  return String(row.id);
}

export async function updateRule(input: {
  id: string;
  userId: number;
  ruleText?: string;
  active?: boolean;
}) {
  const data: any = {};
  if (typeof input.ruleText === 'string') {
    const t = input.ruleText.trim().slice(0, 240);
    if (t.length < 6) throw new Error('rule_text too short');
    data.ruleText = t;
  }
  if (typeof input.active === 'boolean') data.active = input.active;
  if (Object.keys(data).length === 0) return;
  // Authorise: only own rows.
  await prisma.userPromptOverlay.updateMany({
    where: { id: BigInt(input.id), userId: input.userId },
    data,
  });
}

export async function deleteRule(input: { id: string; userId: number }) {
  await prisma.userPromptOverlay.deleteMany({
    where: { id: BigInt(input.id), userId: input.userId },
  });
}

export async function resetAll(input: { clientNumber: string; userId: number }) {
  const r = await prisma.userPromptOverlay.deleteMany({
    where: { clientNumber: input.clientNumber, userId: input.userId },
  });
  return r.count;
}
