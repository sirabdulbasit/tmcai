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
  | { type: 'schedule_meeting'; title: string; whenIso: string; durationMin?: number; attendeeEmails: string[]; attendeeNames: string[]; note?: string };

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
    const siblings = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown",
              metadata->>'date' AS "msgDate", metadata->>'threadId' AS "threadId"
         FROM wiki_pages
        WHERE client_number = $1
          AND page_type = 'email_message'
          AND metadata->>'threadId' = ANY($2::text[])
          AND status NOT IN ('superseded','deleted')
        ORDER BY last_updated_at ASC
        LIMIT 30`,
      clientNumber, Array.from(openedThreadIds),
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
  // The composer used to never see the user's actual open_items list as
  // structured data — only via whatever happened to fall into the wiki
  // retrieval. That meant when MD said "delegate the phoenix one" Brain
  // ran a fresh search for "phoenix" and found nothing, even though the
  // open_item titled "Revisit pricing for Phoenix Systems" was right
  // there. Now we always inject the top 20 most-recent open items as a
  // structured block so the LLM can match a partial reference ("phoenix",
  // "the audit one", "Faizan's email") to a real open_item id and emit
  // an action with that id.
  const openItemsRows = await prisma.openItem.findMany({
    where: {
      clientNumber, userId,
      status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED'] },
      // Smoke filter — items flagged via metadata.smoke=true on ingest
      // by starCadenceService should never appear in MD's conversational
      // surface. Same filter the brainOutboundService applies on send.
      NOT: { metadata: { path: ['smoke'], equals: true } } as any,
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, title: true, priority: true, status: true, dueDate: true, delegateeName: true, delegateeEmail: true },
  }).catch(() => [] as any[]);
  const openItemsBlock = openItemsRows.length === 0
    ? ''
    : '# Open items snapshot (top 20 active — use these ids when emitting actions that reference an existing item)\n'
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

  const systemPrompt = `${persona.systemPreamble}

# Brain schema (v${BRAIN_SCHEMA_VERSION})
${schema}

# System capabilities (what you can actually access right now — answer questions about yourself from this)
${capsBlock}

${overlayBlock ? `${overlayBlock}\n\n` : ''}${delegationMatrixBlock ? `${delegationMatrixBlock}\n\n` : ''}${radarBlock ? `${radarBlock}\n\n` : ''}${instructionsBlock ? `${instructionsBlock}\n\n` : ''}${prefsBlock ? `# Learned user preferences (bias behaviour toward these)\n${prefsBlock}\n\n` : ''}${openItemsBlock ? `${openItemsBlock}\n\n` : ''}${todayCalendarBlock ? `${todayCalendarBlock}\n\n` : ''}${attentionBlock ? `${attentionBlock}\n\n` : ''}${candidatesBlock ? `${candidatesBlock}\n\n` : ''}# Recent tenant activity (chronological tail)
${recentLog || '(no recent activity logged)'}

# Pages opened for this turn (intent=${plan.intent})
${openedBlock}
${opts.steeringHint ? `
# Retry guidance — your previous answer was downvoted
The user gave 👎 to your previous attempt at this question. A diagnostic
LLM pass produced the guidance below. Treat it as the highest-priority
correction for this turn — adjust scope, tone, source choice, or
specificity accordingly. Do NOT mention "the previous answer" or apologise;
just produce a better answer.

${opts.steeringHint.slice(0, 1000)}
` : ''}
# Today
Today is ${new Date().toISOString().slice(0, 10)} (UTC). Use this as the anchor for relative dates ("today", "tomorrow", "yesterday", "Friday"). When the user gives a relative date, resolve it against today and emit an ISO date (YYYY-MM-DD) in any \`action.dueDate\` you produce.

# Output rules for this turn
- Respond with ONE JSON object and nothing else. No prose outside the object. No fenced code blocks.
- Shape: { "answer": string, "cites": [pageId], "gaps": [string], "action": object|null }
- "answer" is the message shown to the user. Markdown is fine. Prose for casual/introspective. Bullets only for enumerating items the user actually asked for.
- "cites" MUST be a subset of the opened page IDs above. If you did not quote or paraphrase a page, do not cite it. If you opened nothing, cites=[].
- "gaps" lists anything the user asked about that wasn't in the opened pages. One short phrase per gap. Each becomes a tracked gap page. Leave empty if nothing was missing.
- NEVER invent a page ID. NEVER cite a page you didn't open.
- If intent=casual and no pages were opened, answer conversationally from persona alone and return cites=[] gaps=[] action=null.

# Actions you can actually perform (when the user asks you to DO something, set "action" instead of just describing what you'd do)

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
            "whenIso": "YYYY-MM-DDTHH:MM" (resolve relative dates against today),
            "durationMin"?: number,
            "attendeeEmails": string[],   // MUST come from candidate blocks above; never a guess
            "attendeeNames": string[],
            "note"?: string }
\`\`\`

When to emit \`action\`:
- The user says any imperative that maps to an action above ("add it to open items", "delegate the phoenix one to Asad", "set a meeting with Asad Friday at 3pm", "remind me to X").
- **Resolve, then act.** When the user names a person:
  - If a "Candidates for X" block exists above with ONE dominant winner, use that email/name in the action.
  - If the candidates block says "no dominant winner", DO NOT emit an action — ask ONE question listing the top 2 candidates by name + one distinguishing reason each.
  - If no candidates block exists OR it says "no matching contacts found", ask the user to spell out the full name or provide an email. Do NOT invent an email.
- **Match references to open items.** When the user says "delegate the phoenix one" / "the audit task" / "Faizan's email", scan the "Open items snapshot" block above for a title containing that fragment and emit \`openItemId\` for the matched row. If multiple match, ask which one. If none match but you mentioned it in a previous turn, the open_item DOES exist — say so and offer to re-look up.
- **For meetings**: \`whenIso\` MUST be resolved against today's date in the system block above. "Tomorrow 3pm" today is "${new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)}T15:00". If the user only said "tomorrow" with no time, ask "what time?" — don't guess.
- **Required slots that are genuinely missing → ask ONE question.** Never enumerate every slot. Never ask for "assignee, priority, importance, due date" all at once.
- After you've emitted an action, the system runs it and you do NOT need to also describe what you did — keep \`answer\` to a one-line confirmation ("Done — delegated to Asad Shafique.").
- Never write "I'll add it" / "I'll delegate it" / "I'll set it up" without ALSO emitting the action. That's the empty-promise failure mode.

Slot continuity: if your IMMEDIATELY-PREVIOUS turn (visible in history above) said you'd add/snooze/delegate something and asked for one missing slot, the user's current message is FILLING THAT SLOT. Re-emit the same action with the slot now populated. Do NOT ask again. Do NOT pivot to retrieval.

# Honesty rule for the open-items + candidates surface

If the "Open items snapshot" block above contains a row whose title fragment matches what the user is referring to, that item EXISTS. Don't say "I don't see any open items with that name" when the snapshot literally lists one. Same for candidates: if the block shows two Asads, don't reply "I can't find any Asad" — say "which one?" with their distinguishing reasons.

# Honesty rules (from brain_schema.md §4, non-negotiable for this turn)
H1. **Answer from what is in front of you.** If the opened pages contain the fact the user asked for (a number, a list, a name, a status, a date), state it plainly. Do NOT punt with "would you like me to tell you more", "I would need to process this", "I could extract that for you" — if it's in the opened pages above, report it now.
H2. **Enumerate when asked to list.** If the user asked "who is X", "list all Y", "everyone in Z", "management", "leadership", and an opened page contains the list, enumerate the actual names/items. Tease-answers ("I have the doc, want me to tell you more?") are a failure mode; avoid them.
H3. **Extract numbers when asked for counts.** If the user asked "how many" and any opened page (including the Drive Index) states a count, quote the number directly. Do not hedge with "the document doesn't explicitly state a total" if any opened page does.
H4. **Prefer the Drive Index for counts.** If the Drive Index is among the opened pages, it is the canonical source for tenant-level counts (projects, deals, employees, OKRs). Cite it.
H5. **If genuinely missing, name the gap.** Only when no opened page has the answer, say you don't have it and add the phrase to \`gaps\`.

H6. **Prefer the most recent source when they disagree.** Every opened page's header shows \`last_updated\` and \`age_days\`. When two pages make different claims about the same fact, lead with the newer one and flag the older as potentially stale. For "latest status" / "current / now" questions, ignore pages older than 60 days unless nothing newer exists.

H7. **Surface age when the info is stale.** If the only available source is >60 days old, say so: "(last updated 94 days ago)". Don't present stale data as current.

H8. **Standing instructions are non-negotiable.** If the "Standing instructions from the user" block above contains any rule relevant to this question or action, follow it — and, when your answer is shaped by one, briefly mention which instruction you applied (e.g. "per your standing rule to delegate Raazia's emails to Asad…"). Never contradict an active standing instruction.

H9. **Delegation matrix is the routing source of truth.** When the question is "who handles X" or you need to choose a delegate/escalate target, look up the area in the "Delegation matrix" block above before inferring from feed history. If a matched area exists, use that owner. Only invent a routing target when no area in the matrix matches the question.

H10. **Risk Radar block is the daily worry list.** When the user asks what to worry about, what's urgent, or what's going on today, lead with the flags in the "Risk Radar" block above (when present). The radar is the system's pre-computed forward-looking risk surface — quoting it is more accurate than re-deriving from feed history. Cite open_item / wiki ids from each flag's sourceRefs.

H11. **Scope lean drives what to lead with.** Each opened page header above carries a \`scope=tenant\` or \`scope=user\` tag. Use the planner's \`scopeLean\` value to decide which to lead with:
  - \`scopeLean=personal\`: lead with user-scoped pages (sender_history / sender_topic / mind_state / answer / gap / observation). Tenant pages may add background context but should not dominate.
  - \`scopeLean=org\`: lead with tenant-scoped pages (org_doc / project / decision / policy / FACL Drive Index / tenant_log). User pages add no value and should be ignored unless the user explicitly references their own touchpoint.
  - \`scopeLean=mixed\`: lead with tenant-scoped pages (more authoritative for definitions / status / org-level facts), then OVERLAY with user-scoped recent threads ("here's how this touches you"). When tenant and user contradict, surface BOTH timestamps and let the user reconcile — do NOT silently pick one.

H12. **Authority hierarchy for factual claims.** When multiple pages claim the same fact:
  1. Tenant FACL org_doc (Drive Index, OKR Tree, Org Chart, SOPs) is most authoritative for definitions and counts.
  2. Tenant project / decision pages are authoritative for org-level decisions.
  3. User-scoped recent threads (sender_history, sender_topic) are authoritative for "what someone said to me", and for current status when tenant pages are stale.
  4. User patterns / mind_state are Brain's own observations — lowest authority; never override an explicitly stated fact.

H13. **Annotate scope on every citation — but only for REAL pages you opened.** When you cite a page that's in the opened-pages block above, the answer prose may make the source layer visible: prefix tenant-sourced facts with "Per the [tenant] X page:" and user-sourced facts with "Per your [thread/notes]:". This is for the user, NOT the cites array.

**H13 hard constraints — never violate.**
- The "(tenant FACL doc:)" suffix is ONLY valid when you are citing a page of \`pageType='org_doc'\` whose header you can see in the opened-pages block above. NEVER as a generic "this came from a tenant source" label.
- **Open Items, Day Brief, My Attention, and any Brain-emitted action result are NOT documents.** Never attribute an action ("I added X to open items") to a fake doc path like "SW_DASHBOARD/Open Items" or "(tenant FACL doc:)". The open_items table is an internal Nexeo feature, not a file. When confirming an action, just say what you did ("Added X to your open items, due tomorrow.") — no doc paths, no folder hierarchies, no FACL labels.
- If you have not opened a page named X, you may not cite X. If you only saw X-shaped text inside the user's emails or in the recent-activity tail, that is not an org_doc — it's correspondence. Treat it as such.

H14. **Your previous reply is an authoritative source.** When the user references content you just produced — a name, an item title, a number, a fact from your immediately-previous reply visible in the history block above — treat that reply as a valid source. Don't re-derive it from scratch; don't deny content you just provided. If you listed "Revisit pricing for Phoenix Systems" as an open item one turn ago and the user now says "delegate the phoenix one", the open_item exists and the reference is unambiguous. Look it up in the snapshot above and act. Falsely denying ("I don't see any item with that name") is worse than any other failure mode.

H15. **Day-brief = full attention coverage, compactly delivered.** When intent=day_brief, your reply must COVER EVERYTHING in the "My Attention surface" block above — same scope as the Day Brief UI — but rendered for a phone screen, not a dashboard. Brief is a noun and a constraint.

**What to cover (skip a section only if its count is 0):**
  1. 📅 **Today's calendar** — every meeting from the "Today's calendar" block. One line each: HH:MM + title + 1–2 attendee first names if interesting.
  2. 📬 **Email** — top 3 from the My Attention surface's email bucket by criticality. If more, end with "+N more in inbox" (use the real count from the bucket header).
  3. 💬 **WhatsApp** — same pattern: top 3 conversations, "+N more" if exceeded.
  4. 📋 **Open items** — top 3 needing your attention from the open-items snapshot (priority high/critical OR no owner yet OR due today/tomorrow). "+N more" if exceeded.
  5. ⚠️ **Watching** — risk radar flags, one short line each (max 2).
  6. **Closing line** — one sentence: which single thing would you start with, and why. No fluff like "let me know if you need anything".

**Compactness rules — non-negotiable:**
  - Hard cap: 800 characters total. Brain Chat on WhatsApp is one phone screen, not a memo.
  - One line per item. Sender name + one phrase = enough. No full subject lines, no previews, no quoting full sentences from emails.
  - Use "+N more in <channel>" instead of listing items 4-onwards. Counts are coverage; enumeration is detail.
  - Drop sections that are empty. Do NOT write "📬 Email: nothing" — just skip that section.
  - If the attention surface block says "(nothing pending)" overall, reply with one short line ("You're clear — nothing on your plate right now.") and stop.

**Forbidden — these failed in MD's earlier tests:**
  - Meta-commentary about Brain's own activity ("you seem to be managing your items...", "I'm seeing recent activity with...").
  - Listing every contact Brain has noticed. The user wants THEIR work, not your observations.
  - Long previews or full subject lines. The card has it; the brief points to it.
  - Test/smoke fixture items in the open-items list (titles like "Test regression task", "Test Urdu item"). Skip those — they're battery rows, not real work.

**Comprehensive coverage + compact delivery.** Coverage means: every attention channel that has at least one item gets a section. Compact means: counts plus the top 3 per section. Together — a brief that's honest about scope and quick to read.`;

  // Recent dialogue prepended so the LLM can resolve follow-ups like
  // "what kind?" or "and that one?" against the previous turn instead
  // of treating each question in isolation. Bounded by trimmedHistory in
  // the caller; renderer also caps each turn to 600 chars.
  const historyBlock = renderComposerHistoryBlock(history);
  // Pass the planner's scopeLean through so H11 can use it to pick
  // which layer to lead with. Defaults to "mixed" if the planner
  // omitted it (older plans / fallback path).
  const lean = (plan as any).scopeLean ?? 'mixed';
  const userMessage = `${historyBlock}User question: ${question}\n\nPlanner rationale: ${plan.rationale}\nPlanner scopeLean: ${lean}`;

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
          const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
          await prisma.openItem.update({
            where: { id: act.openItemId },
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
          await transitionStatus(act.openItemId, 'DELEGATED', {
            clientNumber,
            actor: `user:${userId}`,
            reason: act.note || `Delegated via Brain Chat to ${act.delegateeName}`,
          });
          actionResult = { ok: true, artifactId: act.openItemId, message: `Delegated to ${act.delegateeName} <${act.delegateeEmail}>.` };
          if (!/delegated|assigned|sent to/i.test(answer)) answer = `${actionResult.message}${answer ? `\n\n${answer}` : ''}`;
        } catch (e: any) {
          actionResult = { ok: false, message: `Delegate failed: ${e?.message ?? e}` };
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
      }
    } catch (e: any) {
      actionResult = { ok: false, message: `Action dispatch failed: ${e?.message ?? e}` };
      answer = actionResult.message;
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

/** Pull the FULL My Attention list and render as a structured prompt
 *  block grouped by channel. The composer then digests it compactly
 *  for WhatsApp — coverage of everything Brain wants MD to look at,
 *  surfaced as counts + top items per channel rather than enumerated
 *  in full. Same source-of-truth as the Day Brief UI's /brief/attention
 *  endpoint; same auto-handled / muted / replied filters. */
async function buildAttentionBlockForDayBrief(clientNumber: string, userId: number): Promise<string> {
  try {
    const { buildAttentionList } = await import('../triage/triageSuggester');
    const items = await buildAttentionList(clientNumber, userId, 60);
    if (items.length === 0) return '# My Attention surface\n(nothing pending — inbox/wa/items are clear)';

    // Group by channel for compact rendering. Within each group, sort
    // by criticality band first (critical → high → medium → low), then
    // most recent. Brain reads this once and picks the top 3-5 per
    // group to surface, summarising the rest as "+N more".
    const bandRank = (b?: string) => (b === 'critical' ? 0 : b === 'high' ? 1 : b === 'medium' ? 2 : 3);
    const byChannel: Record<string, any[]> = { email: [], whatsapp: [], meeting: [], task: [], other: [] };
    for (const it of items) {
      const ch = (it.itemType === 'email' || it.itemType === 'whatsapp' || it.itemType === 'meeting' || it.itemType === 'task')
        ? it.itemType
        : 'other';
      byChannel[ch].push(it);
    }
    for (const k of Object.keys(byChannel)) {
      byChannel[k].sort((a, b) => bandRank(a.criticality?.band) - bandRank(b.criticality?.band));
    }

    const sections: string[] = [];
    const renderItem = (it: any): string => {
      const band = it.criticality?.band ? `[${it.criticality.band}] ` : '';
      const from = it.fromDisplay ?? it.from ?? '';
      const subj = (it.subject || it.preview || '').slice(0, 80);
      const archetype = it.archetype ? ` (${it.archetype})` : '';
      return `  - ${band}${from}: ${subj}${archetype}`;
    };

    for (const [ch, list] of Object.entries(byChannel)) {
      if (list.length === 0) continue;
      const top = list.slice(0, 6);
      sections.push(`${ch} (${list.length} total):\n${top.map(renderItem).join('\n')}${list.length > 6 ? `\n  - … +${list.length - 6} more ${ch}` : ''}`);
    }
    return `# My Attention surface (${items.length} item${items.length === 1 ? '' : 's'} pending across channels)\n${sections.join('\n\n')}`;
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
  const now = new Date();
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59));
  const rows = await prisma.feedEvent.findMany({
    where: {
      clientNumber, userId,
      sourceType: 'gcal' as any,
      // gcal rawPayload carries 'start' as ISO; we filter on event time,
      // not created_at, because backfilled events would otherwise miss.
      createdAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },  // window the FROM clause
    },
    select: { id: true, rawPayload: true },
    take: 200,
  }).catch(() => [] as any[]);
  // In-memory filter on the actual event start time from rawPayload.
  // Cheaper than a JSONB indexed query on a low-volume table.
  const events = rows
    .map((r: any) => {
      const p = r.rawPayload ?? {};
      const startIso = typeof p.start === 'string' ? p.start : (p.start?.dateTime ?? p.start?.date ?? null);
      const start = startIso ? new Date(startIso) : null;
      return start && !Number.isNaN(start.getTime())
        ? { id: r.id, start, title: String(p.summary ?? p.title ?? '(no title)').slice(0, 120), location: p.location ?? null, attendees: Array.isArray(p.attendees) ? p.attendees.map((a: any) => a?.email ?? a).filter(Boolean) : [] }
        : null;
    })
    .filter((x: any): x is NonNullable<typeof x> => x !== null && x.start >= startOfDay && x.start <= endOfDay)
    .sort((a: any, b: any) => a.start.getTime() - b.start.getTime());
  if (events.length === 0) return '# Today\'s calendar\n(nothing scheduled)';
  const lines = events.map((e: any) => {
    const hhmm = e.start.toISOString().slice(11, 16);
    const att = e.attendees.length > 0 ? ` — ${e.attendees.slice(0, 3).join(', ')}${e.attendees.length > 3 ? ` +${e.attendees.length - 3}` : ''}` : '';
    return `- ${hhmm} ${e.title}${att}`;
  });
  return `# Today's calendar (UTC times)\n${lines.join('\n')}`;
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
  return null;
}
