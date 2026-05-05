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
/**
 * Orthogonal to PlanIntent. Tells the composer which wiki layer the
 * answer should LEAD with:
 *
 *   'personal' — about the user / their interactions / their tasks.
 *                Compose primarily from user-scoped pages; cite tenant
 *                pages only as background context.
 *   'org'      — about the company / policies / org structure / named
 *                tenant entities. Compose primarily from tenant pages;
 *                user pages only as personal overlay.
 *   'mixed'    — a named entity (project / person / topic) where both
 *                layers contribute. Lead with tenant facts (more
 *                authoritative), overlay with user-recent threads.
 *
 * The visibility filter at the SQL layer still enforces what each
 * user can SEE; this is purely about which layer the composer should
 * PREFER when both have material.
 */
export type ScopeLean = 'personal' | 'org' | 'mixed';

export interface RetrievalPlan {
  intent: PlanIntent;
  scopeLean: ScopeLean;
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
  scopeLean: 'mixed',
  openPageIds: [],
  entityTerms: [],
  faclTitles: [],
  rationale: 'fallback:empty',
};

export interface PlannerHistoryTurn {
  role: 'user' | 'brain';
  text: string;
}

/**
 * Render the recent conversation as a compact block the planner can read.
 * Only the last 4 turns matter for follow-up resolution; older context
 * is captured by the wiki pages anyway.
 */
function renderHistoryBlock(history: PlannerHistoryTurn[]): string {
  if (!history.length) return '';
  const recent = history.slice(-4);
  const lines = recent.map((t) => {
    const who = t.role === 'user' ? 'User' : 'Brain';
    const txt = t.text.slice(0, 400);
    return `${who}: ${txt}`;
  });
  return `\n# Recent conversation (most recent last)\n${lines.join('\n')}\n`;
}

export async function planRetrieval(
  clientNumber: string,
  userId: number,
  question: string,
  history: PlannerHistoryTurn[] = [],
): Promise<RetrievalPlan> {
  const [schema, index, caps] = await Promise.all([
    Promise.resolve(getBrainSchemaText()),
    getCompactIndexForPlanner(clientNumber, userId),
    getSystemCapabilities(clientNumber, userId).catch(() => null),
  ]);

  const capsBlock = caps ? renderCapabilitiesBlock(caps) : '';
  const historyBlock = renderHistoryBlock(history);

  const systemPrompt = `You are Brain's retrieval planner. Your ONLY job is to decide which wiki pages Brain should open before answering, and which entities or FACL docs to search. You never answer the question yourself.

# Brain schema (v${BRAIN_SCHEMA_VERSION})
${schema}

# Tenant index
${index}

# System capabilities (what Brain can actually access right now)
${capsBlock}
${historyBlock}
# Follow-up resolution
If the user's current question is short or refers to "it/that/this" without a clear noun, treat it as a follow-up to the most recent Brain turn above and plan retrieval AS IF the implied subject from that turn is part of the question. Example: Brain just said "missing admin authorization for FACL"; user asks "what kind of authorization?" → plan as if they asked "what kind of authorization is needed for FACL".

# Rules for planning
The composer does semantic vector search over the whole wiki for every non-casual question — you do NOT have to decompose multi-word subjects, add synonyms, or guess keywords. The vector layer matches "demo" to "CBL Demo" and "IP strategy" to any strategy page that talks about intellectual property, without keyword rules. Focus instead on INTENT and on surfacing FACL docs whose FULL body Brain should open (the vector stage returns previews only).

- **intent = "casual"** — small talk, greetings, identity small talk, jokes. Return empty arrays. The composer will reply from persona alone.
- **intent = "introspective"** — questions about Brain, the user, or the tenant as an entity ("who are you", "what can you access", "what do we do", "tell me about my company"). List the foundational FACL org_doc titles in \`faclTitles\` (Company Identity, Org Chart, OKR Tree, Strategy Decision Log) so Brain sees their FULL body, not just previews.
- **intent = "factual"** — the user wants a specific fact. List in \`faclTitles\` any FACL doc whose FULL body is likely the best single source (e.g. Drive Index for tenant-wide counts, Employee Profile Sheet for people questions, Sales Deals / Project Status for deal/project questions). You MAY also list specific page IDs in \`openPageIds\` if the index has an obvious perfect match — otherwise leave empty, the vector search will fill it.
- **entityTerms** is optional and narrow: include a name ONLY when the question names a specific person, company, or entity that Brain should also look up in the \`entities\` table (for relationship-strength ranking). Do NOT use it as a keyword expansion mechanism — that's what vector search is for. Typos handled by the vector layer automatically.
- Never return pages / titles that aren't listed in the index above.
- Output JSON only, no prose. No markdown fences.

# Scope lean — which wiki layer should LEAD the answer
Independent from intent. Tells the composer how to weight tenant vs user pages.

- **scopeLean = "personal"** — question is about the USER's own interactions, inbox, calendar, tasks, decisions. Phrases: "I", "me", "my", "what did X tell ME", "MY meetings", "MY tasks". Answer should LEAD with user-scoped pages (sender_history, sender_topic, mind_state, answer, gap, observation). Tenant pages may add background.
- **scopeLean = "org"** — question is about the COMPANY: policies, SOPs, org chart, named tenant entities (FACL docs, Drive Index, Sales Deals, Project Status). Phrases: "our policy", "the company", "who handles", named org doc. Answer should LEAD with tenant-scoped pages. User pages add no value.
- **scopeLean = "mixed"** — a named entity (project / person / topic) that has BOTH layers contributing. Phrases: "what's happening with Project X", "tell me about Asad", "status of MATRIX". Lead with tenant facts (more authoritative on definitions/status), then OVERLAY with user-recent threads (more current on day-to-day).

When in doubt → "mixed". Better to retrieve more than to miss context.

# Output shape
{
  "intent": "casual" | "factual" | "introspective",
  "scopeLean": "personal" | "org" | "mixed",
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
    const scopeLean: ScopeLean =
      obj.scopeLean === 'personal' || obj.scopeLean === 'org' ? obj.scopeLean : 'mixed';
    return {
      intent,
      scopeLean,
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
