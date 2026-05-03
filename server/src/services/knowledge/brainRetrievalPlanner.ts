/**
 * Pass 1 of the two-pass query loop.
 *
 * Brain reads the schema + tenant_index + question and decides WHAT TO OPEN.
 * No regex keyword extraction. No stopword filtering. The LLM picks.
 *
 * Output is a structured plan. Parsed defensively; falls back to empty plan
 * on parse failure so the chat still works (just with no retrieval).
 */
import { callLLM } from '../llmRouter';
import { BRAIN_SCHEMA_VERSION, getBrainSchemaText } from './brainSchema';
import { getCompactIndexForPlanner } from './tenantIndexService';
import { getSystemCapabilities, renderCapabilitiesBlock } from './systemCapabilitiesService';

export type PlanIntent = 'casual' | 'factual' | 'introspective';

export interface RetrievalPlan {
  intent: PlanIntent;
  /** Page IDs from the tenant_index the planner wants to open. */
  openPageIds: string[];
  /** Entity names / emails to search (pg_trgm + relationshipStrength rank). */
  entityTerms: string[];
  /** FACL doc titles to pull FULL body for, not just preview. */
  faclTitles: string[];
  /** Free-text reason for the plan (debugging/telemetry). */
  rationale: string;
}

const EMPTY_PLAN: RetrievalPlan = {
  intent: 'casual',
  openPageIds: [],
  entityTerms: [],
  faclTitles: [],
  rationale: 'fallback:empty',
};

export async function planRetrieval(
  clientNumber: string,
  userId: number,
  question: string,
): Promise<RetrievalPlan> {
  const [schema, index, caps] = await Promise.all([
    Promise.resolve(getBrainSchemaText()),
    getCompactIndexForPlanner(clientNumber, userId),
    getSystemCapabilities(clientNumber, userId).catch(() => null),
  ]);

  const capsBlock = caps ? renderCapabilitiesBlock(caps) : '';

  const systemPrompt = `You are Brain's retrieval planner. Your ONLY job is to decide which wiki pages Brain should open before answering, and which entities or FACL docs to search. You never answer the question yourself.

# Brain schema (v${BRAIN_SCHEMA_VERSION})
${schema}

# Tenant index
${index}

# System capabilities (what Brain can actually access right now)
${capsBlock}

# Rules for planning
The composer does semantic vector search over the whole wiki for every non-casual question — you do NOT have to decompose multi-word subjects, add synonyms, or guess keywords. The vector layer matches "demo" to "CBL Demo" and "IP strategy" to any strategy page that talks about intellectual property, without keyword rules. Focus instead on INTENT and on surfacing FACL docs whose FULL body Brain should open (the vector stage returns previews only).

- **intent = "casual"** — small talk, greetings, identity small talk, jokes. Return empty arrays. The composer will reply from persona alone.
- **intent = "introspective"** — questions about Brain, the user, or the tenant as an entity ("who are you", "what can you access", "what do we do", "tell me about my company"). List the foundational FACL org_doc titles in \`faclTitles\` (Company Identity, Org Chart, OKR Tree, Strategy Decision Log) so Brain sees their FULL body, not just previews.
- **intent = "factual"** — the user wants a specific fact. List in \`faclTitles\` any FACL doc whose FULL body is likely the best single source (e.g. Drive Index for tenant-wide counts, Employee Profile Sheet for people questions, Sales Deals / Project Status for deal/project questions). You MAY also list specific page IDs in \`openPageIds\` if the index has an obvious perfect match — otherwise leave empty, the vector search will fill it.
- **entityTerms** is optional and narrow: include a name ONLY when the question names a specific person, company, or entity that Brain should also look up in the \`entities\` table (for relationship-strength ranking). Do NOT use it as a keyword expansion mechanism — that's what vector search is for. Typos handled by the vector layer automatically.
- Never return pages / titles that aren't listed in the index above.
- Output JSON only, no prose. No markdown fences.

# Output shape
{
  "intent": "casual" | "factual" | "introspective",
  "openPageIds": [string],
  "entityTerms": [string],
  "faclTitles": [string],
  "rationale": "one short sentence"
}`;

  const userMessage = `Question: ${question}`;

  try {
    const r = await callLLM(systemPrompt, userMessage, {
      maxTokens: 768,
      // Planner is a small structured call — prefer Flash for speed & cost.
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId, clientNumber, purpose: 'retrieval_plan',
    });
    return parsePlan(r.text);
  } catch {
    return EMPTY_PLAN;
  }
}

function parsePlan(text: string): RetrievalPlan {
  // Extract the first {...} block — Gemini sometimes wraps in ```json fences.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return EMPTY_PLAN;
  try {
    const obj = JSON.parse(match[0]);
    const intent: PlanIntent =
      obj.intent === 'factual' || obj.intent === 'introspective' ? obj.intent : 'casual';
    return {
      intent,
      openPageIds: toStringArray(obj.openPageIds).slice(0, 8),
      entityTerms: toStringArray(obj.entityTerms).slice(0, 5),
      faclTitles: toStringArray(obj.faclTitles).slice(0, 5),
      rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 240) : '',
    };
  } catch {
    return EMPTY_PLAN;
  }
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim());
}
