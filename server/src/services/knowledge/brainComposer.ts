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
  /** Which composer path produced this result. Used by
   *  validateBeforeRender to skip empty-promise regex checks on
   *  reasoning-decided turns — those have structured output
   *  (clarifying question / preview text / templated act answer) that
   *  shouldn't be regex-gated for "I delegated"-style verbs. The regex
   *  was designed to catch legacy LLM hallucinations, not reasoning's
   *  legitimate questions and preview templates. */
  source?: 'reasoning' | 'legacy';
}

/** The chat composer's structured action surface. Keep this list tight —
 *  every type needs a matching branch in dispatchBrainChatAction and a
 *  prompt entry telling the LLM when to emit it. */
export type ComposedAction =
  // Per Basit 2026-05-23: actions that talk to humans MUST emit candidateIds
  // (entity row ids), NOT raw emails. The server resolves candidateId →
  // real email at dispatch. Eliminates email hallucinations structurally.
  // Date fields emit `*Raw` (the user's literal phrase); server resolves
  // via chrono with the user's timezone. The LLM does NOT do date math.
  | { type: 'add_open_item'; title: string; dueDateRaw?: string; note?: string }
  | { type: 'update_open_item'; openItemId: string; title?: string; priority?: string; dueDateRaw?: string; note?: string }
  | { type: 'mark_open_item_done'; openItemId: string; completionNote?: string }
  | { type: 'delegate_open_item'; openItemId: string; delegateeCandidateId?: string; delegateeAdHocEmail?: string; note?: string }
  | { type: 'schedule_meeting'; title: string; whenRaw: string; durationMin?: number; attendeeCandidateIds: string[]; attendeeAdHocEmails?: string[]; note?: string }
  | { type: 'cancel_meeting'; eventId: string; titleHint?: string; reason?: string }
  | { type: 'reschedule_meeting'; eventId: string; titleHint?: string; newWhenRaw?: string; newDurationMin?: number; reason?: string }
  | { type: 'send_email'; toCandidateIds: string[]; ccCandidateIds?: string[]; toAdHoc?: string[]; subject: string; body: string; replyToFeedEventId?: string }
  | { type: 'notify_via_whatsapp'; recipientCandidateId?: string; recipientAdHocPhone?: string; message: string }
  | { type: 'set_brain_name'; name: string }
  | { type: 'archive_wiki_page'; wikiPageId: string; titleHint?: string; reason?: string }
  | { type: 'delete_wiki_page'; wikiPageId: string; titleHint?: string; reason?: string }
  | { type: 'set_contact_scope'; contactCandidateId: string; scope: 'tenant' | 'normal' | 'private'; nameHint?: string }
  | { type: 'mark_contact_inactive'; contactCandidateId: string; nameHint?: string }
  // update_contact (2026-07-13): edit an existing contact's fields. The
  // capability registry long CLAIMED contact-edit ("PATCH /entities/:id")
  // but no action backed it, so Brain kept saying "I can't update a
  // contact's email" and offered to create a DUPLICATE contact instead.
  // This is the real emittable action. At least one of newEmail/newPhone/
  // newName must be present.
  | { type: 'update_contact'; contactCandidateId: string; newEmail?: string; newPhone?: string; newName?: string; nameHint?: string }
  | { type: 'record_preference'; key: string; value: unknown; description?: string };

/** Internal, reversible actions that apply immediately. They do not
 * contact another person and must never enter the outbound preview /
 * "reply send" flow. */
/**
 * Kinds `dispatchPendingDirect` can actually EXECUTE as a confirmed-plan step.
 *
 * Must mirror that function's `switch` exactly. Being in the action registry
 * is NOT sufficient: on 2026-08-04 `update_open_item` was registry-valid,
 * passed plan validation, rendered in the preview and was confirmed by the
 * owner — then died with "[Unknown pending action kind]", losing three
 * dictated priority+deadline updates. A test pins this set against the
 * switch so the two cannot drift apart again.
 */
/**
 * DEF-032 — a visible notice when a NEW preview displaced an unconfirmed one.
 *
 * Silent displacement made "send" mean something the owner never saw: a
 * dictated 5-step plan was replaced by a canned test email, and his "send"
 * dispatched the email to a real colleague. The cancellation is correct; the
 * silence was not.
 */
export function displacementNotice(
  replaced: { actionKind: string; stepCount: number } | undefined,
): string {
  if (!replaced) return '';
  const what = replaced.stepCount > 1
    ? `a ${replaced.stepCount}-step plan`
    : `a pending ${replaced.actionKind.replace(/_/g, ' ')}`;
  return `\u26a0\ufe0f Heads up: this replaces ${what} you hadn't confirmed yet — "send" now applies to what's below, not that.\n\n`;
}

export const DISPATCHABLE_PLAN_STEP_KINDS: ReadonlySet<string> = new Set([
  'add_open_item',
  'update_open_item',
  'update_contact',
  'schedule_meeting',
  'reschedule_meeting',
  'cancel_meeting',
  'send_email',
  'notify_via_whatsapp',
  'delegate_open_item',
  // 'action_plan' is deliberately absent — nested plans are rejected.
]);

export const IMMEDIATE_INTERNAL_ACTION_TYPES: ReadonlySet<ComposedAction['type']> = new Set([
  'add_open_item',
  'update_open_item',
  'mark_open_item_done',
  'update_contact',
  'set_brain_name',
  'record_preference',
]);

/** Every ComposedAction type the composer can actually dispatch.
 *  MUST stay in sync with the union above (and its dispatch branches) —
 *  live capability discovery treats a registered actionDefinition as
 *  supported only if its handler is in the generic dispatcher's
 *  allow-list OR its type is listed here. Locked against the seeded
 *  registry by tests/capabilityDiscovery.test.ts (registry-parity). */
export const COMPOSER_DISPATCHED_TYPES: ReadonlySet<string> = new Set([
  'add_open_item', 'update_open_item', 'mark_open_item_done', 'delegate_open_item',
  'schedule_meeting', 'cancel_meeting', 'reschedule_meeting',
  'send_email', 'notify_via_whatsapp',
  'set_brain_name', 'archive_wiki_page', 'delete_wiki_page',
  'set_contact_scope', 'mark_contact_inactive', 'update_contact',
  'record_preference',
]);

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
  role: 'user' | 'brain' | 'artifact';
  text: string;
}

/** Structured payload for role='artifact' history turns. Stored as
 *  JSON-stringified text on the ComposerHistoryTurn so it travels
 *  through existing persistence (conversation_history JSONB) without
 *  schema changes. */
export interface BrainArtifactRecord {
  kind: 'schedule_meeting' | 'send_email' | 'add_open_item' | 'delegate_open_item' | 'notify_via_whatsapp' | 'cancel_meeting' | 'reschedule_meeting';
  artifactId: string;
  summary: string;     // human-readable one-liner
  dispatchedAt: string; // ISO timestamp
}

/** Parse a role='artifact' turn's text back into structured form. */
function parseArtifact(text: string): BrainArtifactRecord | null {
  try {
    const obj = JSON.parse(text);
    if (typeof obj?.artifactId === 'string' && typeof obj?.kind === 'string') {
      return {
        kind: obj.kind,
        artifactId: obj.artifactId,
        summary: typeof obj.summary === 'string' ? obj.summary : '',
        dispatchedAt: typeof obj.dispatchedAt === 'string' ? obj.dispatchedAt : '',
      };
    }
  } catch { /* fall through */ }
  return null;
}

/** Render the recent-artifacts block for compose's prompt. Only
 *  surfaces artifacts from the last 24 hours; older ones rarely
 *  matter for cancel/reschedule intent. */
function renderArtifactsBlock(history: ComposerHistoryTurn[]): string {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const artifacts = history
    .filter((h) => h.role === 'artifact')
    .map((h) => parseArtifact(h.text))
    .filter((a): a is BrainArtifactRecord => !!a)
    .filter((a) => {
      const t = new Date(a.dispatchedAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .slice(-8);
  if (artifacts.length === 0) return '';
  const lines = artifacts.map((a) => `- ${a.kind} artifactId=${a.artifactId} — ${a.summary}`);
  return `# Recent action artifacts (this session, last 24h)
${lines.join('\n')}

When the user asks to cancel or reschedule something you've just done ("cancel that meeting", "move it to 4pm"), refer to ONE of these artifactIds in your action.eventId / action.artifactId field. Do NOT invent ids. If none of these match the user's reference, ask which one.`;
}

function renderComposerHistoryBlock(history: ComposerHistoryTurn[]): string {
  if (!history.length) return '';
  // Artifact turns are not conversation — they're structured side-data.
  // Render them in renderArtifactsBlock instead. Here we keep only
  // user/brain turns so the model sees clean dialogue.
  const turns = history.filter((h) => h.role === 'user' || h.role === 'brain');
  if (!turns.length) return '';
  const recent = turns.slice(-6);
  const lines = recent.map((t) => {
    const who = t.role === 'user' ? 'User' : 'Brain';
    const txt = t.text.slice(0, 600);
    return `${who}: ${txt}`;
  });
  return `Recent conversation (most recent last):\n${lines.join('\n')}\n\n`;
}

export interface ComposeOptions {
  /** Phase 8 (2026-05-22): when true, use the reasoning-first single-call
   *  composer (reasoningCompose) instead of the legacy multi-call dance.
   *  Off by default; turn on per-user or globally once observed stable.
   *
   *  Reads from env var BRAIN_USE_REASONING ('always' | 'never' | percent
   *  like '25' for rollout) if not specified by caller. */
  useReasoning?: boolean;
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

/** Empty-promise / completion-claim detector. Matches first-person
 *  completion verbs across English (past, present-continuous, base form),
 *  Roman-Urdu ("kar diya"), and Urdu-ish forms. Used in two places:
 *    1. The post-dispatch guard at the end of composeAnswer — overrides
 *       the LLM's reply with an honest "I didn't" if it claimed work
 *       that wasn't dispatched.
 *    2. Option A: post-compose retry. Before dispatch, if no action was
 *       emitted but the answer claims one, re-call the LLM once with a
 *       corrective addendum. Catches the "LLM said it did, didn't
 *       actually" failure mode structurally instead of via prompt rules.
 *
 *  Designed to be inclusive of the patterns we've seen in production:
 *  "I've sent", "I'll send", "I'm sending", "I sent", "I just sent",
 *  "Done — delegated", "kar diya hai", "ho gaya". False positives are
 *  cheap (one extra LLM call) — false negatives ship a lie. */
// Verb lemmas used across the branches. Past-tense forms only for the
// bare-"I" branch (which otherwise false-positives on habitual present
// tense like "I schedule my day at 8am"). Verb list is intentionally
// closed — every entry corresponds to a ComposedAction the composer
// can actually dispatch, so we only intercept claims about real actions.
// Verb-list vocabulary — every ComposedAction the composer can dispatch
// contributes its completion verb here so a fabricated "X has been ___"
// claim triggers the safety nets. Extended 2026-07-08 (audit round 2)
// after coverage gaps found for archive_wiki_page, mark_contact_inactive,
// record_preference, set_brain_name, mark_open_item_done.
const _COMPLETION_VERBS_ANY = 'delegated|delegating|delegate|assigned|assigning|assign|added|adding|add|scheduled|scheduling|schedule|sent|sending|send|reminded|reminding|remind|drafted|drafting|draft|dispatched|dispatching|dispatch|emailed|emailing|email|forwarded|forwarding|forward|replied|replying|reply|cancelled|canceled|cancelling|canceling|cancel|rescheduled|rescheduling|reschedule|corrected|correcting|correct|updated|updating|update|fixed|fixing|fix|removed|removing|remove|deleted|deleting|delete|moved|moving|move|changed|changing|change|delivered|delivering|deliver|notified|notifying|notify|informed|informing|inform|set|setting|archived|archiving|archive|marked|marking|mark|saved|saving|save|remembered|remembering|remember|renamed|renaming|rename|completed|completing|complete|closed|closing|close';
const _COMPLETION_VERBS_PAST = 'delegated|assigned|added|scheduled|sent|reminded|drafted|dispatched|emailed|forwarded|replied|cancelled|canceled|rescheduled|corrected|updated|fixed|removed|deleted|moved|changed|delivered|notified|informed|set|archived|marked|saved|remembered|renamed|completed|closed';
export const EMPTY_PROMISE_RE = new RegExp(
  [
    // (1) First-person WITH auxiliary — safe to match any verb form.
    //     Matches: "I've sent", "I have scheduled", "I'll delegate",
    //     "I'm sending", "I just added", "I already emailed".
    `\\bi(?:'ve|\\s+have|'ll|\\s+will|'m|\\s+am|\\s+just|\\s+already)\\s+(?:${_COMPLETION_VERBS_ANY})\\b`,

    // (2) First-person BARE — restricted to past-tense verbs only, to
    //     avoid habitual-present false positives ("I schedule my day
    //     at 8am" must NOT match).
    `\\bi\\s+(?:${_COMPLETION_VERBS_PAST})\\b`,

    // (3) Passive voice — "has been sent", "was delivered", "were dispatched".
    //     This is the Basit-chat-2 failing phrasing: "The email has
    //     been sent to Asad." Slipped past the old first-person-only
    //     regex and let a fabricated completion claim reach the user.
    `\\b(?:has|have|had|was|were|is|are|been)\\s+(?:been\\s+)?(?:${_COMPLETION_VERBS_ANY})\\b`,

    // (4) Third-person impersonal subject — "The email has been sent",
    //     "The invite went out", "It was scheduled", "Done — it's with X now".
    //     Requires the subject phrase to disambiguate from unrelated
    //     uses of "the message/task/etc." elsewhere in prose.
    `\\b(?:the\\s+(?:email|message|invite|reminder|task|meeting|note|reply|nudge|follow-up|followup|thread|item)|it)\\s+(?:has\\s+been|had\\s+been|was|were|is|are)\\s+(?:${_COMPLETION_VERBS_ANY})\\b`,

    // (5) Idiomatic completion — "done — <verb>", "Done." at clause end.
    //     Both em-dash and period follow-through count; the LLM often
    //     writes "Done. Delegated to X." as two adjacent sentences.
    `\\bdone[\\s.!:—-]`,
    // (6) Roman-Urdu / Hindi completion idioms.
    //     Extended 2026-07-08 (audit round 2): "kar liya", "kar li" and
    //     "yaad kar liya" / "yaad rakh liya" (remembered/saved) cover
    //     verbs that the English branch also picks up but the user
    //     might phrase in Urdu.
    `\\b(?:kar\\s+diya|kar\\s+di\\s+hai|kar\\s+liya|kar\\s+li\\s+hai|kar\\s+li|ho\\s+gaya|ho\\s+gai|ho\\s+gayi|kar\\s+diye|yaad\\s+kar\\s+liya|yaad\\s+rakh\\s+liya|yaad\\s+kar\\s+li|yaad\\s+rakh\\s+li)\\b`,

    // (7) Headless past-tense at clause start followed by target/preposition
    //     OR reflexive OR completion-state adjective — "Delegated to
    //     Yousuf.", "Scheduled for Friday.", "Renamed myself to Suzi.",
    //     "Marked Rafay inactive." The past-tense-only verb list is
    //     used deliberately so habitual-present forms ("Schedule your
    //     day at 8am" as a suggestion) don't false-positive.
    //     Broadened 2026-07-08 (audit round 2) to include reflexives
    //     ("myself"/"yourself"/etc.) and state adjectives
    //     ("inactive"/"done"/"complete"/"closed"/"archived") — captures
    //     the mark_contact_inactive + set_brain_name + mark_open_item_done
    //     phrasings the audit's empirical probe uncovered.
    `(?:^|[.!?]\\s+)(?:${_COMPLETION_VERBS_PAST})\\s+(?:\\S+\\s+)?(?:to|for|it|him|her|them|that|this|those|the|myself|yourself|himself|herself|itself|themselves|inactive|done|complete|completed|closed|archived|as\\s+\\w+)\\b`,

    // (8) "call myself <name>" / "calling myself <name>" — set_brain_name's
    //     natural completion phrasing. Verb-list approach doesn't fit
    //     because "call" is too generic elsewhere; require the exact
    //     "myself" object to anchor the semantics. Added 2026-07-08.
    `\\bcall(?:ing|ed)?\\s+myself\\b`,
    `\\b(?:i'll|i\\s+will|i'm)\\s+call(?:ing|ed)?\\s+myself\\b`,

    // (9) Subject-then-past-verb at end-of-sentence — "Preference saved.",
    //     "Item closed.", "Meeting rescheduled.", "Note archived." The
    //     subject is a single word (matches nouns, not entire phrases)
    //     followed by a past-tense verb and terminal punctuation.
    //     Added 2026-07-08 (audit round 2) for headless completion
    //     claims where the LLM omits the "I" or "has been" scaffolding.
    //     False-positive-tolerant on non-action turns via the composer's
    //     isActionTurn gate.
    `(?:^|[.!?]\\s+)[A-Za-z][A-Za-z-]*\\s+(?:${_COMPLETION_VERBS_PAST})[.!](?:\\s|$)`,
  ].join('|'),
  'i',
);

/** Semantic wrapper so tests + call sites can express intent
 *  ("does this claim completion?") without knowing the regex. */
export function claimsCompletion(text: string): boolean {
  return EMPTY_PROMISE_RE.test(text ?? '');
}

// ── Completion-claim GATE (2026-07-14, chat 9) ──────────────────────
//
// The regex above cannot tell a fabricated current-turn claim
// ("I've delegated it" — when nothing ran) from a FACTUAL STATUS
// REPORT ("the item is delegated to Muhammad Yousaf" — read from the
// open-items record). Chat 9: "Tell me its status" → reasoning
// answered correctly from the grounded record → the ungated
// interceptor matched the passive branch ("is delegated") → the user
// got "something didn't dispatch… name the recipient" on a question
// that involved no dispatch at all.
//
// The gate below keeps the safety property (fabricated completion on
// a genuine mutation turn NEVER ships) while letting grounded state
// language through on read-only turns. Structure, not broader regex:
// turn intent × claim shape × dispatch evidence × grounding.

/** Claim SHAPES, split out of EMPTY_PROMISE_RE's branches:
 *  CURRENT_TURN_CLAIM — "I just did it" forms (first person, "Done —",
 *  Urdu completion idioms, headless past-tense). STATIVE_STATE —
 *  passive/impersonal state descriptions ("is delegated", "was sent")
 *  which are the EXPECTED vocabulary of a status answer. */
export const CURRENT_TURN_CLAIM_RE = new RegExp(
  [
    `\\bi(?:'ve|\\s+have|'ll|\\s+will|'m|\\s+am|\\s+just|\\s+already)\\s+(?:${_COMPLETION_VERBS_ANY})\\b`,
    `\\bi\\s+(?:${_COMPLETION_VERBS_PAST})\\b`,
    // Clause-INITIAL "Done —/Done." only: "Done — delegated to X" is a
    // claim; "The task is marked done." is a state description.
    `(?:^|[.!?]\\s+)done[\\s.!:—-]`,
    `\\b(?:kar\\s+diya|kar\\s+di\\s+hai|kar\\s+liya|kar\\s+li\\s+hai|kar\\s+li|ho\\s+gaya|ho\\s+gai|ho\\s+gayi|kar\\s+diye|yaad\\s+kar\\s+liya|yaad\\s+rakh\\s+liya|yaad\\s+kar\\s+li|yaad\\s+rakh\\s+li)\\b`,
    `(?:^|[.!?]\\s+)(?:${_COMPLETION_VERBS_PAST})\\s+(?:\\S+\\s+)?(?:to|for|it|him|her|them|that|this|those|the|myself|yourself|himself|herself|itself|themselves|inactive|done|complete|completed|closed|archived|as\\s+\\w+)\\b`,
    `\\bcall(?:ing|ed)?\\s+myself\\b`,
  ].join('|'),
  'i',
);

export const STATIVE_STATE_RE = new RegExp(
  [
    // Optional adverb ("currently", "already", "now", "still") between
    // auxiliary and verb — "is currently assigned to Sara".
    `\\b(?:has|have|had|was|were|is|are|been)\\s+(?:been\\s+)?(?:(?:currently|already|now|still)\\s+)?(?:${_COMPLETION_VERBS_ANY})\\b`,
    `\\b(?:the\\s+(?:email|message|invite|reminder|task|meeting|note|reply|nudge|follow-up|followup|thread|item)|it)\\s+(?:has\\s+been|had\\s+been|was|were|is|are)\\s+(?:(?:currently|already|now|still)\\s+)?(?:${_COMPLETION_VERBS_ANY})\\b`,
  ].join('|'),
  'i',
);

/** Which claim shape matched — observability only, never full text. */
export function matchedCompletionCategory(text: string): 'current_turn_claim' | 'stative_state' | null {
  const t = text ?? '';
  if (CURRENT_TURN_CLAIM_RE.test(t)) return 'current_turn_claim';
  if (STATIVE_STATE_RE.test(t)) return 'stative_state';
  if (EMPTY_PROMISE_RE.test(t)) return 'current_turn_claim'; // regex drift safety: unclassified match = suspicious
  return null;
}

export type TurnIntent = 'read_only' | 'mutation' | 'ambiguous';

/** What is THIS user turn asking for — a read of existing state, or a
 *  change to the world? Distinct from looksLikeImperative(), whose
 *  leading-verb list counts "tell" as imperative: "tell me its status"
 *  is a read; "tell Asad we're ready" is an outbound send. */
export function classifyTurnIntent(question: string): TurnIntent {
  const q = (question ?? '').trim().toLowerCase();
  if (!q) return 'ambiguous';
  // Outbound/change requests win even when phrased politely or as a
  // question: "can you send it to Asad?", "tell Asad we're ready".
  if (/\b(?:can|could|will|would|please)\s+(?:you\s+)?(?:add|delegate|send|schedule|reschedule|postpone|remind|snooze|draft|reply|create|forward|mark|close|cancel|delete|remove|update|change|book|set(?:\s+up)?|email|chase|follow\s*up|note|log|move|push|shift|invite|notify|call)\b/.test(q)) return 'mutation';
  if (/^tell\s+(?!me\b)/.test(q) || /^check\s+(?:with|in\s+with)\b/.test(q)) return 'mutation';
  // Read-only: interrogatives, ask-brain forms, status/history nouns.
  if (/^(?:what|when|who|whose|where|why|how|which|did|do|does|is|are|was|were|has|have|had|any)\b/.test(q)) return 'read_only';
  if (/^(?:tell|show|give)\s+me\b/.test(q) || /^check\b/.test(q)) return 'read_only';
  if (/\b(?:status|progress|update\s+on|any\s+update|history|latest\s+on|kya\s+hua|kahan\s+tak|where\s+(?:are\s+we|do\s+we\s+stand))\b/.test(q)) return 'read_only';
  if (looksLikeImperative(q)) return 'mutation';
  if (/\?\s*$/.test(q)) return 'read_only';
  return 'ambiguous';
}

export interface CompletionGateInput {
  userQuestion: string;
  answer: string;
  /** Reasoning decision when on the reasoning path ('answer' | 'ask' | …). */
  decision?: string;
  /** Legacy imperative classification — advisory, logged only. */
  isActionTurn?: boolean;
  /** A structured action was emitted this turn. */
  emittedAction?: boolean;
  /** Dispatch outcome when an action ran. */
  actionResult?: { ok: boolean } | null;
  /** Retrieved records/history were available to ground state claims
   *  (open items / day brief / recent messages / artifacts blocks). */
  groundedStatusContext?: boolean;
  /** RECORD-LEVEL grounding (#1 finalization): the canonical record ids
   *  (open items, events) actually retrieved for this turn. Non-empty
   *  grounds state language more strongly than the block-level boolean. */
  groundedRecordIds?: string[];
}

/** Extract canonical record ids (cuid-shaped) from rendered data
 *  blocks — turns block-level grounding into record-level grounding.
 *  Exported for tests. */
export function extractRecordIds(...blocks: Array<string | undefined>): string[] {
  const ids = new Set<string>();
  for (const b of blocks) {
    if (!b) continue;
    for (const m of b.matchAll(/\bc[a-z0-9]{20,28}\b/g)) ids.add(m[0]);
  }
  return [...ids];
}

export interface CompletionGateVerdict {
  intercept: boolean;
  failureType?: 'fabricated_completion_on_action_turn' | 'read_only_answer_validation_failed';
  turnClass: TurnIntent;
  matchedCategory: ReturnType<typeof matchedCompletionCategory>;
}

/** THE decision table (chat 9):
 *    read-only turn  → grounded state language ALLOWED; only a bare
 *                      ungrounded "I just did it" claim is withheld
 *                      (as a status-read failure — never phrased as a
 *                      dispatch failure, because none was attempted);
 *    mutation turn, no dispatch → intercept (the original guarantee);
 *    mutation turn, confirmed dispatch → allowed (dispatch path owns
 *                      the wording);
 *    ambiguous turn  → never invent a dispatch failure; withhold only
 *                      ungrounded current-turn claims. */
export function shouldInterceptCompletionClaim(input: CompletionGateInput): CompletionGateVerdict {
  const turnClass = classifyTurnIntent(input.userQuestion);
  const matchedCategory = matchedCompletionCategory(input.answer);
  if (!matchedCategory) return { intercept: false, turnClass, matchedCategory };
  // Record-level grounding subsumes the block-level boolean.
  if ((input.groundedRecordIds?.length ?? 0) > 0) input = { ...input, groundedStatusContext: true };
  // A real dispatch ran (and, for actionResult.ok, was confirmed by the
  // dispatch path, which builds its own wording from provider evidence).
  if (input.emittedAction || input.actionResult?.ok === true) {
    return { intercept: false, turnClass, matchedCategory };
  }
  if (turnClass === 'read_only') {
    if (matchedCategory === 'current_turn_claim' && !input.groundedStatusContext) {
      return { intercept: true, failureType: 'read_only_answer_validation_failed', turnClass, matchedCategory };
    }
    return { intercept: false, turnClass, matchedCategory };
  }
  if (turnClass === 'mutation') {
    return { intercept: true, failureType: 'fabricated_completion_on_action_turn', turnClass, matchedCategory };
  }
  // ambiguous
  if (matchedCategory === 'current_turn_claim' && !input.groundedStatusContext) {
    return { intercept: true, failureType: 'fabricated_completion_on_action_turn', turnClass, matchedCategory };
  }
  return { intercept: false, turnClass, matchedCategory };
}

/** Marker emitted per failure type — answerSanitizer owns the human
 *  wording. Dispatch/recipient language appears ONLY on the fabricated-
 *  completion type, where a mutation was actually requested. */
export function completionInterceptMarker(failureType: NonNullable<CompletionGateVerdict['failureType']>): string {
  return failureType === 'read_only_answer_validation_failed'
    ? '[status read failed — answer withheld pending a grounded re-read]'
    : '[no action dispatched — the assistant claimed completion but no action ran]';
}

/** Cheap heuristic for "the user is asking me to DO something." Used to
 *  gate the action vocabulary + emission rules — they shouldn't ride
 *  along on casual chat or factual questions. We don't need an LLM to
 *  classify this; the verbs are a closed set and false positives are
 *  cheap (slightly longer prompt, no quality loss). */
function looksLikeImperative(text: string): boolean {
  const q = text.trim().toLowerCase();
  // Leading verb — strongest signal. Added 2026-05-21: reschedule,
  // postpone, move (already there), and explicit "cancel" leading
  // imperatives for the Phase 2 cancel_meeting / reschedule_meeting
  // capabilities. Without these, "reschedule polypack at 3pm" was
  // classified as non-imperative — ACTION_RULES + artifacts block
  // weren't injected, the LLM couldn't see eventIds, and it fell
  // back to "I can't reschedule" prose.
  if (/^(add|delegate|send|schedule|reschedule|postpone|remind|snooze|draft|reply|create|forward|mark|close|cancel|delete|remove|update|change|book|set|email|ask|chase|follow|tell|note|log|move|push|shift|invite)\b/.test(q)) return true;
  // Body verb with action-y framing.
  if (/\b(please|kindly|can you|could you)\s+(add|delegate|send|schedule|reschedule|postpone|remind|snooze|draft|reply|create|forward|mark|close|cancel|delete|remove|update|change|book|set\s+up|email|ask|chase|follow up|tell|note|log|move|push|shift|invite)\b/.test(q)) return true;
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

H7. **Surface age when info is stale.** If the only available source is >60 days old, say so explicitly ("last updated 94 days ago"). Don't present stale data as current.

H7a. **NEVER FABRICATE PROCESSES, TEAMS, OR ESCALATIONS THAT DON'T EXIST.** There is no "support team", no "engineering team", no "escalation channel", no "we'll look into this" handoff that you can defer to. The system Brain runs in is: you, the user, the dispatcher, and the integrations (Gmail / Calendar / etc.). Nothing else. Observed 2026-05-21: when Brain couldn't fix a wrong calendar invite, it wrote "I am escalating this to the support team to figure out why my calendar actions are not working correctly. I will let you know as soon as I have an update from them." — pure fabrication. There is no support team and no future update.
  - When you genuinely cannot do something, say so plainly RIGHT NOW: "I can't cancel or reschedule that meeting — my schedule_meeting action only creates new events, it doesn't modify existing ones. To fix it, please cancel the wrong event in Google Calendar yourself, then I can schedule a new one for the correct time."
  - Acceptable bracketed status markers (machine-emitted): "[Brain unavailable — reasoning service down, retry shortly]", "[preview required]". These are clearly NOT pretending to be Brain.
  - FORBIDDEN: "the team will look into it", "I've notified support", "I'll follow up with engineering", "let me check with the system", "I'll escalate this", "I'll update you when done" without an action emitted, any reference to processes / teams / channels that aren't in the action schema.

H7b. **CAPABILITY HONESTY.** Your actions are exactly the set defined in the action schema above (add_open_item, delegate_open_item, schedule_meeting, cancel_meeting, reschedule_meeting, send_email, notify_via_whatsapp, set_brain_name). You CAN cancel and reschedule meetings — but ONLY when the eventId appears in the "Recent action artifacts" block (i.e., when the meeting was scheduled by Brain in this session). For meetings outside that window (older than 24h, or scheduled manually in Google Calendar), the artifact won't be present and you cannot identify the eventId — in that case, ask the user to cancel from Calendar manually and you'll schedule the replacement.

You CANNOT (no action exists for these): modify open items after creation (only delegate transitions them), recall sent emails, undo arbitrary dispatched actions, edit a meeting's title/attendees after creation (only time and duration are patchable via reschedule). If the user asks for one of these, say plainly that you can't and offer the closest legitimate alternative.`;

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
        | { "type": "cancel_meeting",
            "eventId": string,            // MUST come from the "Recent action artifacts" block — never invent one
            "titleHint"?: string,         // optional, for user-readable confirmation
            "reason"?: string }           // optional, included in cancellation notice to attendees
        | { "type": "reschedule_meeting",
            "eventId": string,            // MUST come from the "Recent action artifacts" block
            "titleHint"?: string,
            "newWhenIso"?: "YYYY-MM-DDTHH:MM",  // local time; the dispatcher appends user's TZ offset
            "newDurationMin"?: number,
            "reason"?: string }
        | { "type": "send_email",
            "to": string[],                          // MUST be real email addresses from a Candidates block. Never a name; never a guess.
            "cc"?: string[],
            "subject": string,                       // Concise, action-oriented. NOT "Hi" or "Following up". For replies, "Re: <original subject>".
            "body": string,                          // Full email body in the user's voice. Do NOT write ANY sign-off or signature (no "Best regards, …", no name at the end) — the user's REAL signature and the Nexeo disclosure footer are appended automatically by the dispatcher.
            "replyToFeedEventId"?: string }          // When replying to an existing inbound, the feed_event id so Gmail keeps it threaded. Omit for fresh outbound.
        | { "type": "notify_via_whatsapp",
            "recipientCandidateId"?: string,         // candidateId from the Candidates block — use this when the user names an existing contact.
            "recipientAdHocPhone"?: string,          // E.164 phone (e.g. "+923710042740") — use ONLY when the user explicitly provided a raw phone number that isn't in Candidates. Never guess; never substitute a contact.
            "message": string }                      // The substantive text. Introduction "Hi <name>, this is Nexeo — <user>'s AI assistant. <user> asked me to let you know:\\n\\n" is prepended automatically — do NOT include it. EXACTLY ONE of recipientCandidateId / recipientAdHocPhone MUST be present.
        | { "type": "set_brain_name",
            "name": string }                         // The new name the user chose. Empty string / "reset" / "none" clears the custom name (you go back to "your AI assistant"). Examples: "Suzi", "Friday", "Atlas". Length cap 40 chars.
        | { "type": "record_preference",
            "key": string,                            // canonical keys: email_signoff, email_signature, email_tone, default_meeting_duration, working_hours, preferred_channel_for, meeting_notification_lead_min — or free-form when the user expresses a preference not in this list
            "value": any,                             // type matches the key: string for signoff/tone, number for duration, object {start, end} for working_hours, etc.
            "description"?: string }                  // optional one-line summary of what was learned
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

- **NO CLOSEST-MATCH SUBSTITUTION — SAFETY-CRITICAL, ZERO EXCEPTIONS.** When the user provides an EXACT target (raw phone number, exact email address, or a name that doesn't appear verbatim in the Candidates block), you MUST NOT substitute a "closest match" or "similarly-named" contact. Silent substitution has caused real harm — sending a test message to the wrong person (Ahmad Sheikh received an unsolicited "Suzi-Smoke test" when the user meant a different number). If the exact target isn't in Candidates, respond: *"I don't have <exact target> in your contacts. Give me the correct email/number, or tell me who exactly you mean."* Never guess. Never pick "the closest one". Never assume the user meant someone else just because their query is close to another contact's name. This applies to send_email, notify_via_whatsapp, schedule_meeting, delegate_open_item — every action that dispatches to a human.

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

  - **Test emails are a one-shot exception — and ONLY when the user literally says "test".** When the user's own words contain "test email" / "test message" / "test mail" naming a recipient, you may auto-fill subject="Test email from Nexeo" and body="This is a test message from your AI assistant. If you received this, the integration is working." and emit \`send_email\` on the FIRST turn. Do NOT ask "want me to send?" — a test email is its own confirmation.
  - **NEVER apply the test-email template to any other request.** On 2026-08-05 the user said "You email them" about three delegated actionable items and received the canned TEST email instead — sent to a real colleague under the user's own name. That is content fabrication and it damaged trust. If the user asks you to email someone but has NOT said what to write, you MUST ask what the message should say, or compose it from the ACTUAL subject under discussion (the open items, the delegation, the thread). A vague "email them" is never a test email.

  - **Confirmation turn ("yes", "go ahead", "send it") MUST emit the action.** If your previous turn previewed an email or asked "want me to send?", the user's confirmation OBLIGATES you to emit \`send_email\` this turn. Forbidden alternatives:
    - "Alright, I'm sending it now." (prose claiming you sent without emitting) — that's the empty-promise failure mode.
    - "I'll let you know once it's sent." (deferring) — there's no "later"; you either emit now or you don't.
    If you don't have a subject/body yet on the confirmation turn, auto-fill reasonable defaults from the conversation context. If you cannot determine a reasonable body even from context, say so plainly ("I don't have anything specific to write in the body — what should it say?") and DO NOT claim to send.

**Slot-fill / disambiguation / confirmation turns OBLIGATE action emission (applies to EVERY action type, not just send_email).** If your previous turn asked for ONE missing slot — a recipient, a time, an item id, a choice between N listed options, OR a yes/no confirmation to a previewed draft — and the user's current message answers it, you MUST emit the structured \`action\` with the resolved slot THIS TURN. The user has done their part; the next step is yours and there isn't a "later".

Three concrete sub-rules:
1. **Slot continuity** — your immediately-previous turn asked for one missing slot, the user's current message is FILLING THAT SLOT. Re-emit the same action with the slot now populated. Do not ask again.
2. **Disambiguation-answer** — your previous turn ended with a clarifying question listing N options, the user's current message is the ANSWER. Map "first", "1", "the first one" to option 1, etc. After mapping, EMIT the pending action with the resolved slot. Observed 2026-05-20: Basit asked Brain to schedule a meeting with "asad"; Brain disambiguated between two Asads; Basit said "first one"; Brain wrote "Got it Sir, I've sent the meeting invite…" with NO action JSON. The empty-promise guard caught it but the meeting still didn't land. Don't repeat this.
3. **Confirmation answer** — your previous turn previewed a draft / asked "want me to do X?" and the user said "yes" / "go ahead" / "send it" / "do it". Emit the action this turn.

Forbidden alternatives in ALL three cases:
- **"I've sent / scheduled / delegated / added [X]"** as prose without an action JSON — that's the empty-promise failure mode. The system has a regex guard that will catch this and overwrite your reply with an honest "I didn't actually do that". You're not fooling the dispatcher and you're not fooling the user; you're just wasting a turn.
- **"I'll send it shortly / send the invite in a moment"** as a deferral — there is no shortly. Either emit \`action\` now or don't claim the work is happening.
- **Asking ANOTHER clarifying question** — only valid if you genuinely have a new missing slot you didn't ask about before. Don't loop.

- **record_preference — capture user-stated preferences durably.** When the user expresses a preference that should persist across sessions, emit \`record_preference\` with a canonical key and the stated value. Examples that should fire:
  - "remember I sign off as Best regards" → \`{ type: "record_preference", key: "email_signoff", value: "Best regards" }\`
  - "default my meetings to 45 minutes" → \`{ type: "record_preference", key: "default_meeting_duration", value: 45 }\`
  - "I work 9 to 6" → \`{ type: "record_preference", key: "working_hours", value: { start: "09:00", end: "18:00" } }\`
  - "always WhatsApp Asad, never email" → \`{ type: "record_preference", key: "preferred_channel_for", value: { "asad": "whatsapp" } }\`
  - "do not read emails older than two weeks" / "only brief me on emails within two weeks" → \`{ type: "record_preference", key: "email_max_age_days", value: 14, description: "Limit normal email retrieval and briefing to the most recent 14 days" }\`
  Confirm with a one-line acknowledgement ("Got it — I'll use 'Best regards' going forward."). Don't ask for confirmation BEFORE recording — explicit user statements like these are themselves the confirmation.
  Saving a preference is INTERNAL and reversible. Never ask the user to reply "send" for it. A later explicit one-time request for an older email may override the normal recency preference without deleting it.

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
async function assembleSystemPrompt(args: {
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
  memoriesBlock: string;
  replyContextBlock: string;
  openItemsBlock: string;
  todayCalendarBlock: string;
  attentionBlock: string;
  candidatesBlock: string;
  artifactsBlock: string;
  recentLog: string;
  openedBlock: string;
  steeringHint: string | null | undefined;
  channel: 'web' | 'whatsapp';
  todayDate: string;
  userId?: number;       // Phase 3: passed through for prompt_blocks user-scope override
  clientNumber?: string;
}): Promise<string> {
  const {
    intent, isActionTurn, persona, schema, capsBlock, overlayBlock, delegationMatrixBlock,
    radarBlock, instructionsBlock, prefsBlock, memoriesBlock, replyContextBlock, openItemsBlock, todayCalendarBlock,
    attentionBlock, candidatesBlock, artifactsBlock, recentLog, openedBlock, steeringHint, channel, todayDate,
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

  // Phase 3 of data-driven refactor (2026-05-22): fetch rule blocks
  // from prompt_blocks table once per assembly. Each constant-push
  // below uses ruleBlock(name, fallback) which prefers the DB content
  // but falls back to the inline constant on miss. User-scope blocks
  // of the same name override the system seed.
  const { getApplicableBlocks } = await import('./promptBlockService');
  const blockMap = new Map<string, string>();
  try {
    const fetched = await getApplicableBlocks(args.userId ?? -1, args.clientNumber ?? '', {
      intent,
      isActionTurn,
      channel,
    });
    for (const b of fetched) blockMap.set(b.name, b.content);
  } catch (e: any) {
    console.warn('[assembleSystemPrompt] DB prompt-block fetch failed — using inline fallbacks', { error: e?.message });
  }
  const ruleBlock = (name: string, fallback: string): string => blockMap.get(name) ?? fallback;

  // Build the variant prompt in pieces, then join.
  const parts: string[] = [];
  parts.push(persona.systemPreamble);
  parts.push(ruleBlock('core_conversational_rules', CORE_CONVERSATIONAL_RULES));
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

  // Capability truth-table — a static list of what Brain can/cannot
  // do at the action layer. Injected on every turn to stop the LLM
  // fabricating limitations ("I can't add contacts yet" — false;
  // POST /entities exists). Kept short; text is stable so it caches.
  // Added 2026-07-07 after Basit Rafay chat where Brain refused a
  // real capability and asked the user to work around it.
  try {
    if (args.clientNumber && args.userId != null) {
      // LIVE truth-table: generated from the action registry + connector
      // health so the prompt can never drift from what dispatch actually
      // supports (audit 2026-07-14 #2). Fails closed to a conservative
      // block internally.
      const { renderCapabilityBlockLive } = await import('./brainCapabilityLive');
      parts.push(await renderCapabilityBlockLive(args.clientNumber, args.userId));
    } else {
      // No tenant/user context (shouldn't happen on chat paths) — the
      // static fallback still forbids fabricated limitations.
      const { renderCapabilityBlock } = require('./brainCapabilityRegistry');
      parts.push(renderCapabilityBlock());
    }
  } catch { /* registry missing = non-fatal, drop the block */ }

  // Overlay — tenant policy. Always when present; it can affect any turn.
  if (overlayBlock) parts.push(overlayBlock);

  // Standing instructions and learned preferences — always when present.
  if (instructionsBlock) parts.push(instructionsBlock);
  if (prefsBlock) parts.push(`# Learned user preferences (bias behaviour toward these)\n${prefsBlock}`);
  if (memoriesBlock) parts.push(memoriesBlock);
  if (replyContextBlock) parts.push(replyContextBlock);

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

  // Recent action artifacts — needed when actions might be emitted so
  // the LLM can reference eventIds for cancel/reschedule, or so it can
  // truthfully cite a recent dispatch when the user asks "did it go
  // through?". Only sent on action turns (not casual / day_brief).
  if (artifactsBlock && isActionTurn) {
    parts.push(artifactsBlock);
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
  parts.push(ruleBlock('output_shape_rules', OUTPUT_SHAPE_RULES));

  // Honesty rule for open-items + candidates surface — relevant when
  // either is shown.
  if (openItemsBlock || candidatesBlock) {
    parts.push(`# Honesty rule for the open-items + candidates surface
If the "Open items snapshot" block above contains a row whose title fragment matches what the user is referring to, that item EXISTS. Don't say "I don't see any open items with that name" when the snapshot literally lists one. Same for candidates: if the block shows two Asads, don't reply "I can't find any Asad" — say "which one?" with their distinguishing reasons.`);
  }

  // Intent-specific rule blocks — Phase 3: prefer DB row, fallback to constant.
  if (intent === 'factual' || intent === 'introspective') {
    parts.push(ruleBlock('factual_honesty_rules', FACTUAL_HONESTY_RULES));
    parts.push(ruleBlock('authority_rules', AUTHORITY_RULES));
  }

  // Action rules — only when the user's text looked like an imperative.
  if (isActionTurn) {
    parts.push(ruleBlock('action_emission_rules', ACTION_RULES));
  }

  // Day Brief format — only on day_brief intent.
  if (intent === 'day_brief') {
    parts.push(ruleBlock('day_brief_format_rules', DAY_BRIEF_FORMAT_RULES));
  }

  // Surface exclusivity — non-negotiable on factual / day_brief / action turns.
  if (intent === 'factual' || intent === 'day_brief' || intent === 'introspective' || isActionTurn) {
    parts.push(ruleBlock('surface_exclusivity_rules', SURFACE_EXCLUSIVITY_RULES));
  }

  return parts.join('\n\n');
}

/** Build a compact contacts/candidates snapshot for the reasoning
 *  prompt. Reasoning needs this so it doesn't hallucinate emails
 *  when emitting send_email / delegate_open_item / notify_via_whatsapp
 *  / schedule_meeting attendees. Observed 2026-05-22: reasoning
 *  emitted `yousaf@tmcltd.com` for "delegate to Yousaf" when the
 *  user's contacts actually had `muhammad.yousuf@tmcltd.com`,
 *  `yousuf.muhammad@tmcltd.ai`, etc. With contacts in its context,
 *  reasoning can either resolve unambiguously OR ask with the real
 *  options. Filtered by user scope (the userScopeGuard P0 fix).
 *
 *  Format: name + email/phone + strength signal. Capped at 60 rows
 *  so the prompt stays bounded. We include rows where ownerUserId
 *  matches this user OR scope='tenant' OR createdBy matches this
 *  user (the same filter contactResolver uses post-leak-fix). */
async function buildCandidatesBlockForReasoning(
  userId: number,
  clientNumber: string,
): Promise<string> {
  try {
    const rows = await prisma.entity.findMany({
      where: {
        clientNumber,
        entityType: 'contact',
        OR: [
          { scope: 'tenant' as any },
          { ownerUserId: userId } as any,
          { AND: [{ ownerUserId: null } as any, { createdBy: userId }] },
        ],
      } as any,
      select: {
        id: true, name: true, email: true, phone: true,
        relationshipStrength: true,
      },
      orderBy: [
        { relationshipStrength: 'desc' as any },
        { lastInteraction: 'desc' },
      ],
      take: 60,
    });
    if (rows.length === 0) return '';
    // Format: candidateId = entity row id (already stable). Reasoning
    // MUST emit candidateId (not raw email) for recipient/attendee
    // fields. Code resolves candidateId → real email at dispatch time.
    // Per Basit 2026-05-23: this eliminates hallucinated emails
    // (yousaf@tmcltd.com, @nexeo.com etc) structurally — LLM can only
    // pick from this list.
    const lines = rows.map((r) => {
      const id = (r.email ?? r.phone ?? '').toString();
      const strength = r.relationshipStrength != null
        ? ` strength=${Math.round((r.relationshipStrength as number) * 100)}%`
        : '';
      const noContact = !r.email && !r.phone ? ' [no email/phone — DO NOT pick this row for actions]' : '';
      return `- candidateId="${r.id}" name="${r.name}" ${id}${strength}${noContact}`;
    });
    return `# Your contacts (REQUIRED: emit candidateId from this list for recipient/attendee fields; NEVER invent emails/phones)\n${lines.join('\n')}`;
  } catch (e: any) {
    console.warn('[reasoning] buildCandidatesBlock failed', { error: e?.message, userId });
    return '';
  }
}

/** Pick the recipient(s) the user is likely emailing in this turn,
 *  for tone-sample prefetch. Matches name tokens (first/last name) from
 *  the user's message against entities (contacts) scoped to this user.
 *
 *  Returns up to 3 candidates so we don't burn Gmail API quota fetching
 *  tone for everyone in the user's contacts on every turn. */
async function pickToneRecipientsFromMessage(
  question: string,
  userId: number,
  clientNumber: string,
): Promise<Array<{ email: string; name: string }>> {
  if (!question || question.length < 4) return [];
  // Extract candidate name tokens — uppercase-or-after-keyword words.
  // Lowercase the question for matching but preserve original tokens.
  const lc = question.toLowerCase();
  // Common patterns: "send email to <Name>", "email <Name>", "reply to <Name>"
  const m = lc.match(/(?:to|email|message|reply|draft|notify)\s+([a-z][a-z\s.-]{2,40})/i);
  if (!m) return [];
  const namePhrase = m[1].trim().split(/\s+(?:about|regarding|re|for|on|that|saying|with|—|-)\b/)[0].trim();
  const tokens = namePhrase.split(/\s+/).filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  try {
    const rows = await prisma.entity.findMany({
      where: {
        clientNumber, entityType: 'contact',
        email: { not: null } as any,
        OR: [
          { scope: 'tenant' as any },
          { ownerUserId: userId } as any,
          { AND: [{ ownerUserId: null } as any, { createdBy: userId }] },
        ],
        AND: tokens.map((t) => ({ name: { contains: t, mode: 'insensitive' as any } } as any)),
      } as any,
      select: { name: true, email: true, relationshipStrength: true },
      orderBy: { relationshipStrength: 'desc' as any },
      take: 3,
    }).catch(() => [] as any[]);
    return rows
      .filter((r: any) => !!r.email)
      .map((r: any) => ({ email: r.email as string, name: r.name as string }));
  } catch {
    return [];
  }
}

/** Build a compact open-items snapshot for the reasoning prompt.
 *  Reasoning needs this to: (a) recognise slot-fill turns ("priority
 *  normal, due date monday" right after a DRAFT was created), (b)
 *  emit update_open_item with a real id, (c) avoid hallucinating
 *  counts ("two items with that title") when there's only one.
 *
 *  Format is intentionally terse — id + title + status + missing
 *  slots are the load-bearing fields; priority and due give reasoning
 *  enough context to know what's already filled. */
export async function buildOpenItemsBlockForReasoning(
  userId: number,
  clientNumber: string,
): Promise<string> {
  try {
    const rows = await prisma.openItem.findMany({
      where: {
        clientNumber, userId, ownerId: userId,
        status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED', 'DRAFT'] },
      },
      select: {
        id: true, title: true, status: true, priority: true, dueDate: true,
        delegateeName: true, delegateeEmail: true, metadata: true,
        delegationFollowupCount: true, delegationLastFollowupAt: true,
        createdAt: true,
      } as any,
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    if (rows.length === 0) return '';

    // Fix 2026-07-10 (Basit "ask status of EXIM" → wrong recipient):
    // resolve each delegatee NAME to its contact entity so the block
    // carries a routable candidate id + reachability. Before this, the
    // block named the delegatee ("Muhammad Yousaf") but gave reasoning
    // no id to send to — so a "ping the owner" ask couldn't bind the
    // right person and substituted whoever was in the recent-candidates
    // block (Asad). One batched lookup over the distinct delegatee names.
    const delegateeNames = Array.from(new Set(
      rows.map((r: any) => (typeof r.delegateeName === 'string' ? r.delegateeName.trim() : ''))
          .filter((n: string) => n.length > 0),
    )) as string[];
    const delegateeContactByName = new Map<string, { id: string; phone: string | null; email: string | null }>();
    if (delegateeNames.length > 0) {
      const contacts = await prisma.entity.findMany({
        where: {
          clientNumber,
          entityType: 'contact',
          name: { in: delegateeNames },
          OR: [
            { scope: 'tenant' as any },
            { ownerUserId: userId } as any,
            { AND: [{ ownerUserId: null } as any, { createdBy: userId }] },
          ],
        } as any,
        select: { id: true, name: true, phone: true, email: true },
      }).catch(() => [] as Array<{ id: string; name: string; phone: string | null; email: string | null }>);
      // First contact wins per name; a duplicate-name collision is rare
      // and the reachability hint still lets reasoning proceed or ask.
      for (const c of contacts) {
        if (!delegateeContactByName.has(c.name)) {
          delegateeContactByName.set(c.name, { id: c.id, phone: c.phone, email: c.email });
        }
      }
    }

    const lines = rows.map((r: any) => {
      const md = (r.metadata as any)?.draft;
      const missing = Array.isArray(md?.missingSlots) ? (md.missingSlots as string[]) : [];
      const due = r.dueDate ? new Date(r.dueDate).toISOString().slice(0, 10) : '—';
      let deleg = '';
      if (r.delegateeName) {
        const contact = delegateeContactByName.get(String(r.delegateeName).trim());
        deleg = ` delegated_to="${r.delegateeName}"`;
        if (contact) {
          // Routable identity — reasoning uses this id verbatim for
          // notify_via_whatsapp / send_email to the owner. Never let
          // it fall back to another candidate.
          deleg += ` delegatee_candidateId=${contact.id}`;
          const reach: string[] = [];
          if (contact.phone) reach.push('whatsapp');
          if (contact.email) reach.push('email');
          deleg += ` delegatee_reachable=${reach.length ? reach.join('+') : 'none'}`;
        } else {
          // Named but not resolvable to a contact — reasoning MUST ask
          // for the contact, not substitute someone else.
          deleg += ' delegatee_candidateId=UNRESOLVED';
        }
      }
      const followups = (r.delegationFollowupCount ?? 0) > 0 ? ` followups_sent=${r.delegationFollowupCount}` : '';
      const missStr = missing.length > 0 ? ` missing=${missing.join('+')}` : '';
      return `- id=${r.id} title="${r.title}" status=${r.status} priority=${r.priority} due=${due}${deleg}${followups}${missStr}`;
    });
    return `# Your active open items (use id to update/delegate/mark_done; to message the OWNER of an item use its delegatee_candidateId)\n${lines.join('\n')}`;
  } catch (e: any) {
    console.warn('[reasoning] buildOpenItemsBlock failed', { error: e?.message, userId });
    return '';
  }
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
  // When the reasoning gate (below) emits a confident `act`, it sets
  // this override and falls through. The legacy LLM call is skipped
  // and a synthetic `parsed` is built from the action so the rest of
  // the function (preview gate, idempotency, dispatcher) runs unchanged.
  let reasoningOverride: {
    action: ComposedAction;
    answer: string;
    confidence: number;
  } | null = null;

  // ── Earned-autonomy toggle commands (Phase 1C, 2026-07-14) ────────
  // Closed command grammar the auto-send OFFER states verbatim
  // ("auto-send emails" / "always preview emails"). Deterministic
  // mechanics like "send" — handled before any LLM so consent is never
  // subject to model interpretation.
  {
    const { parseAutoConfirmCommand, setAutoConfirm, KIND_WORDS } = await import('./autoConfirmService');
    const toggle = parseAutoConfirmCommand(question);
    if (toggle) {
      await setAutoConfirm(userId, toggle.kind, toggle.enable);
      console.info('[compose] auto-confirm toggled', { userId, clientNumber, kind: toggle.kind, enable: toggle.enable });
      return {
        answer: toggle.enable
          ? `[auto-send enabled: ${KIND_WORDS[toggle.kind]}]`
          : `[auto-send disabled: ${KIND_WORDS[toggle.kind]}]`,
        citedPageIds: [], gaps: [], sources: [], action: null,
        actionResult: null,
      };
    }
  }

  // ── DEF-035 — CONFIRMATION IS CHECKED BEFORE RE-REASONING ──────────
  //
  // THE ROOT CAUSE OF THE "send → same preview → send → same preview" LOOP.
  //
  // The reasoning gate below runs FIRST and returns early with a preview when
  // it decides to act. The pending/confirm reducer lives ~200 lines further
  // down and was therefore UNREACHABLE on a confirmation turn: "send" was fed
  // back into reasoning, which re-proposed the identical plan, called
  // startPending (displacing the plan the owner had just approved) and
  // re-rendered the preview. Forever. The owner hit this on 08-04 20:25 and
  // again on 08-05 13:05 with "send" AND "confirm".
  //
  // A human assistant shown a list and told "send" does not re-read the list
  // and ask again — it acts. So the order is inverted here: if a preview is
  // outstanding and this turn is a confirmation, DISPATCH THE STORED PLAN and
  // never re-reason. Confirmation must beat re-planning.
  //
  // Deliberately narrow: only `preview_shown` (a preview the owner actually
  // saw), only an unambiguous confirmation, and it dispatches the STORED slots
  // — so what executes is exactly what was displayed, never a re-derivation.
  {
    const confirmChannel: 'web' | 'whatsapp' = opts.channel ?? 'web';
    const q = question.trim().toLowerCase().replace(/[.!]+$/, '');
    const isBareConfirm = q.length <= 30
      && /^(yes|yep|yeah|send|send it|go\s+ahead|do\s+it|confirm|confirmed|ok|okay|proceed|sure|approve|approved|ship\s+it|please\s+do|kar\s+do|theek\s+hai|haan)$/i.test(q);
    if (isBareConfirm) {
      try {
        const { getActivePending, markCompleted, markFailed } = await import('./pendingActionService');
        const outstanding = await getActivePending(userId, confirmChannel).catch(() => null);
        if (outstanding && outstanding.status === 'preview_shown') {
          console.info('[compose] early-confirm: dispatching the stored preview without re-reasoning', {
            userId, clientNumber, channel: confirmChannel,
            pendingId: outstanding.id, kind: outstanding.actionKind,
          });
          const dispatched = await dispatchPendingDirect(clientNumber, userId, outstanding as any);
          if (dispatched.ok) await markCompleted(outstanding.id, dispatched.artifactId ?? '').catch(() => undefined);
          else await markFailed(outstanding.id, dispatched.message.slice(0, 300)).catch(() => undefined);
          return {
            answer: dispatched.message,
            citedPageIds: [], gaps: [], sources: [], action: null,
            actionResult: { ok: dispatched.ok, message: dispatched.message, artifactId: dispatched.artifactId },
            source: 'reasoning',
          };
        }
      } catch (e: any) {
        // Never break the turn on a confirm-guard failure — fall through to
        // the normal path, which is the pre-existing behaviour.
        console.warn('[compose] early-confirm guard failed, falling through', { userId, error: e?.message });
      }
    }
  }

  // ── Phase 8 (2026-05-22): reasoning-first gate ────────────────────
  // When opts.useReasoning is on (or env says so), short-circuit
  // through the new reasoning composer. Falls through to legacy on
  // any error so we never go blank. Once observed stable for a few
  // days, the legacy path retires.
  const reasoningMode = resolveReasoningMode(userId, opts.useReasoning);
  if (reasoningMode) {
    try {
      const { reasoningComposeWithTools: reasoningCompose } = await import('./reasoningCompose');
      const { applyReasoningDecision } = await import('./reasoningCompose.applyDispatch');
      // Build a minimal system prompt from persona + DB rule blocks
      // for the reasoning step. Full assembly happens on the first
      // legacy path; for now use persona.systemPreamble alone (which
      // includes the DB-fetched communication contract from Phase 2).
      const personaForReasoning = await getBrainPersona(userId, clientNumber);
      // Scoped dataBlocks for reasoning. Started with open_items only
      // (commit 2026-05-22) — every action that needs real context to
      // avoid hallucination gets its own slice added as we audit it.
      //
      // 2026-05-25: added recentEmails / recentWhatsApp / calendar /
      // contactProvenance after the Naveed "Ok sir" hallucination —
      // Brain had no actual inbox/WA data and bridged the gap with
      // fiction. These blocks make ground truth available; anti-
      // fabrication rules in reasoningCompose.ts forbid invention when
      // they're absent or empty.
      const dayBriefishRe = /\b(brief|brief\s+me|catch\s+me\s+up|fill\s+me\s+in|anything\s+(for|new)|what'?s\s+(on|up|new|pending|next)|my\s+day)\b/i;
      const mentionsEmail = /\b(email|mail|inbox|reply|gmail)\b/i.test(question);
      const mentionsWA    = /\b(whatsapp|wa|message|messaged|texted|text)\b/i.test(question);
      const wantsDayBrief = dayBriefishRe.test(question);

      // When the user wants a Day Brief, build the CANONICAL view that
      // the Page also reads. The chat narration is then locked to the
      // same data structure — no re-ranking, no drops, no additions
      // (enforced by anti-fabrication rules + the strict instruction
      // baked into renderDayBriefBlock).
      // For non-day-brief turns, build the fragmented blocks on demand
      // (cheaper than always fetching the full brief).
      let dayBriefBlock = '';
      let openItemsBlockForReasoning = '';
      let candidatesBlockForReasoning = '';
      let recentEmailsBlock = '';
      let recentWhatsAppBlock = '';
      let todayCalendarBlockForReasoning = '';
      let contactProvenanceBlock = '';
      if (wantsDayBrief) {
        const [brief, cands, prov] = await Promise.all([
          (async () => {
            const { getDayBrief, renderDayBriefBlock } = await import('../views');
            const data = await getDayBrief({ clientNumber, userId });
            return renderDayBriefBlock(data);
          })().catch(() => ''),
          buildCandidatesBlockForReasoning(userId, clientNumber).catch(() => ''),
          buildContactProvenanceBlock(clientNumber, userId, question).catch(() => ''),
        ]);
        dayBriefBlock = brief;
        candidatesBlockForReasoning = cands;
        contactProvenanceBlock = prov;
      } else {
        [
          openItemsBlockForReasoning,
          candidatesBlockForReasoning,
          recentEmailsBlock,
          recentWhatsAppBlock,
          todayCalendarBlockForReasoning,
          contactProvenanceBlock,
        ] = await Promise.all([
          buildOpenItemsBlockForReasoning(userId, clientNumber).catch(() => ''),
          buildCandidatesBlockForReasoning(userId, clientNumber).catch(() => ''),
          mentionsEmail
            ? buildRecentEmailsBlock(clientNumber, userId).catch(() => '')
            : Promise.resolve(''),
          mentionsWA
            ? buildRecentWhatsAppBlock(clientNumber, userId).catch(() => '')
            : Promise.resolve(''),
          Promise.resolve(''),
          buildContactProvenanceBlock(clientNumber, userId, question).catch(() => ''),
        ]);
      }

      // Tone-matching dataBlock (2026-05-25): when the user's message
      // suggests an email action, identify the likely recipient(s)
      // from candidates + the message text, fetch the user's recent
      // sent emails TO those people, and inject as toneContext so
      // reasoning drafts in the user's voice — not generic prose.
      // Per Basit "brain should learn and reply in the same tone this
      // is very important".
      let toneContextBlock = '';
      try {
        const looksLikeEmailDraft = /\b(email|send|reply|draft|write|note|message)\b/i.test(question);
        if (looksLikeEmailDraft) {
          const toneCandidates = await pickToneRecipientsFromMessage(
            question, userId, clientNumber,
          );
          if (toneCandidates.length > 0) {
            const { getToneSamplesForRecipients, renderToneBlock } = await import('./senderToneService');
            const samples = await getToneSamplesForRecipients(
              userId,
              toneCandidates.map((c) => c.email),
              5,
            );
            // Attach display names for nicer rendering
            samples.forEach((s) => {
              const match = toneCandidates.find((c) => c.email.toLowerCase() === s.recipientEmail);
              if (match) s.recipientName = match.name;
            });
            toneContextBlock = renderToneBlock(samples);
            if (toneContextBlock) {
              console.info('[compose] toneContext attached', {
                userId, recipients: samples.filter((s) => s.samples.length > 0).map((s) => s.recipientEmail),
              });
            }
          }
        }
      } catch (e: any) {
        console.warn('[compose] toneContext build failed (non-fatal)', { error: e?.message });
      }

      // Chat 9 finalization (#1): carry canonical record ids ACROSS
      // turns. The artifacts block extracts ids Brain surfaced in
      // prior turns (open items, events) from history — so a pronoun
      // follow-up ("tell me its status") resolves against the exact
      // record id, not just the previous answer's prose.
      const artifactsBlockForReasoning = renderArtifactsBlock(history);
      const result = await reasoningCompose({
        userId, clientNumber,
        question, history,
        channel: opts.channel ?? 'web',
        systemPrompt: personaForReasoning.systemPreamble,
        dataBlocks: {
          openItems: openItemsBlockForReasoning || undefined,
          candidates: candidatesBlockForReasoning || undefined,
          memories: toneContextBlock || undefined, // reuse memories slot for tone
          recentEmails: recentEmailsBlock || undefined,
          recentWhatsApp: recentWhatsAppBlock || undefined,
          todayCalendar: todayCalendarBlockForReasoning || undefined,
          contactProvenance: contactProvenanceBlock || undefined,
          dayBrief: dayBriefBlock || undefined,
          artifacts: artifactsBlockForReasoning || undefined,
        },
      });
      if (result) {
        console.info('[compose] reasoning-path used', {
          userId, clientNumber, decision: result.decision, confidence: result.confidence,
        });
        // Persist reasoning trace.
        void writeReasoningTrace({
          userId, clientNumber,
          turnId: `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
          decision: result.decision,
          actionType: result.action?.type ?? null,
          confidence: result.confidence,
          rationale: result.rationale,
        }).catch(() => undefined);

        // ── Compound actions (Phase 1A, 2026-07-14) ──────────────────
        // reasoning has been ABLE to emit multi-step action_plan since
        // 2026-05-23, but nothing ever executed it — compound requests
        // like "update his email AND send followup on email and
        // whatsapp" (Basit chat 5) were silently reduced to one action
        // or dropped. This branch makes plans real: validate every step
        // against the registry, preview ALL steps together, and store a
        // single 'action_plan' pending — one "send" confirms and
        // dispatches every step (guard + provider verification per
        // step, stop on first failure).
        if (result.decision === 'act' && Array.isArray(result.actionPlan) && result.actionPlan.length >= 2) {
          const steps = result.actionPlan.slice(0, 5); // hard cap — a "plan" of 6+ steps is a runaway
          const { validateReasoningAction } = await import('./reasoningCompose');
          let invalid: string | null = null;
          for (const [i, step] of steps.entries()) {
            if (!step?.type || step.type === 'action_plan') { invalid = `step ${i + 1}: missing or nested type`; break; }
            const errs = await validateReasoningAction({ type: step.type, payload: step.payload ?? {} });
            if (errs && errs.length > 0) { invalid = `step ${i + 1} (${step.type}): ${errs[0]}`; break; }
            // DISPATCHABILITY (2026-08-04): registry presence is not enough.
            // update_open_item passed validation, rendered in the preview and
            // was confirmed — then died because dispatchPendingDirect had no
            // case for it, losing three dictated updates. Never ask the owner
            // to confirm something that cannot execute; fail here, where it
            // costs a message, instead of after "yes".
            if (!DISPATCHABLE_PLAN_STEP_KINDS.has(step.type)) {
              invalid = `step ${i + 1} (${step.type}): no dispatcher for this action in a confirmed plan`;
              break;
            }
          }
          if (invalid) {
            return {
              answer: `[action_plan validation failed: ${invalid}]`,
              citedPageIds: [], gaps: [], sources: [], action: null,
              actionResult: { ok: false, message: `plan_invalid: ${invalid}` },
              source: 'reasoning',
            };
          }
          const planSteps = steps.map((s) => ({ kind: s.type, slots: s.payload ?? {} }));
          const preview = await renderPlanPreview(planSteps, userId, clientNumber);
          let previewWithNotice = preview;
          try {
            const { startPending, hashProposedAction, markPreviewShown } = await import('./pendingActionService');
            const pending = await startPending({
              clientNumber, userId,
              channel: opts.channel ?? 'web',
              actionKind: 'action_plan',
              slots: { steps: planSteps },
              missingSlots: [],
            });
            await markPreviewShown(pending.id, hashProposedAction('action_plan', { steps: planSteps }));
            const notice = displacementNotice((pending as any).replaced);
            if (notice) previewWithNotice = notice + preview;
            console.info('[compose] action_plan preview persisted', {
              userId, clientNumber, pendingId: pending.id, stepKinds: planSteps.map((s) => s.kind),
            });
          } catch (e: any) {
            console.warn('[compose] action_plan pending persist failed', { userId, error: e?.message });
            return {
              answer: `[action_plan failed to queue: ${e?.message ?? 'unknown'}]`,
              citedPageIds: [], gaps: [], sources: [], action: null,
              actionResult: { ok: false, message: 'plan_persist_failed' },
              source: 'reasoning',
            };
          }
          return {
            answer: previewWithNotice,
            citedPageIds: [], gaps: [], sources: [], action: null,
            actionResult: { ok: false, message: 'preview_required' },
            source: 'reasoning',
          };
        }

        const envelope = await applyReasoningDecision({
          result, userId, clientNumber,
          channel: opts.channel ?? 'web',
          question,
        });
        // For ask / answer / decline, return reasoning's envelope as-is
        // (these surfaces never needed the legacy LLM). Mark source so
        // downstream validateBeforeRender skips the empty-promise
        // regex check — reasoning's questions and answers shouldn't be
        // regex-gated for "I delegate / I send" verbs (legacy LLM era).
        //
        // EXCEPT: block the reasoning-answer-decision-with-completion-
        // claim case. If reasoning decided 'answer' but the answer_text
        // contains a completion claim ("has been sent", "delegated to
        // X", etc.), that decision was invalid per the reasoning
        // prompt contract (see reasoningCompose.ts anti-fabrication
        // rules). Fabricated completion prose must never ship, even on
        // the ask/answer/decline early-return path. Replace with a
        // bracketed marker; answerSanitizer converts to honest text.
        // (Basit 2026-07-08 fix pass, chat 2 "has been sent to Asad".)
        if (result.decision !== 'act') {
          // Chat 9 (2026-07-14): gate on TURN INTENT, not bare regex.
          // "Tell me its status" → "…is delegated to Muhammad Yousaf"
          // is a grounded status answer, not a fabricated completion —
          // the old unconditional intercept turned it into a bogus
          // "didn't dispatch / name the recipient" reply.
          if (result.decision === 'answer') {
            const groundedRecordIds = extractRecordIds(
              openItemsBlockForReasoning, dayBriefBlock, artifactsBlockForReasoning,
            );
            const verdict = shouldInterceptCompletionClaim({
              userQuestion: question,
              answer: envelope.answer,
              decision: result.decision,
              emittedAction: Boolean(envelope.action),
              actionResult: (envelope as any).actionResult ?? null,
              groundedRecordIds,
              groundedStatusContext: Boolean(
                openItemsBlockForReasoning || dayBriefBlock || recentEmailsBlock
                || recentWhatsAppBlock || todayCalendarBlockForReasoning,
              ),
            });
            if (verdict.intercept) {
              console.warn('[compose] completion claim intercepted (reasoning path)', {
                userId, clientNumber,
                turnClass: verdict.turnClass,
                decision: result.decision,
                emittedAction: Boolean(envelope.action),
                actionResultStatus: 'none',
                matchedCategory: verdict.matchedCategory,
                failureType: verdict.failureType,
                head: (envelope.answer || '').slice(0, 80), // bounded — never full content
              });
              return {
                ...envelope,
                answer: completionInterceptMarker(verdict.failureType!),
                actionResult: { ok: false, message: verdict.failureType! },
                source: 'reasoning',
              };
            }
          }
          return { ...envelope, source: 'reasoning' };
        }
        // For act: short-circuit the legacy LLM round-trip. The
        // legacy LLM doesn't have the cross-turn clarification context
        // that reasoning does — calling it on a follow-up like
        // "Asad Taj" produces empty-promise prose ("got it Sir, I've
        // scheduled it…") with no action JSON, and the empty-promise
        // guard then overwrites Brain's reply.
        //
        // Set `reasoningOverride` and fall through; the LLM call
        // below sees the override and skips, building a synthetic
        // `parsed` so the rest of the function (preview gate,
        // idempotency, dispatcher, artifact tracking) runs unchanged.
        //
        // Threshold: confidence >= 0.7. Below that, fall through to
        // legacy as a safety net — better one extra LLM call than
        // a confidently-wrong action.
        if (envelope.action && result.confidence >= 0.7) {
          // Validate reasoning's action against the data-driven
          // action_definitions schema. This is the AUTHORITATIVE
          // validation — not normaliseAction (which is tuned for the
          // legacy LLM's quirks and can reject perfectly valid
          // reasoning payloads, e.g. observed 2026-05-22 with the
          // Asad meeting flow). If reasoning's payload is malformed
          // (missing required slot, wrong type), tell the user
          // exactly what's missing instead of falling through to a
          // generic "I didn't actually complete that".
          const { validateReasoningAction } = await import('./reasoningCompose');
          const validationErrors = await validateReasoningAction({
            type: envelope.action.type,
            payload: envelope.action as any,
          }, clientNumber); // E3/E5 — tenant-scoped registry lookup
          if (validationErrors && validationErrors.length > 0) {
            console.warn('[compose] reasoning act failed schema validation', {
              userId, clientNumber,
              actionType: envelope.action.type,
              errors: validationErrors,
            });
            return {
              // Bracketed system marker (no-hardcoded-fake-Brain-replies rule).
              answer: `[${envelope.action.type} validation failed: ${validationErrors[0]}]`,
              citedPageIds: [], gaps: [], sources: [],
              action: null,
              actionResult: { ok: false, message: `schema_violation: ${validationErrors.join('; ')}` },
              source: 'reasoning',
            };
          }
          reasoningOverride = {
            action: envelope.action,
            answer: envelope.answer,
            confidence: result.confidence,
          };
          console.info('[compose] reasoning act short-circuit', {
            userId, clientNumber,
            actionType: envelope.action.type,
            confidence: result.confidence,
          });
          // fall through
        } else {
          // Low confidence — fall through to legacy as a safety net.
          console.info('[compose] reasoning act low-confidence, falling through to legacy', {
            userId, clientNumber, confidence: result.confidence,
          });
        }
      } else {
        console.warn('[compose] reasoning returned null — falling through to legacy', { userId });
      }
    } catch (e: any) {
      console.warn('[compose] reasoning path threw — falling through to legacy', { userId, error: e?.message });
    }
  }

  // ── Sprint 1: pending-state short-circuit ─────────────────────────
  // Before paying for the full compose pipeline, check whether the
  // user is confirming or cancelling a preview Brain already showed.
  // Those cases have a deterministic path: no LLM call, no retrieval,
  // no candidate resolution — just dispatch (or abort) the action
  // already cached in the pending row. This is the load-bearing fix
  // for "Brain forgot what we were doing" — the action is stored, the
  // hash matches, we just execute.
  //
  // continue_task and correct_preview also reference pending but
  // still need the composer (for slot extraction + preview re-render)
  // — they fall through after pending is loaded so the prompt
  // assembly below can include it.
  const channel: 'web' | 'whatsapp' = opts.channel ?? 'web';
  const { getActivePending, markCompleted, markFailed, markCancelled, hashProposedAction } = await import('./pendingActionService');
  const { reduceTurn, resolveAmbiguousWithLlm } = await import('./turnRelationReducer');
  let activePending = await getActivePending(userId, channel).catch(() => null);
  let turnRelation = reduceTurn({ question, pending: activePending, history });

  // Quality Sprint 1: Flash tiebreaker for ambiguous cases. The
  // deterministic reducer covers obvious patterns ("yes", "cancel",
  // "actually change to 4pm" etc.) but misses natural-language nuance
  // like "ship it" / "looks good fire it off" / "yes but make it 4".
  // When deterministic returns 'ambiguous' AND a pending exists,
  // burn ~80 tokens on a Flash classifier rather than dropping into
  // the slow full-composer path. Bounded cost; better UX.
  // Structural fix 2026-07-07: bare confirmation on expired pending
  // now REVIVES + DISPATCHES instead of returning an "expired" marker.
  // Reasoning: the user's intent is unambiguous — they saw a preview
  // in Brain's last turn (or a few minutes ago), typed "send". Telling
  // them "that draft expired, re-issue" is machine-shrug UX; the state
  // machine's TTL is our internal problem, not the user's. If the
  // expired pending is the SAME kind and was previewed within 24h,
  // treat it as active and dispatch.
  if (!activePending) {
    const { getRecentlyExpiredPending } = await import('./pendingActionService');
    const q = question.trim().toLowerCase();
    const looksLikeBareConfirm = q.length <= 30 && /^(yes|yep|yeah|send|go\s+ahead|do\s+it|confirm|ok|okay|proceed|sure|approve|approved|ship\s+it|please\s+do)\.?$/i.test(q);
    if (looksLikeBareConfirm) {
      const expired = await getRecentlyExpiredPending(userId, channel).catch(() => null);
      if (expired) {
        console.info('[brain-chat] pending.reviving-expired-on-confirm', {
          userId, clientNumber, expiredId: expired.id, kind: expired.actionKind,
        });
        // Treat as active for the remainder of this turn — falls
        // through to the confirm_preview branch below.
        activePending = expired;
        turnRelation = { type: 'confirm_preview', pendingId: expired.id };
      }
    }
  }

  if (turnRelation.type === 'ambiguous' && activePending) {
    const lastBrain = [...history].reverse().find((h) => h.role === 'brain');
    const resolved = await resolveAmbiguousWithLlm({
      question, pending: activePending,
      lastBrainText: lastBrain?.text ?? '',
    });
    if (resolved.type !== 'ambiguous') {
      console.info('[brain-chat] reducer.tiebreaker', {
        userId, clientNumber, channel,
        original: 'ambiguous', resolved: resolved.type,
      });
      turnRelation = resolved;
    }
  }

  if (activePending && turnRelation.type === 'confirm_preview') {
    // The user confirmed a preview Brain just showed. The action is
    // fully grounded in pending.slots — dispatch directly, no LLM.
    // Wrapped in withIdempotency: if the user double-taps "send" or
    // the webhook retries, the second call replays the first result
    // instead of dispatching twice. Per Sprint 3 hardening (reviewer's
    // #18) — duplicate sends are a real risk on WhatsApp where the
    // user can re-press fast.
    console.info('[brain-chat] pending.confirm dispatching', {
      userId, clientNumber, channel, kind: activePending.actionKind, pendingId: activePending.id,
    });

    // Q5b finish: transition the existing 'previewed' artifact through
    // confirmed → dispatching → succeeded/failed. Lookup by pendingId.
    let artifactRowId: string | null = null;
    try {
      const existing = await (prisma as any).brainActionArtifact.findFirst({
        where: { pendingActionId: activePending.id, status: 'previewed' },
        orderBy: { createdAt: 'desc' },
      });
      if (existing) {
        artifactRowId = existing.id;
        const { updateArtifactStatus } = await import('./brainActionArtifactService');
        await updateArtifactStatus(artifactRowId, 'confirmed');
        await updateArtifactStatus(artifactRowId, 'dispatching');
      }
    } catch { /* artifact tracking is non-fatal */ }

    try {
      const { withIdempotency } = await import('../actionIdempotencyService');
      const idemActionType = brainActionTypeToIdem(activePending.actionKind);
      const idemReferenceId = activePending.id; // pendingId is unique per (user, channel, preview)
      const { result: dispatchResult, replayed } = await wrapDispatchIdem(
        idemActionType, clientNumber, userId, idemReferenceId,
        () => dispatchPendingDirect(clientNumber, userId, activePending),
      );
      if (replayed) {
        console.info('[brain-chat] pending.confirm idempotency replay', {
          userId, clientNumber, pendingId: activePending.id,
        });
      }
      if (dispatchResult.ok && dispatchResult.artifactId) {
        await markCompleted(activePending.id, dispatchResult.artifactId);
      } else if (!dispatchResult.ok) {
        await markFailed(activePending.id, dispatchResult.message);
      }
      // Q5b finish: terminal status transition.
      try {
        const { updateArtifactStatus } = await import('./brainActionArtifactService');
        await updateArtifactStatus(artifactRowId, dispatchResult.ok ? 'succeeded' : 'failed', {
          result: dispatchResult,
          artifactExtId: dispatchResult.artifactId ?? null,
          errorMessage: dispatchResult.ok ? null : dispatchResult.message,
        });
      } catch { /* non-fatal */ }
      // Earned autonomy (Phase 1C): after a successful confirmed
      // dispatch, check whether the user has now approved this kind
      // enough times unmodified to EARN an auto-send offer. Marker is
      // rendered human by answerSanitizer; offered at most once/30d.
      let offerSuffix = '';
      if (dispatchResult.ok) {
        try {
          const { maybeOfferAutoConfirm } = await import('./autoConfirmService');
          const offer = await maybeOfferAutoConfirm(userId, activePending.actionKind);
          if (offer) offerSuffix = `\n\n${offer}`;
        } catch { /* offer is a nicety — never block the confirmation */ }
      }
      return {
        answer: `${dispatchResult.message}${offerSuffix}`,
        citedPageIds: [],
        gaps: [],
        sources: [],
        action: null,
        actionResult: { ok: dispatchResult.ok, artifactId: dispatchResult.artifactId, message: dispatchResult.message },
      };
    } catch (e: any) {
      await markFailed(activePending.id, e?.message);
      try {
        const { updateArtifactStatus } = await import('./brainActionArtifactService');
        await updateArtifactStatus(artifactRowId, 'failed', {
          errorCode: 'dispatch_threw',
          errorMessage: String(e?.message ?? 'unknown'),
        });
      } catch { /* non-fatal */ }
      return {
        answer: `[Action failed: ${e?.message ?? 'unknown error'}]`,
        citedPageIds: [], gaps: [], sources: [], action: null,
        actionResult: { ok: false, message: String(e?.message ?? 'unknown') },
      };
    }
  }

  if (activePending && turnRelation.type === 'cancel_pending') {
    await markCancelled(activePending.id);
    console.info('[brain-chat] pending.cancel', { userId, clientNumber, pendingId: activePending.id });
    return {
      // Bracketed system marker (no-hardcoded-fake-Brain-replies rule).
      answer: `[cancelled]`,
      citedPageIds: [], gaps: [], sources: [], action: null,
      actionResult: null,
    };
  }

  // For continue_task, correct_preview, and all other relations,
  // fall through to the full composer. The pending state will be
  // surfaced to the LLM via the composer's prompt (added below) so
  // it knows what's already collected.
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
  // Today's date in the USER's local timezone, not UTC.
  // Sprint 4A (2026-05-21): swapped to per-user lookup via
  // userTimezoneService. Existing rows default to Asia/Karachi
  // (back-compat); new users in other zones get correct anchoring.
  const { getUserLocalDate } = await import('../userTimezoneService');
  const todayDate = await getUserLocalDate(userId).catch(() => new Date().toISOString().slice(0, 10));

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

  // Artifacts block — includes (a) session-dispatched action artifacts
  // from history AND (b) upcoming Google Calendar events when the user
  // message looks cancel/reschedule-ish, so Brain can identify ANY
  // meeting the user references — not just ones it scheduled in-session.
  // Without (b), a meeting scheduled in a prior session (or manually on
  // Calendar) had no resolvable eventId and Brain self-disabled.
  // 2026-05-22: reply context — when the user's message looks like
  // "reply to X's email about Y" or "ask same as Z did", search
  // feed_events for the target thread + body source so the action-
  // decider can emit send_email with replyToFeedEventId properly
  // grounded. Without this, Brain composed prose claiming to reply
  // but had no thread ID and no actual content to quote — empty-
  // promise guard caught it (correctly) but Brain failed at the
  // task. Per Basit's 12:55 AM session: the diagnostic message
  // helps, actually doing the work helps more.
  const replyContextBlock = await (async () => {
    if (!isActionTurn) return '';
    try {
      const { buildReplyContext, renderReplyContextBlock } = await import('./replyContextBuilder');
      const ctx = await buildReplyContext({ userId, clientNumber, question });
      if (ctx) {
        console.info('[brain-chat] reply-context built', {
          userId, clientNumber,
          targetThreadId: ctx.targetThread?.feedEventId,
          bodySourcePerson: ctx.bodySource?.sourcePersonName,
        });
      }
      return renderReplyContextBlock(ctx);
    } catch (e: any) {
      console.warn('[brain-chat] reply-context build failed (non-fatal)', { userId, error: e?.message });
      return '';
    }
  })();

  // Quality Sprint 2: long-term memory block. Brain remembers
  // user-confirmed preferences (sign-off, default duration, working
  // hours, etc.) and applies them without re-asking. Only EXPLICIT
  // + SYSTEM + confirmed-INFERRED memories make it through; pending
  // inferred memories live in Settings UI for review.
  const memoriesBlock = await (async () => {
    try {
      const { renderMemoriesBlock } = await import('./userMemoryService');
      const inferred = await renderMemoriesBlock(userId);
      // C1 (2026-07-08): governed memories were approve-only dead storage —
      // no compose path ever read them. User-approved memories now ride in
      // the same block slot as inferred ones.
      const { renderGovernedMemoriesBlock } = await import('../learning/governedMemoriesBlock');
      const governed = await renderGovernedMemoriesBlock(clientNumber, userId);
      return [inferred, governed].filter(Boolean).join('\n\n');
    } catch { return ''; }
  })();

  let artifactsBlock = renderArtifactsBlock(history);
  if (isActionTurn && /\b(cancel|reschedule|postpone|move|push|shift|change|update|delete|remove)\b/i.test(question)) {
    try {
      const { getUpcomingEvents } = await import('../calendarService');
      const upcoming = await getUpcomingEvents(userId, 7);
      if (upcoming.events && upcoming.events.length > 0) {
        const calLines = upcoming.events.slice(0, 15).map((e) =>
          `- schedule_meeting artifactId=${e.id} — "${e.title}" at ${e.start}${e.attendees?.length ? ` with ${e.attendees.slice(0, 3).join(', ')}` : ''}`,
        );
        const calBlock = `# Upcoming calendar events (next 7 days — use these artifactIds for cancel_meeting / reschedule_meeting actions referencing existing meetings)
${calLines.join('\n')}`;
        artifactsBlock = artifactsBlock ? `${artifactsBlock}\n\n${calBlock}` : calBlock;
      }
    } catch (e: any) {
      console.warn('[brain-chat] upcoming calendar fetch failed', { userId, error: e?.message });
    }
  }
  const systemPrompt = await assembleSystemPrompt({
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
    memoriesBlock,
    replyContextBlock,
    openItemsBlock,
    todayCalendarBlock,
    attentionBlock,
    candidatesBlock,
    artifactsBlock,
    recentLog: recentLog || '(no recent activity logged)',
    openedBlock,
    steeringHint: opts.steeringHint,
    channel: opts.channel ?? 'web',
    todayDate,
    userId,
    clientNumber,
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
  if (reasoningOverride) {
    // Reasoning already decided this turn is an `act` with a validated
    // payload. Build a synthetic compose envelope so parseCompose
    // returns the reasoning action, and the rest of the function
    // (preview gate, idempotency, dispatch) runs on it unchanged.
    raw = JSON.stringify({
      answer: reasoningOverride.answer,
      cites: [],
      gaps: [],
      action: reasoningOverride.action,
    });
  } else {
    try {
      const r = await callLLM(systemPrompt, userMessage, {
        maxTokens: 2048,
        userId, clientNumber, purpose: 'chat_compose',
      });
      raw = r.text;
    } catch (err: any) {
      // Provider failure: LOG the full chain (Gemini Pro thinking-budget
      // errors, Anthropic credit-balance copy, timeouts) for diagnosis,
      // but NEVER ship err.message to the user. It contains provider
      // names, model error codes, even Anthropic's billing text — that's
      // an internal-infra leak on a phone screen. Replace with a single
      // bracketed system marker (the only non-LLM string the user is
      // allowed to see).
      console.warn('[brain-chat] LLM call failed', { error: err?.message, userId, clientNumber });
      return {
        answer: `[Brain unavailable — reasoning service down, retry shortly]`,
        citedPageIds: [],
        gaps: [],
        sources: [],
        action: null,
        actionResult: null,
      };
    }
  }

  const parsed = parseCompose(raw);

  // If reasoning supplied the action, it's already been validated
  // against the data-driven action_definitions schema upstream — it's
  // authoritative. Override parseCompose's normaliseAction output
  // (which is tuned for the legacy LLM's quirks and was observed
  // dropping perfectly valid reasoning payloads, leaving parsed.action
  // null and triggering the empty-promise guard). Reasoning's emission
  // is the source of truth on this turn.
  if (reasoningOverride) {
    parsed.action = reasoningOverride.action;
    parsed.answer = reasoningOverride.answer;
  }

  // Diagnostic — what did the LLM actually emit on this turn? Without
  // this we can't tell whether a "Sending email now" prose without an
  // actionResult came from (a) LLM emitting no action at all, (b)
  // normaliseAction rejecting it for missing slots, or (c) dispatcher
  // failing silently. Logged once per compose, regardless of outcome.
  // Observed 2026-05-20: Basit asked Brain to send an email to Asad
  // and Brain replied "Sending now…" with no actionResult — was it
  // (a), (b), or (c)? No way to tell from production logs.
  console.info('[brain-chat] compose.parsed', {
    userId, clientNumber,
    rawLen: raw.length,
    actionEmitted: !!parsed.action,
    actionType: parsed.action?.type ?? null,
    citesCount: parsed.cites.length,
    answerHead: parsed.answer.slice(0, 80),
  });

  // ── Option A (v2): constrained action-decider when main compose fails ─
  // When the main compose produces prose that claims completion ("I've
  // sent", "I'm scheduling", "delegated to X") but emits no action,
  // OR produces wandering disambiguation prose after the user has
  // clearly resolved the slot, run a CONSTRAINED action-decider call.
  //
  // The decider has only TWO output paths:
  //   - action (structured JSON for the dispatcher)
  //   - missing_slot (a specific field name to ask the user about)
  //
  // No free-form prose path means no escape valve. The wandering /
  // "let me ask AGAIN which Asad" failure mode (observed 2026-05-20
  // when Basit gave full disambiguation answers and Brain kept looping)
  // is structurally impossible — the model MUST commit.
  //
  // Trigger conditions:
  //   (1) Main compose claimed completion (empty-promise regex matched)
  //       BUT emitted no action.
  //   (2) Main compose produced disambiguation prose (no action) AND
  //       the user's current message is a short slot-fill answer
  //       (the disambiguation-resolution case).
  //
  // Cost: one extra LLM call (Flash, ~1024 tokens, constrained JSON)
  // only when the failure pattern is detected. Happy path unchanged.
  const userMessageLooksLikeSlotFill =
    !parsed.action &&
    question.trim().length <= 60 &&
    history.length > 0 &&
    history[history.length - 1]?.role === 'brain' &&
    /\?\s*$/.test(history[history.length - 1]?.text || '');
  // Mutate intent — user clearly asked for action but main compose
  // self-disabled ("I can't…"). Fire the decider to either commit OR
  // honestly identify the missing slot (e.g., eventId not in artifacts).
  // Added 2026-05-21 after Basit's reschedule turn was rejected by
  // the main compose without ever consulting the decider.
  const userMessageIsActionImperative =
    !parsed.action &&
    looksLikeImperative(question) &&
    /^i\s+(?:can'?t|cannot|am\s+unable)/i.test(parsed.answer);
  const triggerDecider =
    !parsed.action &&
    (EMPTY_PROMISE_RE.test(parsed.answer) || userMessageLooksLikeSlotFill || userMessageIsActionImperative);

  if (triggerDecider) {
    console.warn('[brain-chat] triggering constrained action-decider', {
      userId, clientNumber,
      reason: EMPTY_PROMISE_RE.test(parsed.answer) ? 'empty-promise' : 'slot-fill-no-action',
      firstAttemptHead: parsed.answer.slice(0, 100),
    });
    const decision = await decideAction({
      question, history,
      candidatesBlock: candidatesBlock ?? '',
      openItemsBlock: openItemsBlock ?? '',
      artifactsBlock: artifactsBlock ?? '',
      todayDate,
      userId, clientNumber,
    });
    console.info('[brain-chat] decideAction.result', {
      userId, clientNumber,
      decidedAction: decision?.action?.type ?? null,
      missingSlot: decision?.missingSlot ?? null,
      rationale: (decision?.rationale ?? '').slice(0, 120),
    });
    if (decision) {
      if (decision.action) {
        // Decider committed to an action. Use it — replace whatever
        // confused prose the main compose produced with a neutral
        // descriptive line; the dispatch path below (or the gate)
        // will overwrite with the actionResult message anyway.
        parsed.action = decision.action;
        parsed.answer = `Proceeding with ${decision.action.type.replace(/_/g, ' ')} based on your message.`;
      } else if (decision.missingSlot) {
        // Decider couldn't ground the action because a specific slot
        // is missing. Ask the user for THAT slot, not a generic
        // "what did you want?" question.
        parsed.answer = renderMissingSlotPrompt(null, decision.missingSlot);
        parsed.action = null;
      } else {
        // Structural safety net (Basit 2026-07-08 fix pass; re-gated
        // 2026-07-14 chat 9). The decider gave up (no action, no
        // missing slot) BUT the prose asserted completion. The gate
        // distinguishes a fabricated current-turn claim on a MUTATION
        // turn (must never ship) from grounded state language on a
        // read-only/status turn ("is delegated to X" — the correct
        // answer, previously false-positived into a dispatch error).
        //
        // Invariant preserved: completion prose on a mutation turn
        // reaches the user ONLY when built from a real provider
        // response (see the sendRes.messageId assembly for send_email).
        const verdict = shouldInterceptCompletionClaim({
          userQuestion: question,
          answer: parsed.answer,
          isActionTurn,
          emittedAction: false,
          actionResult: null,
          groundedStatusContext: Boolean(openItemsBlock || artifactsBlock),
        });
        if (verdict.intercept) {
          console.warn('[brain-chat] completion claim intercepted (legacy decider path)', {
            userId, clientNumber,
            turnClass: verdict.turnClass,
            decision: 'decider_no_action',
            emittedAction: false,
            actionResultStatus: 'none',
            matchedCategory: verdict.matchedCategory,
            failureType: verdict.failureType,
            head: parsed.answer.slice(0, 80), // bounded — never full content
          });
          parsed.answer = completionInterceptMarker(verdict.failureType!);
          parsed.action = null;
        }
      }
      // If neither action, missingSlot, nor completion claim: decider
      // concluded no action intent AND the prose is innocuous. Leave
      // it alone.
    }
  }

  // Cite resolution moved AFTER the retry so retry's cites win if it
  // ran. Otherwise this uses the first attempt's cites unchanged.
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

  // ── Option B: Preview-by-default gate for human-facing actions ───
  // Every action that touches another human (send_email,
  // schedule_meeting, notify_via_whatsapp) is blocked by default
  // and converted to a preview. The user sees EVERY slot value
  // (recipient, time, subject, body, attendees) and confirms on the
  // NEXT turn. Only on confirmation does the action dispatch.
  //
  // Solves the full "Brain did the wrong thing" failure class:
  //   - wrong recipient (2-Asad case) → user sees the email, corrects
  //   - wrong time (3pm misparsed as 03:00) → user sees the ISO, corrects
  //   - wrong subject / wrong body → user reads draft, corrects
  //   - wrong action type → user sees "schedule_meeting" when they
  //     wanted add_open_item, corrects
  //
  // Two narrow exceptions for one-shot dispatch:
  //   1. Confirmation turn — prior Brain message was a preview AND
  //      user's current message is a short confirmation ("yes",
  //      "send", "go ahead").
  //   2. Canonical test email — subject + body match hardcoded test
  //      defaults AND recipient appears verbatim in user message.
  //
  // Internal actions (add_open_item, delegate_open_item, set_brain_name)
  // skip the gate — reversible or user-owned data, no cross-human
  // impact. Per Basit 2026-05-20: "0 tolerance on wrong actions by
  // Brain." Wrong outbound to another human is irreversible and
  // visible; the preview default ensures the user always catches it
  // before it ships.
  if (parsed.action) {
    const blockReason = await gateHumanFacingAction(parsed.action, question, history, userId);
    if (blockReason) {
      console.warn('[brain-chat] human-facing action blocked by verification gate', {
        userId, clientNumber, actionType: parsed.action.type, reason: blockReason,
      });
      // Convert to a preview the user must confirm. Action dispatch
      // is skipped entirely; the user sees the exact slot values
      // Brain wants to use and either confirms or corrects.
      answer = await renderActionPreview(parsed.action, userId, clientNumber, blockReason);

      // Q5a: availability check for meeting previews. Before storing
      // the pending, look at the user's own calendar; if the
      // requested time conflicts with an existing event, prepend a
      // warning to the preview so the user can decide before
      // confirming. We don't auto-pick a new time — that's the
      // user's call.
      if (parsed.action.type === 'schedule_meeting' || parsed.action.type === 'reschedule_meeting') {
        try {
          const { checkUserAvailability } = await import('./availabilityService');
          const { resolveDateTime } = await import('./dateResolver');
          // V2: raw phrases on the action; resolve here for the
          // availability check.
          const rawWhen = parsed.action.type === 'schedule_meeting'
            ? parsed.action.whenRaw
            : (parsed.action.newWhenRaw ?? '');
          const durationMin = parsed.action.type === 'schedule_meeting'
            ? (parsed.action.durationMin ?? 30)
            : (parsed.action.newDurationMin ?? 30);
          const whenIso = rawWhen ? await resolveDateTime(rawWhen, userId) : null;
          if (whenIso) {
            const conflicts = await checkUserAvailability(userId, whenIso, durationMin);
            if (conflicts.length > 0) {
              const conflictLines = conflicts.slice(0, 3).map((c) =>
                `  • "${c.title}" at ${c.start}`,
              ).join('\n');
              answer = `⚠️ Heads up — you already have ${conflicts.length === 1 ? 'a meeting' : 'meetings'} at that time:\n${conflictLines}\n\n${answer}`;
            }
          }
        } catch (e: any) {
          console.warn('[brain-chat] availability check failed (non-fatal)', { userId, error: e?.message });
        }
      }

      actionResult = { ok: false, message: 'preview_required' };

      // Sprint 1: persist as PendingAction so the next-turn confirm
      // can short-circuit straight to dispatch (no LLM, no risk of
      // the slots drifting). The hash matches the proposed slots so
      // any divergence between what was previewed and what would be
      // dispatched is detectable.
      try {
        const { startPending, hashProposedAction, markPreviewShown } = await import('./pendingActionService');
        const actionKindLookup: Record<string, import('./pendingActionService').PendingActionKind | null> = {
          schedule_meeting: 'schedule_meeting',
          reschedule_meeting: 'reschedule_meeting',
          cancel_meeting: 'cancel_meeting',
          send_email: 'send_email',
          notify_via_whatsapp: 'notify_via_whatsapp',
          delegate_open_item: 'delegate_open_item',
        };
        const kind = actionKindLookup[parsed.action.type];
        if (kind) {
          const { type: _t, ...slots } = parsed.action as any;
          const pending = await startPending({
            clientNumber, userId, channel,
            actionKind: kind,
            slots,
            missingSlots: [],
          });
          const hash = hashProposedAction(kind, slots);
          await markPreviewShown(pending.id, hash);
          console.info('[brain-chat] pending.preview persisted', {
            userId, clientNumber, pendingId: pending.id, kind, hashPrefix: hash.slice(0, 8),
          });

          // Q5b: record artifact lifecycle row for the preview.
          try {
            const { recordArtifact } = await import('./brainActionArtifactService');
            await recordArtifact({
              clientNumber, userId, channel,
              actionType: kind,
              status: 'previewed',
              payload: slots,
              pendingActionId: pending.id,
              previewHash: hash,
            });
          } catch (e2: any) {
            console.warn('[brain-chat] artifact record failed (non-fatal)', { error: e2?.message });
          }
        }
      } catch (e: any) {
        // Pending persistence failure is non-fatal — the preview still
        // ships, the user can still confirm; next-turn dispatch will
        // go through the main composer's slower path.
        console.warn('[brain-chat] pending.preview persist failed', { userId, error: e?.message });
      }

      return {
        answer, citedPageIds, gaps: parsed.gaps, sources,
        action: parsed.action, actionResult,
        source: reasoningOverride ? 'reasoning' : 'legacy',
      };
    }
  }

  if (parsed.action) {
    try {
      const { dispatchInstruction } = await import('../instructions/instructionDispatcher');
      const act = parsed.action;
      if (act.type === 'add_open_item') {
        // Resolve raw date phrase via chrono (deterministic). Reasoning
        // emits dueDateRaw ("monday", "next friday"); server resolves.
        let resolvedDue: string | undefined;
        if (act.dueDateRaw) {
          const { resolveDate } = await import('./dateResolver');
          const iso = await resolveDate(act.dueDateRaw, userId);
          if (!iso) {
            actionResult = { ok: false, message: `[add_open_item: couldn't parse dueDate "${act.dueDateRaw}" — try a specific date]` };
            answer = actionResult.message;
          } else {
            resolvedDue = iso;
          }
        }
        if (!actionResult || actionResult.ok !== false) {
          const res = await dispatchInstruction({
            clientNumber,
            userId,
            instruction: {
              intent: 'add_open_item',
              confidence: 1,
              summary: act.title,
              params: { itemTitle: act.title, itemDueDate: resolvedDue, itemNote: act.note },
            } as any,
          });
          actionResult = { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
          // Always emit the system-built confirmation on both success
          // and failure — never retain LLM prose that "sounds right".
          // Retention removed 2026-07-08 (audit round 2): the previous
          // "keep LLM prose if it mentions added|noted|done|got it"
          // shortcut allowed the LLM's paraphrase to overshadow the
          // real dispatcher outcome (e.g. it might invent a title
          // that differs from the row actually persisted).
          answer = res.message;
        }
      } else if (act.type === 'update_open_item') {
        // Update fields on an existing open item — typically used to
        // complete a DRAFT (priority + dueDate) the user just provided
        // in a follow-up turn. Reasoning passes the openItemId from
        // the open-items context block we feed it.
        try {
          const existing = await prisma.openItem.findFirst({
            where: { id: act.openItemId, clientNumber, userId },
            select: { id: true, title: true, status: true, priority: true, dueDate: true },
          });
          if (!existing) {
            actionResult = {
              ok: false,
              message: `[update_open_item: id not found — reference may be stale, retry by title]`,
            };
            answer = actionResult.message;
          } else {
            const data: any = {};
            if (act.title) data.title = act.title;
            if (act.note != null) data.description = act.note;
            // Normalise priority — accept the LLM's free-form words.
            // 'normal' is the most common synonym the user types for medium.
            if (act.priority) {
              const p = act.priority.toLowerCase().trim();
              const valid = new Set(['critical', 'high', 'medium', 'low']);
              const normalised = valid.has(p) ? p : (p === 'normal' ? 'medium' : null);
              if (normalised) data.priority = normalised;
            }
            // dueDate: reasoning emits dueDateRaw ("monday", "next friday",
            // "tomorrow", "2026-05-25"); server resolves via chrono with the
            // user's timezone. Per Basit 2026-05-23 — LLM does NOT do date
            // math; date math is a calculator.
            if (act.dueDateRaw) {
              const { resolveDate } = await import('./dateResolver');
              const iso = await resolveDate(act.dueDateRaw, userId);
              if (iso) {
                data.dueDate = new Date(iso + 'T00:00:00Z');
              } else {
                actionResult = { ok: false, message: `[update_open_item: couldn't parse dueDate "${act.dueDateRaw}" — try a specific date]` };
                answer = actionResult.message;
              }
            }
            // If we have at least one field to update, do it. Also
            // transition DRAFT → NEW once required slots are present.
            if (!actionResult && Object.keys(data).length > 0) {
              // Detect if this update completes DRAFT requirements.
              const md = (existing as any).metadata?.draft;
              const willHavePriority = data.priority || (existing.priority && existing.priority !== 'medium');
              const willHaveDueDate = data.dueDate || existing.dueDate;
              if (existing.status === 'DRAFT' && willHavePriority && willHaveDueDate) {
                data.status = 'NEW';
                // Clear the draft metadata block.
                data.metadata = { ...(md ? { draft: null } : {}) };
              }
              await prisma.openItem.update({
                where: { id: existing.id },
                data,
              });
              const changes: string[] = [];
              if (data.priority) changes.push(`priority=${data.priority}`);
              if (data.dueDate) changes.push(`due=${data.dueDate.toISOString().slice(0, 10)}`);
              if (data.title) changes.push(`title="${data.title}"`);
              if (data.status === 'NEW') changes.push(`status=NEW (DRAFT completed)`);
              actionResult = {
                ok: true,
                artifactId: existing.id,
                message: `Updated "${existing.title}": ${changes.join(', ')}.`,
              };
              answer = actionResult.message;
            } else if (!actionResult) {
              actionResult = { ok: false, message: `[update_open_item: no recognised fields to update]` };
              answer = actionResult.message;
            }
          }
        } catch (e: any) {
          console.warn('[brain-chat] update_open_item failed', { error: e?.message, openItemId: act.openItemId, userId });
          actionResult = { ok: false, message: `[update_open_item failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'mark_open_item_done') {
        // Mark DONE + closure summary to user. If the item was
        // DELEGATED with a follow-up trail, the user gets the
        // accumulated trail (per Basit 2026-05-23 spec step 5).
        try {
          const existing = await prisma.openItem.findFirst({
            where: { id: act.openItemId, clientNumber, userId },
            select: {
              id: true, title: true, status: true,
              delegateeName: true, delegateeEmail: true,
              delegationFollowupTrail: true, delegationFollowupCount: true,
            } as any,
          });
          if (!existing) {
            actionResult = { ok: false, message: `[mark_open_item_done: openItemId not found]` };
            answer = actionResult.message;
          } else if ((existing as any).status === 'CLOSED' || (existing as any).status === 'INFORMED') {
            actionResult = { ok: false, message: `[mark_open_item_done: item already ${(existing as any).status.toLowerCase()}]` };
            answer = actionResult.message;
          } else {
            const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
            await transitionStatus((existing as any).id, 'CLOSED', {
              clientNumber,
              actor: `user:${userId}`,
              reason: act.completionNote || 'Marked done via Brain Chat',
            });
            // Build closure summary
            const wasDelegated = !!(existing as any).delegateeName;
            const trail = Array.isArray((existing as any).delegationFollowupTrail) ? (existing as any).delegationFollowupTrail as any[] : [];
            let summary = `Marked "${(existing as any).title}" done.`;
            if (act.completionNote) summary += ` ${act.completionNote}`;
            if (wasDelegated) {
              summary += `\n\n— Delegation summary —`;
              summary += `\nDelegated to: ${(existing as any).delegateeName} <${(existing as any).delegateeEmail}>`;
              summary += `\nFollow-ups sent: ${(existing as any).delegationFollowupCount ?? 0}`;
              if (trail.length > 0) {
                summary += `\nTrail:`;
                trail.slice(-5).forEach((t: any) => {
                  const time = t.at ? new Date(t.at).toISOString().slice(0, 16).replace('T', ' ') : '?';
                  summary += `\n  • [${time}] ${t.channel} ${t.direction}: ${String(t.content ?? '').slice(0, 80)}${(t.content?.length ?? 0) > 80 ? '…' : ''}`;
                });
              }
            }
            actionResult = { ok: true, artifactId: (existing as any).id, message: summary };
            answer = summary;
          }
        } catch (e: any) {
          console.warn('[brain-chat] mark_open_item_done failed', { error: e?.message, openItemId: act.openItemId, userId });
          actionResult = { ok: false, message: `[mark_open_item_done failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'delegate_open_item') {
        try {
          // (1) Item existence check.
          const existing = await prisma.openItem.findFirst({
            where: { id: act.openItemId, clientNumber, userId },
            select: { id: true, title: true, status: true },
          });
          if (!existing) {
            actionResult = {
              ok: false,
              message: `[delegate_open_item: openItemId not found — reference stale; retry by title]`,
            };
            answer = actionResult.message;
          } else if (existing.status === 'CLOSED' || existing.status === 'INFORMED') {
            actionResult = {
              ok: false,
              message: `[delegate_open_item: item already ${existing.status.toLowerCase()} — nothing to delegate]`,
            };
            answer = actionResult.message;
          } else {
          // (2) Recipient resolution — two paths (structural fix 2026-07-07):
          //   (a) delegateeCandidateId → resolve entity row → real contact.
          //   (b) delegateeAdHocEmail  → raw email user typed for a
          //       person not yet in contacts. Synthesise a matched-like
          //       object so the rest of the flow works uniformly.
          const { resolveCandidate } = await import('./candidateResolver');
          let matched: { name: string; email: string | null; phone: string | null } | null = null;
          if (act.delegateeAdHocEmail) {
            matched = {
              name: act.delegateeAdHocEmail.split('@')[0],
              email: act.delegateeAdHocEmail,
              phone: null,
            };
          } else if (act.delegateeCandidateId) {
            matched = await resolveCandidate(act.delegateeCandidateId, userId, clientNumber);
          }
          if (!matched) {
            const label = act.delegateeAdHocEmail ?? act.delegateeCandidateId ?? '(missing recipient)';
            actionResult = {
              ok: false,
              message: `[delegate_open_item: recipient "${label}" not resolved — re-issue with a valid contact or email]`,
            };
            answer = actionResult.message;
          } else if (!matched.email) {
            actionResult = {
              ok: false,
              message: `[delegate_open_item: ${matched.name} has no email on file — add one in Settings → Contacts and retry]`,
            };
            answer = actionResult.message;
          } else {
            const { transitionStatus } = await import('../itemLifecycle/lifecycleService');
            await prisma.openItem.update({
              where: { id: existing.id },
              data: {
                delegateeName: matched.name,
                delegateeEmail: matched.email,
                // delegateeId is set only when the email resolves to an
                // internal User row.
                delegateeId: (await prisma.user.findFirst({
                  where: { clientNumber, email: matched.email, isActive: true },
                  select: { id: true },
                }).catch(() => null))?.id ?? null,
              } as any,
            });
            await transitionStatus(existing.id, 'DELEGATED', {
              clientNumber,
              actor: `user:${userId}`,
              reason: act.note || `Delegated via Brain Chat to ${matched.name}`,
            });

            // Delegation-lifecycle step 1 (per Basit 2026-05-23 spec):
            // queue an email preview to the delegatee. Per default Q2
            // = preview-first, we render the preview the user must
            // confirm BEFORE the email goes out. This populates a
            // pending action so the next-turn "send" confirms it.
            // The actual email is sent through send_email's V2 path
            // — toAdHoc receives the resolved email (delegatee may
            // not be in candidates as a separate row).
            try {
              const { startPending, hashProposedAction, markPreviewShown } = await import('./pendingActionService');
              const userName = persona.userFirstName || persona.userFullName || 'the user';
              const draftSubject = `Task for you: ${existing.title}`;
              const dueLine = (existing as any).dueDate
                ? `\n\nDue: ${new Date((existing as any).dueDate).toISOString().slice(0, 10)}`
                : '';
              // No hardcoded sign-off here — the user's REAL signature
              // (learned from Sent items) is appended by the send_email
              // dispatch, so a template "Thanks, <name>" would double-sign.
              const draftBody = `Hi ${matched.name.split(/\s+/)[0]},\n\n${userName} has delegated this task to you:\n\n"${existing.title}"${dueLine}${act.note ? `\n\nNote from ${userName}: ${act.note}` : ''}\n\nPlease let me know once it's done, or reply if you need anything to get started.`;
              const emailSlots = {
                toCandidateIds: [],
                toAdHoc: [matched.email],
                subject: draftSubject,
                body: draftBody,
                // Internal slot — dispatchPendingDirect uses this to
                // link the messageId to the open_item after send so
                // the follow-up worker knows the email landed.
                _delegationOpenItemId: existing.id,
              };
              const channel: 'web' | 'whatsapp' = opts.channel ?? 'web';
              const pending = await startPending({
                clientNumber, userId, channel,
                actionKind: 'send_email',
                slots: emailSlots,
                missingSlots: [],
              });
              const hash = hashProposedAction('send_email', emailSlots);
              await markPreviewShown(pending.id, hash);
              actionResult = {
                ok: true,
                artifactId: existing.id,
                message: `Delegated "${existing.title}" to ${matched.name} <${matched.email}>. I've drafted an email to let them know:\n\nTo: ${matched.email}\nSubject: ${draftSubject}\nBody:\n${draftBody}\n\nReply "send" to fire the email, or tell me what to change. (You can also skip the email — just say "skip".)`,
              };
              answer = actionResult.message;
            } catch (emailErr: any) {
              // Delegation already succeeded; email queue is non-fatal.
              console.warn('[brain-chat] delegation auto-email queue failed', { error: emailErr?.message, openItemId: existing.id });
              actionResult = { ok: true, artifactId: existing.id, message: `Delegated "${existing.title}" to ${matched.name} <${matched.email}>. (Couldn't auto-draft the email — try "email ${matched.name.split(/\s+/)[0]} about it".)` };
              answer = actionResult.message;
            }
          }
          } // close candidate-resolution else
        } catch (e: any) {
          console.warn('[brain-chat] delegate_open_item failed', { error: e?.message, openItemId: act.openItemId, userId });
          actionResult = { ok: false, message: `[delegate_open_item failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'schedule_meeting') {
        // Two attendee paths (structural fix 2026-07-07):
        //   (a) attendeeCandidateIds → resolve to contact emails
        //   (b) attendeeAdHocEmails  → raw emails user typed for
        //       people not yet in contacts (e.g. "set meeting with
        //       rafayfrasat02@gmail.com"). Union of both is sent.
        const { resolveCandidates } = await import('./candidateResolver');
        const { resolveDateTime } = await import('./dateResolver');
        const ids = Array.isArray(act.attendeeCandidateIds) ? act.attendeeCandidateIds : [];
        const adHocEmails = Array.isArray(act.attendeeAdHocEmails) ? act.attendeeAdHocEmails : [];
        const [resolvedAttendees, whenIso] = await Promise.all([
          resolveCandidates(ids, userId, clientNumber),
          resolveDateTime(act.whenRaw, userId),
        ]);
        const unresolvedIds = resolvedAttendees.map((r, i) => r ? null : ids[i]).filter(Boolean) as string[];
        if (unresolvedIds.length > 0) {
          actionResult = { ok: false, message: `[schedule_meeting: unresolved attendee candidateIds (${unresolvedIds.join(', ')}) — re-issue selecting from the contacts block]` };
          answer = actionResult.message;
        } else if (!whenIso) {
          actionResult = { ok: false, message: `[schedule_meeting: couldn't parse whenRaw "${act.whenRaw}" — try a specific date and time]` };
          answer = actionResult.message;
        } else {
          const validAttendees = resolvedAttendees.filter((r): r is NonNullable<typeof r> => !!r);
          const contactEmails = validAttendees.filter((r) => !!r.email).map((r) => r.email!);
          const emails = Array.from(new Set([...contactEmails, ...adHocEmails]));
          const names = [
            ...validAttendees.map((r) => r.name),
            ...adHocEmails.filter((e) => !contactEmails.includes(e)).map((e) => e.split('@')[0]),
          ];
          if (emails.length === 0) {
            actionResult = { ok: false, message: `[schedule_meeting: no attendee emails resolved — add them and retry]` };
            answer = actionResult.message;
          } else {
            const res = await dispatchInstruction({
              clientNumber,
              userId,
              instruction: {
                intent: 'schedule_meeting',
                confidence: 1,
                summary: act.title,
                params: {
                  meetingTitle: act.title,
                  meetingWhen: whenIso,
                  meetingDurationMin: act.durationMin,
                  meetingAttendees: [...emails, ...names],
                },
              } as any,
            });
            actionResult = { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
            // Always return the system-built confirmation on success —
            // never retain LLM prose that "sounds right". Retention
            // removed 2026-07-08 (audit round 2): LLM prose could
            // claim a time or attendee list that differs from what
            // Google Calendar actually recorded via r.event; the user
            // saw the wrong-details LLM version, not the truth.
            answer = res.ok ? res.message : `[schedule_meeting failed: ${res.message}]`;
          }
        }
      } else if (act.type === 'cancel_meeting') {
        const res = await dispatchInstruction({
          clientNumber,
          userId,
          instruction: {
            intent: 'cancel_meeting',
            confidence: 1,
            summary: `cancel ${act.titleHint ?? act.eventId}`,
            params: {
              eventId: act.eventId,
              titleHint: act.titleHint,
              reason: act.reason,
            },
          } as any,
        });
        actionResult = { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
        answer = res.message;
      } else if (act.type === 'reschedule_meeting') {
        // newWhenRaw → ISO via chrono if provided.
        let resolvedWhenIso: string | undefined;
        if (act.newWhenRaw) {
          const { resolveDateTime } = await import('./dateResolver');
          const iso = await resolveDateTime(act.newWhenRaw, userId);
          if (!iso) {
            actionResult = { ok: false, message: `[reschedule_meeting: couldn't parse newWhenRaw "${act.newWhenRaw}" — try a specific date and time]` };
            answer = actionResult.message;
          } else {
            resolvedWhenIso = iso;
          }
        }
        if (!actionResult || actionResult.ok !== false) {
          const res = await dispatchInstruction({
            clientNumber,
            userId,
            instruction: {
              intent: 'reschedule_meeting',
              confidence: 1,
              summary: `reschedule ${act.titleHint ?? act.eventId}`,
              params: {
                eventId: act.eventId,
                titleHint: act.titleHint,
                newWhenIso: resolvedWhenIso,
                newDurationMin: act.newDurationMin,
                reason: act.reason,
              },
            } as any,
          });
          actionResult = { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
          answer = res.message;
        }
      } else if (act.type === 'set_contact_scope') {
        try {
          // contactCandidateId is the entities.id, but the visibility
          // lives on wiki_pages.metadata.scope for the corresponding
          // entity_person page. Lookup by entity → wiki page via email.
          const ent = await prisma.entity.findFirst({
            where: { id: act.contactCandidateId, clientNumber },
            select: { id: true, name: true, email: true, phone: true },
          });
          if (!ent) {
            actionResult = { ok: false, message: `[set_contact_scope: contact not found in your contacts]` };
          } else {
            // Locate the wiki_page (entity_person) for this contact
            const pageRows = await prisma.$queryRawUnsafe<any[]>(
              `SELECT id, metadata, user_id FROM wiki_pages
               WHERE client_number = $1 AND page_type = 'entity_person'
                 AND (
                   ($2 <> '' AND lower(metadata->>'email') = $2)
                   OR ($3 <> '' AND regexp_replace(COALESCE(metadata->>'phone',''),'[^0-9+]','','g') = $3)
                 ) LIMIT 1`,
              clientNumber,
              (ent.email ?? '').toLowerCase(),
              (ent.phone ?? '').replace(/[^\d+]/g, ''),
            ).catch(() => []);
            const page = pageRows[0];
            if (!page) {
              actionResult = { ok: false, message: `[set_contact_scope: no wiki page for ${ent.name}]` };
            } else if (page.user_id !== userId) {
              actionResult = { ok: false, message: `[set_contact_scope: only the owner can change scope]` };
            } else {
              const newMeta = { ...(page.metadata as object), scope: act.scope };
              if (act.scope === 'tenant') {
                (newMeta as any).publicSince = new Date().toISOString();
                (newMeta as any).publicSetBy = userId;
              }
              await prisma.$executeRawUnsafe(
                `UPDATE wiki_pages SET metadata = $1::jsonb, last_updated_at = NOW() WHERE id = $2`,
                JSON.stringify(newMeta), page.id,
              );
              actionResult = { ok: true, artifactId: page.id, message: `Set "${ent.name}" scope to ${act.scope}.` };
            }
          }
          answer = actionResult.message;
        } catch (e: any) {
          actionResult = { ok: false, message: `[set_contact_scope failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'mark_contact_inactive') {
        try {
          const ent = await prisma.entity.findFirst({
            where: { id: act.contactCandidateId, clientNumber },
            select: { id: true, name: true, email: true, phone: true },
          });
          if (!ent) {
            actionResult = { ok: false, message: `[mark_contact_inactive: contact not found]` };
          } else {
            // Locate wiki page and set status='inactive' + metadata.markedInactiveByUser=true
            const pageRows = await prisma.$queryRawUnsafe<any[]>(
              `SELECT id, metadata, user_id FROM wiki_pages
               WHERE client_number = $1 AND page_type = 'entity_person'
                 AND (
                   ($2 <> '' AND lower(metadata->>'email') = $2)
                   OR ($3 <> '' AND regexp_replace(COALESCE(metadata->>'phone',''),'[^0-9+]','','g') = $3)
                 ) LIMIT 1`,
              clientNumber,
              (ent.email ?? '').toLowerCase(),
              (ent.phone ?? '').replace(/[^\d+]/g, ''),
            ).catch(() => []);
            const page = pageRows[0];
            if (page && page.user_id === userId) {
              const newMeta = { ...(page.metadata as object), markedInactiveByUser: true, markedInactiveAt: new Date().toISOString() };
              await prisma.$executeRawUnsafe(
                `UPDATE wiki_pages SET metadata = $1::jsonb, status = 'inactive', last_updated_at = NOW() WHERE id = $2`,
                JSON.stringify(newMeta), page.id,
              );
            }
            actionResult = { ok: true, artifactId: ent.id, message: `Marked "${ent.name}" inactive. Brain will skip them.` };
          }
          answer = actionResult.message;
        } catch (e: any) {
          actionResult = { ok: false, message: `[mark_contact_inactive failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'update_contact') {
        // Real contact-field edit (2026-07-13). Shared helper — the same
        // implementation serves plan steps in dispatchPendingDirect.
        actionResult = await updateContactGuarded(clientNumber, userId, {
          contactCandidateId: act.contactCandidateId,
          newEmail: act.newEmail,
          newPhone: act.newPhone,
          newName: act.newName,
        });
        answer = actionResult.message;
      } else if (act.type === 'archive_wiki_page') {
        try {
          const existing = await prisma.wikiPage.findUnique({
            where: { id: act.wikiPageId },
            select: { id: true, clientNumber: true, userId: true, scope: true, title: true, status: true },
          });
          if (!existing || existing.clientNumber !== clientNumber) {
            actionResult = { ok: false, message: `[archive_wiki_page: page not found]` };
          } else if (existing.scope === 'user' && existing.userId !== userId) {
            actionResult = { ok: false, message: `[archive_wiki_page: only the owner can archive this page]` };
          } else if (existing.status === 'archived') {
            actionResult = { ok: true, artifactId: existing.id, message: `"${existing.title}" was already archived.` };
          } else {
            await prisma.wikiPage.update({
              where: { id: existing.id },
              data: { status: 'archived' as any, lastUpdatedAt: new Date() } as any,
            });
            actionResult = { ok: true, artifactId: existing.id, message: `Archived wiki page "${existing.title}". Brain won't surface it until you restore it.` };
          }
          answer = actionResult.message;
        } catch (e: any) {
          actionResult = { ok: false, message: `[archive_wiki_page failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'delete_wiki_page') {
        try {
          const existing = await prisma.wikiPage.findUnique({
            where: { id: act.wikiPageId },
            select: { id: true, clientNumber: true, userId: true, scope: true, title: true, pageType: true },
          });
          if (!existing || existing.clientNumber !== clientNumber) {
            actionResult = { ok: false, message: `[delete_wiki_page: page not found]` };
          } else if (existing.scope === 'user' && existing.userId !== userId) {
            actionResult = { ok: false, message: `[delete_wiki_page: only the owner can delete this page]` };
          } else {
            await prisma.wikiPage.delete({ where: { id: existing.id } });
            console.warn('[brain-chat] wiki page hard-deleted via Brain', {
              id: existing.id, title: existing.title, pageType: existing.pageType,
              actor: userId, clientNumber,
            });
            actionResult = { ok: true, artifactId: existing.id, message: `Deleted wiki page "${existing.title}". Brain has forgotten it.` };
          }
          answer = actionResult.message;
        } catch (e: any) {
          actionResult = { ok: false, message: `[delete_wiki_page failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'record_preference') {
        try {
          const { recordExplicitMemory } = await import('./userMemoryService');
          await recordExplicitMemory({
            clientNumber, userId,
            key: act.key,
            value: act.value,
          });
          const valStr = typeof act.value === 'string' ? act.value : JSON.stringify(act.value);
          const emailDays = act.key === 'email_max_age_days' ? Number(act.value) : NaN;
          const preferenceMessage = Number.isFinite(emailDays)
            ? `Got it — I'll limit normal email retrieval and briefing to the most recent ${Math.max(1, Math.round(emailDays))} days. If you explicitly ask for an older email, I'll treat that as a one-time override.`
            : `Got it — I'll remember "${act.key}" as ${valStr} going forward. You can change or remove this in Settings → Brain → Memories.`;
          actionResult = {
            ok: true,
            artifactId: `pref:${act.key}`,
            message: preferenceMessage,
          };
          answer = actionResult.message;
        } catch (e: any) {
          actionResult = { ok: false, message: `Couldn't save preference: ${e?.message ?? 'unknown'}` };
          answer = actionResult.message;
        }
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
        // Two dispatch paths (per Basit 2026-07-07 fix):
        //   (a) recipientCandidateId → resolve to contact name+phone
        //   (b) recipientAdHocPhone  → send to explicit raw number
        // Ad-hoc path exists so the user can send to a number that
        // isn't in Candidates without Brain silently substituting
        // a similarly-named contact (the wrong-Ahmad-Sheikh bug).
        try {
          const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
          const userName = persona.userFirstName || persona.userFullName || 'the user';
          let recipientName: string;
          let recipientPhone: string;
          let canDispatch = true;

          const adHoc = String(act.recipientAdHocPhone ?? '').trim();
          if (adHoc) {
            const cleaned = adHoc.replace(/[\s\-()]/g, '');
            if (!/^\+?\d{10,15}$/.test(cleaned)) {
              actionResult = { ok: false, message: `[notify_via_whatsapp: adHoc phone "${adHoc}" isn't a valid E.164 number]` };
              answer = actionResult.message;
              canDispatch = false;
              recipientName = ''; recipientPhone = '';
            } else {
              recipientPhone = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
              recipientName = `contact at ${recipientPhone}`;
            }
          } else {
            const { resolveCandidate } = await import('./candidateResolver');
            const matched = await resolveCandidate(String(act.recipientCandidateId ?? ''), userId, clientNumber);
            if (!matched) {
              actionResult = { ok: false, message: `[notify_via_whatsapp: candidateId "${act.recipientCandidateId ?? '(missing)'}" not in your contacts]` };
              answer = actionResult.message;
              canDispatch = false;
              recipientName = ''; recipientPhone = '';
            } else if (!matched.phone) {
              actionResult = { ok: false, message: `[notify_via_whatsapp: ${matched.name} has no phone on file — add one in Settings → Contacts]` };
              answer = actionResult.message;
              canDispatch = false;
              recipientName = matched.name; recipientPhone = '';
            } else {
              recipientName = matched.name;
              recipientPhone = matched.phone;
            }
          }

          if (canDispatch && recipientPhone) {
            const introName = recipientName.startsWith('contact at') ? 'there' : recipientName;
            // Intro name = custom brain name when set ("Suzi"), Nexeo
            // otherwise (Basit 2026-07-14).
            const { getBrainDisplayName } = await import('./outboundIdentity');
            const brainName = await getBrainDisplayName(userId).catch(() => 'Nexeo');
            const intro = `Hi ${introName}, this is ${brainName} — ${userName}'s AI assistant. ${userName} asked me to let you know:\n\n`;
            const { normalizeWhatsAppSubstantiveMessage, whatsappAcceptedMessage } = await import('./whatsappOutboundPolicy');
            const substantive = normalizeWhatsAppSubstantiveMessage(act.message, recipientName);
            const fullBody = `${intro}${substantive}`;
            const r = await sendTenantWhatsAppText(clientNumber, recipientPhone, fullBody, userId);
            if (r.ok) {
              actionResult = {
                ok: true,
                artifactId: r.waMessageId,
                message: r.waMessageId
                  ? `Sent WhatsApp to ${recipientName} (${recipientPhone}) from the Nexeo number.`
                  : whatsappAcceptedMessage(recipientName, recipientPhone),
              };
              answer = actionResult.message;
            } else {
              actionResult = { ok: false, message: `[notify_via_whatsapp failed: ${r.error ?? 'provider rejected the send'}]` };
              answer = actionResult.message;
            }
          }
        } catch (e: any) {
          console.warn('[brain-chat] notify_via_whatsapp failed', { error: e?.message, userId });
          actionResult = { ok: false, message: `[notify_via_whatsapp failed: ${e?.message ?? 'unknown'}]` };
          answer = actionResult.message;
        }
      } else if (act.type === 'send_email') {
        // V2 candidate-ID resolution. Reasoning emits toCandidateIds +
        // optional toAdHoc (when user typed a verbatim email NOT in
        // contacts). Server resolves IDs → real emails.
        try {
          const { sendUserEmail } = await import('../gmailService');
          const { resolveCandidates } = await import('./candidateResolver');
          const userName = persona.userFirstName || persona.userFullName || 'the user';
          // Basit 2026-07-14: emails from the user's mailbox sign the
          // way the USER signs (learned from Sent items / explicit
          // pref), THEN the Nexeo disclosure — content in the user's
          // voice, identity always disclosed. Skip the signature when
          // the body already contains it (LLM habit or a re-send).
          const { getUserEmailSignature } = await import('./outboundIdentity');
          const signature = await getUserEmailSignature(userId, clientNumber).catch(() => `Thanks,\n${userName}`);
          const disclosureFooter = `\n\n—\nSent by Nexeo, ${userName}'s AI assistant.`;
          const bodyCore = act.body.includes(signature) ? act.body : `${act.body}\n\n${signature}`;
          const bodyWithFooter = bodyCore.endsWith(disclosureFooter)
            ? bodyCore
            : `${bodyCore}${disclosureFooter}`;
          const toIds = Array.isArray(act.toCandidateIds) ? act.toCandidateIds : [];
          const ccIds = Array.isArray(act.ccCandidateIds) ? act.ccCandidateIds : [];
          const adHocTo = Array.isArray(act.toAdHoc) ? act.toAdHoc.filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) : [];
          const [resolvedTo, resolvedCc] = await Promise.all([
            resolveCandidates(toIds, userId, clientNumber),
            resolveCandidates(ccIds, userId, clientNumber),
          ]);
          const unresolvedTo = resolvedTo.map((r, i) => r ? null : toIds[i]).filter(Boolean) as string[];
          const unresolvedCc = resolvedCc.map((r, i) => r ? null : ccIds[i]).filter(Boolean) as string[];

          let toEmails: string[] = [];
          let ccEmails: string[] = [];
          let primaryTo: string | undefined;
          let extraCc: string[] = [];
          let ccStr: string | undefined;
          let sendPrep: 'ok' | 'unresolved' | 'no-recipient' = 'ok';

          if (unresolvedTo.length > 0 || unresolvedCc.length > 0) {
            sendPrep = 'unresolved';
            actionResult = {
              ok: false,
              message: `[send_email: unresolved candidateIds (${[...unresolvedTo, ...unresolvedCc].join(', ')}) — re-issue selecting from the contacts block]`,
            };
            answer = actionResult.message;
          } else {
            toEmails = [
              ...resolvedTo.filter((r): r is NonNullable<typeof r> => !!r && !!r.email).map((r) => r!.email!),
              ...adHocTo,
            ];
            ccEmails = resolvedCc.filter((r): r is NonNullable<typeof r> => !!r && !!r.email).map((r) => r!.email!);
            if (toEmails.length === 0) {
              sendPrep = 'no-recipient';
              actionResult = { ok: false, message: `[send_email: no valid recipient — selected contacts have no email on file]` };
              answer = actionResult.message;
            } else {
              primaryTo = toEmails[0];
              extraCc = [...toEmails.slice(1), ...ccEmails];
              ccStr = extraCc.length ? extraCc.join(', ') : undefined;
            }
          }

          if (sendPrep === 'ok' && primaryTo) {
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
            // Fabrication guard (Basit 2026-07-08): only claim success
            // when Gmail returned a messageId AND (ideally) the post-
            // send verification found it in the Sent label. Same
            // pattern as the WhatsApp send fabrication guard.
            if (sendRes.success && sendRes.messageId) {
              const recipients = [primaryTo, ...extraCc].join(', ');
              const fromLine = sendRes.sentFromAddress
                ? ` (from ${sendRes.sentFromAddress})`
                : '';
              const verifyNote = sendRes.verified
                ? ''
                : '\n(Note: Gmail accepted the send, but I couldn\'t verify it landed in your Sent folder — please check.)';
              actionResult = {
                ok: true,
                artifactId: sendRes.messageId,
                message: `Sent email to ${recipients}${fromLine} — subject: "${act.subject}". messageId=${sendRes.messageId}${verifyNote}`,
              };
              answer = actionResult.message;
            } else if (sendRes.success && !sendRes.messageId) {
              // API returned success but no id. Almost never happens
              // with Gmail, but if it does we must not claim sent.
              actionResult = { ok: false, message: `[send_email failed: Gmail returned success without a messageId — treat as unsent]` };
              answer = actionResult.message;
            } else {
              actionResult = { ok: false, message: `[send_email failed: ${sendRes.error ?? 'unknown error from Gmail'}]` };
              answer = actionResult.message;
            }
          }
        } catch (e: any) {
          console.warn('[brain-chat] send_email failed', { error: e?.message, userId });
          actionResult = { ok: false, message: `[send_email failed: ${e?.message ?? 'unknown'}]` };
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
    //
    // 2026-05-20 (later): missed again. Brain wrote "Alright Sir, I'm
    // sending that test email to sirabdulbasit@gmail.com now. I'll let
    // you know once it's sent." — no action emitted, no actionResult,
    // guard didn't fire because:
    //   - "I'm" wasn't in the pronoun alternation
    //   - "sending" / "send" weren't in the verb set (only past-tense
    //     "sent" was)
    // Added: i'?m pronoun, present-continuous verbs (sending, etc.),
    // and base-form verbs that follow "I'll" / "I'?m about to" / "now
    // I'll" (send, delegate, etc.). The constant is hoisted (see
    // EMPTY_PROMISE_RE near the top) so the post-compose retry
    // (Option A) can use the same detector.
    if (EMPTY_PROMISE_RE.test(answer)) {
      // P0 (2026-05-22): narrow the guard. Previously it fired on ANY
      // turn where the regex matched, including conversational
      // acknowledgments like "I've noted that" / "I've removed that
      // from my reading list". Observed at 12:08-12:09 PKT on Basit's
      // session — guard rewrote three innocuous replies with the
      // honest-no-op marker, breaking trust mid-conversation.
      //
      // Tighter gate: only fire when THIS TURN was an action-likely
      // turn AND there's no successful actionResult. Conversational
      // turns are exempt because there was nothing to do anyway.
      // Chat 9 (2026-07-14): "action turn" here now means the user
      // asked for a MUTATION. looksLikeImperative counted "tell me its
      // status" as imperative (leading "tell"), so grounded status
      // answers on read-only turns were rewritten into failure prose.
      const wasActionTurn = classifyTurnIntent(question) === 'mutation';

      // Look for an artifactId in the recent history — pattern is the
      // dispatcher's success messages from earlier turns. If we can
      // see Brain previously confirmed dispatch of this kind of action
      // with a real artifactId, the claim is honest.
      const historyText = history.map((h) => h.text || '').join('\n');
      const seenArtifact = /artifact[Ii]d[\s:=]+\w/.test(historyText)
        || /\b(delegated|added)\s+(?:"[^"]+"|to\s+\w+)\s+(?:to|in)\s+\w/.test(historyText);

      if (!seenArtifact && wasActionTurn) {
        // 2026-05-22: diagnostic override instead of the generic
        // "I didn't actually complete that". The previous message
        // was indistinguishable across all failure modes and read as
        // Brain breaking. Now we describe what Brain TRIED to do so
        // the user knows their intent was understood — Brain just
        // couldn't ground the action.
        console.warn('[brain-chat] empty-promise guard triggered', {
          userId, clientNumber,
          attemptedAnswer: answer.slice(0, 200),
        });
        const diagnosticHead = describeAttemptForUser(answer, question);
        answer = `${diagnosticHead}\n\nWhat I'd need to make it actually happen: ${describeMissingPiece(question)}`;
        actionResult = { ok: false, message: 'empty_promise_blocked' };
      } else if (!seenArtifact && !wasActionTurn) {
        // Log so we can tune further — but don't override innocent prose.
        console.info('[brain-chat] empty-promise regex matched on non-action turn, leaving prose unchanged', {
          userId, clientNumber, head: answer.slice(0, 120),
        });
      }
    }
  }

  // Sprint 2: record alias resolutions implied by a successful dispatch.
  // When Brain just scheduled with "Asad Ahmed Taj" <asad.ahmed@tmcltd.ai>
  // because the user typed "asad", we now know "asad" → that email for
  // this user. Next session's resolver picks immediately. Fire-and-
  // forget; failures must not affect the user-visible reply.
  if (parsed.action && actionResult && actionResult.ok === true) {
    recordAliasesFromDispatch(clientNumber, userId, question, parsed.action).catch(() => undefined);
  }

  return {
    answer,
    citedPageIds,
    gaps: parsed.gaps,
    sources,
    action: parsed.action,
    actionResult,
    // If reasoning supplied the action (act path), mark source so
    // validateBeforeRender skips the empty-promise regex check.
    source: reasoningOverride ? 'reasoning' : 'legacy',
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
  const { resolveUserTimezone } = await import('../userTimezoneService');
  const tz = await resolveUserTimezone(userId);
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

/** Recent inbound emails (last 24h) — ground truth for "any email
 *  from X", "what came in", and the Day Brief inbox summary. Each row
 *  is one feed_event of source_type='gmail'. Empty list → reasoning
 *  says "no new emails", not "I don't have access". */
async function buildRecentEmailsBlock(clientNumber: string, userId: number, max = 10): Promise<string> {
  const prisma = (await import('../../db/prisma')).default;
  const rows = await prisma.$queryRawUnsafe<Array<{
    sender_name: string | null;
    sender_email: string | null;
    raw_payload: any;
    created_at: Date;
  }>>(
    `SELECT sender_name, sender_email, raw_payload, created_at
       FROM feed_events
      WHERE client_number = $1 AND user_id = $2
        AND source_type = 'gmail'
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT $3`,
    clientNumber, userId, max,
  ).catch(() => [] as any[]);
  if (rows.length === 0) return '# Recent emails (last 24h)\n(no emails received in the last 24 hours)';
  const lines = rows.map((r) => {
    const fromEmail = r.sender_email
      ? (r.sender_email.match(/<([^>]+)>/)?.[1] ?? r.sender_email)
      : '(unknown)';
    const fromName = r.sender_name?.trim() || '';
    const subj = String(r.raw_payload?.subject ?? r.raw_payload?.headers?.subject ?? '').slice(0, 120) || '(no subject)';
    const snippet = String(r.raw_payload?.snippet ?? '').replace(/\s+/g, ' ').slice(0, 140);
    const when = new Date(r.created_at).toISOString().slice(11, 16) + ' UTC';
    return `- [${when}] From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail} · Subject: ${subj}${snippet ? `\n    ${snippet}` : ''}`;
  });
  return `# Recent emails (last 24h, newest first — ${rows.length} of last ${max})\n${lines.join('\n')}`;
}

/** Recent WhatsApp messages (last 24h) the user actually received.
 *  Source: feed_events where source_type='whatsapp' AND user
 *  is the receiver (not fromMe). Names resolved through entity_person
 *  for known senders; unknown numbers labelled as such. Empty list →
 *  reasoning says "no recent WhatsApp", not invents a sender.
 *
 *  2026-05-25: prepends a degraded-status warning when the WA
 *  connector is in status='degraded' (lying-status fix). Without it,
 *  Brain would correctly report "no messages" but the user has no
 *  idea WHY — distinguishing "no WA in last 24h" from "WA ingest is
 *  broken, can't see messages" matters for trust. */
async function buildRecentWhatsAppBlock(clientNumber: string, userId: number, max = 10): Promise<string> {
  const prisma = (await import('../../db/prisma')).default;
  // Connector health probe — if WA is degraded, surface that to
  // reasoning as a header on the block so Brain doesn't say
  // "no messages" when the truth is "I can't read messages".
  const connStatus = await prisma.$queryRawUnsafe<Array<{ status: string; error_message: string | null; metadata: any }>>(
    `SELECT uc.status, uc.error_message, uc.metadata
       FROM user_connectors uc
       JOIN connector_types ct ON ct.id = uc.connector_type_id
      WHERE uc.user_id = $1 AND ct.slug = 'whatsapp_personal'
      LIMIT 1`,
    userId,
  ).catch(() => [] as any[]);
  let degradedHeader = '';
  if (connStatus[0]?.status === 'degraded' || connStatus[0]?.status === 'error') {
    const reason = connStatus[0]?.metadata?.degradedReason
                || connStatus[0]?.error_message
                || 'WhatsApp ingest is currently degraded';
    degradedHeader = `# ⚠️ WhatsApp ingest is DEGRADED right now\n${reason}\nThis means I cannot see WhatsApp messages received after the connector started degrading. When the user asks about recent WhatsApp activity, ALWAYS tell them the ingest is degraded and you can only see messages up to the last-good timestamp shown below. Do NOT say "no messages" without this caveat.\n\n`;
  }
  const rows = await prisma.$queryRawUnsafe<Array<{
    sender_phone: string | null;
    sender_name: string | null;
    raw_payload: any;
    created_at: Date;
  }>>(
    `SELECT sender_phone, sender_name, raw_payload, created_at
       FROM feed_events
      WHERE client_number = $1 AND user_id = $2
        AND source_type = 'whatsapp'
        AND COALESCE((raw_payload->>'fromMe')::boolean, FALSE) = FALSE
        AND created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT $3`,
    clientNumber, userId, max,
  ).catch(() => [] as any[]);
  if (rows.length === 0) return `${degradedHeader}# Recent WhatsApp messages (last 24h)\n(no WhatsApp messages received in the last 24 hours)`;
  // Resolve known names by phone match against entity_person rows the
  // user can see — keeps the rule "only people in your contacts get
  // named" honest while still surfacing the raw phone for unknowns.
  const phones = Array.from(new Set(rows.map((r) => (r.sender_phone ?? '').replace(/[^\d+]/g, '')).filter(Boolean)));
  const known = new Map<string, string>();
  if (phones.length > 0) {
    const wikiRows = await prisma.$queryRawUnsafe<Array<{ title: string; phone: string }>>(
      `SELECT title, regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') AS phone
         FROM wiki_pages
        WHERE client_number = $1 AND page_type='entity_person'
          AND user_id = $2
          AND status NOT IN ('archived','inactive','deleted','contradicted')
          AND regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]','','g') = ANY($3::text[])`,
      clientNumber, userId, phones,
    ).catch(() => [] as any[]);
    for (const w of wikiRows) known.set(w.phone, w.title);
  }
  const lines = rows.map((r) => {
    const phone = (r.sender_phone ?? '').replace(/[^\d+]/g, '');
    const sender = known.get(phone) ?? r.sender_name?.trim() ?? '(unknown sender)';
    const body = String(r.raw_payload?.body ?? r.raw_payload?.text ?? '').replace(/\s+/g, ' ').slice(0, 200);
    const when = new Date(r.created_at).toISOString().slice(11, 16) + ' UTC';
    const knownTag = known.has(phone) ? '' : ' [not in your contacts]';
    return `- [${when}] From: ${sender}${knownTag} (${phone || 'no phone'}): ${body || '(empty)'}`;
  });
  return `${degradedHeader}# Recent WhatsApp messages (last 24h, newest first — ${rows.length} of last ${max})\n${lines.join('\n')}`;
}

/** Contact provenance block — ONLY built when the user's question
 *  references a specific contact identifier (email, phone, or name
 *  with a clear identity question). Surfaces the actual feed_events
 *  history so reasoning can answer "where did X come from" with truth
 *  instead of a guess. */
async function buildContactProvenanceBlock(
  clientNumber: string, userId: number, question: string,
): Promise<string> {
  // Trigger only on origin/identity questions to avoid bloating every
  // turn. The "where/how/why/who" + contact-name pattern catches:
  //   "where did rfurnivall come from"
  //   "why do I have katja in my contacts"
  //   "who is naveed"
  //   "from where this contact"
  const originPattern = /\b(where|why|who|how|from where)\b.*\b(contact|sender|email|whatsapp|added|come from|came from|in my)\b/i;
  if (!originPattern.test(question)) return '';
  // Extract emails + phone-like patterns from the question; if none,
  // pull the last-mentioned candidate from history (handled upstream).
  const emails = (question.match(/[\w.+\-]+@[\w.\-]+/g) ?? []).map((e) => e.toLowerCase());
  if (emails.length === 0) return '';
  const prisma = (await import('../../db/prisma')).default;
  const blocks: string[] = [];
  for (const email of emails.slice(0, 3)) {
    const rows = await prisma.$queryRawUnsafe<Array<{
      user_id: number;
      user_email: string | null;
      source_type: string;
      first_seen: Date;
      last_seen: Date;
      events: number;
    }>>(
      `SELECT fe.user_id,
              (SELECT u.email FROM users u WHERE u.id = fe.user_id) AS user_email,
              fe.source_type,
              MIN(fe.created_at) AS first_seen,
              MAX(fe.created_at) AS last_seen,
              COUNT(*)::int       AS events
         FROM feed_events fe
        WHERE fe.client_number = $1
          AND lower(COALESCE(substring(fe.sender_email FROM '<([^>]+)>'), fe.sender_email)) = $2
        GROUP BY fe.user_id, fe.source_type
        ORDER BY MAX(fe.created_at) DESC`,
      clientNumber, email,
    ).catch(() => [] as any[]);
    if (rows.length === 0) {
      blocks.push(`## ${email}\n- No feed_events recorded for this address in this tenant.`);
      continue;
    }
    const lines = rows.map((r) => {
      const youOrThem = r.user_id === userId ? '(your inbox)' : `(${r.user_email ?? 'another user'}'s inbox)`;
      const first = new Date(r.first_seen).toISOString().slice(0, 10);
      const last  = new Date(r.last_seen).toISOString().slice(0, 10);
      return `  - ${r.source_type}: ${r.events} event(s), ${first} → ${last} ${youOrThem}`;
    });
    blocks.push(`## ${email}\n${lines.join('\n')}`);
  }
  if (blocks.length === 0) return '';
  return `# Where this contact came from (feed_events evidence)\n${blocks.join('\n\n')}\n\n(If a row is in "another user's inbox", you have NOT corresponded with this sender — they came into your contacts list via a separate path. Say so plainly when asked.)`;
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

/** Preview-by-default safety gate for human-facing actions.
 *
 *  Returns a "block reason" string when the action should be blocked
 *  and a preview shown, or null when the action is safe to dispatch.
 *
 *  Policy: every human-facing action (send_email, schedule_meeting,
 *  notify_via_whatsapp) goes through a one-turn preview UNLESS one
 *  of two narrow exceptions applies:
 *
 *    1. The user is confirming a preview Brain just showed — last
 *       Brain message contains a preview signature and the user's
 *       current message is a short confirmation ("yes", "send",
 *       "go ahead", "do it"). This is the normal two-turn happy path.
 *
 *    2. The action is a TEST EMAIL with a fully explicit recipient
 *       and our canonical test subject/body defaults. The user is
 *       checking the channel; the contents are pro-forma; the
 *       recipient is whatever the user typed verbatim. Safe to
 *       one-shot.
 *
 *  Everything else — wrong time, wrong attendee, wrong subject, wrong
 *  body, wrong action type — gets caught by the user when they see
 *  the preview. No outbound action ships without the user seeing the
 *  exact slot values first. Per Basit 2026-05-20: "wrong recipient /
 *  wrong time destroys trust — invisible damage that can't be
 *  retracted."
 *
 *  Internal actions (add_open_item, delegate, set_brain_name) skip
 *  this entirely — they're reversible / affect only user data. */
async function gateHumanFacingAction(
  act: ComposedAction,
  question: string,
  history: ComposerHistoryTurn[],
  userId?: number,
): Promise<string | null> {
  // Internal-only, reversible actions apply immediately. In
  // particular, record_preference must not fall through to the generic
  // "reply send" preview: there is no recipient or external effect.
  if (IMMEDIATE_INTERNAL_ACTION_TYPES.has(act.type)) return null;

  // Earned autonomy (Phase 1C, 2026-07-14): the user can CONSENT to
  // skipping the preview for a kind after the brain proves itself
  // (10 unmodified approvals → offer → "auto-send emails"). Consent
  // removes only the CONFIRMATION step — ground-or-ask and per-verb
  // target resolution still run on every dispatch, and the eligible
  // set is a whitelist (destructive/rare kinds always preview).
  if (typeof userId === 'number') {
    try {
      const { isAutoConfirmEnabled } = await import('./autoConfirmService');
      if (await isAutoConfirmEnabled(userId, act.type)) return null;
    } catch { /* consent lookup best-effort — fall through to preview */ }
  }
  // update_contact edits an existing contact in place. It's internal
  // (no outward message), explicitly parameterized by the value the
  // user stated ("his email is X"), and reversible — so it dispatches
  // inline like update_open_item rather than through preview/confirm.
  // The inline block resolves the entity + enforces the owner scope,
  // which is its own grounding (fails closed on an unknown contact).
  // NOTE — delegate_open_item is INTENTIONALLY NOT skipped here.
  // It used to be (hardcoded skip), but action_definitions has
  // isHumanFacing=true for delegate and reasoning was observed
  // dispatching to a hallucinated email (`yousaf@tmcltd.com` when
  // the user's contacts had different addresses) — no preview meant
  // the bad email went out silently. Treat delegations like every
  // other outbound human action: preview-by-default, user confirms.

  // Exception 1: prior turn was a preview AND user is confirming.
  if (priorTurnWasPreview(history) && userMessageIsShortConfirmation(question)) {
    return null;
  }

  // Exception 2: canonical test-email pattern with explicit recipient.
  if (act.type === 'send_email' && isCanonicalTestEmail(act, question)) {
    return null;
  }

  // Default: human-facing action requires preview-then-confirm. Show
  // every slot value to the user; let them catch wrong-recipient,
  // wrong-time, wrong-subject, wrong-body, wrong-action-type before
  // the email/invite/WA goes out.
  return `human-facing action requires preview; type=${act.type}`;
}

/** Brain's last user-visible message looks like one of our preview
 *  templates. The signature must be distinctive enough that no
 *  ordinary Brain reply contains it. */
function priorTurnWasPreview(history: ComposerHistoryTurn[]): boolean {
  const lastBrain = [...history].reverse().find((h) => h.role === 'brain');
  if (!lastBrain) return false;
  // Preview signature: contains "Before I send" or "Before I" + "please confirm"
  // followed by the structured slot block (To: / With: / etc).
  const t = lastBrain.text;
  if (!/Before I (send|proceed)/i.test(t)) return false;
  if (!/please confirm|Reply ['"]?send['"]?/i.test(t)) return false;
  return true;
}

/** The user's current message is a short confirmation of a preview
 *  Brain just showed. Limited to a closed set of confirmation words
 *  to avoid false positives ("yes I know him" should NOT confirm). */
function userMessageIsShortConfirmation(question: string): boolean {
  const q = question.trim().toLowerCase();
  if (q.length > 30) return false; // long messages aren't bare confirmations
  return /^(yes|yep|yes\s+send|send|send\s+it|go\s+ahead|do\s+it|confirm|confirmed|ok|okay|proceed|approved|approve|yes\s+please)\.?$/.test(q);
}

/** Recognize the canonical test-email pattern: subject + body match
 *  the defaults Brain auto-fills for "send a test email" requests,
 *  AND every recipient appears verbatim in the user's current message.
 *
 *  The subject + body checks are exact-match (case-insensitive) — a
 *  paraphrased test email ("Test message", "Hello from Nexeo")
 *  doesn't qualify and goes through preview. This keeps the one-shot
 *  exception narrow. */
function isCanonicalTestEmail(act: ComposedAction, _question: string): boolean {
  // V2: candidate-IDs replace raw emails — the canonical-test-email
  // bypass loses its semantic anchor (we can't check "to includes
  // exact email" against candidateIds without resolving). Conservative
  // default: never bypass the preview gate. send_email always previews.
  if (act.type !== 'send_email') return false;
  return false;
}

/** Render a structured preview when the verification gate blocks an
 *  action. The user sees the slot values; either confirm or correct.
 *
 *  V2 (2026-05-23 — second pass): NEVER show raw candidateIds to the
 *  user. Resolve each candidateId to "Name <email>" via candidateResolver
 *  before rendering. Per Basit 2026-05-23: "U should not show ur internal
 *  ids to me these are meaningless for me show his email to whom test
 *  email has to send". The IDs are internal references; the user sees
 *  the resolved person.
 *
 *  Async because resolution hits the DB. Callers must await. */
async function renderActionPreview(
  act: ComposedAction,
  userId: number,
  clientNumber: string,
  _blockReason: string,
): Promise<string> {
  const { resolveCandidates, resolveCandidate } = await import('./candidateResolver');

  function fmt(r: { name: string; email: string | null; phone: string | null } | null, fallbackId: string): string {
    if (!r) return `[unknown contact ${fallbackId}]`;
    const ident = r.email ?? r.phone ?? '';
    return ident ? `${r.name} <${ident}>` : r.name;
  }

  if (act.type === 'send_email') {
    const resolvedTo = await resolveCandidates(act.toCandidateIds, userId, clientNumber);
    const toLines = act.toCandidateIds.map((id, i) => fmt(resolvedTo[i], id));
    const adHocLines = act.toAdHoc && act.toAdHoc.length ? act.toAdHoc : [];
    const allTo = [...toLines, ...adHocLines];
    const toStr = allTo.length > 0 ? allTo.join(', ') : '(no recipient)';
    const ccPart = act.ccCandidateIds && act.ccCandidateIds.length ? await (async () => {
      const r = await resolveCandidates(act.ccCandidateIds!, userId, clientNumber);
      return `\nCc: ${act.ccCandidateIds!.map((id, i) => fmt(r[i], id)).join(', ')}`;
    })() : '';
    return `Before I send, please confirm — I'm about to send:\n\nTo: ${toStr}${ccPart}\nSubject: ${act.subject}\nBody:\n${act.body}\n\nReply "send" to confirm, or tell me what to change.`;
  }
  if (act.type === 'schedule_meeting') {
    // Preview merges both attendee paths (structural fix 2026-07-07):
    // resolved contacts + ad-hoc emails the user typed directly.
    // Empty "With:" was a real bug (Rafay case, 2026-07-07).
    const resolved = await resolveCandidates(act.attendeeCandidateIds, userId, clientNumber);
    const contactLines = act.attendeeCandidateIds.map((id, i) => fmt(resolved[i], id));
    const adHocLines = (act.attendeeAdHocEmails ?? []).map((e) => e);
    const allAttendees = [...contactLines, ...adHocLines];
    const attendees = allAttendees.length > 0 ? allAttendees.join(', ') : '(no attendee)';
    const dur = act.durationMin ? ` (${act.durationMin} min)` : '';
    return `Before I send the invite, please confirm — meeting:\n\nWith: ${attendees}\nWhen: ${act.whenRaw}${dur}\nTitle: ${act.title}${act.note ? `\nNote: ${act.note}` : ''}\n\nReply "send" to confirm, or tell me what to change.`;
  }
  if (act.type === 'notify_via_whatsapp') {
    // Ad-hoc phone path takes precedence when set (Basit 2026-07-07):
    // if the user typed a raw number, we send to THAT number and never
    // substitute a similarly-named contact. Preview must reflect the
    // same behavior so the user sees exactly what will happen.
    const adHoc = String(act.recipientAdHocPhone ?? '').trim();
    let who: string;
    if (adHoc) {
      who = `+${adHoc.replace(/^\+/, '')}`;
    } else {
      const candId = String(act.recipientCandidateId ?? '');
      const r = candId ? await resolveCandidate(candId, userId, clientNumber) : null;
      // Chat 6 (2026-07-13): channel-ground the preview. fmt() shows
      // email ?? phone, so a phone-less contact rendered as
      // "WhatsApp to Asad <asad.ahmed@tmcltd.ai>" — a promise the send
      // could never keep, discovered only AFTER the user confirmed
      // ("I can't find a phone number… should I email instead?").
      // A WhatsApp preview must bind to a PHONE at preview time; no
      // phone → say so now and offer the real alternative, don't
      // preview a dead end.
      if (r && !r.phone) {
        return `[notify_via_whatsapp: ${r.name} has no phone on file — I can send an email instead, or give me their WhatsApp number]`;
      }
      who = r ? `${r.name} (${r.phone})` : fmt(r, candId || '(no recipient)');
    }
    return `Before I send the WhatsApp, please confirm — message to ${who}:\n\n"${act.message}"\n\nThe note will be prefixed with the standard Nexeo-on-behalf-of intro. Reply "send" to confirm, or tell me what to change.`;
  }
  if (act.type === 'set_contact_scope') {
    const r = await resolveCandidate(act.contactCandidateId, userId, clientNumber);
    const who = r?.name ?? act.nameHint ?? act.contactCandidateId;
    const label = act.scope === 'tenant' ? 'Public (tenant-shared)' : act.scope === 'private' ? 'Private (Brain-muted)' : 'Normal (default)';
    return `Before I change visibility, please confirm — set "${who}" to ${label}? Reply "send" to confirm.`;
  }
  if (act.type === 'mark_contact_inactive') {
    const r = await resolveCandidate(act.contactCandidateId, userId, clientNumber);
    const who = r?.name ?? act.nameHint ?? act.contactCandidateId;
    return `Before I mark inactive, please confirm — "${who}" will be hidden and Brain will skip them. Reply "send" to confirm.`;
  }
  if (act.type === 'archive_wiki_page') {
    return `Before I archive, please confirm — I'm about to archive wiki page:\n\n"${act.titleHint ?? '(id ' + act.wikiPageId + ')'}"\n\nArchiving hides it from Brain's retrieval. It stays in the DB and can be restored. Reply "send" to confirm, or tell me what to change.`;
  }
  if (act.type === 'delete_wiki_page') {
    return `⚠️ PERMANENT DELETE — please confirm:\n\n"${act.titleHint ?? '(id ' + act.wikiPageId + ')'}"\n\nThis is IRREVERSIBLE. Brain will forget this page entirely. If you just want Brain to ignore it temporarily, say "archive instead". Reply "send" to confirm permanent deletion.`;
  }
  return `Before I proceed, please confirm the details and reply "send".`;
}

/** Constrained action-decider. Replaces A's free-form retry with a
 *  call whose output is structurally restricted to a tiny JSON shape:
 *
 *    { "action": <ActionSchema> | null,
 *      "missing_slot": "<field name>" | null,
 *      "rationale": "<one short sentence>" }
 *
 *  No prose-output path means no escape valve. The model can either
 *  commit to an action OR explicitly name what's missing. The
 *  "wander into more disambiguation prose" failure mode (observed
 *  2026-05-20: Brain kept asking "which Asad?" instead of emitting
 *  schedule_meeting after the user resolved the slot) is structurally
 *  impossible here.
 *
 *  Uses Gemini Flash with responseMimeType="application/json" for
 *  strict JSON output. Falls back gracefully on parse failure. */
async function decideAction(opts: {
  question: string;
  history: ComposerHistoryTurn[];
  candidatesBlock: string;
  openItemsBlock: string;
  artifactsBlock: string;
  todayDate: string;
  userId?: number;
  clientNumber?: string;
}): Promise<{ action: ComposedAction | null; missingSlot: string | null; rationale: string } | null> {
  // Tight system prompt: just the action schema and decision rules.
  // No persona, no day-brief format, no factual rules — those would
  // dilute the model's attention. The decider has ONE job: decide.
  const systemPrompt = `You are a structured action extractor. Read the conversation context and decide exactly one of three things:

1. **Emit an action** when the conversation provides all required slots.
2. **Report a missing slot** when the action is clear but one required field cannot be filled from the conversation.
3. **No action** when the user's message is not an action request.

Output ONLY a JSON object — no prose, no explanation, no markdown:
{
  "action": <ActionSchema> | null,
  "missing_slot": "<specific field name>" | null,
  "rationale": "<one short sentence>"
}

ActionSchema is one of these (set "type" to one of these values):
- { "type": "add_open_item", "title": string, "dueDate"?: "YYYY-MM-DD", "note"?: string }
- { "type": "delegate_open_item", "openItemId": string, "delegateeEmail": string, "delegateeName": string, "note"?: string }
- { "type": "schedule_meeting", "title": string, "whenIso": "YYYY-MM-DDTHH:MM", "durationMin"?: number, "attendeeEmails": string[], "attendeeNames": string[], "note"?: string }
- { "type": "cancel_meeting", "eventId": string, "titleHint"?: string, "reason"?: string }
- { "type": "reschedule_meeting", "eventId": string, "titleHint"?: string, "newWhenIso"?: "YYYY-MM-DDTHH:MM", "newDurationMin"?: number, "reason"?: string }
- { "type": "send_email", "to": string[], "cc"?: string[], "subject": string, "body": string }
- { "type": "notify_via_whatsapp", "recipientName": string, "recipientPhone": string, "message": string }
- { "type": "set_brain_name", "name": string }

Slot grounding rules (MUST follow):
- Emails MUST come from the Candidates block or appear verbatim in the user's message. NEVER guess.
- Phone numbers MUST come from the Candidates block or appear verbatim in the user's message.
- openItemId MUST come from the Open Items snapshot.
- eventId for cancel_meeting / reschedule_meeting MUST come from the Recent action artifacts block. If no matching artifact exists, set action=null and missing_slot="eventId" (Brain will ask the user which meeting).
- whenIso resolves relative dates ("tomorrow", "Friday") against today's date.
- For test emails: ONLY if the user's own words contain "test email"/"test message"/"test mail", use subject="Test email from Nexeo" and body="This is a test message from your AI assistant. If you received this, the integration is working." — these are the canonical test defaults. For ANY other email request, never substitute this template: compose from the actual subject under discussion, or ask what to write. (2026-08-05: "You email them" about three delegated items sent the canned test email to a real colleague under the user's own name.)
- A user message like "first one" / "the first" / "option 1" maps to candidate #1 in the Candidates block.

If the user's CURRENT message is a slot-fill or disambiguation answer to YOUR previous question:
- Map their answer to the slot they're resolving.
- EMIT the action with the resolved slot, do NOT re-ask.

If the action type is ambiguous (user said "remind me about X" — is it add_open_item or schedule_meeting?), pick the most natural mapping and explain in rationale.

If only ONE field is genuinely missing, set "action": null and "missing_slot" to the exact JSON field name (e.g., "to", "subject", "whenIso", "attendeeEmails").

If the message has no action intent at all, set both action and missing_slot to null.

Today is ${opts.todayDate} (UTC). Use this as the anchor for relative dates.`;

  const historyText = opts.history.slice(-8).map((h) => `[${h.role}] ${h.text}`).join('\n');
  const userPayload = `User's current message:
${opts.question}

Recent conversation:
${historyText || '(none)'}

${opts.candidatesBlock || '(no candidates block)'}

${opts.openItemsBlock || '(no open items snapshot)'}

${opts.artifactsBlock || '(no recent action artifacts)'}`;

  try {
    const { callGemini } = await import('../geminiService');
    const raw = await callGemini(systemPrompt, userPayload, {
      maxTokens: 1024,
      flash: true,
      responseMimeType: 'application/json',
    });
    // The model returns JSON. Strip any markdown fencing just in case.
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const validated = normaliseAction(parsed.action);
    return {
      action: validated,
      missingSlot: typeof parsed.missing_slot === 'string' && parsed.missing_slot.trim()
        ? parsed.missing_slot.trim()
        : null,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.trim() : '',
    };
  } catch (e: any) {
    console.warn('[brain-chat] decideAction failed', {
      userId: opts.userId, clientNumber: opts.clientNumber, error: e?.message,
    });
    return null;
  }
}

/** Render a one-line message asking the user for a specific missing
 *  slot. Used when the action-decider reports `missing_slot`. */
function renderMissingSlotPrompt(actionType: string | null, slot: string): string {
  const SLOT_PROMPTS: Record<string, string> = {
    to: 'Who should I send the email to? Give me the name or email address.',
    attendeeEmails: 'Who should I invite to the meeting?',
    attendeeNames: 'Who should I invite to the meeting?',
    whenIso: 'What date and time should I schedule it for?',
    subject: 'What should the subject line be?',
    body: 'What should the email say?',
    openItemId: 'Which open item are you referring to? Mention the title or part of it.',
    delegateeEmail: 'Who should I delegate it to?',
    delegateeName: 'Who should I delegate it to?',
    title: 'What\'s the title or topic?',
    recipientPhone: 'What\'s the recipient\'s phone number?',
    recipientName: 'Who should I send the WhatsApp to?',
    message: 'What should the WhatsApp message say?',
    name: 'What name would you like?',
    dueDate: 'When is it due?',
  };
  const ask = SLOT_PROMPTS[slot] ?? `I need one more detail (${slot}) before I can proceed.`;
  return ask;
}

/** Record alias resolutions implied by a successfully-dispatched
 *  action. When Brain just sent an email to "Asad Ahmed Taj"
 *  <asad.ahmed@tmcltd.ai> on the user's instruction, the user's
 *  alias ("asad" or "asad ahmed taj" depending on what they typed)
 *  → asad.ahmed@tmcltd.ai is now confirmed. Stored so the next
 *  session's resolver picks immediately instead of re-asking.
 *
 *  Sprint 2 (2026-05-21). Idempotent — repeat dispatches just bump
 *  usedCount. Failures are non-fatal: alias recording must not
 *  break the dispatch reply path. */
async function recordAliasesFromDispatch(
  clientNumber: string,
  userId: number,
  question: string,
  action: ComposedAction,
): Promise<void> {
  try {
    const { recordResolution } = await import('./userResolutionAliasService');
    const qLower = question.toLowerCase();

    // Quality Sprint 1: stopword filter — don't record generic terms
    // as aliases. "send to boss" / "email the vendor" / "message him"
    // would otherwise silently teach Brain the wrong identifier and
    // misroute future requests. Per third-party review.
    const ALIAS_STOPWORDS = new Set([
      'him', 'her', 'them', 'they', 'he', 'she',
      'boss', 'manager', 'team', 'admin', 'support',
      'vendor', 'client', 'customer', 'partner',
      'the team', 'my team', 'our team',
      'the guy', 'the lady', 'the person',
      'someone', 'anyone', 'everyone', 'nobody',
      'mr', 'mrs', 'ms', 'dr', 'prof',
    ]);
    const looksLikeProperName = (raw: string): boolean => {
      // Originally-capitalized in the user's message — pull from
      // question (not the action's resolved name) to check what the
      // user actually typed.
      const re = new RegExp(`\\b${raw.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
      const m = question.match(re);
      if (!m) return false;
      // First character must be uppercase in the user's original text.
      const idx = question.toLowerCase().indexOf(raw.toLowerCase());
      if (idx < 0) return false;
      const original = question.slice(idx, idx + raw.length);
      return /^[A-Z]/.test(original);
    };

    const aliasCandidates = (full: string, first: string): string[] => {
      const out = new Set<string>();
      const fullLc = full.toLowerCase().trim();
      const firstLc = first.toLowerCase().trim();
      // Skip if the alias is a stopword (generic term, pronoun, title).
      if (ALIAS_STOPWORDS.has(fullLc) || ALIAS_STOPWORDS.has(firstLc)) return [];
      // Record the full name + first name as aliases (whichever the
      // user typed will match). Skip alias if the user didn't
      // actually mention this name in their CURRENT message (avoids
      // recording for slots resolved purely from candidates without
      // user mention).
      if (qLower.includes(fullLc) && looksLikeProperName(fullLc)) out.add(fullLc);
      if (firstLc && qLower.includes(firstLc) && looksLikeProperName(firstLc)) out.add(firstLc);
      return Array.from(out);
    };

    // V2 (2026-05-23): alias recording is superseded by candidate-IDs.
    // Reasoning now picks contacts by stable candidateId from the
    // candidates block (entity row id), so there's no need to learn
    // "name → email" aliases anymore. The candidate pool IS the alias
    // table. If we want to record name aliases in V2, we'd do it
    // during the entity-discovery pipeline, not at dispatch time.
    // Branches removed; function kept for future extension.
    void aliasCandidates; void recordResolution; void qLower; void looksLikeProperName;
  } catch (e: any) {
    console.warn('[brain-chat] alias recording failed (non-fatal)', { userId, error: e?.message });
  }
}

/** Map a Brain action kind to the idempotency service's ActionType
 *  union. Used by the Sprint 3 idempotency wrap so duplicate dispatches
 *  (webhook retries, double-taps) replay instead of re-executing. */
function brainActionTypeToIdem(kind: string): import('../actionIdempotencyService').ActionType {
  switch (kind) {
    case 'schedule_meeting':    return 'BRAIN_SCHEDULE_MEETING';
    case 'reschedule_meeting':  return 'BRAIN_RESCHEDULE_MEETING';
    case 'cancel_meeting':      return 'BRAIN_CANCEL_MEETING';
    case 'send_email':          return 'BRAIN_SEND_EMAIL';
    case 'notify_via_whatsapp': return 'BRAIN_NOTIFY_WA';
    case 'delegate_open_item':  return 'BRAIN_DELEGATE_OPEN_ITEM';
    case 'add_open_item':       return 'BRAIN_ADD_OPEN_ITEM';
    default:                    return 'REPLY'; // safe fallback
  }
}

/** Wrap a dispatch thunk with the existing actionIdempotencyService.
 *  Returns {result, replayed} so the caller can log replay events.
 *  On cache hit, returns the prior result without invoking dispatchFn. */
async function wrapDispatchIdem(
  actionType: import('../actionIdempotencyService').ActionType,
  clientNumber: string,
  userId: number,
  referenceId: string,
  dispatchFn: () => Promise<{ ok: boolean; artifactId?: string; message: string }>,
): Promise<{ result: { ok: boolean; artifactId?: string; message: string }; replayed: boolean }> {
  const { generateKey, checkKey, withIdempotency: existingWithIdem } = await import('../actionIdempotencyService');
  const key = generateKey({ actionType, clientNumber, userId, referenceId });
  const cached = await checkKey(key);
  if (cached !== null) {
    return { result: cached as any, replayed: true };
  }
  const result = await existingWithIdem(
    { actionType, clientNumber, userId, referenceId },
    dispatchFn,
  );
  return { result, replayed: false };
}

/** Guarded in-place contact edit (2026-07-13, extracted 2026-07-14 so
 *  compound-plan steps reuse the exact same implementation).
 *
 *  Closes the gap where the capability registry claimed contact-edit
 *  but no action existed — Brain refused ("I can't update a contact's
 *  email") and offered to create a DUPLICATE contact (the anti-pattern
 *  behind the earlier cross-user contact leakage). Updates the
 *  canonical entity row (what resolveCandidate reads) AND refreshes the
 *  entity_person wiki page metadata so contact resolution stays
 *  consistent across both stores — "re-read truth, not cache" made
 *  concrete: fix the source, don't strand a stale copy.
 *
 *  Scope: resolves with the SAME user-scope filter candidateResolver
 *  uses — tenant-shared, owned, or self-created. Another user's private
 *  contact simply won't resolve → "not found", never an unauthorized
 *  edit. */
async function updateContactGuarded(
  clientNumber: string,
  userId: number,
  edit: { contactCandidateId: string; newEmail?: string; newPhone?: string; newName?: string },
): Promise<{ ok: boolean; artifactId?: string; message: string }> {
  try {
    const ent = await prisma.entity.findFirst({
      where: {
        id: edit.contactCandidateId,
        clientNumber,
        entityType: 'contact',
        OR: [
          { scope: 'tenant' as any },
          { ownerUserId: userId } as any,
          { AND: [{ ownerUserId: null } as any, { createdBy: userId }] },
        ],
      } as any,
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!ent) return { ok: false, message: `[update_contact: contact not found in your contacts]` };
    const changes: string[] = [];
    const data: Record<string, unknown> = {};
    if (edit.newEmail) { data.email = edit.newEmail; changes.push(`email → ${edit.newEmail}`); }
    if (edit.newPhone) { data.phone = edit.newPhone; changes.push(`phone → ${edit.newPhone}`); }
    if (edit.newName) { data.name = edit.newName; changes.push(`name → ${edit.newName}`); }
    if (changes.length === 0) return { ok: false, message: `[update_contact: no fields to change]` };
    const { updateEntity } = await import('../entityService');
    await updateEntity(ent.id, clientNumber, data as any);
    // Keep the entity_person wiki page metadata in sync so the stale
    // value can't resurface via the wiki-backed lookup path.
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages
            SET metadata = metadata
              || jsonb_build_object('email', COALESCE($3, metadata->>'email'),
                                    'phone', COALESCE($4, metadata->>'phone')),
                last_updated_at = NOW()
          WHERE client_number = $1 AND page_type = 'entity_person'
            AND ( (metadata->>'email') IS NOT NULL AND lower(metadata->>'email') = $2 )`,
        clientNumber,
        (ent.email ?? '').toLowerCase(),
        edit.newEmail ?? null,
        edit.newPhone ?? null,
      );
    } catch { /* wiki sync is best-effort; entity is source of truth */ }
    return { ok: true, artifactId: ent.id, message: `Updated ${ent.name}: ${changes.join(', ')}.` };
  } catch (e: any) {
    return { ok: false, message: `[update_contact failed: ${e?.message ?? 'unknown'}]` };
  }
}

/** Compact one-line summary per plan step for the combined preview.
 *  (renderActionPreview's full texts each end in their own "Reply
 *  send…" instruction — unusable stacked; these are single lines.)
 *  Resolves candidate ids to names so the user reviews PEOPLE, not ids. */
export async function renderPlanPreview(
  steps: Array<{ kind: string; slots: Record<string, unknown> }>,
  userId: number,
  clientNumber: string,
): Promise<string> {
  const { resolveCandidate } = await import('./candidateResolver');
  const nameOf = async (id: unknown): Promise<string> => {
    if (typeof id !== 'string' || !id) return '(unknown)';
    const r = await resolveCandidate(id, userId, clientNumber).catch(() => null);
    return r ? r.name : `(unknown contact ${id})`;
  };
  /** Title of an open item, for previews. A preview naming only the ACTION
   *  ("Delegate item to Hamna" ×3) is unconfirmable — the owner cannot tell
   *  which items they are approving. Reported twice: 08-04 19:57 (update) and
   *  08-04 20:25 (delegate). */
  const itemTitleOf = async (id: unknown): Promise<string> => {
    if (typeof id !== 'string' || !id) return '(no item)';
    const row = await prisma.openItem.findFirst({
      where: { id, clientNumber, userId }, select: { title: true },
    }).catch(() => null);
    return row?.title ? `"${row.title}"` : `(unknown item ${id.slice(0, 8)})`;
  };
  const lines: string[] = [];
  for (const [i, step] of steps.entries()) {
    const s = step.slots as any;
    let line: string;
    switch (step.kind) {
      case 'send_email': {
        const to = Array.isArray(s.toCandidateIds) && s.toCandidateIds.length
          ? await Promise.all(s.toCandidateIds.map(nameOf)).then((n) => n.join(', '))
          : (Array.isArray(s.toAdHoc) ? s.toAdHoc.join(', ') : '(no recipient)');
        line = `Email to ${to} — "${s.subject ?? ''}"`;
        break;
      }
      case 'notify_via_whatsapp': {
        const who = s.recipientAdHocPhone
          ? String(s.recipientAdHocPhone)
          : await nameOf(s.recipientCandidateId);
        line = `WhatsApp to ${who}: "${String(s.message ?? '').slice(0, 120)}"`;
        break;
      }
      case 'schedule_meeting': {
        const who = Array.isArray(s.attendeeCandidateIds) && s.attendeeCandidateIds.length
          ? await Promise.all(s.attendeeCandidateIds.map(nameOf)).then((n) => n.join(', '))
          : (Array.isArray(s.attendeeAdHocEmails) ? s.attendeeAdHocEmails.join(', ') : '(no attendee)');
        line = `Meeting "${s.title ?? ''}" with ${who} — ${s.whenRaw ?? s.whenIso ?? ''}`;
        break;
      }
      case 'delegate_open_item':
        line = `Delegate ${await itemTitleOf(s.openItemId)} to ${s.delegateeAdHocEmail ?? await nameOf(s.delegateeCandidateId)}`;
        break;
      case 'update_open_item': {
        // Name the item AND every field being changed — this case did not
        // exist, so three updates rendered as "update open item" ×3.
        const changes = [
          s.priority && `priority → ${s.priority}`,
          s.dueDateRaw && `due → ${s.dueDateRaw}`,
          s.title && `rename → "${s.title}"`,
          s.note && 'note added',
        ].filter(Boolean).join(', ');
        line = `Update ${await itemTitleOf(s.openItemId)}: ${changes || '(no changes specified)'}`;
        break;
      }
      case 'update_contact': {
        const changes = [s.newEmail && `email → ${s.newEmail}`, s.newPhone && `phone → ${s.newPhone}`, s.newName && `name → ${s.newName}`].filter(Boolean).join(', ');
        line = `Update contact ${await nameOf(s.contactCandidateId)}: ${changes}`;
        break;
      }
      case 'add_open_item':
        line = `Add open item "${s.title ?? ''}"`;
        break;
      case 'cancel_meeting':
        line = `Cancel meeting ${s.titleHint ?? s.eventId ?? ''}`;
        break;
      case 'reschedule_meeting':
        line = `Reschedule meeting ${s.titleHint ?? s.eventId ?? ''} to ${s.newWhenRaw ?? ''}`;
        break;
      default:
        line = `${step.kind.replace(/_/g, ' ')}`;
    }
    lines.push(`${i + 1}. ${line}`);
  }
  return `Before I proceed, please confirm — I'm about to do ALL of these:\n\n${lines.join('\n')}\n\nReply "send" to confirm everything, or tell me what to change.`;
}

/** Dispatch a pending action directly from its stored slots.
 *  Used by the Sprint 1 confirm_preview short-circuit — bypasses
 *  the LLM entirely because the action is fully grounded already.
 *  Returns {ok, artifactId, message} mirroring the existing
 *  dispatcher contract so the caller can persist the artifact and
 *  reply to the user uniformly. */
export async function dispatchPendingDirect(
  clientNumber: string,
  userId: number,
  pending: import('./pendingActionService').PendingAction,
): Promise<{ ok: boolean; artifactId?: string; message: string }> {
  const slots = pending.slots as any;

  // Pillar 2 (2026-07-10) — ground-or-ask guard. This is the LAST gate
  // before a confirmed action irreversibly fires. Verify every target
  // (recipient / attendee / delegatee / contact / open item) grounds to
  // a real record scoped to this user. If any can't, fail closed to an
  // ask marker instead of dispatching to a guessed/stale target. The
  // guard mirrors each verb's accept-conditions exactly, so it can only
  // catch what the verb's own resolution would also reject — never a
  // false block. This is the structural end of the substitution class
  // (wrong-recipient, wrong-owner, stale-contact).
  try {
    const { verifyActionTargets } = await import('./actionTargetGuard');
    const verdict = await verifyActionTargets(pending.actionKind, slots, userId, clientNumber);
    if (!verdict.ok) {
      console.warn('[brain-chat] ground-or-ask guard blocked confirmed dispatch', {
        userId, clientNumber, actionKind: pending.actionKind, marker: verdict.marker,
      });
      return { ok: false, message: verdict.marker };
    }
  } catch (e: any) {
    // Guard failure must not itself block a legitimate send — log and
    // proceed to the per-verb resolution, which still fails closed on
    // its own if a target is unresolved.
    console.warn('[brain-chat] ground-or-ask guard errored (non-fatal, per-verb resolution still applies)', {
      userId, clientNumber, actionKind: pending.actionKind, error: e?.message,
    });
  }

  const { dispatchInstruction } = await import('../instructions/instructionDispatcher');

  // V2: slots may contain candidateIds + rawDate; resolve here.
  const { resolveCandidates } = await import('./candidateResolver');
  const { resolveDateTime } = await import('./dateResolver');

  switch (pending.actionKind) {
    case 'action_plan': {
      // Phase 1A (2026-07-14): compound plan — fan the confirmed steps
      // back through this same dispatcher one at a time (recursion,
      // depth 1; nested plans are rejected at validation). Each step
      // re-runs the ground-or-ask guard for ITS kind at the top of the
      // recursive call, and each provider dispatch verifies itself.
      // Stop on first failure — later steps may depend on earlier ones
      // (e.g. update the email, THEN send to it).
      const steps = Array.isArray(slots.steps) ? slots.steps as Array<{ kind: string; slots: Record<string, unknown> }> : [];
      if (steps.length === 0) return { ok: false, message: `[action_plan: no steps stored]` };
      const results: string[] = [];
      let firstArtifact: string | undefined;
      for (const [i, step] of steps.entries()) {
        if (step.kind === 'action_plan') {
          return { ok: false, message: `[action_plan: nested plan at step ${i + 1} — refusing]` };
        }
        const r = await dispatchPendingDirect(clientNumber, userId, {
          ...pending,
          actionKind: step.kind as import('./pendingActionService').PendingActionKind,
          slots: step.slots,
        });
        results.push(`${i + 1}. ${r.ok ? '✓' : '✗'} ${r.message}`);
        if (r.ok && !firstArtifact && r.artifactId) firstArtifact = r.artifactId;
        if (!r.ok) {
          const remaining = steps.length - i - 1;
          return {
            ok: false,
            artifactId: firstArtifact,
            message: `${results.join('\n')}${remaining > 0 ? `\n(stopped — ${remaining} remaining step${remaining === 1 ? '' : 's'} not attempted)` : ''}`,
          };
        }
      }
      return { ok: true, artifactId: firstArtifact, message: results.join('\n') };
    }
    case 'update_open_item': {
      // 2026-08-04: this case did NOT exist, so a confirmed plan whose steps
      // were update_open_item died with "[Unknown pending action kind]" and
      // three dictated priority+deadline updates were lost. The registry
      // listed the action, the validator accepted it, the preview rendered
      // it, the owner confirmed it — and nothing could execute it. Shares
      // one implementation with the inline path (applyOpenItemUpdate).
      const { applyOpenItemUpdate } = await import('../openItems/applyOpenItemUpdate');
      const r = await applyOpenItemUpdate({
        clientNumber, userId,
        openItemId: String(slots.openItemId ?? ''),
        title: slots.title as string | undefined,
        priority: slots.priority as string | undefined,
        dueDateRaw: slots.dueDateRaw as string | undefined,
        note: slots.note as string | undefined,
      });
      return { ok: r.ok, artifactId: r.artifactId, message: r.message };
    }
    case 'add_open_item': {
      // Plan-step only (single add_open_item dispatches inline in
      // compose, no preview). Routed via the same instructionDispatcher
      // path as the inline branch, dedup + gate included.
      const res = await dispatchInstruction({
        clientNumber, userId,
        instruction: {
          intent: 'add_open_item', confidence: 1,
          summary: String(slots.title ?? ''),
          params: { itemTitle: slots.title, itemDueDate: slots.dueDate, itemNote: slots.note },
        } as any,
      });
      return { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
    }
    case 'update_contact': {
      // Plan-step only — same guarded in-place edit as the inline
      // compose branch (shared helper keeps one implementation).
      return updateContactGuarded(clientNumber, userId, {
        contactCandidateId: String(slots.contactCandidateId ?? ''),
        newEmail: typeof slots.newEmail === 'string' ? slots.newEmail : undefined,
        newPhone: typeof slots.newPhone === 'string' ? slots.newPhone : undefined,
        newName: typeof slots.newName === 'string' ? slots.newName : undefined,
      });
    }
    case 'schedule_meeting': {
      // Union contact-resolved emails with ad-hoc emails the user
      // typed directly (structural fix 2026-07-07).
      const ids = Array.isArray(slots.attendeeCandidateIds) ? slots.attendeeCandidateIds : [];
      const adHocEmails = Array.isArray(slots.attendeeAdHocEmails)
        ? slots.attendeeAdHocEmails.filter((x: any) => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
        : [];
      const [attendees, whenIso] = await Promise.all([
        resolveCandidates(ids, userId, clientNumber),
        slots.whenRaw ? resolveDateTime(String(slots.whenRaw), userId) : Promise.resolve(null as string | null),
      ]);
      const contactEmails = attendees.filter((r): r is NonNullable<typeof r> => !!r && !!r.email).map((r) => r.email!);
      const emails = Array.from(new Set([...contactEmails, ...adHocEmails]));
      const names = [
        ...attendees.filter((r): r is NonNullable<typeof r> => !!r).map((r) => r.name),
        ...adHocEmails.filter((e: string) => !contactEmails.includes(e)).map((e: string) => e.split('@')[0]),
      ];
      if (!whenIso) return { ok: false, message: `[schedule_meeting: couldn't parse whenRaw "${slots.whenRaw}"]` };
      if (emails.length === 0) return { ok: false, message: `[schedule_meeting: no attendees with email]` };
      const res = await dispatchInstruction({
        clientNumber, userId,
        instruction: {
          intent: 'schedule_meeting', confidence: 1,
          summary: String(slots.title ?? 'Meeting'),
          params: {
            meetingTitle: slots.title,
            meetingWhen: whenIso,
            meetingDurationMin: slots.durationMin,
            meetingAttendees: [...emails, ...names],
          },
        } as any,
      });
      return { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
    }
    case 'reschedule_meeting': {
      const newWhenIso = slots.newWhenRaw ? await resolveDateTime(String(slots.newWhenRaw), userId) : null;
      if (slots.newWhenRaw && !newWhenIso) return { ok: false, message: `[reschedule_meeting: couldn't parse newWhenRaw "${slots.newWhenRaw}"]` };
      const res = await dispatchInstruction({
        clientNumber, userId,
        instruction: {
          intent: 'reschedule_meeting', confidence: 1,
          summary: `reschedule ${slots.titleHint ?? slots.eventId}`,
          params: {
            eventId: slots.eventId,
            titleHint: slots.titleHint,
            newWhenIso: newWhenIso ?? undefined,
            newDurationMin: slots.newDurationMin,
            reason: slots.reason,
          },
        } as any,
      });
      return { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
    }
    case 'cancel_meeting': {
      const res = await dispatchInstruction({
        clientNumber, userId,
        instruction: {
          intent: 'cancel_meeting', confidence: 1,
          summary: `cancel ${slots.titleHint ?? slots.eventId}`,
          params: {
            eventId: slots.eventId,
            titleHint: slots.titleHint,
            reason: slots.reason,
          },
        } as any,
      });
      return { ok: res.ok, artifactId: (res as any).artifactId, message: res.message };
    }
    case 'send_email': {
      const { sendUserEmail } = await import('../gmailService');
      const { getBrainPersona } = await import('./brainPersonaService');
      const personaInner = await getBrainPersona(userId, clientNumber).catch(() => null);
      const userName = personaInner?.userFirstName || personaInner?.userFullName || 'the user';
      // User's real signature (learned from Sent items) before the
      // disclosure — same treatment as the inline send_email branch.
      const { getUserEmailSignature } = await import('./outboundIdentity');
      const signature = await getUserEmailSignature(userId, clientNumber).catch(() => `Thanks,\n${userName}`);
      const footer = `\n\n— Sent by Nexeo, ${userName}'s AI assistant`;
      const rawBody = String(slots.body ?? '');
      const fullBody = `${rawBody.includes(signature) ? rawBody : `${rawBody}\n\n${signature}`}${footer}`;
      // V2: resolve toCandidateIds + ccCandidateIds + accept toAdHoc.
      const toIds = Array.isArray(slots.toCandidateIds) ? slots.toCandidateIds : [];
      const ccIds = Array.isArray(slots.ccCandidateIds) ? slots.ccCandidateIds : [];
      const adHoc = Array.isArray(slots.toAdHoc) ? slots.toAdHoc.filter((e: any) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) : [];
      const [toResolved, ccResolved] = await Promise.all([
        resolveCandidates(toIds, userId, clientNumber),
        resolveCandidates(ccIds, userId, clientNumber),
      ]);
      const toEmails = [
        ...toResolved.filter((r): r is NonNullable<typeof r> => !!r && !!r.email).map((r) => r.email!),
        ...adHoc,
      ];
      const ccEmails = ccResolved.filter((r): r is NonNullable<typeof r> => !!r && !!r.email).map((r) => r.email!);
      if (toEmails.length === 0) return { ok: false, message: `[send_email: no valid recipient]` };
      try {
        const r = await sendUserEmail(
          userId,
          toEmails.join(', '),
          String(slots.subject ?? ''),
          fullBody,
          ccEmails.length ? ccEmails.join(', ') : undefined,
        );
        // Fabrication guard + verification report (Basit 2026-07-08):
        // require messageId AND surface sentFromAddress / verified so
        // Brain can be honest about "sent from which account".
        if (r.success && r.messageId) {
          const linkedOpenItemId = typeof slots._delegationOpenItemId === 'string' ? slots._delegationOpenItemId : null;
          if (linkedOpenItemId) {
            await prisma.openItem.update({
              where: { id: linkedOpenItemId },
              data: {
                delegationEmailedAt: new Date(),
                delegationEmailMessageId: r.messageId,
              } as any,
            }).catch((e) => console.warn('[brain-chat] delegation email link write failed', { error: (e as any)?.message }));
          }
          const fromLine = (r as any).sentFromAddress ? ` (from ${(r as any).sentFromAddress})` : '';
          const verifyNote = (r as any).verified === false
            ? '\n(Note: Gmail accepted the send, but I couldn\'t verify it landed in your Sent folder — please check.)'
            : '';
          return {
            ok: true,
            artifactId: r.messageId,
            message: `Sent email to ${toEmails.join(', ')}${fromLine} — subject: "${slots.subject}". messageId=${r.messageId}${verifyNote}`,
          };
        }
        if (r.success && !r.messageId) {
          return { ok: false, message: `[send_email failed: Gmail returned success without a messageId — treat as unsent]` };
        }
        return { ok: false, message: `[send_email failed: ${r.error ?? 'unknown'}]` };
      } catch (e: any) {
        return { ok: false, message: `[send_email failed: ${e?.message ?? 'unknown'}]` };
      }
    }
    case 'notify_via_whatsapp': {
      const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
      const { getBrainPersona } = await import('./brainPersonaService');
      const personaInner = await getBrainPersona(userId, clientNumber).catch(() => null);
      const userName = personaInner?.userFirstName || personaInner?.userFullName || 'the user';

      // Two paths: (a) resolve a candidateId from contacts, or (b)
      // send ad-hoc to a raw phone the user explicitly named.
      // Ad-hoc path is required so Brain can honour "send to
      // +923710042740" without silently substituting a contact.
      // Per Basit 2026-07-07: closest-match substitution caused a
      // wrong-recipient send (Ahmad Sheikh); the fix at the prompt
      // layer refuses substitution, and this dispatch path gives
      // Brain a legitimate way to fulfil the request.
      let recipientName: string;
      let recipientPhone: string;
      const adHoc = String(slots.recipientAdHocPhone ?? '').trim();
      if (adHoc) {
        // Validate E.164-ish shape and normalise.
        const cleaned = adHoc.replace(/[\s\-()]/g, '');
        if (!/^\+?\d{10,15}$/.test(cleaned)) {
          return { ok: false, message: `[notify_via_whatsapp: adHoc phone "${adHoc}" isn't a valid E.164 number]` };
        }
        recipientPhone = cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
        recipientName = `contact at ${recipientPhone}`;
      } else {
        const { resolveCandidate } = await import('./candidateResolver');
        const matched = await resolveCandidate(String(slots.recipientCandidateId ?? ''), userId, clientNumber);
        if (!matched) return { ok: false, message: `[notify_via_whatsapp: candidateId not found]` };
        if (!matched.phone) return { ok: false, message: `[notify_via_whatsapp: ${matched.name} has no phone on file]` };
        recipientName = matched.name;
        recipientPhone = matched.phone;
      }

      const { getBrainDisplayName } = await import('./outboundIdentity');
      const brainDisplayName = await getBrainDisplayName(userId).catch(() => 'Nexeo');
      const intro = `Hi ${recipientName.startsWith('contact at') ? 'there' : recipientName}, this is ${brainDisplayName} — ${userName}'s AI assistant. ${userName} asked me to let you know:\n\n`;
      try {
        const { normalizeWhatsAppSubstantiveMessage, whatsappAcceptedMessage } = await import('./whatsappOutboundPolicy');
        const substantive = normalizeWhatsAppSubstantiveMessage(String(slots.message), recipientName);
        const r = await sendTenantWhatsAppText(clientNumber, recipientPhone, `${intro}${substantive}`, userId);
        if (r.ok) {
          return {
            ok: true,
            artifactId: r.waMessageId,
            message: r.waMessageId
              ? `Sent WhatsApp to ${recipientName} (${recipientPhone}) from the Nexeo number. waMessageId=${r.waMessageId}`
              : whatsappAcceptedMessage(recipientName, recipientPhone),
          };
        }
        return { ok: false, message: `[notify_via_whatsapp failed: ${r.error ?? 'provider rejected the send'}]` };
      } catch (e: any) {
        return { ok: false, message: `[notify_via_whatsapp failed: ${e?.message ?? 'unknown'}]` };
      }
    }
    case 'delegate_open_item': {
      // Two recipient paths (structural fix 2026-07-07):
      //   (a) delegateeCandidateId → resolveCandidate
      //   (b) delegateeAdHocEmail  → synthesize a matched-like row
      const { resolveCandidate } = await import('./candidateResolver');
      const { delegateItem } = await import('../openItemsService');
      const adHocEmail = typeof slots.delegateeAdHocEmail === 'string' ? slots.delegateeAdHocEmail.trim() : '';
      let matched: { name: string; email: string | null; phone: string | null } | null = null;
      if (adHocEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adHocEmail)) {
        matched = { name: adHocEmail.split('@')[0], email: adHocEmail, phone: null };
      } else {
        matched = await resolveCandidate(String(slots.delegateeCandidateId ?? ''), userId, clientNumber);
      }
      if (!matched) return { ok: false, message: `[delegate_open_item: recipient not resolved]` };
      if (!matched.email) return { ok: false, message: `[delegate_open_item: ${matched.name} has no email]` };
      try {
        const r = await delegateItem(
          String(slots.openItemId),
          clientNumber,
          null,
          matched.name,
          matched.email,
          slots.note ? String(slots.note) : undefined,
        );
        return {
          ok: !!r,
          artifactId: String(slots.openItemId),
          message: `Delegated "${slots.titleHint ?? slots.openItemId}" to ${matched.name} <${matched.email}>.`,
        };
      } catch (e: any) {
        return { ok: false, message: `[delegate failed: ${e?.message ?? 'unknown'}]` };
      }
    }
  }
  return { ok: false, message: `[Unknown pending action kind: ${pending.actionKind}]` };
}

/** Describe what Brain attempted in the previous (rejected) response,
 *  in honest first-person terms. Used by the empty-promise guard to
 *  give the user a diagnostic message instead of the generic
 *  "I didn't actually complete that" — which read as Brain breaking
 *  no matter what intent was. Per Basit 2026-05-22: trust loss when
 *  every failure looks the same. */
function describeAttemptForUser(attemptedAnswer: string, userQuestion: string): string {
  const q = userQuestion.trim().toLowerCase();
  // Detect the most likely action class from the user's wording so
  // the diagnostic message frames Brain's understanding correctly.
  if (/\b(reply|respond|answer)\b.*(?:to|on)\b.*(?:email|thread|message)/i.test(q) ||
      /\breply\s+(to\s+)?(all|him|her|them)/i.test(q)) {
    return `I understood the ask — reply to that thread — and tried to compose it, but I didn't actually send anything. The draft never made it to a structured action this turn.`;
  }
  if (/\bsend\s+(an?\s+)?email\b/i.test(q)) {
    return `I understood: send an email. I tried to compose it but didn't actually emit the send — nothing went out.`;
  }
  if (/\b(schedule|book|set\s+up)\b.*(?:meeting|call|sync)/i.test(q)) {
    return `I understood: schedule a meeting. I tried to draft it but the calendar invite didn't actually emit — nothing was created.`;
  }
  if (/\bcancel\b.*(?:meeting|invite|event)/i.test(q)) {
    return `I understood: cancel a meeting. I tried but didn't actually cancel anything on your calendar — the event is still there.`;
  }
  if (/\b(reschedule|move|push|shift)\b.*(?:meeting|invite|to)/i.test(q)) {
    return `I understood: reschedule. I tried but didn't actually move the meeting — it's at the original time.`;
  }
  if (/\bdelegate\b/i.test(q)) {
    return `I understood: delegate. I tried but didn't actually transition the item to anyone — it's still on you.`;
  }
  if (/\bremind|add\s+(?:to|that|this).*(?:open\s+items?|list|todo)/i.test(q)) {
    return `I understood: add it to your open items. I tried but didn't actually create the row — nothing was added.`;
  }
  // Fallback: generic but still acknowledging the attempt.
  return `I understood what you wanted and tried to act on it, but the structured action didn't actually emit. Nothing went through.`;
}

/** Name the specific missing piece so the user can supply it on the
 *  next turn and Brain can dispatch successfully. */
function describeMissingPiece(userQuestion: string): string {
  const q = userQuestion.trim().toLowerCase();
  if (/\b(reply|respond)\b.*(?:email|thread)/i.test(q)) {
    return `the specific email I should reply to — share the sender's name, the subject line, or forward me the thread.`;
  }
  if (/\bsend\s+(an?\s+)?email\b/i.test(q)) {
    return `the recipient's email address (not just their name), and a short note on what to write.`;
  }
  if (/\b(schedule|book|set\s+up)\b.*(?:meeting|call)/i.test(q)) {
    return `the attendee's email address and the exact date + time (in your timezone).`;
  }
  if (/\bcancel\b.*(?:meeting|invite)/i.test(q)) {
    return `the meeting title or time so I can find it on your calendar.`;
  }
  if (/\bdelegate\b/i.test(q)) {
    return `which open item (by title) and the delegatee's email.`;
  }
  return `which specific item / person you mean, and any details I should use.`;
}

/** Decide whether THIS call uses the reasoning-first composer or the
 *  legacy multi-call path.
 *
 *  Default = reasoning ON (changed 2026-05-25 after Basit's
 *  data-parity test: UI chat hit the reasoning path and got real
 *  WhatsApp data, WhatsApp Nexeo hit the legacy path and falsely
 *  said "no messages in last 24h" because the legacy composer doesn't
 *  inject the new recentEmails / recentWhatsApp / contactProvenance /
 *  dayBrief blocks or have access to brain tools).
 *
 *  Sources, in priority:
 *    1. explicit opts.useReasoning=false → force legacy (escape hatch
 *       for incidents or A/B comparison)
 *    2. explicit opts.useReasoning=true → force reasoning
 *    3. BRAIN_USE_REASONING env var:
 *       'never' → false (override default for emergency rollback);
 *       any other value → reasoning ON (default).
 *
 *  The percent-rollout mode (numeric env) is removed — once the
 *  reasoning path became the only path with current visibility data,
 *  splitting a tenant's users across paths creates the very parity
 *  bug we're trying to eliminate. */
function resolveReasoningMode(_userId: number, explicit: boolean | undefined): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  if (process.env.BRAIN_USE_REASONING === 'never') return false;
  return true;
}

/** Persist the reasoning step's decision + token telemetry. Used for
 *  debugging, cost monitoring, and the Settings → Brain → Activity
 *  view. Fire-and-forget — failures don't affect the reply. */
async function writeReasoningTrace(args: {
  userId: number;
  clientNumber: string;
  turnId: string;
  decision: string;
  actionType: string | null;
  confidence: number;
  rationale: string;
}): Promise<void> {
  try {
    await (prisma as any).reasoningTrace.create({
      data: {
        userId: args.userId,
        clientNumber: args.clientNumber,
        turnId: args.turnId,
        decidedAction: args.decision,
        actionType: args.actionType,
        confidence: args.confidence,
        reasoningText: args.rationale.slice(0, 1000),
      },
    });
  } catch (e: any) {
    console.warn('[compose] reasoning trace write failed', { error: e?.message });
  }
}

interface ParsedCompose { answer: string; cites: string[]; gaps: string[]; action: ComposedAction | null; }

function parseCompose(text: string): ParsedCompose {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    // No JSON envelope at all — LLM emitted prose. Pass it through
    // (handles flash-fallback cases where the model ignores schema).
    return { answer: text.trim() || '(no response)', cites: [], gaps: [], action: null };
  }
  try {
    const obj = JSON.parse(match[0]);
    return {
      answer: typeof obj.answer === 'string' ? obj.answer.trim() : (text.trim() || '(no response)'),
      cites: Array.isArray(obj.cites) ? obj.cites.filter((x: unknown): x is string => typeof x === 'string') : [],
      gaps: Array.isArray(obj.gaps) ? obj.gaps.filter((x: unknown): x is string => typeof x === 'string').map((s: string) => s.trim()).filter(Boolean) : [],
      action: normaliseAction(obj.action),
    };
  } catch {
    // JSON.parse failed — typically because maxOutputTokens truncated
    // the envelope mid-cites array, leaving an unclosed bracket. We
    // observed this 2026-05-20 on Basit's "send a test email to
    // asad…" turn: the LLM emitted 20+ cite ids and ran out of tokens,
    // and the raw `{"answer": "...","cites":[…` shipped to WhatsApp
    // as the user-visible reply.
    //
    // Salvage strategy: pull the `"answer": "..."` string with a
    // non-greedy regex that tolerates a missing closing `}`. The cites
    // and action are lost (they came after the answer in the schema),
    // but the user gets clean prose instead of a JSON dump.
    const answerSalvage = text.match(/"answer"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (answerSalvage && answerSalvage[1]) {
      const unescaped = answerSalvage[1]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
      console.warn('[brain-chat] compose JSON truncated; salvaged answer field', {
        textLen: text.length, answerLen: unescaped.length,
      });
      return { answer: unescaped.trim(), cites: [], gaps: [], action: null };
    }
    // Neither valid JSON nor a recoverable answer field. Better to
    // emit a bracketed marker than ship a JSON brace to the user.
    console.warn('[brain-chat] compose unparseable, returning system marker', {
      head: text.slice(0, 120),
    });
    return {
      answer: `[Brain output malformed — retry, or check logs]`,
      cites: [], gaps: [], action: null,
    };
  }
}

/** Reject anything that doesn't conform to ComposedAction. Validation is
 *  strict on every non-negotiable field — required slots that are missing
 *  cause the whole action to drop to null so the LLM's prose answer goes
 *  out instead. This is intentional: bad action data is worse than no
 *  action (we'd write a wrong row in the DB).
 *
 *  When validation drops a non-null raw, we log WHY. Otherwise a "Sending
 *  email now…" prose with no actionResult looks identical whether the
 *  LLM forgot to emit an action at all or emitted one with an empty
 *  subject. Observed 2026-05-20: Basit's send-email-to-Asad turn went
 *  out as bare prose with no action, and we couldn't tell which path
 *  it took. */
export function normaliseAction(raw: unknown): ComposedAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : null;
  const reject = (reason: string): null => {
    console.warn('[brain-chat] action rejected', { type, reason, keys: Object.keys(r) });
    return null;
  };
  if (type === 'add_open_item') {
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    if (!title) return null;
    const dueDateRaw = typeof r.dueDateRaw === 'string' && r.dueDateRaw.trim() ? r.dueDateRaw.trim() : undefined;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
    return { type: 'add_open_item', title, dueDateRaw, note };
  }
  if (type === 'update_open_item') {
    const openItemId = typeof r.openItemId === 'string' ? r.openItemId.trim() : '';
    if (!openItemId) return null;
    const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : undefined;
    const priority = typeof r.priority === 'string' && r.priority.trim() ? r.priority.trim() : undefined;
    const dueDateRaw = typeof r.dueDateRaw === 'string' && r.dueDateRaw.trim() ? r.dueDateRaw.trim() : undefined;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
    return { type: 'update_open_item', openItemId, title, priority, dueDateRaw, note };
  }
  if (type === 'mark_open_item_done') {
    const openItemId = typeof r.openItemId === 'string' ? r.openItemId.trim() : '';
    if (!openItemId) return null;
    const completionNote = typeof r.completionNote === 'string' && r.completionNote.trim() ? r.completionNote.trim() : undefined;
    return { type: 'mark_open_item_done', openItemId, completionNote };
  }
  if (type === 'delegate_open_item') {
    // Accept THREE input shapes (structural fix 2026-07-07):
    //   (a) delegateeCandidateId — new schema, existing contact
    //   (b) delegateeAdHocEmail  — new schema, ad-hoc email
    //   (c) delegateeEmail       — legacy schema still emitted by
    //       the LLM prompt at line ~820 / ~4467. Treat any legacy
    //       email as an ad-hoc email so the flow works.
    const openItemId = typeof r.openItemId === 'string' ? r.openItemId.trim() : '';
    const delegateeCandidateId = typeof r.delegateeCandidateId === 'string' && r.delegateeCandidateId.trim()
      ? r.delegateeCandidateId.trim() : undefined;
    const rawAdHoc = typeof r.delegateeAdHocEmail === 'string' ? r.delegateeAdHocEmail.trim() : '';
    const rawLegacy = typeof r.delegateeEmail === 'string' ? r.delegateeEmail.trim() : '';
    const candidateEmail = rawAdHoc || rawLegacy;
    const delegateeAdHocEmail = candidateEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail)
      ? candidateEmail : undefined;
    if (!openItemId) return reject('delegate_open_item:no-openItemId');
    if (!delegateeCandidateId && !delegateeAdHocEmail) return reject('delegate_open_item:no-recipient');
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
    return { type: 'delegate_open_item', openItemId, delegateeCandidateId, delegateeAdHocEmail, note };
  }
  if (type === 'schedule_meeting') {
    // Accept multiple input shapes (structural fix 2026-07-07):
    //   • attendeeCandidateIds — new-schema contact IDs
    //   • attendeeAdHocEmails  — new-schema raw emails
    //   • attendeeEmails       — legacy-schema (still in LLM prompt);
    //     treat as ad-hoc emails
    //   • whenRaw / whenIso    — accept either as the time phrase
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const whenRaw = typeof r.whenRaw === 'string' && r.whenRaw.trim()
      ? r.whenRaw.trim()
      : (typeof r.whenIso === 'string' ? r.whenIso.trim() : '');
    const attendeeCandidateIds = Array.isArray(r.attendeeCandidateIds)
      ? r.attendeeCandidateIds.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      : [];
    const legacyEmails = Array.isArray(r.attendeeEmails)
      ? r.attendeeEmails.filter((x: unknown): x is string => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
      : [];
    const newAdHocEmails = Array.isArray(r.attendeeAdHocEmails)
      ? r.attendeeAdHocEmails.filter((x: unknown): x is string => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
      : [];
    const attendeeAdHocEmails = Array.from(new Set([...newAdHocEmails, ...legacyEmails]));
    if (!title || !whenRaw || (attendeeCandidateIds.length === 0 && attendeeAdHocEmails.length === 0)) return reject('schedule_meeting:missing-required');
    const durationMin = typeof r.durationMin === 'number' && r.durationMin > 0 ? Math.floor(r.durationMin) : undefined;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim() : undefined;
    return { type: 'schedule_meeting', title, whenRaw, durationMin, attendeeCandidateIds, attendeeAdHocEmails: attendeeAdHocEmails.length ? attendeeAdHocEmails : undefined, note };
  }
  if (type === 'cancel_meeting') {
    // eventId is the only hard requirement — without it we don't know
    // which event to cancel. titleHint helps the dispatcher log a
    // human-readable summary; reason is optional and goes to a
    // notification email if Calendar attendees expect explanation.
    const eventId = typeof r.eventId === 'string' ? r.eventId.trim() : '';
    if (!eventId) return reject('cancel_meeting:no-eventId');
    const titleHint = typeof r.titleHint === 'string' && r.titleHint.trim() ? r.titleHint.trim() : undefined;
    const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : undefined;
    return { type: 'cancel_meeting', eventId, titleHint, reason };
  }
  if (type === 'reschedule_meeting') {
    const eventId = typeof r.eventId === 'string' ? r.eventId.trim() : '';
    if (!eventId) return reject('reschedule_meeting:no-eventId');
    const newWhenRaw = typeof r.newWhenRaw === 'string' && r.newWhenRaw.trim() ? r.newWhenRaw.trim() : undefined;
    const newDurationMin = typeof r.newDurationMin === 'number' && r.newDurationMin > 0
      ? Math.floor(r.newDurationMin) : undefined;
    if (!newWhenRaw && !newDurationMin) return reject('reschedule_meeting:no-change-fields');
    const titleHint = typeof r.titleHint === 'string' && r.titleHint.trim() ? r.titleHint.trim() : undefined;
    const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : undefined;
    return { type: 'reschedule_meeting', eventId, titleHint, newWhenRaw, newDurationMin, reason };
  }
  if (type === 'send_email') {
    // Accept multiple input shapes (structural fix 2026-07-07):
    //   • toCandidateIds / ccCandidateIds — new-schema contact IDs
    //   • toAdHoc — new-schema raw emails
    //   • to / cc  — legacy schema (LLM prompt still uses these);
    //     treat as toAdHoc so the flow works
    const toCandidateIds = Array.isArray(r.toCandidateIds)
      ? r.toCandidateIds.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      : [];
    const ccCandidateIds = Array.isArray(r.ccCandidateIds)
      ? r.ccCandidateIds.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      : [];
    const legacyTo = Array.isArray(r.to)
      ? r.to.filter((x: unknown): x is string => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
      : [];
    const newToAdHoc = Array.isArray(r.toAdHoc)
      ? r.toAdHoc.filter((x: unknown): x is string => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))
      : [];
    const toAdHoc = Array.from(new Set([...newToAdHoc, ...legacyTo]));
    const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
    const body = typeof r.body === 'string' ? r.body.trim() : '';
    if (toCandidateIds.length === 0 && toAdHoc.length === 0) return reject('send_email:no-recipient');
    if (!subject) return reject('send_email:no-subject');
    if (!body) return reject('send_email:no-body');
    const replyToFeedEventId = typeof r.replyToFeedEventId === 'string' && r.replyToFeedEventId.trim()
      ? r.replyToFeedEventId.trim() : undefined;
    return { type: 'send_email', toCandidateIds, ccCandidateIds: ccCandidateIds.length ? ccCandidateIds : undefined, toAdHoc: toAdHoc.length ? toAdHoc : undefined, subject, body, replyToFeedEventId };
  }
  if (type === 'notify_via_whatsapp') {
    // Accept multiple input shapes (structural fix 2026-07-07):
    //   • recipientCandidateId — new-schema contact ID
    //   • recipientAdHocPhone  — new-schema raw phone
    //   • recipientPhone       — legacy schema (still in some paths);
    //     treat as ad-hoc phone
    // Silent-bug fix: earlier parser dropped recipientAdHocPhone
    // even though type + dispatch supported it, so LLM's ad-hoc
    // phone was silently ignored.
    const recipientCandidateId = typeof r.recipientCandidateId === 'string' && r.recipientCandidateId.trim()
      ? r.recipientCandidateId.trim() : undefined;
    const rawNew = typeof r.recipientAdHocPhone === 'string' ? r.recipientAdHocPhone.trim() : '';
    const rawLegacy = typeof r.recipientPhone === 'string' ? r.recipientPhone.trim() : '';
    const rawPhone = rawNew || rawLegacy;
    const cleaned = rawPhone.replace(/[\s\-()]/g, '');
    const recipientAdHocPhone = cleaned && /^\+?\d{10,15}$/.test(cleaned)
      ? (cleaned.startsWith('+') ? cleaned : `+${cleaned}`)
      : undefined;
    const message = typeof r.message === 'string' ? r.message.trim() : '';
    if (!message) return reject('notify_via_whatsapp:no-message');
    if (!recipientCandidateId && !recipientAdHocPhone) return reject('notify_via_whatsapp:no-recipient');
    return { type: 'notify_via_whatsapp', recipientCandidateId, recipientAdHocPhone, message };
  }
  if (type === 'set_contact_scope') {
    const contactCandidateId = typeof r.contactCandidateId === 'string' ? r.contactCandidateId.trim() : '';
    const scopeRaw = typeof r.scope === 'string' ? r.scope.trim().toLowerCase() : '';
    if (!contactCandidateId) return reject('set_contact_scope:no-id');
    if (!['tenant', 'normal', 'private'].includes(scopeRaw)) return reject('set_contact_scope:bad-scope');
    const nameHint = typeof r.nameHint === 'string' && r.nameHint.trim() ? r.nameHint.trim() : undefined;
    return { type: 'set_contact_scope', contactCandidateId, scope: scopeRaw as any, nameHint };
  }
  if (type === 'mark_contact_inactive') {
    const contactCandidateId = typeof r.contactCandidateId === 'string' ? r.contactCandidateId.trim() : '';
    if (!contactCandidateId) return reject('mark_contact_inactive:no-id');
    const nameHint = typeof r.nameHint === 'string' && r.nameHint.trim() ? r.nameHint.trim() : undefined;
    return { type: 'mark_contact_inactive', contactCandidateId, nameHint };
  }
  if (type === 'update_contact') {
    const contactCandidateId = typeof r.contactCandidateId === 'string' ? r.contactCandidateId.trim() : '';
    if (!contactCandidateId) return reject('update_contact:no-id');
    const rawEmail = typeof r.newEmail === 'string' ? r.newEmail.trim() : '';
    const newEmail = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : undefined;
    // If an email was supplied but is malformed, reject rather than
    // silently dropping it (a bad email is worse than asking again).
    if (rawEmail && !newEmail) return reject('update_contact:bad-email');
    const rawPhone = typeof r.newPhone === 'string' ? r.newPhone.trim() : '';
    const cleanedPhone = rawPhone.replace(/[\s\-()]/g, '');
    const newPhone = cleanedPhone && /^\+?\d{10,15}$/.test(cleanedPhone)
      ? (cleanedPhone.startsWith('+') ? cleanedPhone : `+${cleanedPhone}`)
      : undefined;
    if (rawPhone && !newPhone) return reject('update_contact:bad-phone');
    const newName = typeof r.newName === 'string' && r.newName.trim() ? r.newName.trim() : undefined;
    // At least one field to change, else there's nothing to do.
    if (!newEmail && !newPhone && !newName) return reject('update_contact:no-fields');
    const nameHint = typeof r.nameHint === 'string' && r.nameHint.trim() ? r.nameHint.trim() : undefined;
    return { type: 'update_contact', contactCandidateId, newEmail, newPhone, newName, nameHint };
  }
  if (type === 'archive_wiki_page') {
    const wikiPageId = typeof r.wikiPageId === 'string' ? r.wikiPageId.trim() : '';
    if (!wikiPageId) return reject('archive_wiki_page:no-id');
    const titleHint = typeof r.titleHint === 'string' && r.titleHint.trim() ? r.titleHint.trim() : undefined;
    const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : undefined;
    return { type: 'archive_wiki_page', wikiPageId, titleHint, reason };
  }
  if (type === 'delete_wiki_page') {
    const wikiPageId = typeof r.wikiPageId === 'string' ? r.wikiPageId.trim() : '';
    if (!wikiPageId) return reject('delete_wiki_page:no-id');
    const titleHint = typeof r.titleHint === 'string' && r.titleHint.trim() ? r.titleHint.trim() : undefined;
    const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim() : undefined;
    return { type: 'delete_wiki_page', wikiPageId, titleHint, reason };
  }
  if (type === 'record_preference') {
    // User stated a preference Brain should remember across sessions.
    // Quality Sprint 2 (2026-05-21). Key is free-form but should
    // typically match one of CANONICAL_KEYS in userMemoryService for
    // automatic prompt rendering. Value can be any JSON-serializable
    // type; the prompt rule below tells the LLM what shapes are
    // expected per canonical key.
    const key = typeof r.key === 'string' ? r.key.trim() : '';
    if (!key || key.length > 80) return reject('record_preference:invalid-key');
    let value = r.value;
    if (value === undefined || value === null) return reject('record_preference:no-value');
    if (key === 'email_max_age_days') {
      const days = Number(value);
      if (!Number.isFinite(days)) return reject('record_preference:email-max-age-not-numeric');
      value = Math.max(1, Math.min(365, Math.round(days)));
    }
    const description = typeof r.description === 'string' && r.description.trim() ? r.description.trim() : undefined;
    return { type: 'record_preference', key, value, description };
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
