/**
 * semanticDedupService — pre-create duplicate detection for open items.
 *
 * Two layers, both at the gate (server/src/services/openItems/openItemGate.ts):
 *
 *   1. Exact dedup by (userId, sourceFeed, sourceRef). A genuine
 *      double-create — same feed event hits us twice via different
 *      paths (e.g. real-time message + backfill, or webhook + poll).
 *      Cheap DB query; no LLM.
 *
 *   2. Semantic dedup — when a NEW item's title/description points
 *      at the same loop as an EXISTING open item. e.g. user
 *      delegates "follow up with Aziz on the contract" while an
 *      item titled "Aziz - contract review" already exists.
 *
 *      Two-step to keep LLM cost bounded:
 *        a) Structural pre-filter: pull last ~50 OPEN items for the
 *           user, score Jaccard token overlap on titles. Only items
 *           with ≥0.2 overlap become candidates. Skips the LLM call
 *           entirely when there's no plausible match.
 *        b) LLM judges the candidates — same loop or different?
 *           Returns the matched item id + a short reason. Per
 *           [[feedback_no_hardcoded_judgement]] the actual "is this
 *           the same loop?" judgement is LLM-with-context, never a
 *           regex / Jaccard threshold.
 *
 * Caller (the gate) blocks the create when a duplicate is found and
 * returns the existing item id so the surface (UI / chat) can show
 * "you already have this — see <existing>" instead of silently dropping.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';

const log = createLogger('semantic-dedup');

export interface DedupCandidate {
  itemId: string;
  reason: string;
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'or', 'but', 'the', 'this', 'that', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'has', 'have', 'had',
  'do', 'does', 'did', 'will', 'would', 'should', 'could', 'can', 'may',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'about',
  'as', 'into', 'than', 'then', 're', 'fwd', 'fw', 'pl', 'pls', 'plz',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'my', 'our', 'your', 'their',
  'me', 'us', 'them', 'him', 'her',
]);

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  const tokens = (s || '').toLowerCase().match(/\b[a-z][a-z0-9'-]{1,}\b/g) ?? [];
  for (const t of tokens) {
    if (t.length < 3) continue;
    if (STOPWORDS.has(t)) continue;
    out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── Layer 1: Exact (sourceFeed, sourceRef) ─────────────────────────

export async function findExactDuplicate(args: {
  userId: number;
  sourceFeed: string | null | undefined;
  sourceRef: string | null | undefined;
}): Promise<DedupCandidate | null> {
  if (!args.sourceFeed || !args.sourceRef) return null;
  try {
    const existing = await prisma.openItem.findFirst({
      where: {
        userId: args.userId,
        sourceFeed: args.sourceFeed,
        sourceRef: args.sourceRef,
        // Only count rows that are still open — a closed identical
        // item from months ago shouldn't block a fresh create.
        status: { notIn: ['CLOSED', 'closed'] as any },
      } as any,
      select: { id: true, title: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!existing) return null;
    return {
      itemId: existing.id,
      reason: `Same source event (${args.sourceFeed}/${args.sourceRef}) already produced "${existing.title.slice(0, 80)}".`,
    };
  } catch (err: any) {
    log.warn('exact dedup lookup failed', { err: err.message });
    return null;
  }
}

// ─── Layer 2: Semantic ──────────────────────────────────────────────

interface CandidateRow {
  id: string;
  title: string;
  description: string | null;
  delegateeName: string | null;
  delegateeEmail: string | null;
  createdAt: Date;
}

const SEMANTIC_SYSTEM = `You decide whether a NEW open item is the same loop as one of EXISTING open items.

"Same loop" means: same person, same topic, same expected next action — even if worded differently. For example "follow up with Aziz on the contract" and "Aziz - contract review" are the SAME LOOP. But "Aziz - contract review" and "Aziz - hiring Q3 budget" are DIFFERENT LOOPS even though same person.

Output ONLY this JSON, nothing else:
{"verdict": "duplicate" | "distinct", "matchedItemId": "<id from candidates or null>", "reason": "<one short sentence>"}

Be CONSERVATIVE. Return "distinct" when uncertain. Only return "duplicate" when the new item clearly closes the same loop as an existing one.`;

function buildSemanticUserPrompt(
  newTitle: string,
  newDescription: string,
  newDelegatee: string | null,
  candidates: CandidateRow[],
): string {
  const candidateBlock = candidates.map((c, i) => {
    const ageDays = Math.floor((Date.now() - c.createdAt.getTime()) / 86_400_000);
    return [
      `--- CANDIDATE ${i + 1} (id=${c.id}, ${ageDays}d old) ---`,
      `Title:     ${c.title}`,
      c.delegateeName || c.delegateeEmail ? `Delegatee: ${c.delegateeName ?? ''} <${c.delegateeEmail ?? ''}>` : '',
      c.description ? `Detail:    ${c.description.slice(0, 300)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return [
    `## NEW item`,
    `Title:     ${newTitle}`,
    newDelegatee ? `Delegatee: ${newDelegatee}` : '',
    newDescription ? `Detail:    ${newDescription.slice(0, 300)}` : '',
    '',
    `## EXISTING open items (candidates)`,
    candidateBlock,
    '',
    `Decide. JSON only.`,
  ].filter(Boolean).join('\n');
}

export async function findSemanticDuplicate(args: {
  userId: number;
  clientNumber: string;
  newTitle: string;
  newDescription?: string | null;
  newDelegateeName?: string | null;
  newDelegateeEmail?: string | null;
}): Promise<DedupCandidate | null> {
  // 2a) Structural pre-filter.
  const recent = (await prisma.openItem.findMany({
    where: {
      userId: args.userId,
      status: { notIn: ['CLOSED', 'closed'] as any },
    } as any,
    select: {
      id: true, title: true, description: true,
      delegateeName: true, delegateeEmail: true, createdAt: true,
    } as any,
    orderBy: { createdAt: 'desc' },
    take: 50,
  })) as unknown as CandidateRow[];

  if (recent.length === 0) return null;

  const newTokens = tokenize(args.newTitle + ' ' + (args.newDescription ?? ''));
  if (newTokens.size === 0) return null;

  // Score every candidate; keep the top 5 by Jaccard if they cross 0.2.
  const scored = recent.map((c) => {
    const cTokens = tokenize(c.title + ' ' + (c.description ?? ''));
    return { row: c, score: jaccard(newTokens, cTokens) };
  })
  .filter((x) => x.score >= 0.2)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);

  if (scored.length === 0) return null;

  // 2b) LLM call.
  const newDelegatee = args.newDelegateeName || args.newDelegateeEmail || null;
  const userPrompt = buildSemanticUserPrompt(
    args.newTitle,
    args.newDescription ?? '',
    newDelegatee,
    scored.map((x) => x.row),
  );

  try {
    const r = await callLLM(SEMANTIC_SYSTEM, userPrompt, {
      maxTokens: 200,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: args.userId,
      clientNumber: args.clientNumber,
      purpose: 'open_item_semantic_dedup',
      timeoutMs: 8_000,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);
    if (obj.verdict !== 'duplicate') return null;
    const matchedId = String(obj.matchedItemId ?? '').trim();
    if (!matchedId) return null;
    // Sanity check the matched id is one we actually offered.
    if (!scored.some((x) => x.row.id === matchedId)) return null;
    const matched = scored.find((x) => x.row.id === matchedId)!.row;
    return {
      itemId: matched.id,
      reason: `Semantic duplicate of "${matched.title.slice(0, 80)}" — ${String(obj.reason ?? '').slice(0, 160)}`,
    };
  } catch (err: any) {
    log.warn('semantic dedup LLM failed', { err: err.message });
    return null;
  }
}
