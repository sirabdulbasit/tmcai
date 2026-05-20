/**
 * Pass 2 of the two-pass query loop.
 *
 * Brain receives ONLY the pages Pass 1 asked for (full body for FACL titles,
 * preview for the rest), plus persona + schema, and composes the answer.
 *
 * Structured output: { answer, cites: [pageId], gaps: [string] }.
 *
 * Honesty rules (from brain_schema.md, enforced here):
 *   H1. Only cite pages in the supplied context.
 *   H2. If opened pages don't cover the question, return a `gaps` string.
 *   H3. Prose for self/casual; bullets only when listing items the user asked for.
 *   H4. Opened pages override ambient org snapshot claims.
 */
import prisma from '../../db/prisma';
import { callLLM } from '../llmRouter';
import { BRAIN_SCHEMA_VERSION, getBrainSchemaText } from './brainSchema';
import { getBrainPersona } from './brainPersonaService';
import { getRecentTenantLog } from './tenantLogService';
import { getSystemCapabilities, renderCapabilitiesBlock } from './systemCapabilitiesService';
import { getLearnedPreferences, renderPreferencesBlock } from './preferenceLearnerService';
import { getActiveInstructions, renderInstructionsBlock } from './instructionService';
import { renderMatrixBlock as renderDelegationMatrixBlock } from './delegationMatrixService';
import { getLatestForUser as getLatestRiskFlagDoc } from '../brain/riskRadarService';
import { TENANT_SHARED_PAGE_TYPES } from './tenantIndexService';
import { searchWikiByVector } from './wikiEmbeddingService';
import type { RetrievalPlan } from './brainRetrievalPlanner';

export interface OpenedPage {
  id: string;
  title: string;
  pageType: string;
  body: string;
  /**
   * Visibility scope of the source page. Drives H11/H12/H13 in the
   * composer system prompt: which layer to lead with, the authority
   * hierarchy, and how citations are annotated. Falls back to 'user'
   * for safety when the source row pre-dates the scope column.
   */
  scope?: 'tenant' | 'user';
  relationshipStrength?: number | null;
  sourceRef: { type: string; id: string; snippet: string };
}

export interface ComposeResult {
  answer: string;
  citedPageIds: string[];
  gaps: string[];
  sources: Array<{ type: string; id: any; snippet: string }>;
  /** Action Brain wants to perform. Dispatched after compose returns;
   *  the resulting confirmation/error replaces or supplements `answer`. */
  action?: ComposedAction | null;
  /** Set when an action was attempted. The dispatch outcome is folded
   *  into the answer text; this is here for callers/logs. */
  actionResult?: { ok: boolean; artifactId?: string; message: string } | null;
}

/** The chat composer's structured action surface. Keep this list tight —
 *  every type needs a matching branch in dispatchBrainChatAction and a
 *  prompt entry telling the LLM when to emit it. */
export type ComposedAction =
  | { type: 'add_open_item'; title: string; dueDate?: string; note?: string }
  | { type: 'delegate_open_item'; openItemId: string; delegateeEmail: string; delegateeName: string; note?: string }
  | { type: 'schedule_meeting'; title: string; whenIso: string; durationMin?: number; attendeeEmails: string[]; attendeeNames: string[]; note?: string }
  | { type: 'send_email'; to: string[]; cc?: string[]; subject: string; body: string; replyToFeedEventId?: string }
  | { type: 'notify_via_whatsapp'; recipientName: string; recipientPhone: string; message: string }
  | { type: 'set_brain_name'; name: string };

/** Resolve plan → opened pages (full body where FACL titles were named).
 *  `query` is the raw user question, used for the semantic-vector search
 *  stage that replaces the old keyword decomposition. */
export async function openPagesForPlan(
  clientNumber: string,
  userId: number,
  plan: RetrievalPlan,
  query: string,
): Promise<OpenedPage[]> {
  const opened: OpenedPage[] = [];
  const seen = new Set<string>();

  // 1) By explicit page ID.
  //    Tenant-shared page types (org_doc, policy, project, decision,
  //    pattern) are visible to every user in the tenant — Brain should be
  //    able to open them regardless of which user owns the row. Other
  //    types stay user-scoped.
  if (plan.openPageIds.length > 0) {
    // Visibility: tenant-scoped pages open for any user in the tenant;
    // user-scoped only for the owner. See services/knowledge/wikiScope.ts.
    const pages = await prisma.wikiPage.findMany({
      where: {
        id: { in: plan.openPageIds },
        clientNumber,
        OR: [
          { scope: 'tenant' },
          { scope: 'user', userId },
        ],
      } as any,
      select: { id: true, title: true, pageType: true, bodyMarkdown: true, scope: true },
    }).catch(() => [] as any[]);
    for (const p of pages) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      opened.push(toOpenedPage(p));
    }
  }

  // 2) FACL titles — tenant-shared; open regardless of userId.
  if (plan.faclTitles.length > 0) {
    const faclPages = await prisma.wikiPage.findMany({
      where: {
        clientNumber, pageType: 'org_doc',
        title: { in: plan.faclTitles },
      },
      select: { id: true, title: true, pageType: true, bodyMarkdown: true, scope: true },
    }).catch(() => [] as any[]);
    for (const p of faclPages) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      opened.push(toOpenedPage(p));
    }
  }

  // 3) Semantic retrieval + smart ranker. Vector returns top-40; we then
  //    re-rank by (concept > source), (recent > stale), and dedupe
  //    multiple hits of the same thread so we don't fill the prompt with
  //    40 versions of the same content.
  if (plan.intent !== 'casual') {
    const vectorHits = await searchWikiByVector(clientNumber, userId, query, { limit: 40 });
    const ranked = await rankAndTrim(vectorHits, query, clientNumber, userId);
    for (const h of ranked) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      opened.push({
        id: h.id,
        title: h.title,
        pageType: h.pageType,
        body: String(h.bodyMarkdown ?? ''),
        scope: ((h as any).scope === 'tenant' ? 'tenant' : 'user') as 'tenant' | 'user',
        sourceRef: { type: 'wiki_page', id: h.id, snippet: h.title },
      });
    }
  }

  // 3aa) Query-shape boosters: inject page types the user clearly wants
  //      but that the vector top-40 may have missed.
  //
  //    Aggregation queries — always include every org_doc that carries
  //    a precomputed "## Computed aggregates" block. Deterministic truth
  //    beats LLM hand-counting on 500+ rows.
  //
  //    Email-thread / email-content queries — always include the top
  //    email_message pages by vector match on the same query, so the
  //    thread-continuity expansion (below) has something to walk from.
  const AGG_HINTS_Q = /\b(how many|count(s)?( of)?|total(s)?|break\s*up|break\s*down|per [a-z]+|wise|grade[- ]wise|department[- ]wise|gl[- ]wise|location[- ]wise)\b/i;
  // Broadened — also fires on:
  //   "what did X say/mention/tell/write/think/ask/propose/suggest"
  //   "who is X" / "who's X" / "who are X"        ← most common lookup
  //   "tell me about X" / "what do you know about X"
  //   "X's role" / "X's position"
  // Without this, a bare "who is gru?" slips past every booster and
  // relies on vector similarity alone — which under-ranks short
  // lowercase proper nouns and misses typos entirely.
  const EMAIL_HINTS_Q = /\b(email|thread|inbox|reply|replies|forwarded|sent me|wrote me|said in .*(mail|message)|what did [a-z][a-z'.-]{2,} (say|said|mention|mentioned|tell|told|write|wrote|think|thought|ask|asked|propose|proposed|suggest|suggested)|who(?:'s| is| are) [a-z][a-z'.-]{2,}|tell me about [a-z][a-z'.-]{2,}|what do you know about [a-z][a-z'.-]{2,})\b/i;

  if (plan.intent !== 'casual' && AGG_HINTS_Q.test(query)) {
    const aggPages = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown"
         FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'org_doc'
          AND status NOT IN ('superseded','deleted')
          AND body_markdown ILIKE '%## Computed aggregates%'
        ORDER BY last_updated_at DESC
        LIMIT 5`,
      clientNumber,
    ).catch(() => []);
    for (const p of aggPages) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      opened.push(toOpenedPage(p));
    }
  }

  // Person-lookup & email-content boosters. Note: we deliberately run
  // these even when the planner classified intent as 'casual' — the
  // classifier is unreliable on short lookup phrases ("who is Gru?",
  // "tell me about X"). If the query shape matches one of our booster
  // patterns, we've already confirmed it's a lookup, not small talk.
  if (EMAIL_HINTS_Q.test(query)) {
    // Vector pass — catches semantic matches ("what did X discuss", "follow-up about Y")
    const emailPages = await searchWikiByVector(clientNumber, userId, query, {
      limit: 6,
      pageTypes: ['email_message'],
      minScore: 0.25,
    });
    for (const h of emailPages) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
      opened.push({
        id: h.id, title: h.title, pageType: h.pageType,
        body: String(h.bodyMarkdown ?? ''),
        sourceRef: { type: 'wiki_page', id: h.id, snippet: h.title },
      });
    }
    // Keyword pass — catches short rare tokens ("EXIM", "SFML", "R-26-00081")
    // that vector embeddings don't rank well. Extract capitalised or
    // all-caps tokens from the query and do an ILIKE against email bodies.
    const distinctive = extractDistinctiveTokens(query);
    // Person-name pass — pull the subject out of "what did NAME say"
    // patterns so lowercase proper nouns (the user types "guru" not
    // "Guru") still trigger an exact-match scan. Without this, people
    // mentioned inside email bodies are invisible to retrieval.
    const personNames = extractPersonNamesFromQuery(query);
    const allLikeTokens = [...new Set([...distinctive, ...personNames])].slice(0, 6);
    if (allLikeTokens.length > 0) {
      for (const tok of allLikeTokens) {
        // Pass 1 — exact ILIKE against source pages. Fast + precise for
        // correctly-spelled names.
        const exact = await prisma.$queryRawUnsafe<any[]>(
          `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown"
             FROM wiki_pages
            WHERE client_number = $1 AND user_id = $2
              AND page_type IN ('email_message','attachment_doc','whatsapp_conversation','sender_topic')
              AND status NOT IN ('superseded','deleted')
              AND (title ILIKE '%' || $3 || '%' OR body_markdown ILIKE '%' || $3 || '%')
            ORDER BY last_updated_at DESC
            LIMIT 8`,
          clientNumber, userId, tok,
        ).catch(() => []);
        for (const p of exact) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          opened.push(toOpenedPage(p));
        }
        // Pass 2 — fuzzy fallback when exact returned zero rows. Covers
        // typos like "gru" → "Guru". Uses pg_trgm with a deliberately
        // loose threshold (0.22) for short tokens because trigram
        // similarity between short strings is naturally low. Wider net:
        // also searches concept pages (entity_person/topic) because
        // that's where the canonical name would live.
        //
        // IMPORTANT: exclude gap/answer pages so a stale "gap: about X"
        // row doesn't dominate the result when retrieval does find the
        // real content — that was a self-reinforcing miss loop.
        if (exact.length === 0 && tok.length >= 3) {
          const fuzzy = await prisma.$queryRawUnsafe<any[]>(
            `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown",
                    similarity(title, $3) AS sim
               FROM wiki_pages
              WHERE client_number = $1
                AND status NOT IN ('superseded','deleted')
                AND page_type IN ('entity_person','topic','email_message','attachment_doc','sender_topic')
                AND (user_id = $2 OR page_type IN ('entity_person','topic','attachment_doc'))
                AND similarity(title, $3) > 0.22
              ORDER BY similarity(title, $3) DESC
              LIMIT 5`,
            clientNumber, userId, tok,
          ).catch(() => []);
          for (const p of fuzzy) {
            if (seen.has(p.id)) continue;
            seen.add(p.id);
            opened.push(toOpenedPage(p));
          }
          // Pass 3 — fuzzy against body too if title didn't hit. Cheaper
          // second-degree miss: mentions of "Guru" inside email bodies
          // whose titles don't carry the name.
          if (fuzzy.length === 0) {
            const bodyFuzzy = await prisma.$queryRawUnsafe<any[]>(
              `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown"
                 FROM wiki_pages
                WHERE client_number = $1 AND user_id = $2
                  AND page_type IN ('email_message','attachment_doc','whatsapp_conversation','sender_topic')
                  AND status NOT IN ('superseded','deleted')
                  AND (body_markdown % $3 OR word_similarity($3, body_markdown) > 0.4)
                ORDER BY last_updated_at DESC
                LIMIT 5`,
              clientNumber, userId, tok,
            ).catch(() => []);
            for (const p of bodyFuzzy) {
              if (seen.has(p.id)) continue;
              seen.add(p.id);
              opened.push(toOpenedPage(p));
            }
          }
        }
      }
    }
  }

  // 3ab) Live Open Items + Calendar snapshots
  //
  //   The wiki layer doesn't store a live copy of every open_item or
  //   calendar event — those are mutable state that would bloat the
  //   compound memory. But the user still asks questions like "what's
  //   open right now?" or "what meetings do I have today?" expecting
  //   Brain to answer. Gather those on-demand and inject them as
  //   synthetic opened pages so the composer can cite them.
  if (plan.intent !== 'casual' && OPEN_ITEMS_HINTS_Q.test(query)) {
    try {
      const live = await buildOpenItemsSnapshot(clientNumber, userId, query);
      if (live) {
        seen.add(live.id);
        opened.push(live);
      }
    } catch { /* best-effort */ }
  }

  if (plan.intent !== 'casual' && CALENDAR_HINTS_Q.test(query)) {
    try {
      const cal = await buildCalendarSnapshot(clientNumber, userId, query);
      if (cal) {
        seen.add(cal.id);
        opened.push(cal);
      }
    } catch { /* best-effort */ }
  }

  // 3a) Thread continuity — when we open any email_message, also pull
  //     every other email_message in the same Gmail thread. A reply is
  //     useless without the original; a thread shown chronologically is
  //     how you reconstruct "what happened". Capped at 12 siblings per
  //     thread to keep the prompt bounded.
  const openedThreadIds = new Set<string>();
  for (const p of opened) {
    if (p.pageType !== 'email_message') continue;
    const meta = await prisma.wikiPage.findUnique({
      where: { id: p.id },
      select: { metadata: true },
    }).catch(() => null);
    const tid = (meta?.metadata as any)?.threadId;
    if (typeof tid === 'string' && tid) openedThreadIds.add(tid);
  }
  if (openedThreadIds.size > 0) {
    // CRITICAL: user_id filter REQUIRED. email_message pages are
    // scope='user' — without this clause, threads shared across users
    // (newsletters, mailing-list digests, AWS Partner notices, etc.)
    // leak siblings between users. Observed 2026-05-20: Haseeb's
    // "Experience is Strategy" email surfaced as one of Basit's "5
    // latest emails" because both users received messages on the same
    // Asian Business Review thread. Multi-tenancy breach, not a UX bug.
    const siblings = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown",
              metadata->>'date' AS "msgDate", metadata->>'threadId' AS "threadId"
         FROM wiki_pages
        WHERE client_number = $1
          AND user_id = $3
          AND page_type = 'email_message'
          AND metadata->>'threadId' = ANY($2::text[])
          AND status NOT IN ('superseded','deleted')
        ORDER BY last_updated_at ASC
        LIMIT 30`,
      clientNumber, Array.from(openedThreadIds), userId,
    ).catch(() => []);
    for (const s of siblings) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      opened.push(toOpenedPage(s));
    }
  }

  // 3b) Domain expansion — if the question mentions a company name that
  //     appears in any entity's email domain, pull every entity_person
  //     from that domain. Handles questions like "status of X at Y" when
  //     the relevant person wasn't the top semantic hit but does sit at
  //     that company.
  const companyHint = extractCompanyHint(query);
  if (companyHint) {
    const domainPeople = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown"
         FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'entity_person'
          AND status NOT IN ('superseded','deleted')
          AND (metadata->>'email' ILIKE '%' || $2 || '%' OR title ILIKE '%' || $2 || '%')
        ORDER BY last_updated_at DESC
        LIMIT 8`,
      clientNumber, companyHint,
    ).catch(() => []);
    for (const p of domainPeople) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      opened.push(toOpenedPage(p));
    }
  }

  // 3b) Cross-channel expansion. If any opened page has an entityId
  //     (a real human reconciled across email/phone/WA), pull every
  //     other wiki page for the same person. This is how Brain answers
  //     "what did Fahim say" holistically — with the email sender page
  //     + WhatsApp sender page + any attachment he sent, not just one.
  const seenEntities = new Set<string>();
  for (const p of opened) {
    const metadata = await prisma.wikiPage.findUnique({
      where: { id: p.id },
      select: { metadata: true },
    }).catch(() => null);
    const eid = (metadata?.metadata as any)?.entityId;
    if (typeof eid === 'string' && eid) seenEntities.add(eid);
  }
  if (seenEntities.size > 0) {
    const { getPagesLinkedToEntity } = await import('./personIdentityService');
    for (const eid of seenEntities) {
      const linked = await getPagesLinkedToEntity(clientNumber, eid);
      for (const l of linked) {
        if (seen.has(l.id)) continue;
        // Respect multi-tenancy: only surface user-scoped pages that
        // belong to this user (or tenant-shared types).
        // Visibility: tenant-scoped pages OK for anyone; user-scoped
        // pages must belong to this user. Driven by wiki_pages.scope.
        if (l.scope !== 'tenant' && l.userId !== userId) continue;
        const page = await prisma.wikiPage.findUnique({
          where: { id: l.id },
          select: { id: true, title: true, pageType: true, bodyMarkdown: true, scope: true },
        }).catch(() => null);
        if (!page) continue;
        seen.add(l.id);
        opened.push(toOpenedPage(page));
      }
    }
  }

  // 4) Entities — keep the entity-table lookup ONLY when the planner
  //    explicitly named specific terms. We still want the relationship
  //    strength signal (newsletter sender vs real contact) which isn't
  //    in the wiki-page vector space.
  if (plan.entityTerms.length > 0) {
    for (const term of plan.entityTerms) {
      const entityHits = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, entity_type AS "entityType", name, email, company,
                relationship_strength AS "relationshipStrength"
           FROM entities
          WHERE client_number = $2
            AND (
              COALESCE(name,'')    ILIKE '%' || $1 || '%'
              OR COALESCE(email,'')   ILIKE '%' || $1 || '%'
              OR COALESCE(company,'') ILIKE '%' || $1 || '%'
              OR similarity(COALESCE(name,''),    $1) > 0.25
              OR similarity(COALESCE(email,''),   $1) > 0.25
              OR similarity(COALESCE(company,''), $1) > 0.25
            )
          ORDER BY relationship_strength DESC NULLS LAST,
                   GREATEST(
                     similarity(COALESCE(name,''),    $1),
                     similarity(COALESCE(email,''),   $1),
                     similarity(COALESCE(company,''), $1)
                   ) DESC
          LIMIT 5`,
        term, clientNumber,
      ).catch(() => []);
      for (const e of entityHits) {
        const id = `entity:${e.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        opened.push({
          id,
          title: `${e.name}${e.email ? ` <${e.email}>` : ''}`,
          pageType: `entity_${e.entityType}`,
          body: `${e.entityType.toUpperCase()}: ${e.name}${e.email ? ` <${e.email}>` : ''}${e.company ? ` @ ${e.company}` : ''} · relationship strength ${e.relationshipStrength ?? 0}`,
          relationshipStrength: e.relationshipStrength,
          sourceRef: { type: 'entity', id: e.id, snippet: `${e.name}${e.email ? ` <${e.email}>` : ''}` },
        });
        // Pull every wiki page linked to this entity — full cross-channel
        // view of the person (email + WhatsApp + attachments + topics).
        const { getPagesLinkedToEntity } = await import('./personIdentityService');
        const linked = await getPagesLinkedToEntity(clientNumber, e.id);
        for (const l of linked) {
          if (seen.has(l.id)) continue;
          // Visibility: tenant-scoped pages OK for anyone; user-scoped
        // pages must belong to this user. Driven by wiki_pages.scope.
        if (l.scope !== 'tenant' && l.userId !== userId) continue;
          const page = await prisma.wikiPage.findUnique({
            where: { id: l.id },
            select: { id: true, title: true, pageType: true, bodyMarkdown: true, scope: true },
          }).catch(() => null);
          if (!page) continue;
          seen.add(l.id);
          opened.push(toOpenedPage(page));
        }
      }
    }
  }

  return opened;
}

function toOpenedPage(p: { id: string; title: string; pageType: string; bodyMarkdown: string | null; scope?: string | null }): OpenedPage {
  // Tag scope on the OpenedPage so the composer prompt's per-page
  // header can carry it through to H11/H12/H13. Default to 'user' if
  // the source row pre-dates the scope column.
  const scope = (p.scope === 'tenant' ? 'tenant' : 'user') as 'tenant' | 'user';
  return {
    id: p.id,
    title: p.title,
    pageType: p.pageType,
    body: String(p.bodyMarkdown ?? ''),
    scope,
    sourceRef: { type: 'wiki_page', id: p.id, snippet: p.title },
  };
}

export interface ComposerHistoryTurn {
  role: 'user' | 'brain';
  text: string;
}

function renderComposerHistoryBlock(history: ComposerHistoryTurn[]): string {
  if (!history.length) return '';
  const recent = history.slice(-6);
  const lines = recent.map((t) => {
    const who = t.role === 'user' ? 'User' : 'Brain';
    const txt = t.text.slice(0, 600);
    return `${who}: ${txt}`;
  });
  return `Recent conversation (most recent last):\n${lines.join('\n')}\n\n`;
}

export interface ComposeOptions {
  /** Free-text guidance prepended to the system prompt. Used by the chat
   *  retry loop to feed in the previous-turn diagnosis ("you cited the
   *  wrong person — re-scope to Omar") so the LLM corrects course on the
   *  second attempt. Bounded to 1000 chars by the caller. */
  steeringHint?: string | null;
  /** Target rendering channel — drives compactness, formatting choice,
   *  and the renderer's later trim limit. 'whatsapp' tells the LLM to
   *  produce one-line-per-item compact output (≤ 800 chars); 'web' lets
   *  it use markdown + longer prose. Per Basit 2026-05-20: previously
   *  this flag was dropped at the answerAsBrain → compose boundary, so
   *  the LLM never knew it was writing for WA — it produced verbose
   *  web-format prose and the channelRenderer trimmed mid-sentence. */
  channel?: 'web' | 'whatsapp';
}

// ─── Conditional-prompt assembly ──────────────────────────────────────
// Top LLM assistants (GPT-4, Claude, Gemini) run with focused system
// prompts of 3-15K tokens. Brain's old prompt was 80K static template
// + dynamic blocks → 40-60K tokens per call, with rules competing for
// the model's attention. The new design assembles the prompt per
// turn-intent so a casual "thanks" hits the model with ~2K tokens, an
// action-emit turn gets only the action vocabulary, a day_brief gets
// only the brief format. Everything still gets retrieved/computed —
// only what reaches the LLM is gated.
//
// The intent flags are computed once per compose() call from
// plan.intent + a light heuristic on the user's text. They drive WHICH
// rule blocks the assembler concatenates.

/** Cheap heuristic for "the user is asking me to DO something." Used to
 *  gate the action vocabulary + emission rules — they shouldn't ride
 *  along on casual chat or factual questions. We don't need an LLM to
 *  classify this; the verbs are a closed set and false positives are
 *  cheap (slightly longer prompt, no quality loss). */
function looksLikeImperative(text: string): boolean {
  const q = text.trim().toLowerCase();
  // Leading verb — strongest signal.
  if (/^(add|delegate|send|schedule|remind|snooze|draft|reply|create|forward|mark|close|cancel|update|book|set|email|ask|chase|follow|tell|note|log|move)\b/.test(q)) return true;
  // Body verb with action-y framing.
  if (/\b(please|kindly|can you|could you)\s+(add|delegate|send|schedule|remind|snooze|draft|reply|create|forward|mark|close|cancel|update|book|set\s+up|email|ask|chase|follow up|tell|note|log|move)\b/.test(q)) return true;
  return false;
}

/** Core conversational rules — always sent regardless of intent. These
 *  are the FEW universals; everything else is intent-specific below.
 *  Drawn from the six conversation improvements that distinguish good
 *  LLM chat (GPT/Claude/Gemini) from a rule-bundled assistant. */
const CORE_CONVERSATIONAL_RULES = `# Core conversational rules (always apply)
1. **Anchor to recent.** If the user is replying to your most recent message — its content, items, or names — that is your primary context. Don't search elsewhere first. The history block below shows what you just said.
2. **Commit to specifics.** When confirming or proposing an action, name exact entities — full email addresses, full subject lines, exact item ids/titles, exact times. Vague paraphrases ("the thing", "that email", "the meeting") are failure modes, not options.
3. **Enumerate ambiguity.** When the user's request has two or more valid readings, present 2-3 as named options and ask which one. Don't ask "is that right?" against a single guess.
4. **Honesty about limits.** If you can't do something or don't have the info, say so plainly. Don't fabricate. Don't punt with "would you like me to look into that" when the answer is already in front of you.
5. **Mirror language and vary register.** Reply in the user's current-message language. Vary your acknowledgements ("Got it" / "Makes sense" / "Alright" / "One sec"). Don't sound mechanical.
6. **Never claim what you didn't do.** If you write "delegated", "added", "sent", "scheduled" — you MUST also emit the corresponding structured action this turn, OR be quoting a confirmed previous action visible in history. False completion claims are the worst failure mode.
7. **Address every part of a multi-part message.** A single user message often contains TWO or more distinct items: greeting + question, question + sub-question, request + clarification, etc. ("Hi who are you?" is greeting AND identity question. "Brief my day. Also what's the weather?" is two requests.) Answer EACH part — don't lock onto the first and drop the rest. If parts conflict or you can't address one, say which and why; don't silently skip.`;

/** Output shape rules — sent on every turn (the LLM must always emit
 *  valid JSON). Channel-aware: markdown is fine for web; on WhatsApp,
 *  plain text only. */
const OUTPUT_SHAPE_RULES = `# Output rules for this turn
- Respond with ONE JSON object and nothing else. No prose outside the object. No fenced code blocks.
- Shape: { "answer": string, "cites": [pageId], "gaps": [string], "action": object|null }
- "answer" is the message shown to the user. Markdown is fine for web; on WhatsApp (terse mode), use plain text only.
- "cites" MUST be a subset of the opened page IDs above. If you did not quote or paraphrase a page, do not cite it. If you opened nothing, cites=[].
- "gaps" lists anything the user asked about that wasn't in the opened pages. One short phrase per gap. Leave empty if nothing was missing.
- NEVER invent a page ID. NEVER cite a page you didn't open.`;

/** Honesty rules that apply to factual / introspective answers. Pulled
 *  from the legacy H1-H7 set + H5a-H5e refinements. NOT sent on casual
 *  chat or pure-action turns — they're about retrieval-grounded answers. */
const FACTUAL_HONESTY_RULES = `# Honesty rules — factual and introspective answers
H1. **Answer from what's in front of you.** If opened pages contain the fact (number, list, name, status, date), state it plainly. No tease-answers ("would you like me to tell you more").
H2. **Enumerate when asked to list.** "Who is X", "list all Y", "everyone in Z", "management" → enumerate actual names/items from the opened pages.
H3. **Extract numbers when asked for counts.** "How many" → quote the number directly. Don't hedge with "the document doesn't explicitly state a total" if a page does.
H4. **Prefer the Drive Index for counts.** If Drive Index is among opened pages, it's the canonical source for tenant-level counts (projects, deals, employees, OKRs). Cite it.
H5. **If genuinely missing, name the gap.** Only when no opened page has the answer, say so and add the phrase to \`gaps\`.

H5a. **DON'T REACH WHEN YOU DON'T KNOW.** When no opened page directly answers the question, say so plainly. NEVER pull in adjacent documents (same sender, same project name, keyword-similar) as if they were evidence. Don't fabricate composite answers from topically-similar but logically-unrelated sources.

H5b. **COMPUTE OVER RETRIEVE for derivable answers.** When the user asks "how many", "list all", "who is X", and the answer is derivable from row-level data in an opened spreadsheet/list page, EXTRACT and COUNT. Don't say "the document doesn't explicitly state" when the data is the rows themselves.

H5c. **HEDGE-CONFIDENCE CALIBRATION.** Only hedge ("likely", "probably", "appears to be") when there's genuine ambiguity. If exactly one opened page matches, it IS the document — say "the BRD plan", not "likely the BRD plan". Hedge ONLY when pages disagree, the answer requires inference, or the user asked a prediction question. Otherwise: confident voice.

H5d. **ENTITY-TYPE AWARENESS.** When the user asks about "people", "resources", "team", "headcount", filter evidence to entity-shaped sources (\`pageType ∈ {entity_person, org_role, sender_history}\`), NOT tool/SaaS/license/account pages. When in doubt whether a name is a person or a software account, ASK rather than assume.

H5e. **OFFER THE NEXT MOVE.** Every factual reply should close with one short, specific offered action — not "let me know if you need anything", but "want me to pull the developer list from the BRD rows?". The action must be one Brain CAN take. ONE offered action, not a menu.

H6. **Prefer the most recent source when they disagree.** Each opened page header shows \`last_updated\` and \`age_days\`. Lead with the newer one; flag older as potentially stale. For "current / latest" questions, ignore pages older than 60 days unless nothing newer exists.

H7. **Surface age when info is stale.** If the only available source is >60 days old, say so explicitly ("last updated 94 days ago"). Don't present stale data as current.`;

/** Authority / scope rules — apply when there are opened pages with
 *  potentially conflicting claims (factual + introspective). */
const AUTHORITY_RULES = `# Authority + scope rules
H8. **Standing instructions are non-negotiable.** If the "Standing instructions" block contains a rule relevant to this question or action, follow it — and briefly mention which instruction you applied. Never contradict an active standing instruction.
H9. **Delegation matrix is the routing source of truth.** When choosing a delegate/escalate target, look up the area in the Delegation matrix block first. Only invent a routing target when no area matches.
H10. **Risk Radar is the worry list.** When asked what to worry about / what's urgent today, lead with Risk Radar flags. Cite open_item / wiki ids from each flag's sourceRefs.
H11. **Scope lean drives what to lead with.** scopeLean=personal: user-scoped pages lead. scopeLean=org: tenant-scoped pages lead. scopeLean=mixed: tenant first, then user-recent overlays.
H12. **Authority hierarchy for factual claims.** When pages disagree on the same fact, prefer: org_doc / Drive Index > wiki summary > recent feed events.
H13. **Annotate scope on every citation, but only for REAL pages.** Tenant-sourced facts: "Per the [tenant] X page:"; user-sourced: "Per your [thread/notes]:". Don't fabricate doc paths for Brain-internal features like Open Items, Day Brief, My Attention — those are not documents.

**H13 hard constraints — never violate.**
- The "(tenant FACL doc:)" suffix is ONLY valid when citing a page of \`pageType='org_doc'\` whose header you can see. NEVER as a generic "this came from a tenant source" label.
- Open Items, Day Brief, My Attention, and any Brain-emitted action result are NOT documents. Never attribute an action ("I added X to open items") to a fake doc path. When confirming an action, just say what you did ("Added X to your open items, due tomorrow.") — no doc paths, no folder hierarchies, no FACL labels.
- If you have not opened a page named X, you may not cite X. If you only saw X-shaped text inside emails or in the recent-activity tail, that is not an org_doc — it's correspondence.

H14. **Your previous reply is an authoritative source for content.** When the user references something you just said (name, item title, number), don't re-derive it. Look it up and act. Falsely denying ("I don't see any item with that name") when you just listed it is worse than any other failure. (Note: this applies to content — actions still require fresh emission per Rule 6 above.)`;

/** Day-Brief-specific format rules. Only sent on intent=day_brief. */
/** Exclusive-source rules. Each canonical entity (open items, emails,
 *  meetings, WhatsApp threads, connectors) has exactly one block in the
 *  prompt that names the authoritative data. When the user asks about
 *  that entity, the answer MUST come from that block — never from
 *  wiki_pages, recent activity, vector search results, or anywhere else.
 *
 *  Why this exists: Basit's 2026-05-20 transcript showed Brain answering
 *  "any open item?" with 19 fabricated items (status=DONE, status=closed)
 *  drawn from wiki_pages whose titles mentioned the phrase "open item"
 *  — even though the actual Open Items snapshot in the same prompt had
 *  exactly 2 rows. The data was right; the LLM ignored it and invented.
 *  This rule block says: don't.
 *
 *  Applies to factual, day_brief, and action-emit turns. Skipped for
 *  pure casual chat (no entity questions). */
const SURFACE_EXCLUSIVITY_RULES = `# Surface exclusivity — non-negotiable

Every entity in the user's workspace has exactly ONE authoritative block in this prompt. When the user asks about that entity, you answer EXCLUSIVELY from that block. Never substitute wiki_pages, recent activity, vector-search results, semantic guesses, or content from past turns.

| Entity | Authoritative block | What you answer with |
|---|---|---|
| Open items | "Open items snapshot" | Count = rows.length. Listing = these rows only. Status / priority / due / delegatee = the row's fields. Item titles you mention MUST appear verbatim in the snapshot. |
| Today's meetings | "Today's calendar" | Same — every meeting you list is in that block. Don't pull meetings from email content or wiki summaries. |
| Emails needing attention | "My Attention surface" (email bucket) | Same — top emails come from there. Recent activity tail and email_message wiki pages are NOT alternative sources. |
| WhatsApp threads needing attention | "My Attention surface" (whatsapp bucket) | Same — never invent threads from wiki search. |
| Risk / worry list | "Risk Radar" block | If absent, say "nothing on the radar". Don't synthesize risks from email content. |
| Standing instructions | "Standing instructions" block | Same. |
| Delegation routing | "Delegation matrix" block | When picking a delegate target, this is the only legitimate source. |

**Rules:**
1. **If the authoritative block is empty, the answer is empty.** "How many open items?" + empty snapshot → "You have zero active open items." Do NOT fall back to searching elsewhere.
2. **If the user asks for a count, you count rows in the block — no estimating, no rounding, no synthesizing from other context.** N rows = N items, period.
3. **Status / priority / due-date / delegatee labels you cite MUST come from the block's row data.** No inventing labels like "(status DONE)" or "(closed)" when the row says NEW or DELEGATED. Quote the row's field verbatim.
4. **If you find yourself writing an item title that's not in the snapshot, stop.** That title came from a wiki page or email content — it's not an open item. Either remove it from your answer or move it to a separate "I also see this in your wiki/inbox" section that's clearly distinct from the canonical entity.
5. **You can synthesize ABOUT the entities** (why is X high-priority, how should I sequence Y and Z, what's the pattern across these emails) — but the data being synthesized is still only from the authoritative block.

This rule trumps any vector-search "relevance" intuition. If the snapshot has 2 items and the wiki has 17 pages mentioning "open item", you answer with 2. The wiki pages are context, not data.`;

const DAY_BRIEF_FORMAT_RULES = `# Day Brief format (this turn is a daily digest)
H15. **Day-brief = TODAY's attention surface, compactly delivered.** Your reply covers what's IN the "My Attention surface" block — pre-filtered to the last 24h + still-unhandled high/critical carryover. Do NOT surface medium/low items from days ago — they're in the dashboard, not the brief.

**Carryover items:** when an item ends in "(carryover, Nd ago)" or "(carryover, yesterday)", surface it but tag it — e.g. "Sayyed Mohsin: White Belt update (carryover from yesterday)".

**What to cover (skip a section only if its count is 0):**
  1. 📅 **Today's calendar** — every meeting from the "Today's calendar" block. Use the times exactly as written in that block — they are already in the user's local timezone (the block header tells you which). Do NOT convert, shift, or re-render the hour. One line each: HH:MM + title + 1-2 attendee first names if interesting.
  2. 📬 **Email** — pick the FIRST THREE rows from the "email" sub-section of the My Attention surface block (NOT a re-ranking, NOT a re-selection by criticality / recency / your own judgement — literally the first three lines). For the "+N more" line, copy the EXACT string the attention block prepared for you (it looks like "+11 more in inbox"). Do NOT invent a different number. The block tells you the true total — use that count, never estimate.
  3. 💬 **WhatsApp** — same: first three rows from the "whatsapp" sub-section in source order, then the exact "+N more in WhatsApp" string the block provides. Never re-rank, never substitute, never estimate the count.
  4. 📋 **Open items** — ALWAYS include this section if the "Open items snapshot" has at least one row. Show top 3 ordered by: priority (critical > high > medium > low), then due date asc (soonest first, null last), then most recent. Line shape: "Title — [priority] — owner/delegatee/—". More than 3 rows → "+N more open items (open Nexeo to see all)". Do NOT skip just because no item is "due today" — open items are the user's live task ledger; an empty ledger is the only valid reason to omit.
  5. ⚠️ **Watching** — Risk Radar flags, one short line each (max 2).
  6. **Closing line** — one sentence: which single thing would you start with, and why. No fluff.

**Compactness rules — non-negotiable:**
  - Hard cap: 800 characters total. WhatsApp = one phone screen, not a memo.
  - One line per item — sender + what the conversation is actually about (substance, not raw subject). Use the attention block's extracted substance.
  - "+N more in <channel>" instead of listing items 4-onwards.
  - Drop empty sections silently. Don't write "📬 Email: nothing".
  - If attention surface is "(nothing pending)" overall, reply with one short line ("You're clear — nothing on your plate right now.") and stop.

**Forbidden — these failed in earlier user tests:**
  - Meta-commentary about Brain's activity ("you seem to be managing your items").
  - Listing every contact Brain noticed.
  - Long previews / full subject lines.
  - Test/smoke fixture items.`;

/** Action vocabulary + emission rules. Only sent when the user's text
 *  looks like an imperative (looksLikeImperative). Casual chat and pure
 *  factual queries don't need these. */
const ACTION_RULES = `# Actions you can actually perform (when the user asks you to DO something, set "action" instead of just describing what you'd do)

Schema:
\`\`\`
"action": null
        | { "type": "add_open_item",
            "title": string,
            "dueDate"?: "YYYY-MM-DD",
            "note"?: string }
        | { "type": "delegate_open_item",
            "openItemId": string,         // MUST be an id from the "Open items snapshot" block above
            "delegateeEmail": string,     // MUST come from a candidate in the "Candidates for X" block above
            "delegateeName": string,
            "note"?: string }
        | { "type": "schedule_meeting",
            "title": string,
            "whenIso": "YYYY-MM-DDTHH:MM",
            "durationMin"?: number,
            "attendeeEmails": string[],   // MUST come from candidate blocks; never a guess
            "attendeeNames": string[],
            "note"?: string }
        | { "type": "send_email",
            "to": string[],                          // MUST be real email addresses from a Candidates block. Never a name; never a guess.
            "cc"?: string[],
            "subject": string,                       // Concise, action-oriented. NOT "Hi" or "Following up". For replies, "Re: <original subject>".
            "body": string,                          // Full email body in the user's voice. Disclosure footer "Sent by Nexeo, <user>'s AI assistant" appended automatically by the dispatcher — do NOT include it yourself.
            "replyToFeedEventId"?: string }          // When replying to an existing inbound, the feed_event id so Gmail keeps it threaded. Omit for fresh outbound.
        | { "type": "notify_via_whatsapp",
            "recipientName": string,                 // The person's display name. Used in the auto-prepended introduction.
            "recipientPhone": string,                // E.164 phone (e.g. "+923001234567"). MUST be a real phone from a Candidates block. Never an email; never a guess.
            "message": string }                      // The substantive text. Introduction "Hi <name>, this is Nexeo — <user>'s AI assistant. <user> asked me to let you know:\\n\\n" is prepended automatically — do NOT include it.
        | { "type": "set_brain_name",
            "name": string }                         // The new name the user chose. Empty string / "reset" / "none" clears the custom name (you go back to "your AI assistant"). Examples: "Suzi", "Friday", "Atlas". Length cap 40 chars.
\`\`\`

When to emit \`action\`:
- The user says any imperative that maps to an action above ("add it to open items", "delegate the phoenix one to Asad", "set a meeting with Asad Friday 3pm").
- **Resolve, then act.** When the user names a person: use the "Candidates for X" block's dominant winner; if no dominant winner, ask ONE question listing top 2 with one distinguishing reason each; if no candidates block at all, ask the user to spell out the name or provide email. Do NOT invent an email.
- **Match references to open items.** When the user says "delegate the phoenix one", scan "Open items snapshot" for a title containing that fragment and emit \`openItemId\` for the matched row. If multiple match, ask which one.
- **Before emitting \`add_open_item\`, scan the snapshot for paraphrased duplicates.** Same-topic match → don't emit; reply naturally, ask if they want to update the existing item.
- **For meetings**: \`whenIso\` MUST be resolved against today's date. If user said "tomorrow" with no time, ask "what time?" — don't guess.
- **Required slots that are genuinely missing → ask ONE question.** Never enumerate every slot.
- **After emitting, keep answer to a one-line confirmation.** ("Done — delegated to Asad Shafique.")
- **Never write "I'll add it" / "I'll delegate it" without ALSO emitting the action.** That's the empty-promise failure mode.
- **CRITICAL: action.payload must mirror your answer text.** Every name, recipient, title, and identifier you mention in \`answer\` MUST appear verbatim in \`action.payload\`, and every field in \`action.payload\` must be named in \`answer\`. If your text says "I'll email Numair about Google credits" but your action's title is "EXIM solution", that's a lie — rewrite both until they match.
- **NEVER source action subjects from the Open Items snapshot for items the user hasn't named.** The snapshot is for RESOLVING references the user made; it's not a menu to pick from. If you can't quote a recent line containing the action subject (recipient, delegatee, item title), do NOT emit an action — ask for the missing detail in text.
- **If the user's ask maps to an action TYPE not in the list above** (making a phone call, posting to Slack, sending SMS, sending a WhatsApp message AS the user from their personal WhatsApp identity), do NOT pick the nearest type that "sort of" fits. Say so plainly and offer the closest legitimate alternative or ask the user to clarify.

- **WhatsApp from the user's personal number is FORBIDDEN. WhatsApp from the Nexeo notifier number on the user's behalf is ALLOWED via \`notify_via_whatsapp\`.** Distinction matters and the user can tell:
  - Forbidden: replying to a contact AS the user, from the user's paired WhatsApp number — recipient would see the user's number and assume the user wrote it. Hard rule, no exceptions, ever.
  - Allowed: sending FROM the Nexeo tenant notifier number, with an explicit introduction ("Hi <name>, this is Nexeo — <user>'s AI assistant. <user> asked me to let you know: ..."). Recipient sees a different number, knows an assistant is writing, sees the message clearly attributed.
  - Use \`notify_via_whatsapp\` when the user EXPLICITLY asks to inform/notify/tell someone — e.g. "tell Asad I'll be in office", "let Yousuf know the meeting moved", "ping Debby that the plan is ready". The dispatcher auto-prepends the introduction; you write only the substantive message in \`message\`.
  - Do NOT use \`notify_via_whatsapp\` to "reply" on the user's existing WhatsApp thread with a contact — that creates split-identity confusion (contact sees half the thread from user's number, half from Nexeo's). For reply intent, draft for the user to copy/paste instead.

- **Identity-by-channel: emails go to email addresses, meetings go to email addresses, WhatsApp replies are forbidden.** When a contact has BOTH email and phone in the Candidates block (most TMC contacts do), pick by the channel the action requires:
  - send_email \`to\` → MUST be the email address (the one with @), never the phone number.
  - schedule_meeting \`attendeeEmails\` → MUST be email addresses, never phones. Google Calendar invites work via email only.
  - If a contact has ONLY a phone number and no email, you cannot send_email or schedule_meeting to them. Reply: *"I don't have an email address for <name> — only their WhatsApp number. Want to give me their email, or should I do something else?"*

- **send_email is for OUTBOUND email from the user's Gmail.** Use it when the user says "email X", "send an email to Y", "reply to Z", "respond to that thread". Requirements before emitting:
  - \`to\` MUST be real email address(es) (containing @) from a Candidates block above. If you only have a name and no candidate match, ask the user to confirm the email or pick from a candidates list. NEVER guess an email. NEVER use a phone number — those go to /dev/null on the validator and the user reads a fake "sent" confirmation.
  - \`subject\` and \`body\` MUST be specific — say what you'd send. Vague subjects like "Following up" or "Hi" fail; "Re: Google credits — Debby's consumption plan question" passes.
  - For replies, include \`replyToFeedEventId\` if you opened the original inbound email (its id is in the opened pages or attention surface). This keeps Gmail threading correct.
  - The disclosure footer "Sent by Nexeo, <user>'s AI assistant" is appended automatically by the dispatcher — do NOT include it in your \`body\`.
  - **PREVIEW BEFORE SENDING for fresh outbound.** Per Rule D of conversational rules: when the user hasn't seen the draft yet, your first reply states {to, subject, body} in your \`answer\` text and DOES NOT emit \`action\`. Emit the structured action only on the user's next-turn confirmation ("yes send", "go ahead", "send it"). For obvious one-step requests where the user already gave the exact recipient + topic in this same message, you may emit directly — but only when ambiguity is zero.

Slot continuity: if your immediately-previous turn asked for one missing slot, the user's current message is FILLING THAT SLOT. Re-emit the same action with the slot now populated. Do not ask again.

Disambiguation-answer rule: if your previous turn ended with a clarifying question listing N options, the user's current message is the ANSWER. Map "first", "1", "the first one" to option 1, etc. After mapping, re-emit the pending action with the resolved slot.

- **set_brain_name — the user can rename you through conversation.** When the user says "your name is X", "call yourself X", "I'll call you X", "let's name you X" — emit \`set_brain_name\` with \`name\` = the proposed name. Examples that should fire:
  - "your name is Suzi" → \`{ type: "set_brain_name", name: "Suzi" }\`
  - "call yourself Friday" → \`{ type: "set_brain_name", name: "Friday" }\`
  - "I want to name you Atlas" → \`{ type: "set_brain_name", name: "Atlas" }\`
  - "reset your name" / "forget your name" / "you don't need a name" → \`{ type: "set_brain_name", name: "" }\` (clears it, you go back to "your AI assistant").
  After the action dispatches, the cache invalidates and your next turn already reflects the new name. Don't ask for confirmation on this — the user said it clearly; act. They can change it again any time.

**Multi-action rule (one action per turn).** Your \`action\` field can hold ONE action. When the user requests several things at once ("send email + schedule meeting + reply on WhatsApp"), do NOT promise all three in text and then emit none of them — that's the failure mode where Brain confirmed three sends and dispatched zero. Instead:
  - Pick the FIRST action you can fully ground (recipient resolved, fields known) and emit just that one.
  - In your \`answer\` text, name the one you're doing AND list the others as "queued — reply after this one lands and I'll do the next". Don't say "I'll do all three" if you can only emit one.
  - The user sees one confirmed dispatch per turn. They confirm or correct, then ask for the next.
  - Forbidden multi-actions like "send WhatsApp as you" simply get refused per the rule above; they don't count toward the queue.`;

/** Persona-only minimal prompt for casual / small-talk turns. Strip
 *  everything else — schema, rules, action vocabulary — they dilute
 *  the model's attention and slow the reply. Just be a good
 *  conversational assistant with the user's identity context. */
function buildCasualPrompt(args: {
  persona: { systemPreamble: string };
  todayBlock: string;
  capsBlock: string;
  channelRule: string;
}): string {
  return `${args.persona.systemPreamble}

${CORE_CONVERSATIONAL_RULES}

${args.channelRule}

${args.todayBlock}

# System capabilities (for "what can you do" style asks)
${args.capsBlock}

${OUTPUT_SHAPE_RULES}

For casual / small-talk turns: cites=[], gaps=[], action=null. Answer from persona alone.`;
}

/** Full prompt assembler. Branches by intent + action-turn flag.
 *  Always returns a complete prompt; never throws. Dynamic blocks (open
 *  items, candidates, opened pages, etc.) are passed in as strings;
 *  empty strings are skipped. */
function assembleSystemPrompt(args: {
  intent: 'casual' | 'factual' | 'introspective' | 'day_brief' | string;
  isActionTurn: boolean;
  persona: { systemPreamble: string };
  schema: string;
  capsBlock: string;
  overlayBlock: string;
  delegationMatrixBlock: string;
  radarBlock: string;
  instructionsBlock: string;
  prefsBlock: string;
  openItemsBlock: string;
  todayCalendarBlock: string;
  attentionBlock: string;
  candidatesBlock: string;
  recentLog: string;
  openedBlock: string;
  steeringHint: string | null | undefined;
  channel: 'web' | 'whatsapp';
  todayDate: string;
}): string {
  const {
    intent, isActionTurn, persona, schema, capsBlock, overlayBlock, delegationMatrixBlock,
    radarBlock, instructionsBlock, prefsBlock, openItemsBlock, todayCalendarBlock,
    attentionBlock, candidatesBlock, recentLog, openedBlock, steeringHint, channel, todayDate,
  } = args;

  const todayBlock = `# Today
Today is ${todayDate} (UTC). Use this as the anchor for relative dates ("today", "tomorrow", "yesterday", "Friday"). When the user gives a relative date, resolve against today and emit ISO (YYYY-MM-DD) in any \`action.dueDate\` you produce.`;

  // Channel-specific compactness directive. When writing for WhatsApp,
  // the LLM must produce one-line-per-item compact output — no
  // multi-sentence prose, no commentary, no markdown. The renderer
  // trims to 1000 chars but anything close to that wall-of-texts on a
  // phone screen, so target ≤ 800. Per Basit 2026-05-20: WA brief was
  // truncated mid-sentence because the LLM produced 600-char paragraphs
  // per email item ("Numair is asking to assign a COPA resource for
  // Grow Reporting, which needs to be delegated to someone who can
  // action it. Sohaib is mentioned.") instead of the one-liner
  // ("Numair Mazhar: Asking to assign a COPA resource for Grow
  // Reporting.") the web Brain Chat produced.
  const channelRule = channel === 'whatsapp'
    ? `# Channel: WhatsApp — COMPACT but COMPLETE (non-negotiable)
Your reply will be read on a phone screen. Target ≤ 800 characters total; the renderer hard-caps at 1000 with overflow guidance below.

**Two properties matter equally — neither beats the other:**
1. **Compact per-item** — ONE LINE per row: "<Sender>: <one-clause substance>." No multi-sentence prose. No "which needs to be / will likely / seems to be" expansions. No commentary about your own activity ("I see…", "Looking at…", "It seems…"). No markdown (**, \`, #, etc.); plain text with the section emojis (📅 📬 💬 📋 ⚠️) only.
2. **Complete the picture** — every section with content gets included. Calendar → Email → WhatsApp → Open Items → Watching → closing line. Dropping a section because you're "running out of space" is wrong; tighten the per-item lines until everything fits.

**Trade-off priority when the cap is tight (in order):**
  a. Cut verbose words from each item line (verbs like "asking" / "following up" can become ":" alone)
  b. Reduce per-section "top 3" to "top 2" — but still emit the +N more line
  c. Drop the closing reasoning sentence
  Never silently drop a whole section. If WhatsApp has content, the 💬 section appears, even with just "+N more in WhatsApp" and zero shown.

Web Brain Chat produces "Numair Mazhar: Asking to assign a COPA resource for Grow Reporting." — match that compactness here. Web also produces all five sections (calendar / email / WhatsApp / open items / closing). Match that completeness too. The user expects to see the same picture on phone and laptop.`
    : `# Channel: web
Markdown rendering is supported. Use bullets, headers, and bold sparingly for scannability. No hard char cap. Per-item lines still kept short for scannability (the day-brief format rules apply).`;

  // Casual turns — minimal prompt. No schema, no rules, no actions.
  if (intent === 'casual' && !isActionTurn) {
    return buildCasualPrompt({ persona, todayBlock, capsBlock, channelRule });
  }

  // Build the variant prompt in pieces, then join.
  const parts: string[] = [];
  parts.push(persona.systemPreamble);
  parts.push(CORE_CONVERSATIONAL_RULES);
  parts.push(channelRule);

  // Schema — only for introspective questions (about Brain/Nexeo/tenant)
  // and for factual queries that might need to reason about the data model.
  // Casual and day_brief don't need it.
  if (intent === 'introspective' || intent === 'factual') {
    parts.push(`# Brain schema (v${BRAIN_SCHEMA_VERSION})\n${schema}`);
  }

  // Capabilities — always include except for day_brief (already focused).
  if (intent !== 'day_brief') {
    parts.push(`# System capabilities (what you can actually access right now — answer questions about yourself from this)\n${capsBlock}`);
  }

  // Overlay — tenant policy. Always when present; it can affect any turn.
  if (overlayBlock) parts.push(overlayBlock);

  // Standing instructions and learned preferences — always when present.
  if (instructionsBlock) parts.push(instructionsBlock);
  if (prefsBlock) parts.push(`# Learned user preferences (bias behaviour toward these)\n${prefsBlock}`);

  // Delegation matrix and risk radar — relevant for actions and for
  // day_brief / introspective. Skip on casual factual to keep prompt
  // focused.
  if (delegationMatrixBlock && (isActionTurn || intent === 'day_brief' || intent === 'introspective')) {
    parts.push(delegationMatrixBlock);
  }
  if (radarBlock && (intent === 'day_brief' || intent === 'introspective')) {
    parts.push(radarBlock);
  }

  // Open items snapshot — needed when actions might be emitted, for
  // day_brief (to populate the open-items section), and for factual
  // questions about ongoing work.
  if (openItemsBlock && (isActionTurn || intent === 'day_brief' || intent === 'factual')) {
    parts.push(openItemsBlock);
  }

  // Day-brief-specific blocks.
  if (intent === 'day_brief') {
    if (todayCalendarBlock) parts.push(todayCalendarBlock);
    if (attentionBlock) parts.push(attentionBlock);
  }

  // Candidates — needed when actions might be emitted (resolves names)
  // or for factual queries about specific people.
  if (candidatesBlock && (isActionTurn || intent === 'factual')) {
    parts.push(candidatesBlock);
  }

  // Recent tenant activity tail — useful background for factual /
  // introspective. Skip on casual or day_brief.
  if (recentLog && (intent === 'factual' || intent === 'introspective')) {
    parts.push(`# Recent tenant activity (chronological tail)\n${recentLog}`);
  }

  // Opened wiki pages — only when there's something to ground in.
  parts.push(`# Pages opened for this turn (intent=${intent})\n${openedBlock}`);

  // Steering hint (retry path).
  if (steeringHint) {
    parts.push(`# Retry guidance — your previous answer was downvoted
The user gave 👎 to your previous attempt at this question. A diagnostic LLM pass produced the guidance below. Treat it as the highest-priority correction for this turn — adjust scope, tone, source choice, or specificity. Do NOT mention "the previous answer" or apologise; just produce a better answer.

${steeringHint.slice(0, 1000)}`);
  }

  parts.push(todayBlock);
  parts.push(OUTPUT_SHAPE_RULES);

  // Honesty rule for open-items + candidates surface — relevant when
  // either is shown.
  if (openItemsBlock || candidatesBlock) {
    parts.push(`# Honesty rule for the open-items + candidates surface
If the "Open items snapshot" block above contains a row whose title fragment matches what the user is referring to, that item EXISTS. Don't say "I don't see any open items with that name" when the snapshot literally lists one. Same for candidates: if the block shows two Asads, don't reply "I can't find any Asad" — say "which one?" with their distinguishing reasons.`);
  }

  // Intent-specific rule blocks — flattened from the old H1-H15.
  if (intent === 'factual' || intent === 'introspective') {
    parts.push(FACTUAL_HONESTY_RULES);
    parts.push(AUTHORITY_RULES);
  }

  // Action rules — only when the user's text looked like an imperative.
  if (isActionTurn) {
    parts.push(ACTION_RULES);
  }

  // Day Brief format — only on day_brief intent.
  if (intent === 'day_brief') {
    parts.push(DAY_BRIEF_FORMAT_RULES);
  }

  // Surface exclusivity — non-negotiable on factual / day_brief / action
  // turns. Casual chat skips it (no entity questions). This block is the
  // structural guard against the "19 vs 2" hallucination: the LLM had
  // the right snapshot in front of it and still invented items from
  // wiki_pages. Goes last so it's the LAST set of rules in the model's
  // context window — best position for adherence.
  if (intent === 'factual' || intent === 'day_brief' || intent === 'introspective' || isActionTurn) {
    parts.push(SURFACE_EXCLUSIVITY_RULES);
  }

  return parts.join('\n\n');
}

export async function compose(
  clientNumber: string,
  userId: number,
  question: string,
  plan: RetrievalPlan,
  opened: OpenedPage[],
  history: ComposerHistoryTurn[] = [],
  opts: ComposeOptions = {},
): Promise<ComposeResult> {
  // Read-through cache wraps the four read-heavy envelope blocks. Each
  // changes rarely (persona/capabilities/preferences/instructions are
  // updated by explicit user actions) so a 60s TTL is generous and a
  // 5s TTL on tenant_log keeps it fresh while still amortising. Without
  // this, the codebase had structurally near-zero Redis hit rate
  // because Redis was used only for SETNX writes.
  const { getOrCompute } = await import('../../utils/redisClient');
  const { listActiveForPrompt: listOverlayRules, renderOverlayBlock, recordHits: recordOverlayHits } = await import('./userPromptOverlayService');
  const [schema, persona, recentLog, caps, prefs, instructions, delegationMatrixBlock, latestRadarDoc, overlayRules] = await Promise.all([
    Promise.resolve(getBrainSchemaText()),
    getOrCompute(`persona:${clientNumber}:${userId}`, 60, () => getBrainPersona(userId, clientNumber)),
    getOrCompute(`tenantlog:${clientNumber}:${userId}:15`, 5, () => getRecentTenantLog(clientNumber, userId, 15).catch(() => '')),
    getOrCompute(`caps:${clientNumber}:${userId}`, 120, () => getSystemCapabilities(clientNumber, userId).catch(() => null)),
    getOrCompute(`prefs:${clientNumber}:${userId}`, 60, () => getLearnedPreferences(clientNumber, userId).catch(() => null)),
    getOrCompute(`instructions:${clientNumber}:${userId}`, 30, () => getActiveInstructions(clientNumber, userId, 30).catch(() => [])),
    renderDelegationMatrixBlock(clientNumber).catch(() => ''),
    getOrCompute(`riskradar:${clientNumber}:${userId}`, 300, () => getLatestRiskFlagDoc(clientNumber, userId).catch(() => null)),
    // Cache 60s — overlay changes only on user edit / new auto-promote.
    getOrCompute(`overlay:${clientNumber}:${userId}`, 60, () => listOverlayRules(clientNumber, userId)),
  ]);
  const capsBlock = caps ? renderCapabilitiesBlock(caps) : '';
  const prefsBlock = prefs ? renderPreferencesBlock(prefs) : '';
  const instructionsBlock = renderInstructionsBlock(instructions);
  const radarBlock = renderRiskRadarBlock(latestRadarDoc as any);
  const overlayBlock = renderOverlayBlock(overlayRules ?? []);

  // Telemetry — bump hits_count on the rules used in this prompt. Fire-
  // and-forget so the user's response is never blocked on this.
  if (overlayRules?.length) {
    void recordOverlayHits(overlayRules.map((r: any) => r.id)).catch(() => {});
  }

  // Fetch lastUpdatedAt for every opened page in one query so the
  // composer prompt shows freshness on each page header.
  const openedIds = opened.map((p) => p.id).filter((id) => !id.startsWith('entity:'));
  const datesById = new Map<string, Date | null>();
  if (openedIds.length > 0) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, last_updated_at AS "lastUpdatedAt" FROM wiki_pages WHERE id = ANY($1::text[])`,
      openedIds,
    ).catch(() => []);
    for (const r of rows) datesById.set(r.id, r.lastUpdatedAt);
  }

  const openedBlock = opened.length === 0
    ? '(no pages opened for this turn — answer from persona knowledge only, and be honest about what you do not have in context)'
    : opened.map((p) => renderOpenedPageWithQuery(p, question, datesById.get(p.id) ?? null)).join('\n\n');

  // ── Open items snapshot ──
  // CANONICAL VIEW: getOpenItems is the SOLE entry point. Web UI's
  // Action Center, this composer snapshot, WhatsApp Brain, Day Brief
  // cron — all four call the same function with the same defaults.
  // Per README in services/views: divergence by accident is impossible
  // because there's nowhere else to go for this data.
  const { getOpenItems } = await import('../views');
  const openItemsRows = await getOpenItems({
    clientNumber, userId,
    opts: { limit: 30, excludeSmoke: true },
  }).catch(() => [] as any[]);
  // Surface critical/high items first inside the block so the LLM's
  // attention naturally lands there when ranking. Falls back to the SQL
  // ordering (due-date asc) for medium/low.
  const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  openItemsRows.sort((a: any, b: any) => {
    const pa = PRIORITY_RANK[String(a.priority ?? '').toLowerCase()] ?? 4;
    const pb = PRIORITY_RANK[String(b.priority ?? '').toLowerCase()] ?? 4;
    if (pa !== pb) return pa - pb;
    const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return da - db;
  });
  const openItemsBlock = openItemsRows.length === 0
    ? ''
    : `# Open items snapshot (top ${openItemsRows.length} active, sorted by priority then due-date — use these ids when emitting actions that reference an existing item, and pick the Day-Brief Open Items section from the top of this list)\n`
      + openItemsRows.map((it: any) => {
        const due = it.dueDate ? ` due ${it.dueDate.toISOString().slice(0, 10)}` : '';
        const dele = it.delegateeName ? ` → ${it.delegateeName}` : '';
        return `- ${it.id} [${it.priority}/${it.status}]: ${it.title}${due}${dele}`;
      }).join('\n');

  // ── Contact candidates ──
  // Scan the user's question + last two conversation turns for proper-noun
  // tokens (people names) and run each through resolveContact. Inject any
  // resulting candidate blocks so the LLM can pick the right person OR
  // ask a clean disambiguation question. Without this, MD says "delegate
  // to Asad" → LLM picks one Asad at random or says "I don't see them".
  const candidatesBlock = await buildCandidatesBlockForTurn(clientNumber, userId, question, history);

  // ── Today's calendar ──
  // Only built for day_brief intent. Pulls today's gcal feed_events so
  // the structured digest can lead with meetings. Without this block,
  // Brain's "brief my day" reply has no calendar grounding and ends up
  // vaguely summarising whatever wiki retrieval returned.
  const todayCalendarBlock = plan.intent === 'day_brief'
    ? await buildTodayCalendarBlock(clientNumber, userId)
    : '';

  // ── My Attention snapshot ──
  // Per MD 2026-05-12: "Day brief should cover all which brain seeks
  // my attention." The day_brief digest is now anchored to the same
  // surface MD sees in the Day Brief UI — buildAttentionList. Same
  // collapse rules, same muted-sender filter, same auto-handled
  // suppression. Composer formats it compactly for WhatsApp instead
  // of as cards.
  const attentionBlock = plan.intent === 'day_brief'
    ? await buildAttentionBlockForDayBrief(clientNumber, userId)
    : '';

  // Intent-conditional prompt assembly (see assembleSystemPrompt above).
  // Replaces the old 165-line inline template that sent every block + every
  // rule on every turn regardless of relevance. Now: casual gets a minimal
  // ~2K-token prompt, action turns get the action vocabulary, factual gets
  // the retrieval rules, day_brief gets the brief format. Same data — less
  // attention-dilution for Gemini/Claude.
  const isActionTurn = looksLikeImperative(question);

  // Casual-override heuristic. Three patterns to detect, in priority
  // order (most-inclusive first so a question that's BOTH "anything
  // for me?" and "who are you" gets the day_brief blocks AND can answer
  // identity from persona):
  //
  //   1. dayBriefishRe — status-check phrases ("anything for me?",
  //      "what's up", "anything pending", "catch me up", "fill me in").
  //      These need the full attention surface + open items + calendar
  //      + risk radar in context — Brain decides what's important from
  //      across all channels. Per Basit 2026-05-20: "since brain is
  //      ready everything email, whatsapp, calendar, risk so brain will
  //      decide what it thinks important for me to update or to ask".
  //
  //   2. introspectiveRe — identity / capability questions wrapped in
  //      a casual prefix ("Hi who are you?", "what can you do?"). These
  //      need the schema + capabilities blocks. Falls back here only
  //      when the status-check pattern didn't already match.
  //
  //   3. entityKeywordRe — specific entity questions ("show me my
  //      emails", "what meetings today"). Upgraded to factual so the
  //      relevant snapshots get included.
  //
  // Pure greetings ("hi", "hello", "good morning") with no follow-up
  // stay casual — minimal prompt, fast reply.
  const dayBriefishRe = /\b(anything\s+(for\s+(me|us)|pending|new|urgent|important|going\s+on)|whats?\s+(up|new|going\s+on|happening|on\s+my\s+plate|on\s+my\s+desk|important|urgent|pending)|what\s+do\s+i\s+have(\s+today)?|catch\s+me\s+up|brief\s+(me|my\s+day)|summari[sz]e\s+my\s+day|run\s+my\s+day|update\s+me|fill\s+me\s+in|tell\s+me\s+whats?\s+(important|urgent|pending|happening|going\s+on))\b/i;
  const entityKeywordRe = /\b(open\s+item|emails?|inbox|sent\s+item|meeting|meetings|calendar|whatsapp|wa|chat|contact|task|tasks|reminder|reply|drafts?|day\s+brief|brief|status|update)\b/i;
  // Introspective patterns — handles formal "you" AND informal "u" / "r" /
  // "ya" / "ur" shorthand that the planner classifies as casual. Per
  // Basit 2026-05-20: "hi who are u?" got only the greeting back because
  // the prior regex required literal "you" and missed the shorthand.
  const introspectiveRe = /\b(who\s+(?:are|r)\s+(?:you|u|ya|ur)|who\s+made\s+(?:you|u)|what\s+(?:are|r)\s+(?:you|u|ya|ur)|what\s+can\s+(?:you|u)\s+do|what\s+do\s+(?:you|u)\s+know\s+about\s+(?:me|us|tmc|nexeo)|tell\s+me\s+about\s+(?:yourself|nexeo|tmc|you|u|urself))\b/i;
  let effectiveIntent = String(plan.intent ?? 'factual');
  if (effectiveIntent === 'casual') {
    if (dayBriefishRe.test(question)) {
      // day_brief beats other classifications when both match — it's
      // the most inclusive prompt (attention + open items + calendar +
      // radar). Identity questions in the same message are still
      // answerable from the persona block (always present).
      effectiveIntent = 'day_brief';
    } else if (introspectiveRe.test(question)) {
      effectiveIntent = 'introspective';
    } else if (entityKeywordRe.test(question)) {
      effectiveIntent = 'factual';
    }
  }

  const systemPrompt = assembleSystemPrompt({
    intent: effectiveIntent,
    isActionTurn,
    persona,
    schema,
    capsBlock,
    overlayBlock,
    delegationMatrixBlock,
    radarBlock,
    instructionsBlock,
    prefsBlock,
    openItemsBlock,
    todayCalendarBlock,
    attentionBlock,
    candidatesBlock,
    recentLog: recentLog || '(no recent activity logged)',
    openedBlock,
    steeringHint: opts.steeringHint,
    channel: opts.channel ?? 'web',
    todayDate: new Date().toISOString().slice(0, 10),
  });

  // Recent dialogue prepended so the LLM can resolve follow-ups like
  // "what kind?" or "and that one?" against the previous turn instead
  // of treating each question in isolation. Bounded by trimmedHistory in
  // the caller; renderer also caps each turn to 600 chars.
  const historyBlock = renderComposerHistoryBlock(history);
  // Pass the planner's scopeLean through so H11 can use it to pick
  // which layer to lead with. Defaults to "mixed" if the planner
  // omitted it (older plans / fallback path).
  const lean = (plan as any).scopeLean ?? 'mixed';

  // Detect the language of MD's CURRENT message and inject as explicit
  // instruction. Per MD 2026-05-12: "why is it changing language if I
  // am not?" The persona has a "mirror language" rule, but Gemini
  // drifts (especially across long threads). Giving the LLM a hard
  // typed signal — "REPLY LANGUAGE = English" — is more reliable than
  // hoping it infers correctly from the user's message text.
  const detectedLanguage = detectMessageLanguage(question);
  const userMessage = `${historyBlock}User question: ${question}\n\nPlanner rationale: ${plan.rationale}\nPlanner scopeLean: ${lean}\n\n# CRITICAL — Reply language\nMD's current message is in: **${detectedLanguage}**.\nYour reply MUST be entirely in this language. Do NOT switch languages mid-reply. Do NOT pick a different language than the user. The full conversation history may show language drift in earlier turns; ignore that and match THIS message's language.`;

  let raw = '';
  try {
    const r = await callLLM(systemPrompt, userMessage, {
      maxTokens: 2048,
      userId, clientNumber, purpose: 'chat_compose',
    });
    raw = r.text;
  } catch (err: any) {
    return {
      answer: `I can't reach my reasoning service right now — ${err.message}. Try again in a moment.`,
      citedPageIds: [],
      gaps: [],
      sources: [],
      action: null,
      actionResult: null,
    };
  }

  const parsed = parseCompose(raw);
  const validCiteSet = new Set(opened.map((p) => p.id));
  const citedPageIds = parsed.cites.filter((id) => validCiteSet.has(id));
  const sources = opened
    .filter((p) => citedPageIds.includes(p.id))
    .map((p) => p.sourceRef);

  // Action dispatch — if the LLM emitted a structured action, run it
  // through the same instructionDispatcher the Day Brief uses so an
  // open item created via Brain Chat is indistinguishable from one
  // created via the Day Brief UI. Result is folded into the answer
  // text so the user sees the actual outcome (success / artifact id /
  // error) rather than the LLM's pre-action announcement.
  let answer = parsed.answer;
  let actionResult: { ok: boolean; artifactId?: string; message: string } | null = null;
  if (parsed.action) {
    try {
      const { dispatchInstruction } = await import('../instructions/instructionDispatcher');
      const act = parsed.action;
      if (act.type === 'add_open_item') {
        const res = await dispatchInstruction({
          clientNumber,
          userId,
          instruction: {
            intent: 'add_open_item',
            confidence: 1,
            summary: act.title,
            params: { itemTitle: act.title, itemDueDate: act.dueDate, itemNote: act.note },
          } as any,
        });
        actionResult = { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
        if (!res.ok) answer = res.message;
        else if (!/added|added to|noted|done|got it/i.test(answer)) answer = `${res.message}${answer ? `\n\n${answer}` : ''}`;
      } else if (act.type === 'delegate_open_item') {
        // Transition the existing open_item to DELEGATED with the
        // resolved delegatee. We do this directly via the lifecycle
        // service (the instructionDispatcher 'delegate' case is for
        // forwarding a Gmail message, not transitioning an existing
        // open_item — different shape).
        try {
          // Defensive existence check. Per MD 2026-05-12: a previous
          // delegate emission leaked a raw Prisma error to chat
          // ("No record was found for an update") because the LLM
          // emitted an openItemId that didn't exist (hallucinated id
          // or stale snapshot reference to an already-closed item).
          // Verify the item before update; on miss, give MD a useful
          // message and let them retry with a clearer reference.
          const existing = await prisma.openItem.findFirst({
            where: { id: act.openItemId, clientNumber, userId },
            select: { id: true, title: true, status: true },
          });
          if (!existing) {
            actionResult = {
              ok: false,
              message: `I couldn't find that open item to delegate (id ${act.openItemId}). It may have been closed or the reference got stale — tell me by title and I'll re-find it.`,
            };
            answer = actionResult.message;
          } else if (existing.status === 'CLOSED' || existing.status === 'INFORMED') {
            actionResult = {
              ok: false,
              message: `"${existing.title}" is already ${existing.status.toLowerCase()} — nothing to delegate. Want me to reopen it first?`,
            };
            answer = actionResult.message;
          } else {
            const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
            await prisma.openItem.update({
              where: { id: existing.id },
              data: {
                delegateeName: act.delegateeName,
                delegateeEmail: act.delegateeEmail,
                // delegateeId is set only when the email resolves to an
                // internal User row; we look that up here so internal
                // delegations get the FK populated.
                delegateeId: (await prisma.user.findFirst({
                  where: { clientNumber, email: act.delegateeEmail, isActive: true },
                  select: { id: true },
                }).catch(() => null))?.id ?? null,
              } as any,
            });
            await transitionStatus(existing.id, 'DELEGATED', {
              clientNumber,
              actor: `user:${userId}`,
              reason: act.note || `Delegated via Brain Chat to ${act.delegateeName}`,
            });
            actionResult = { ok: true, artifactId: existing.id, message: `Delegated "${existing.title}" to ${act.delegateeName} <${act.delegateeEmail}>.` };
            if (!/delegated|assigned|sent to/i.test(answer)) answer = `${actionResult.message}${answer ? `\n\n${answer}` : ''}`;
          }
        } catch (e: any) {
          // Never leak a raw Prisma stack to chat. Log it server-side
          // for diagnosis; tell MD something they can act on.
          console.warn('[brain-chat] delegate_open_item failed', { error: e?.message, openItemId: act.openItemId, userId });
          actionResult = { ok: false, message: `I hit an error trying to delegate — the item id may be stale. Tell me which item by title and I'll retry.` };
          answer = actionResult.message;
        }
      } else if (act.type === 'schedule_meeting') {
        const res = await dispatchInstruction({
          clientNumber,
          userId,
          instruction: {
            intent: 'schedule_meeting',
            confidence: 1,
            summary: act.title,
            params: {
              meetingTitle: act.title,
              meetingWhen: act.whenIso,
              meetingDurationMin: act.durationMin,
              // Mix names + emails as the dispatcher accepts either; the
              // resolver gave us both so we pass through.
              meetingAttendees: [...act.attendeeEmails, ...act.attendeeNames],
            },
          } as any,
        });
        actionResult = { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
        if (!res.ok) answer = res.message;
        else if (!/scheduled|set|sent invite/i.test(answer)) answer = `${res.message}${answer ? `\n\n${answer}` : ''}`;
      } else if (act.type === 'set_brain_name') {
        // User renamed Brain through chat ("call yourself Suzi" /
        // "your name is Friday" / "reset your name"). Persisted via
        // setBrainName which also invalidates the persona cache so
        // the very next turn uses the new name in the system prompt.
        // Same destination as Settings → Brain → Name input, so the
        // UI and conversation paths stay in sync.
        try {
          const { setBrainName } = await import('./brainPersonaService');
          const saved = await setBrainName(userId, act.name || null);
          if (saved) {
            actionResult = {
              ok: true,
              message: `Got it — from now on you can call me ${saved}.`,
            };
          } else {
            actionResult = {
              ok: true,
              message: `Cleared my custom name — I'll go by "your AI assistant" from here on. You can name me again any time.`,
            };
          }
          answer = actionResult.message;
        } catch (e: any) {
          actionResult = { ok: false, message: `Couldn't save the name: ${e?.message ?? 'unknown'}` };
          answer = actionResult.message;
        }
      } else if (act.type === 'notify_via_whatsapp') {
        // Outbound WhatsApp via the tenant Nexeo number, NOT the user's
        // personal WA. Recipient sees a message from Nexeo's number,
        // with an introduction making it clear an assistant is writing
        // on the user's behalf. This is the WA mirror of send_email's
        // disclosure-footer pattern — Brain speaks as Brain, on behalf
        // of the user, not impersonating them.
        try {
          const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
          const userName = persona.userFirstName || persona.userFullName || 'the user';
          const intro = `Hi ${act.recipientName}, this is Nexeo — ${userName}'s AI assistant. ${userName} asked me to let you know:\n\n`;
          const fullBody = `${intro}${act.message}`;
          const r = await sendTenantWhatsAppText(clientNumber, act.recipientPhone, fullBody, userId);
          if (r.ok) {
            actionResult = {
              ok: true,
              artifactId: r.waMessageId,
              message: `Sent WhatsApp to ${act.recipientName} (${act.recipientPhone}) from the Nexeo number, introducing me as your assistant.`,
            };
            answer = actionResult.message;
          } else {
            actionResult = { ok: false, message: `WhatsApp send failed: ${r.error ?? 'tenant notifier not paired or returned no result'}` };
            answer = actionResult.message;
          }
        } catch (e: any) {
          console.warn('[brain-chat] notify_via_whatsapp failed', { error: e?.message, userId });
          actionResult = { ok: false, message: `WhatsApp send failed: ${e?.message ?? 'unknown'}` };
          answer = actionResult.message;
        }
      } else if (act.type === 'send_email') {
        // Outbound email via the user's own Gmail account. Per the
        // locked decision in feedback_brain_never_speaks_as_user.md:
        // Brain CAN send from the user's Gmail (it's the user's
        // identity, not Brain's) BUT MUST append the disclosure footer
        // so recipients know an assistant composed it. Sent via
        // gmailService.sendUserEmail which uses the user's OAuth grant.
        try {
          const { sendUserEmail } = await import('../gmailService');
          const userName = persona.userFirstName || persona.userFullName || 'the user';
          const disclosureFooter = `\n\n—\nSent by Nexeo, ${userName}'s AI assistant.`;
          const bodyWithFooter = act.body.endsWith(disclosureFooter)
            ? act.body
            : `${act.body}${disclosureFooter}`;
          // Single-To-only for v1; if act.to.length > 1, the first is
          // the primary recipient and the rest go to Cc. cc array (if
          // present) is appended after that. Comma-join is what
          // sendUserEmail expects for cc.
          const primaryTo = act.to[0];
          const extraCc = [...act.to.slice(1), ...(act.cc ?? [])];
          const ccStr = extraCc.length ? extraCc.join(', ') : undefined;
          // If this is a reply, look up the original feed event for
          // threadId + messageId headers so Gmail keeps it in-thread.
          let threadOpts: { threadId?: string; inReplyTo?: string; references?: string } | undefined;
          if (act.replyToFeedEventId) {
            const fe = await prisma.feedEvent.findUnique({
              where: { id: act.replyToFeedEventId },
              select: { sourceId: true, rawPayload: true },
            }).catch(() => null);
            if (fe) {
              const payload = (fe.rawPayload as Record<string, unknown> | null) ?? {};
              const messageIdHeader = typeof payload.messageIdHeader === 'string'
                ? payload.messageIdHeader
                : (typeof payload.messageId === 'string' ? payload.messageId : undefined);
              const threadId = typeof payload.threadId === 'string' ? payload.threadId : undefined;
              threadOpts = {
                threadId,
                inReplyTo: messageIdHeader,
                references: messageIdHeader,
              };
            }
          }
          const sendRes = await sendUserEmail(userId, primaryTo, act.subject, bodyWithFooter, ccStr, threadOpts);
          if (sendRes.success) {
            const recipients = [primaryTo, ...extraCc].join(', ');
            actionResult = {
              ok: true,
              artifactId: sendRes.messageId,
              message: `Sent email to ${recipients} — subject: "${act.subject}".`,
            };
            // Replace the LLM's announcement with the canonical
            // confirmation so what the user sees matches what dispatched.
            answer = actionResult.message;
          } else {
            actionResult = { ok: false, message: `Send failed: ${sendRes.error ?? 'unknown error from Gmail'}` };
            answer = actionResult.message;
          }
        } catch (e: any) {
          console.warn('[brain-chat] send_email failed', { error: e?.message, userId });
          actionResult = { ok: false, message: `Send failed: ${e?.message ?? 'unknown'}` };
          answer = actionResult.message;
        }
      }
    } catch (e: any) {
      actionResult = { ok: false, message: `Action dispatch failed: ${e?.message ?? e}` };
      answer = actionResult.message;
    }
  }

  // Address guard. Replaces greeting + full-name OR greeting + first-name
  // openers with greeting + the user's preferred form of address
  // (preferredTitle from Settings → Profile, e.g. "Sir", "Boss"; falls
  // back to firstName when unset). Per Basit 2026-05-20: persona told
  // Brain to use "Sir" but Brain kept saying "Hi Basit Ahmed!" anyway —
  // structural post-process is the only thing that stops it 100% of the
  // time. Doesn't touch full names as TOPIC references ("Abdul Haseeb's
  // profile says..."), only when used as a direct ADDRESS in an opener.
  const targetAddress = persona.addressAs || persona.userFirstName;
  if (persona.userFullName && targetAddress) {
    const escapedFull = persona.userFullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedFirst = persona.userFirstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match greeting + full name OR greeting + first name (when the
    // preferred address differs from the first name, e.g. user set
    // "Sir" but the LLM defaulted to using their first name).
    const namesToReplace = persona.userFirstName && persona.userFirstName !== targetAddress
      ? `(?:${escapedFull}|${escapedFirst})`
      : escapedFull;
    if (persona.userFullName !== targetAddress) {
      const addressRe = new RegExp(
        `\\b(hi|hello|hey|yes|yeah|sure|ok|okay|good\\s+morning|good\\s+afternoon|good\\s+evening|salaam|salam|aoa)([,\\s!]+)${namesToReplace}\\b`,
        'gi',
      );
      answer = answer.replace(addressRe, (_m, greeting, sep) => `${greeting}${sep}${targetAddress}`);
    }
  }

  // Empty-promise guard. Per MD 2026-05-12: Brain replied
  // "Revisit pricing for Phoenix System ka open item Asad Ahmed Taj
  // ko delegate kar diya hai" without ever emitting an action — the
  // item stayed NEW with no delegatee. Worst possible failure: Brain
  // claimed something was done when it wasn't.
  //
  // Structural defense: if the answer text contains action-completion
  // verbs (English, Roman-Urdu, Urdu) AND no action was successfully
  // dispatched in this turn AND we can't see an artifactId from a
  // previous turn referenced in the answer, override the answer with
  // an honest "no, I didn't" line. The user can then retry the action
  // and we get to actually emit it.
  //
  // This is intentionally narrow: only fires when the answer is
  // claiming an action result. Status updates ("X is done" referring
  // to an existing item's status) get a pass via the artifactId-in-
  // history check — if Brain previously emitted a successful action
  // with that artifactId, claiming it's done is honest.
  if (!actionResult || actionResult.ok !== true) {
    // First-person completion claims only. Match patterns where Brain
    // is claiming IT just did something ("I've added X", "Done — delegated
    // to Y", Brain-voice "I scheduled the meeting"), NOT generic mentions
    // ("you've added 5 to open items", "these items were delegated to
    // various owners last week").
    //
    // Earlier version missed "I've sent" / "I've delegated" because the
    // pronoun alternation expected the verb immediately, no whitespace.
    // Fixed: required \s+ between pronoun and verb. Also extended verb
    // set with dispatched/emailed for the upcoming send_email action.
    // Observed 2026-05-20: Basit asked Brain to send an email; Brain
    // wrote "I've sent that draft reply to Numair Mazhar..." with no
    // dispatched action; guard's regex missed it; lie reached the user.
    const completionRe = /\b(?:i'?ve|i\s+have|i'?ll|i\s+just|i\s+already|i)\s+(?:delegated|assigned|added|scheduled|sent|reminded|set|drafted|dispatched|emailed|forwarded|replied)\b|\bdone\s+—|\b(?:kar\s+diya|kar\s+di\s+hai|ho\s+gaya|ho\s+gai)\b/i;
    if (completionRe.test(answer)) {
      // Look for an artifactId in the recent history — pattern is the
      // dispatcher's success messages from earlier turns. If we can
      // see Brain previously confirmed dispatch of this kind of action
      // with a real artifactId, the claim is honest.
      const historyText = history.map((h) => h.text || '').join('\n');
      const seenArtifact = /artifact[Ii]d[\s:=]+\w/.test(historyText)
        || /\b(delegated|added)\s+(?:"[^"]+"|to\s+\w+)\s+(?:to|in)\s+\w/.test(historyText);
      if (!seenArtifact) {
        // Override with an honest message. Keep the original answer
        // appended so the user sees what Brain TRIED to say if needed.
        console.warn('[brain-chat] empty-promise guard triggered', {
          userId, clientNumber,
          attemptedAnswer: answer.slice(0, 200),
        });
        answer = `I didn't actually complete that — no action went through on my side. Tell me which item and which person and I'll act on it now.`;
        actionResult = { ok: false, message: 'empty_promise_blocked' };
      }
    }
  }

  return {
    answer,
    citedPageIds,
    gaps: parsed.gaps,
    sources,
    action: parsed.action,
    actionResult,
  };
}

function renderOpenedPage(p: OpenedPage): string {
  return renderOpenedPageWithQuery(p, '');
}

/**
 * Render an opened page for the composer prompt. For small pages we
 * dump the whole body. For pages larger than the soft cap, we keep the
 * HEADER (up to the first "## Full content" marker if present) and then
 * paste only the chunks of the body most relevant to the query. This
 * keeps the prompt bounded without losing the ability to answer
 * specific row-level questions against a 500K-char doc.
 */
/**
 * Render today's RiskFlagDoc as a compact markdown block. Brain reads this
 * to know "what should I worry about today" without re-running the radar.
 * Returns '' when the doc is missing/empty/stale (>36h since generation).
 */
/** Detect the language of a user's message so we can give the LLM a
 *  hard signal instead of relying on it to mirror correctly.
 *
 *  Three buckets:
 *    - Urdu script  — contains Arabic/Urdu unicode chars
 *    - Roman-Urdu  — contains any of a closed list of Roman-Urdu tokens
 *                    ("aap", "kya", "hai", "mein", "ko", "ki", "kal", etc.)
 *    - English     — everything else (default; lowest-confidence bucket)
 *
 *  Designed to be precise rather than recall — we don't want to falsely
 *  flag Roman-Urdu in an English message that happens to contain "ok"
 *  or "kal" as someone's name. The trigger list is curated to be
 *  high-precision: tokens that almost never appear in normal English. */
function detectMessageLanguage(text: string): 'Urdu (script)' | 'Roman-Urdu' | 'English' {
  if (!text) return 'English';
  if (/[؀-ۿ]/.test(text)) return 'Urdu (script)';
  // Roman-Urdu requires at least one strongly Roman-Urdu token.
  // List tuned to avoid false positives on English ("ok", "tak", "kar"
  // alone wouldn't trigger — "ko", "mein", "krna", etc. are reliable).
  const romanUrduTokens = /\b(aap|kya|hai|hain|nahi|nahin|han|jee|theek|batao|batain|batayein|chahiye|abhi|kal|ki|ko|mein|mei|mere|mera|meri|hum|krna|krne|krdo|krdiya|raha|rahi|rha|rhi|aaj|kyun|kyon|kahan|kaise|kitne|kitna|sakte|sakta|sakti|lagta|lagti|delegate\s+kr|kar\s+(diya|do|den|rha|rahi)|ho\s+(gaya|gai|raha|rahi)|wala|wali|waly)\b/i;
  if (romanUrduTokens.test(text)) return 'Roman-Urdu';
  return 'English';
}

/** Extract candidate person-name tokens from the user's current question
 *  + their last two utterances. Heuristic: capitalised tokens of length
 *  ≥3 that look like names ("Asad", "Phoenix") plus a few imperative-
 *  trigger phrases ("delegate to X", "meeting with X", "schedule with X").
 *  Tokens that are common stopwords or English month names are dropped.
 *  This is intentionally noisy — false positives just produce empty
 *  candidate blocks; false negatives (missing a name) are the real cost.
 */
function extractNameCandidates(question: string, history: ComposerHistoryTurn[]): string[] {
  const lastUserUtterances = history
    .filter((h) => h.role === 'user')
    .slice(-2)
    .map((h) => h.text);
  const all = [question, ...lastUserUtterances].join(' ');

  const found = new Set<string>();
  // Pattern 1: explicit imperatives — "delegate to Asad", "meeting with Mr. X".
  const imperativeRe = /\b(delegate|forward|assign|send|tell|message|email|meet|meeting|schedule|call)\b[^A-Za-z]*(?:to\s+|with\s+)?([A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,})?)/g;
  let m: RegExpExecArray | null;
  while ((m = imperativeRe.exec(all)) !== null) found.add(m[2]);

  // Pattern 2: any capitalised word(s) of length ≥3, max 3 tokens. Filters
  // out stopwords and month names below.
  const capRe = /\b([A-Z][A-Za-z]{2,}(?:\s+[A-Z][A-Za-z]{2,}){0,2})\b/g;
  while ((m = capRe.exec(all)) !== null) {
    const t = m[1];
    if (!STOPWORD_TOKENS.has(t.toLowerCase().split(/\s+/)[0])) found.add(t);
  }

  // Cap at 5 names per turn so we don't run 20 DB queries on a verbose msg.
  return Array.from(found).slice(0, 5);
}

const STOPWORD_TOKENS = new Set([
  'i', 'my', 'me', 'we', 'our', 'us', 'you', 'your', 'they', 'them', 'their',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
  'today', 'tomorrow', 'yesterday', 'tonight',
  'phoenix', // common in product names like "Phoenix Systems" — but treat as NOT a person name; org/account resolution is a separate codepath.
  'gmail', 'whatsapp', 'calendar', 'drive', 'tasks', 'chat', 'nexeo', 'tmc',
  'open', 'items', 'item', 'brief', 'attention', 'day', 'reply',
  'mr', 'mrs', 'ms', 'dr',
]);

/** Pull the FULL My Attention list and filter to what actually belongs
 *  in a DAY brief: items received today (last 24h) PLUS still-unhandled
 *  high/critical items regardless of age. Older medium/low items live
 *  in the My Attention dashboard but don't pollute the daily digest.
 *
 *  Per MD 2026-05-12 ("how old message you are showing in brief"): the
 *  earlier version surfaced 4-day-old emails because buildAttentionList
 *  uses briefWindowDays (default 7+). A day brief that includes 4-day-
 *  old items isn't a day brief.
 *
 *  Groups by channel, sorts by criticality, renders compactly with
 *  per-channel counters so the LLM can produce "+N more" lines. */
async function buildAttentionBlockForDayBrief(clientNumber: string, userId: number): Promise<string> {
  try {
    // CANONICAL VIEW — route through getAttentionSurface which wraps
    // computeBriefPartition (the same function GET /api/brief/attention
    // calls). Previously this function called buildAttentionList
    // directly with limit=80 — which (a) bypassed the partition cache,
    // and (b) re-mutated buildAttentionList's shared state per its own
    // documented warning ("buildAttentionList mutates shared
    // AttentionItem objects in the suggester cache"). Result: UI and
    // Brain saw different rankings and different counts for the same
    // user at the same moment.
    //
    // Per Basit 2026-05-20: "there is difference between whatsapp brain
    // and UI brain why? this is again trust shaker". One brain by
    // construction means one DATA function — this is that fix.
    const { getAttentionSurface } = await import('../views');
    const allItems = await getAttentionSurface({ clientNumber, userId, opts: { limit: 200 } });
    if (allItems.length === 0) return '# My Attention surface\n(nothing pending — inbox/wa/items are clear)';

    // Per MD 2026-05-12: "Sobia, Taiba seem to be missed." Earlier
    // version filtered to last 24h + high-band carryover, which
    // dropped medium-priority items >24h old. But buildAttentionList
    // ALREADY filters items MD has replied to (WA user-replied filter)
    // and items auto-handled by triage. So anything still in the
    // attention surface is by definition unhandled — and the brief
    // should surface ALL of it, not re-filter by age. We only mark
    // older items as "(carryover)" so MD knows what's new vs what's
    // been waiting; everything stays in the brief.
    //
    // The per-channel cap below + total char cap in H15 still bound
    // the brief size for phone readability — we just stop pre-dropping
    // items the user genuinely cares about.
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const isFreshToday = (it: any) => {
      const ts = it.receivedAt ? new Date(it.receivedAt).getTime() : 0;
      return ts >= twentyFourHoursAgo;
    };
    // Kept for telemetry / tagging only — no longer used to filter.
    const _isStillUrgent = (it: any) => {
      const band = it.criticality?.band;
      return band === 'critical' || band === 'high';
    };
    // Identify short WA bodies that need context-enrichment to be
    // meaningful in a brief. NOT a drop filter — short messages like
    // "069", "ok", "AOA" are legitimate fragments of an ongoing
    // conversation. A brain understands them by reading the message
    // they replied to. So instead of dropping, we'll fetch a piece
    // of prior thread context for each one and render the line as
    // "Haseeb: '069' (replying to your 'OTP?' 10m ago)".
    const SHORT_OR_NOISY_RE = /^\s*(aoa|salam|salaam|salam\s*alaikum|assalamu?\s*alai?kum|wa\s*alaikum|wassalam|hi|hello|hey|hii+|yo|hola|good\s+(morning|evening|afternoon|night)|gn|gm|ok|okay|kk|k\b|ack|noted|sure|yes|yep|yup|haan|han|jee|theek|theek\s+hai|thanks|thx|ty|tysm|cool|got\s+it|done|np)\s*[.!?…\s]*$/i;
    const needsContext = (it: any): boolean => {
      if (it.itemType !== 'whatsapp') return false;
      const body = String(it.preview ?? it.subject ?? '').trim();
      if (!body) return true;
      if (body.length < 12) return true;                         // very short
      if (/^\d{1,6}\s*$/.test(body)) return true;                // pure number/code
      if (SHORT_OR_NOISY_RE.test(body)) return true;             // greeting/ack
      if (/^voice\s+note\s+(in\s+\w+|unavailable|no\s+transcription)/i.test(body)) return true;
      return false;
    };

    // Include ALL attention items — buildAttentionList has already
    // filtered out muted senders, items MD has replied to, and items
    // auto-handled by triage. Anything still here genuinely needs MD's
    // eyes. We just tag older items as (carryover) so MD can scan
    // freshness at a glance.
    const filteredForFreshness = allItems;

    // For each WA item with a short/non-substantive body, read the
    // whole chat thread and run it through the conversation analyzer
    // (LLM call) to extract the TOPIC of the conversation. A real
    // brain doesn't just quote the previous message — it reads enough
    // back to understand what the thread is about, then describes
    // that topic so the latest fragment ("069", "ok", "AOA") makes
    // sense. Per MD 2026-05-12:
    //   "what is 069, you should read previous if still not clear
    //    read more previous until you get cleared picture and then
    //    make it descriptive and then tell last message 069"
    // analyzeConversation already does exactly that (loop extraction
    // + summary), so we reuse it instead of inventing a parallel
    // prompt. It's cached per latest-message-id so a chatty
    // conversation doesn't re-burn the LLM call every brief.
    //
    // Cap at 5 items per brief — beyond that we're saturating LLM
    // budget on a single read.
    const wantsContext = filteredForFreshness.filter(needsContext).slice(0, 5);
    if (wantsContext.length > 0) {
      const { fetchThreadContext } = await import('../whatsapp/UserWebjsProvider');
      const { analyzeConversation } = await import('../triage/conversationAnalyzer');
      await Promise.all(wantsContext.map(async (it: any) => {
        const chatId = it.chatId || (it.senderPhone ? `${String(it.senderPhone).replace(/[^\d]/g, '')}@c.us` : null);
        const senderKey = String(it.senderPhone ?? it.chatId ?? it.from ?? '').toLowerCase();
        if (!chatId || !senderKey) return;
        try {
          const thread = await fetchThreadContext(userId, String(chatId), 20);
          if (!thread || thread.length === 0) return;
          // Single-message threads can't have context; skip.
          if (thread.length === 1) return;
          const analysis = await analyzeConversation({
            userId, clientNumber,
            senderName: it.fromDisplay ?? it.from ?? 'them',
            senderKey,
            thread,
            latestEventId: it.feedEventId,
          });
          // The analyzer returns:
          //   summary: 2-3 sentence what-the-conversation-is-about
          //   loops:   per-topic open/closed loops
          // For the brief line we want a one-liner: prefer the most
          // recent OPEN-with-user loop's "ask" (most actionable); fall
          // back to the conversation summary; fall back to the prior-
          // turn quote we used earlier as last resort.
          const openLoop = analysis.loops?.find((l) => l.openWith === 'user' && l.ask);
          const recentLoop = analysis.loops?.[0];
          let topic = '';
          if (openLoop?.ask) {
            topic = openLoop.ask;
          } else if (recentLoop?.topic) {
            topic = recentLoop.topic;
          } else if (analysis.summary) {
            topic = analysis.summary;
          }
          if (topic) {
            // Cap topic length for readability.
            it.contextPrefix = topic.slice(0, 100);
          } else {
            // Fall back: prior-turn quote (still better than nothing).
            const eventTs = it.receivedAt ? new Date(it.receivedAt).getTime() : Date.now();
            const prior = [...thread]
              .filter((t) => t.timestamp < eventTs - 1000 && t.text && t.text.trim().length >= 6)
              .sort((a, b) => b.timestamp - a.timestamp)[0];
            if (prior) {
              const from = prior.from === 'me' ? 'your earlier message' : 'their earlier message';
              it.contextPrefix = `in reply to ${from} "${prior.text.slice(0, 60)}"`;
            }
          }
        } catch { /* best-effort */ }
      }));
    }

    const items = filteredForFreshness;

    // Diagnostic log. Per MD 2026-05-12 ("my email attachment not
    // reflecting on Brief"): need to know what reached buildAttentionList
    // and what got filtered. Counts by channel + enrichment counter so
    // we can verify analyzeConversation fired on short messages.
    const byChannelRaw: Record<string, number> = {};
    for (const it of allItems) {
      byChannelRaw[it.itemType] = (byChannelRaw[it.itemType] ?? 0) + 1;
    }
    const enrichedCount = wantsContext.filter((it: any) => it.contextPrefix).length;
    console.log(
      `[day-brief] attention pipeline: total=${allItems.length} byChannel=${JSON.stringify(byChannelRaw)} `
      + `wantsContext=${wantsContext.length} enriched=${enrichedCount}`,
    );

    if (items.length === 0) {
      return '# My Attention surface\n(nothing pending — inbox/wa/items are clear)';
    }

    // Group by channel for compact rendering. Within each group, sort
    // by criticality band first (critical → high → medium → low), then
    // most recent.
    const bandRank = (b?: string) => (b === 'critical' ? 0 : b === 'high' ? 1 : b === 'medium' ? 2 : 3);
    const byChannel: Record<string, any[]> = { email: [], whatsapp: [], meeting: [], task: [], other: [] };
    for (const it of items) {
      const ch = (it.itemType === 'email' || it.itemType === 'whatsapp' || it.itemType === 'meeting' || it.itemType === 'task')
        ? it.itemType
        : 'other';
      byChannel[ch].push(it);
    }
    for (const k of Object.keys(byChannel)) {
      byChannel[k].sort((a, b) => {
        const br = bandRank(a.criticality?.band) - bandRank(b.criticality?.band);
        if (br !== 0) return br;
        // tie-break: newest first
        return new Date(b.receivedAt ?? 0).getTime() - new Date(a.receivedAt ?? 0).getTime();
      });
    }

    const sections: string[] = [];
    const renderItem = (it: any): string => {
      const band = it.criticality?.band ? `[${it.criticality.band}] ` : '';
      const from = it.fromDisplay ?? it.from ?? '';
      const ageHr = it.receivedAt ? Math.round((Date.now() - new Date(it.receivedAt).getTime()) / 3600000) : -1;
      const ageTag = ageHr < 0 ? '' : ageHr < 24 ? '' : ageHr < 48 ? ' (carryover, yesterday)' : ` (carryover, ${Math.floor(ageHr / 24)}d ago)`;
      const archetype = it.archetype ? ` (${it.archetype})` : '';

      // Extract the SUBSTANCE of this item — what is it actually about?
      // The Day Brief web UI shows: triage rationale + open loops +
      // conversation summary. The brief should reflect the SAME
      // understanding, just compacted to one line. Per MD 2026-05-12
      // ("same brief at both, WhatsApp will have less in text"):
      // priority order, first non-empty wins:
      //   1. Open-with-user loop's topic + ask  (most actionable;
      //      already extracted by the conversation analyzer for WA)
      //   2. contextPrefix  (set by our analyzeConversation pass for
      //      short messages — already enriches "069"-style fragments)
      //   3. triage rationale  (LLM's per-item "why this matters" — same
      //      string the web UI's card shows under "Brain suggests…")
      //   4. raw subject/preview  (last resort — what we used to show)
      let substance = '';
      const openLoop = it.loops?.find((l: any) => l.openWith === 'user' && l.ask);
      const rawBody = (it.subject || it.preview || '').slice(0, 60);
      if (openLoop?.ask) {
        const topic = openLoop.topic ? `${openLoop.topic}: ` : '';
        substance = `${topic}${openLoop.ask}`.slice(0, 140);
      } else if (it.contextPrefix) {
        substance = `${it.contextPrefix} — last: "${rawBody}"`.slice(0, 160);
      } else if (typeof it.rationale === 'string' && it.rationale.length >= 30) {
        substance = it.rationale.slice(0, 140);
      } else {
        substance = rawBody.slice(0, 100);
      }

      return `  - ${band}${from}: ${substance}${archetype}${ageTag}`;
    };

    // Per-channel cap raised from 6 → 10 so more senders are visible.
    // The total-brief char cap (in H15) still bounds size, but the
    // LLM picks which lines to keep within that cap — cap-by-channel
    // was hiding senders like Sobia/Taiba in "+N more" even when they
    // had today's activity. The LLM gets more to pick from now.
    for (const [ch, list] of Object.entries(byChannel)) {
      if (list.length === 0) continue;
      const top = list.slice(0, 10);
      // Pre-compute the "+N more" line for the LLM so it CAN'T fabricate
      // a different number. Per Basit 2026-05-20: web Brain said "+11
      // more in inbox" (correct), WhatsApp Brain said "+8 more" (wrong)
      // for the same 14 emails. Different surfaces, same data, wrong
      // arithmetic on at least one. Format rule below says to use the
      // exact "+N more" string we provide.
      const remaining = Math.max(0, list.length - 3);
      const overflowLine = remaining > 0
        ? `\n  +${remaining} more ${ch} (use exactly: "+${remaining} more in ${ch === 'email' ? 'inbox' : ch === 'whatsapp' ? 'WhatsApp' : ch}")`
        : '';
      sections.push(`${ch} (${list.length} pending — top 3 below, show those 3, then add the +N line verbatim):\n${top.map(renderItem).join('\n')}${overflowLine}`);
    }
    return `# My Attention surface (${items.length} pending across channels — same source as the Day Brief UI)\n${sections.join('\n\n')}`;
  } catch {
    return '';
  }
}

/** Pull today's calendar events (gcal feed) for this user and render
 *  as a structured block. Only the day-brief intent path uses this —
 *  injecting it on every turn would bloat every prompt for no gain.
 *
 *  Events are pulled from feed_events with sourceType='gcal' filtered
 *  to today (local-day window in UTC, so a 23:30 event still counts
 *  as today). Returns '' when nothing's scheduled — Brain's digest
 *  will simply skip the calendar section. */
async function buildTodayCalendarBlock(clientNumber: string, userId: number): Promise<string> {
  // CANONICAL VIEW: getTodayCalendar is the SOLE entry point for "what
  // meetings does this user have today". Web UI's Day Brief calendar
  // tile, this composer block, the dayBriefDispatchJob — all route
  // through the same view function so the time strings, attendee
  // lists, and event titles are byte-identical across surfaces. Per
  // README in services/views: rule of thumb, no prisma calls outside
  // the views layer for user-facing entities.
  const { getTodayCalendar } = await import('../views');
  const tz = 'Asia/Karachi'; // future: pull from user prefs
  const events = await getTodayCalendar({ clientNumber, userId, opts: { timezone: tz } });
  if (events.length === 0) return '# Today\'s calendar\n(nothing scheduled)';
  const lines = events.map((e) => {
    const att = e.attendees.length > 0
      ? ` — ${e.attendees.slice(0, 3).join(', ')}${e.attendees.length > 3 ? ` +${e.attendees.length - 3}` : ''}`
      : '';
    return `- ${e.localTime} ${e.title}${att}`;
  });
  return `# Today's calendar (times in ${tz})\n${lines.join('\n')}`;
}

/** Build the contact candidates block for this turn. Scans names, runs
 *  resolveContact per name (in parallel), and concatenates the blocks.
 *  Returns '' when no usable names were found or no candidates matched. */
async function buildCandidatesBlockForTurn(
  clientNumber: string,
  userId: number,
  question: string,
  history: ComposerHistoryTurn[],
): Promise<string> {
  const names = extractNameCandidates(question, history);
  if (names.length === 0) return '';
  const { resolveContact, renderCandidatesBlock } = await import('./contactResolver');
  const results = await Promise.all(
    names.map((n) => resolveContact(n, { clientNumber, userId, limit: 4 }).catch(() => [])),
  );
  const blocks: string[] = [];
  results.forEach((cands, i) => {
    if (cands.length > 0) blocks.push(renderCandidatesBlock(names[i], cands));
  });
  return blocks.join('\n\n');
}

function renderRiskRadarBlock(doc: { generatedAt?: Date | null; runDate?: Date | null; flags?: unknown; summary?: string | null; narrative?: string | null; flagCount?: number; highSeverityCount?: number } | null | undefined): string {
  if (!doc) return '';
  const generatedAt = doc.generatedAt ? new Date(doc.generatedAt) : null;
  if (generatedAt && Date.now() - generatedAt.getTime() > 36 * 60 * 60 * 1000) return '';
  const flags = Array.isArray(doc.flags) ? (doc.flags as Array<{ severity?: string; title?: string; reason?: string }>) : [];
  if (flags.length === 0) return '';
  const runDate = doc.runDate ? new Date(doc.runDate).toISOString().slice(0, 10) : (generatedAt?.toISOString().slice(0, 10) ?? 'today');
  const lines: string[] = [];
  lines.push(`## Risk Radar (today's flags — generated ${runDate})`);
  if (doc.summary) lines.push(`Summary: ${doc.summary}`);
  if (doc.narrative) lines.push(doc.narrative.trim());
  lines.push('');
  for (const f of flags.slice(0, 8)) {
    lines.push(`- [${f.severity ?? 'medium'}] **${f.title ?? '(untitled)'}** — ${f.reason ?? ''}`);
  }
  if (flags.length > 8) lines.push(`- … +${flags.length - 8} more flags`);
  lines.push('');
  lines.push('When the user asks "what should I worry about", "anything urgent", "what\'s going on" or similar, lead with these flags. Cite the open_item / wiki page id from each flag\'s sourceRefs as you would any other source.');
  return lines.join('\n');
}

function renderOpenedPageWithQuery(p: OpenedPage, query: string, lastUpdatedAt?: Date | null): string {
  const whenBit = lastUpdatedAt
    ? ` last_updated="${new Date(lastUpdatedAt).toISOString().slice(0, 10)}" age_days="${Math.floor((Date.now() - new Date(lastUpdatedAt).getTime()) / (24*60*60*1000))}"`
    : '';
  // Tag scope on every page header so H11/H12/H13 in the system prompt
  // can act on it. Default 'user' if absent for safety (matches the
  // scope-column default).
  const scopeBit = ` scope="${p.scope ?? 'user'}"`;
  const header = `--- PAGE id=${p.id} type=${p.pageType}${scopeBit} title="${p.title}"${whenBit} ---`;
  const SOFT_CAP =
    p.pageType === 'org_doc' ? 60_000 :
    p.pageType === 'attachment_doc' ? 30_000 :
    4_000;

  if (p.body.length <= SOFT_CAP || !query) {
    const body = p.body.length > SOFT_CAP
      ? p.body.slice(0, SOFT_CAP) + `\n\n[…body continues for ${p.body.length - SOFT_CAP} more chars…]`
      : p.body;
    return `${header}\n${body || '(empty body)'}`;
  }

  // Large page — keep everything up to "## Full content" (summary +
  // aggregates + metadata), then add the top-K most relevant chunks
  // from the full content for the query. This is map-style retrieval
  // inside a single doc: we give the LLM only the regions that actually
  // contain the user's subject.
  const marker = '## Full content';
  const markerIdx = p.body.indexOf(marker);
  const preface = markerIdx >= 0 ? p.body.slice(0, markerIdx + marker.length + 1) : '';
  const rest = markerIdx >= 0 ? p.body.slice(markerIdx + marker.length + 1) : p.body;

  const chunks = splitIntoChunks(rest, 4000, 200); // ~4K each, 200 char overlap
  const topChunks = rankChunks(chunks, query, 3);

  const body = [
    preface.trim(),
    '',
    `_[Showing ${topChunks.length} of ${chunks.length} content chunks (~4K chars each), ranked by relevance to the question. Full doc is ${p.body.length.toLocaleString()} chars.]_`,
    '',
    topChunks.map((c, i) => `### Chunk ${i + 1} (best match)\n${c.text}`).join('\n\n'),
  ].filter(Boolean).join('\n');

  return `${header}\n${body}`;
}

/** Split a long string into overlapping chunks. Tries to break at line boundaries. */
function splitIntoChunks(text: string, size: number, overlap: number): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(text.length, pos + size);
    // Prefer to end at a newline within the last 200 chars of the chunk
    let cut = end;
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end);
      if (nl > pos + size - 400) cut = nl;
    }
    out.push({ start: pos, text: text.slice(pos, cut) });
    if (cut >= text.length) break;
    pos = Math.max(pos + 1, cut - overlap);
  }
  return out;
}

/**
 * Rank chunks by a simple bag-of-tokens overlap with the query. Keeps
 * this pass dependency-free and fast (no extra embed calls per chunk).
 * Good enough for row-level questions — the query's proper nouns (GL,
 * PSO, Fahim, SFML) only appear in chunks that actually contain them.
 */
function rankChunks(
  chunks: Array<{ start: number; text: string }>,
  query: string,
  k: number,
): Array<{ start: number; text: string; score: number }> {
  const qTokens = new Set((query.toLowerCase().match(/[a-z0-9][a-z0-9\-_]+/g) ?? []));
  if (qTokens.size === 0) return chunks.slice(0, k).map((c) => ({ ...c, score: 0 }));

  const scored = chunks.map((c) => {
    const text = c.text.toLowerCase();
    let hits = 0;
    for (const t of qTokens) {
      if (text.includes(t)) hits += 1;
    }
    return { ...c, score: hits };
  });
  scored.sort((a, b) => b.score - a.score || a.start - b.start);
  // Restore original order for the top-K so the LLM reads them in doc order.
  return scored.slice(0, k).sort((a, b) => a.start - b.start);
}

/**
 * Rank vector hits and trim to a composer-friendly slice.
 *
 * Avoids the "50 matches all shoved into the prompt" failure:
 *  - Boost concept pages (entity_person, topic) over source pages — one
 *    concept page summarizes many sources.
 *  - Boost recent pages when the query has temporal words ("latest",
 *    "status", "recent", "now", "current").
 *  - Dedupe: at most 2 pages per entityId (no 8 SAP invoices piling up
 *    when the question wasn't about invoices).
 *  - Return up to 12 pages for the composer. If more candidates existed,
 *    prepend a meta-note so the LLM can tell the user more is available.
 */
async function rankAndTrim(
  hits: Array<{ id: string; title: string; pageType: string; bodyMarkdown: string | null; score: number; userId: number }>,
  query: string,
  clientNumber: string,
  userId: number,
): Promise<Array<{ id: string; title: string; pageType: string; bodyMarkdown: string | null; score: number; userId: number }>> {
  const TEMPORAL_HINTS = /\b(latest|status|recent|now|current|today|this week|ongoing|up-to-date|updated)\b/i;
  const temporalBias = TEMPORAL_HINTS.test(query);
  // Aggregation queries — "how many X by Y", "count of Z", "breakup".
  // Pages with a precomputed `## Computed aggregates` block answer these
  // deterministically; rank them up.
  const AGG_HINTS = /\b(how many|count(s)?( of)?|total(s)?|break\s*up|break\s*down|per [a-z]+|wise|grade[- ]wise|department[- ]wise|gl[- ]wise|location[- ]wise)\b/i;
  const aggBias = AGG_HINTS.test(query);

  // Fetch lastUpdatedAt + entityId for every candidate in one query.
  const ids = hits.map((h) => h.id);
  const meta = ids.length > 0 ? await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, last_updated_at AS "lastUpdatedAt", metadata->>'entityId' AS "entityId"
       FROM wiki_pages WHERE id = ANY($1::text[])`,
    ids,
  ).catch(() => []) : [];
  const metaById = new Map<string, { lastUpdatedAt: Date | null; entityId: string | null }>();
  for (const m of meta) metaById.set(m.id, { lastUpdatedAt: m.lastUpdatedAt, entityId: m.entityId });

  // Per-(user, page) feedback boosts — Phase C re-ranker. A page that's
  // been 👍'd repeatedly for similar queries gets up to +0.4 added to
  // its score; one that's been 👎'd as wrong_source gets up to -0.4.
  // Pages with no signal get 0 (no entry in the map). Bounded
  // single-trip query.
  const { getBoosts } = await import('./retrievalFeedbackService');
  const feedbackBoosts = await getBoosts(userId, ids);

  const now = Date.now();
  const weighted = hits.map((h) => {
    const m = metaById.get(h.id);
    let score = h.score;  // semantic similarity 0..1

    // Concept pages pre-aggregate — prefer them over raw sources.
    if (h.pageType === 'entity_person' || h.pageType === 'topic') score += 0.10;
    if (h.pageType === 'project' || h.pageType === 'policy')       score += 0.05;
    if (h.pageType === 'answer')                                    score += 0.03;
    // Gap pages are meta-placeholders; demote.
    if (h.pageType === 'gap')                                       score -= 0.15;
    // Aggregation queries → heavily prefer pages with a computed-aggregates
    // block. These are deterministic counts we trust over LLM hand-count.
    if (aggBias && h.pageType === 'org_doc' && typeof h.bodyMarkdown === 'string' && h.bodyMarkdown.includes('## Computed aggregates')) {
      score += 0.25;
    }

    // Recency bias — active only when the query asked for it.
    if (temporalBias && m?.lastUpdatedAt) {
      const ageDays = (now - new Date(m.lastUpdatedAt).getTime()) / (24 * 60 * 60 * 1000);
      // +0.10 for today, fading to 0 at 30d, mild negative after 90d
      const bonus = Math.max(-0.05, 0.10 * Math.max(0, 1 - ageDays / 30));
      score += bonus;
    }

    // Per-user feedback boost — additive ∈ [-0.4, +0.4] from
    // retrievalFeedbackService.getBoosts. Pages with no row default 0.
    const fbBoost = feedbackBoosts.get(h.id) ?? 0;
    score += fbBoost;

    return { ...h, finalScore: score, lastUpdatedAt: m?.lastUpdatedAt ?? null, entityId: m?.entityId ?? null };
  });

  weighted.sort((a, b) => b.finalScore - a.finalScore);

  // Dedupe per-entity: keep at most 2 pages per (entityId OR fall-back title prefix).
  const PER_ENTITY_MAX = 2;
  const PER_THREAD_MAX = 2;   // sender_topic dedup by title prefix before "::"
  const TOTAL_MAX = 12;
  const perEntity = new Map<string, number>();
  const perThread = new Map<string, number>();
  const kept: typeof weighted = [];
  for (const h of weighted) {
    if (kept.length >= TOTAL_MAX) break;
    const ek = h.entityId ?? `_none:${h.pageType}`;
    const tk = String(h.title).split('::')[0];
    if ((perEntity.get(ek) ?? 0) >= PER_ENTITY_MAX) continue;
    if ((perThread.get(tk) ?? 0) >= PER_THREAD_MAX) continue;
    perEntity.set(ek, (perEntity.get(ek) ?? 0) + 1);
    perThread.set(tk, (perThread.get(tk) ?? 0) + 1);
    kept.push(h);
  }
  return kept;
}

/**
 * Extract a company-domain hint from the user query. Cheap heuristic:
 * look for any token that looks like a proper noun and doesn't contain
 * spaces or punctuation. If the entities table has a contact at a
 * matching domain, that company is in scope.
 *
 * Kept deliberately loose — over-matching is fine because the resulting
 * pages join the opened set and rank by semantic score anyway. Missing
 * a match is worse than an extra page.
 */
/**
 * Pull out tokens that vector search reliably under-ranks:
 *   - ALL-CAPS words ≥3 chars (EXIM, ADNOC, SFML, PSO, OGDCL, FACL)
 *   - CamelCase or TitleCase proper nouns ≥4 chars
 *   - Codes with digits (R-26-00081, Project 846, OPP-005)
 * These get an ILIKE pass alongside the vector search so short distinctive
 * tokens find their home regardless of embedding weight.
 */
/**
 * Pull a likely person name out of questions shaped like:
 *   "what did X say"
 *   "did X mention …"
 *   "has X replied"
 *   "what does X think"
 *   "what did X write about Y"
 *
 * X is kept as-is (the ILIKE pass is case-insensitive). Filters out
 * pronouns and common stopwords so we don't search on 'he' / 'she'.
 */
// ─── Live snapshots (Open Items + Calendar) ─────────────────────
//
// The composer's wiki-only view has a blind spot: it can't answer
// "what's open right now?" or "what's on my calendar today?" because
// those aren't `wiki_pages`, they're operational state in
// `open_items` and `feed_events`. These helpers synthesize live
// snapshot pages on demand and inject them into the `opened` set so
// Brain cites them like any other page.

/** Queries that should trip the Open Items snapshot. */
const OPEN_ITEMS_HINTS_Q = /\b(open items?|open tasks?|open work|pending (items?|tasks?)|overdue|to[- ]?dos?|what(?:'s| is) (?:open|pending|overdue|due|on my plate|left)|what needs (?:me|you|attention)|what should i (do|handle)|critical items?|follow[- ]ups?\b|action items?)\b/i;

/** Queries that should trip the Calendar snapshot. */
const CALENDAR_HINTS_Q = /\b(meetings?|calendar|schedule|agenda|upcoming|today(?:'s)?|tomorrow(?:'s)?|this week|next week|this month|call with|event|what(?:'s| is) (?:on|in) my (?:calendar|schedule|agenda|day))\b/i;

async function buildOpenItemsSnapshot(
  clientNumber: string,
  userId: number,
  query: string,
): Promise<OpenedPage | null> {
  // Scope filter — "overdue" narrows to past-due; otherwise all open.
  const onlyOverdue = /\boverdue\b/i.test(query);
  const where = onlyOverdue
    ? `AND status NOT IN ('CLOSED','INFORMED') AND due_date IS NOT NULL AND due_date < NOW()`
    : `AND status NOT IN ('CLOSED','INFORMED')`;

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, item_number AS "itemNumber", title, description,
            type, status, priority, due_date AS "dueDate",
            delegatee_name AS "delegateeName",
            source_feed AS "sourceFeed", source_ref AS "sourceRef",
            archetype, priority_score AS "priorityScore",
            EXTRACT(EPOCH FROM (NOW() - created_at))/86400 AS "ageDays",
            created_at AS "createdAt"
       FROM open_items
      WHERE client_number = $1 AND user_id = $2
        ${where}
      ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
               (due_date IS NULL), due_date ASC, priority_score DESC NULLS LAST, created_at DESC
      LIMIT 40`,
    clientNumber, userId,
  );
  if (rows.length === 0) return null;

  const byPriority = { critical: [] as any[], high: [] as any[], medium: [] as any[], low: [] as any[] };
  for (const r of rows) {
    const p = (byPriority as any)[r.priority] ? r.priority : 'medium';
    (byPriority as any)[p].push(r);
  }
  const fmtRow = (r: any) => {
    const bits: string[] = [];
    if (r.dueDate) {
      const d = new Date(r.dueDate);
      const hrs = (d.getTime() - Date.now()) / 3600000;
      bits.push(`due ${d.toISOString().slice(0, 10)}${hrs < 0 ? ' (overdue)' : hrs < 48 ? ' (<48h)' : ''}`);
    }
    if (r.delegateeName) bits.push(`delegated to ${r.delegateeName}`);
    if (r.status && r.status !== 'NEW') bits.push(`status=${r.status}`);
    if (r.sourceFeed) bits.push(`via ${r.sourceFeed}`);
    bits.push(`${Math.round(Number(r.ageDays ?? 0))}d old`);
    return `- [#${r.itemNumber}] **${r.title}** — ${bits.join(' · ')}`;
  };

  const section = (label: string, arr: any[]) =>
    arr.length === 0 ? '' : `\n\n## ${label} (${arr.length})\n${arr.map(fmtRow).join('\n')}`;

  const body = [
    `# Open items — live snapshot`,
    '',
    `_Live query from open_items table at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC._`,
    `**Total open:** ${rows.length} (${byPriority.critical.length} critical, ${byPriority.high.length} high, ${byPriority.medium.length} medium, ${byPriority.low.length} low)`,
    section('Critical',  byPriority.critical),
    section('High',      byPriority.high),
    section('Medium',    byPriority.medium),
    section('Low',       byPriority.low),
  ].filter(Boolean).join('\n');

  return {
    id: 'live:open_items',
    title: 'Open items (live)',
    pageType: 'open_items_snapshot',
    body,
    sourceRef: { type: 'open_items_live', id: 'live:open_items', snippet: `${rows.length} open items` },
  };
}

async function buildCalendarSnapshot(
  clientNumber: string,
  userId: number,
  query: string,
): Promise<OpenedPage | null> {
  // Decide window from the query shape.
  const today = /\btoday\b/i.test(query);
  const tomorrow = /\btomorrow\b/i.test(query);
  const thisWeek = /\bthis week\b|\bnext week\b/i.test(query);
  const windowMs = today ? 24 * 60 * 60 * 1000
    : tomorrow ? 2 * 24 * 60 * 60 * 1000
    : thisWeek ? 8 * 24 * 60 * 60 * 1000
    : 14 * 24 * 60 * 60 * 1000;
  const horizon = new Date(Date.now() + windowMs);

  // Calendar events live inside feed_events.raw_payload as Google
  // Calendar objects. Pull the recent ones and filter by
  // start.dateTime / start.date in the window.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, raw_payload AS payload, created_at AS "createdAt"
       FROM feed_events
      WHERE client_number = $1 AND user_id = $2 AND source_type = 'gcal'
        AND created_at >= NOW() - INTERVAL '60 days'
      ORDER BY created_at DESC LIMIT 300`,
    clientNumber, userId,
  );

  interface Meeting { title: string; startIso: string; endIso: string | null; attendees: string[]; allDay: boolean; hoursUntil: number; status: string; organizer: string | null; location: string | null; }
  const upcoming: Meeting[] = [];
  for (const r of rows) {
    const p: any = r.payload ?? {};
    // Our gcal ingester normalises events into flat fields:
    //   start, end — ISO strings (with timezone offset)
    //   title — event summary
    //   isAllDay — boolean
    //   attendees — [{displayName, email, responseStatus}]
    //   location, organizer, description — strings / objects
    // Be defensive: also accept the raw Google shape (start.dateTime / start.date)
    // for any events ingested by a different path.
    const startRaw = typeof p.start === 'string'
      ? p.start
      : (p.start?.dateTime ?? p.start?.date ?? null);
    if (!startRaw) continue;
    const ts = Date.parse(startRaw);
    if (!Number.isFinite(ts)) continue;
    if (ts < Date.now() - 3600000 || ts > horizon.getTime()) continue;
    const endRaw = typeof p.end === 'string'
      ? p.end
      : (p.end?.dateTime ?? p.end?.date ?? null);
    const attendees = Array.isArray(p.attendees)
      ? p.attendees.map((a: any) => String(a.displayName ?? a.email ?? a).trim()).filter(Boolean)
      : [];
    upcoming.push({
      title: String(p.title ?? p.summary ?? '(no title)').slice(0, 140),
      startIso: new Date(ts).toISOString(),
      endIso: endRaw ? new Date(Date.parse(endRaw)).toISOString() : null,
      attendees,
      allDay: p.isAllDay === true || (!!p.start?.date && !p.start?.dateTime),
      hoursUntil: Math.max(0, Math.round((ts - Date.now()) / 3600000)),
      status: String(p.status ?? 'confirmed'),
      organizer: (typeof p.organizer === 'string' ? p.organizer : (p.organizer?.email ?? p.organizer?.displayName)) ?? null,
      location: p.location ? String(p.location).slice(0, 120) : null,
    });
  }
  if (upcoming.length === 0) return null;

  // Sort, de-dup by (title, start) in case of poller overlap
  upcoming.sort((a, b) => a.startIso.localeCompare(b.startIso));
  const seen = new Set<string>();
  const deduped = upcoming.filter((m) => {
    const k = `${m.title}|${m.startIso}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  const label = today ? 'today' : tomorrow ? 'tomorrow' : thisWeek ? 'this week' : 'next 14 days';
  const fmt = (m: Meeting) => {
    const start = new Date(m.startIso);
    const when = m.allDay
      ? start.toISOString().slice(0, 10)
      : start.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    const who = m.attendees.slice(0, 6).join(', ') + (m.attendees.length > 6 ? `, +${m.attendees.length - 6}` : '');
    const extras: string[] = [];
    if (m.location) extras.push(`at ${m.location}`);
    if (m.status !== 'confirmed') extras.push(`status=${m.status}`);
    return `- **${m.title}** — ${when}${m.hoursUntil < 48 ? ` (in ${m.hoursUntil}h)` : ''}${who ? ` · with ${who}` : ''}${extras.length ? ` · ${extras.join(' · ')}` : ''}`;
  };

  const body = [
    `# Calendar — ${label}`,
    '',
    `_Live query from gcal feed at ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC._`,
    `**${deduped.length} meeting${deduped.length === 1 ? '' : 's'}** in the window.`,
    '',
    ...deduped.map(fmt),
  ].join('\n');

  return {
    id: 'live:calendar',
    title: `Calendar (${label})`,
    pageType: 'calendar_snapshot',
    body,
    sourceRef: { type: 'calendar_live', id: 'live:calendar', snippet: `${deduped.length} meetings (${label})` },
  };
}

function extractPersonNamesFromQuery(query: string): string[] {
  const out = new Set<string>();
  const STOP = new Set([
    'he', 'she', 'they', 'it', 'we', 'you', 'i',
    'anyone', 'someone', 'everyone', 'nobody',
    'the', 'a', 'an', 'that', 'this', 'my', 'your', 'our',
    // Interrogative words that can accidentally land after "is/are" —
    // "what is the deal" must not grab "the".
    'what', 'when', 'where', 'why', 'how',
  ]);
  const patterns: RegExp[] = [
    /\bwhat did ([a-z][a-z'.-]{2,}) (?:say|said|mention|mentioned|tell|told|write|wrote|think|thought|ask|asked|propose|proposed|suggest|suggested)\b/gi,
    /\bdid ([a-z][a-z'.-]{2,}) (?:say|mention|tell|reply|respond|write|ask|follow up|follow-up)\b/gi,
    /\bwhat does ([a-z][a-z'.-]{2,}) (?:think|say|want|need|expect|plan)\b/gi,
    /\bhas ([a-z][a-z'.-]{2,}) (?:replied|responded|written|sent|confirmed|agreed)\b/gi,
    /\bfrom ([a-z][a-z'.-]{2,})\b(?=.*(?:email|message|whatsapp|reply|update))/gi,
    // Lookup shapes — "who is X", "tell me about X", "what do you know about X"
    /\bwho(?:'s| is| are) ([a-z][a-z'.-]{2,})\b/gi,
    /\btell me about ([a-z][a-z'.-]{2,})\b/gi,
    /\bwhat do you know about ([a-z][a-z'.-]{2,})\b/gi,
    /\b([a-z][a-z'.-]{2,})'s (?:role|position|background|company)\b/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(query)) !== null) {
      const raw = (m[1] ?? '').replace(/[?.,!]$/, '').trim();
      if (!raw) continue;
      const norm = raw.toLowerCase();
      if (STOP.has(norm)) continue;
      if (norm.length < 3) continue;
      out.add(raw);
    }
  }
  return Array.from(out).slice(0, 3);
}

function extractDistinctiveTokens(query: string): string[] {
  const tokens = new Set<string>();
  // All-caps words
  const allCaps = query.match(/\b[A-Z]{3,}\b/g) ?? [];
  for (const t of allCaps) tokens.add(t);
  // Codes with digits (R-26-00081, OPP-005, Project 809)
  const coded = query.match(/\b[A-Z][A-Z0-9-]*\d[A-Z0-9-]*\b/g) ?? [];
  for (const t of coded) tokens.add(t);
  // Remove any pure stopwords that somehow slipped in (e.g. "IT" in "IT dept")
  const PROPER_STOP = new Set(['IT', 'HR', 'MD', 'AI', 'US']);
  for (const s of PROPER_STOP) tokens.delete(s);
  return Array.from(tokens).slice(0, 4);
}

function extractCompanyHint(query: string): string | null {
  const tokens = query.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  // Strip common words so we don't expand on "at", "the", "about"
  const STOP = new Set(['about','what','when','where','which','with','from','have','that','this','they','tell','give','last','year','latest','status','project','deal','email','whatsapp','message','update','please','provide']);
  for (const t of tokens) {
    if (STOP.has(t)) continue;
    if (t.length < 5) continue;
    // Prefer tokens that look like company-style strings (e.g. contain digits
    // or camelcase patterns — "feroz1888", "adnoc", "datagraders")
    return t;
  }
  return null;
}

interface ParsedCompose { answer: string; cites: string[]; gaps: string[]; action: ComposedAction | null; }

function parseCompose(text: string): ParsedCompose {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { answer: text.trim() || '(no response)', cites: [], gaps: [], action: null };
  try {
    const obj = JSON.parse(match[0]);
    return {
      answer: typeof obj.answer === 'string' ? obj.answer.trim() : (text.trim() || '(no response)'),
      cites: Array.isArray(obj.cites) ? obj.cites.filter((x: unknown): x is string => typeof x === 'string') : [],
      gaps: Array.isArray(obj.gaps) ? obj.gaps.filter((x: unknown): x is string => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean) : [],
      action: normaliseAction(obj.action),
    };
  } catch {
    return { answer: text.trim() || '(no response)', cites: [], gaps: [], action: null };
  }
}

/** Reject anything that doesn't conform to ComposedAction. Validation is
 *  strict on every non-negotiable field — required slots that are missing
 *  cause the whole action to drop to null so the LLM's prose answer goes
 *  out instead. This is intentional: bad action data is worse than no
 *  action (we'd write a wrong row in the DB). */
function normaliseAction(raw: unknown): ComposedAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : null;
  if (type === 'add_open_item') {
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) return null;
    const dueDate = typeof r.dueDate === 'string' && r.dueDate.trim() ? r.dueDate.trim() : undefined;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
    return { type: 'add_open_item', title, dueDate, note };
  }
  if (type === 'delegate_open_item') {
    const openItemId = typeof r.openItemId === 'string' ? r.openItemId.trim() : '';
    const delegateeEmail = typeof r.delegateeEmail === 'string' ? r.delegateeEmail.trim() : '';
    const delegateeName = typeof r.delegateeName === 'string' ? r.delegateeName.trim() : '';
    // openItemId is the gate — without it we don't know what to move.
    // Email is the second gate — name without email means the resolver
    // returned nothing and we should NOT silently delegate to a guess.
    if (!openItemId || !delegateeEmail || !delegateeName) return null;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
    return { type: 'delegate_open_item', openItemId, delegateeEmail, delegateeName, note };
  }
  if (type === 'schedule_meeting') {
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const whenIso = typeof r.whenIso === 'string' ? r.whenIso.trim() : '';
    const attendeeEmails = Array.isArray(r.attendeeEmails)
      ? r.attendeeEmails.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      : [];
    const attendeeNames = Array.isArray(r.attendeeNames)
      ? r.attendeeNames.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      : [];
    if (!title || !whenIso || attendeeEmails.length === 0) return null;
    const durationMin = typeof r.durationMin === 'number' && r.durationMin > 0 ? Math.floor(r.durationMin) : undefined;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
    return { type: 'schedule_meeting', title, whenIso, durationMin, attendeeEmails, attendeeNames, note };
  }
  if (type === 'send_email') {
    // Strict slot validation. Missing any of {to, subject, body} drops
    // the action to null so the LLM's text answer goes out alone, and
    // the empty-promise guard catches any "I've sent" claim that
    // accompanies a null action. We do NOT silently send with one of
    // these missing — that's how wrong-recipient bugs happen.
    const toRaw = Array.isArray(r.to) ? r.to : (typeof r.to === 'string' ? [r.to] : []);
    const to = toRaw.filter((x: unknown): x is string => typeof x === 'string' && x.includes('@'));
    const ccRaw = Array.isArray(r.cc) ? r.cc : (typeof r.cc === 'string' ? [r.cc] : []);
    const cc = ccRaw.filter((x: unknown): x is string => typeof x === 'string' && x.includes('@'));
    const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
    const body = typeof r.body === 'string' ? r.body.trim() : '';
    if (to.length === 0 || !subject || !body) return null;
    const replyToFeedEventId = typeof r.replyToFeedEventId === 'string' && r.replyToFeedEventId.trim()
      ? r.replyToFeedEventId.trim() : undefined;
    return { type: 'send_email', to, cc: cc.length ? cc : undefined, subject, body, replyToFeedEventId };
  }
  if (type === 'notify_via_whatsapp') {
    // Outbound WhatsApp from Nexeo's tenant notifier number (NOT the
    // user's personal WA — that's still forbidden). Brain identifies
    // itself in the body so the recipient knows it's an assistant, not
    // the user themselves. Same pattern as send_email's "Sent by Nexeo"
    // footer but for the WA channel.
    const recipientName = typeof r.recipientName === 'string' ? r.recipientName.trim() : '';
    const recipientPhone = typeof r.recipientPhone === 'string' ? r.recipientPhone.trim() : '';
    const message = typeof r.message === 'string' ? r.message.trim() : '';
    // Phone must be E.164-ish (digits + optional + / spaces / dashes /
    // parens). If the LLM put an email in this field, we reject — that
    // would be the same channel-confusion bug as send_email got with
    // a phone number, in reverse.
    const phoneOk = !recipientPhone.includes('@') && /^[+\d][\d\s().-]{6,}$/.test(recipientPhone);
    if (!recipientName || !phoneOk || !message) return null;
    return { type: 'notify_via_whatsapp', recipientName, recipientPhone, message };
  }
  if (type === 'set_brain_name') {
    // User-controlled rename: "call yourself X", "your name is Y".
    // Stored in user.notificationPreferences.brainName, surfaced by
    // brainPersonaService.getBrainPersona on every subsequent turn,
    // also reflected in Settings → Brain. Empty / 'reset' / null
    // clears it (back to "your AI assistant" default). Length cap
    // matches setBrainName's slice(0, 40).
    const raw = typeof r.name === 'string' ? r.name.trim() : '';
    // A few obvious garbage values get dropped to null (clear the name).
    const cleared = /^(reset|none|null|blank|clear|default|no name|nothing)$/i.test(raw);
    const name = cleared ? '' : raw.slice(0, 40);
    // Empty is valid (it's a "reset to default") but we still validate
    // that the LLM emitted SOMETHING meaningful. Don't allow a single
    // character (probably a typo or wrong-field misuse).
    if (!cleared && (!name || name.length < 2)) return null;
    return { type: 'set_brain_name', name };
  }
  return null;
}
