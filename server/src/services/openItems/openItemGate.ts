/**
 * openItemGate — single chokepoint that all open-item creation must
 * pass through. Centralises three pre-create concerns so we don't
 * scatter the logic across the dispatcher + briefRoutes + future
 * surfaces.
 *
 *   1) Private-contact filter — items derived from a feed_event whose
 *      sender is Brain-muted (scope='private') don't get created.
 *      Mirrors brainMuteService's My Attention filter; closes the
 *      "open items still appear from Private senders" gap the user
 *      flagged on 2026-05-14.
 *
 *   2) Delegation normalisation — accepts an explicit delegatee
 *      (params) OR detects a "Delegated to X" line in the description
 *      and infers delegateeName from it. Sets status='DELEGATED' so
 *      the UI's Delegated filter tab is honest. Closes the "EXIM
 *      solution shows as NEW even though description says Delegated
 *      to Yousaf" bug the user flagged.
 *
 *   3) (Phase 2 placeholder — not implemented here): English
 *      translation of titles, DRAFT state for incomplete items.
 *      Hooks are stubbed so Phase 2 lands cleanly.
 *
 * Per the brain rule, this is hygiene + structural normalisation,
 * not LLM judgement. The Private check is a database lookup
 * (entity_person.scope), and the "Delegated to X" detection is
 * a known structural artefact in our own UI ("EXIM solution" had
 * exactly this text in description from a manual create). Real
 * semantic question — "is X the right person to delegate to?" —
 * stays with the composer.
 */
import prisma from '../../db/prisma';

export interface GateInput {
  clientNumber: string;
  userId: number;
  /** The feed_event this item is derived from, if any. Drives the
   *  Private-contact lookup. */
  sourceFeedEventId?: string | null;
  title: string;
  description?: string | null;
  /** Explicit delegatee from the caller (if known). */
  delegateeId?: number | null;
  delegateeName?: string | null;
  delegateeEmail?: string | null;
  /** Caller's intended priority — when missing, gate routes to DRAFT. */
  priority?: 'critical' | 'high' | 'medium' | 'low' | null;
  /** Caller's intended due date — when missing, gate routes to DRAFT. */
  dueDate?: Date | null;
  /** Source feed (gmail / whatsapp / etc) + the source-specific ref
   *  (Gmail message id, WA message id, etc). When both are present
   *  the gate's exact-dedup layer blocks duplicate inserts from a
   *  webhook + poll race or a real-time-then-backfill chain. */
  sourceFeed?: string | null;
  sourceRef?: string | null;
  /** Skip the semantic-dedup LLM call. Use only when the caller is
   *  certain this is intentional (e.g. UI create where the user
   *  acknowledged a duplicate warning and chose to proceed). */
  skipDedupCheck?: boolean;
}

export interface GateOutput {
  /** When true, do NOT create the item. Caller returns silently or
   *  surfaces the reason to the user. */
  block: boolean;
  /** Reason for blocking, when block=true. */
  reason?: string;
  /** When block=true and the cause was a duplicate, this is the id
   *  of the existing item the caller should surface ("you already
   *  have this — see <existing>"). null otherwise. */
  duplicateOfId?: string | null;
  /** Normalised values to use in the prisma.openItem.create call. */
  status: 'NEW' | 'DELEGATED' | 'DRAFT';
  delegateeId: number | null;
  delegateeName: string | null;
  delegateeEmail: string | null;
  /** When status='DRAFT' (item missing priority and/or dueDate), names
   *  the slots the daily ask job should fill via WhatsApp. */
  missingSlots: Array<'priority' | 'dueDate'>;
}

/** "Delegated to <Name>" pattern at start of description or as its
 *  own line. Captures up to ~60 chars after the keyword as the name.
 *  Case-insensitive. Brain-rule note: this is structural pattern
 *  recognition for OUR OWN UI's known text format, not a regex
 *  panel making a content judgement. */
const DELEGATED_TO_PATTERN = /(?:^|\n)\s*delegat(?:ed|ing)\s+to[:\s]+([^\n]{2,80})/i;

function parseDelegateeFromDescription(desc: string | null | undefined): string | null {
  if (!desc) return null;
  const m = desc.match(DELEGATED_TO_PATTERN);
  if (!m || !m[1]) return null;
  // Strip trailing punctuation / quotes.
  return m[1].trim().replace(/[.,;:'"`]+$/, '').trim() || null;
}

/**
 * Run the gate. Caller must respect block=true and skip create.
 */
export async function gateOpenItemCreate(input: GateInput): Promise<GateOutput> {
  // 1) Private-contact filter.
  if (input.sourceFeedEventId) {
    try {
      const event = await prisma.feedEvent.findUnique({
        where: { id: input.sourceFeedEventId },
        select: { senderEmail: true, senderPhone: true },
      });
      if (event && (event.senderEmail || event.senderPhone)) {
        const { getBrainMutedSenders } = await import('../knowledge/brainMuteService');
        const muted = await getBrainMutedSenders(input.clientNumber, input.userId);
        const email = (event.senderEmail ?? '').toLowerCase();
        const phone = (event.senderPhone ?? '').replace(/[^\d+]/g, '');
        const isMuted =
          (email && muted.emails.has(email)) ||
          (phone && muted.phones.has(phone));
        if (isMuted) {
          return {
            block: true,
            reason: 'Source sender is a Private contact — Brain skips open-item creation for muted senders.',
            status: 'NEW',
            delegateeId: null, delegateeName: null, delegateeEmail: null,
            missingSlots: [],
          };
        }
      }
    } catch { /* tolerate — if we can't check, fall through to create */ }
  }

  // 1b) User auto-create settings — Settings → Open Items.
  //   - Per-source toggle (email / WhatsApp / voice): when off, Brain
  //     still detected the item but the user has asked us not to
  //     create live rows from this source. Caller is expected to park
  //     it as a Day Brief suggestion instead.
  //   - Criticality floor: when the priority is below the floor, same
  //     treatment — block the live create, surface as a suggestion.
  // Block path returns a structured reason so the caller can route
  // to the right surface (Day Brief suggestion queue) instead of
  // silently dropping.
  if (input.sourceFeedEventId) {
    try {
      const event = await prisma.feedEvent.findUnique({
        where: { id: input.sourceFeedEventId },
        select: { sourceType: true },
      });
      const { getOpenItemsSettings, sourceToggleKey, meetsCriticalityFloor } =
        await import('./openItemsSettings');
      const settings = await getOpenItemsSettings(input.userId);
      const key = sourceToggleKey(event?.sourceType ?? null);
      if (key && settings[key] === false) {
        return {
          block: true,
          reason: `Auto-create from ${event?.sourceType} disabled in Settings → Open Items.`,
          status: 'NEW',
          delegateeId: null, delegateeName: null, delegateeEmail: null,
          missingSlots: [],
        };
      }
      if (!meetsCriticalityFloor(input.priority ?? null, settings.autoCreateCriticalityFloor)) {
        return {
          block: true,
          reason: `Priority below the auto-create floor (${settings.autoCreateCriticalityFloor}) in Settings → Open Items.`,
          status: 'NEW',
          delegateeId: null, delegateeName: null, delegateeEmail: null,
          missingSlots: [],
        };
      }
    } catch { /* fall through — never break create on a settings lookup */ }
  }

  // 1c) Dedup — exact then semantic. Block create when we find a
  // still-open item that's clearly the same loop.
  //
  // Exact layer: (userId, sourceFeed, sourceRef) — catches double-fire
  // from webhook + poll races / real-time + backfill chains. Cheap DB
  // query, no LLM.
  //
  // Semantic layer: structural pre-filter (Jaccard ≥ 0.2 on title
  // tokens against last 50 open items) gates an LLM judgement on
  // whether the new item closes the same loop as one of the
  // candidates. Per [[feedback_no_hardcoded_judgement]] the actual
  // "is this the same loop?" decision is LLM-with-context; the
  // Jaccard is structural pre-filter only.
  //
  // skipDedupCheck on the input bypasses BOTH layers — used when the
  // user has explicitly confirmed they want a duplicate (e.g. UI
  // create after a warning).
  if (!input.skipDedupCheck) {
    try {
      const { findExactDuplicate, findSemanticDuplicate } =
        await import('./semanticDedupService');

      const exact = await findExactDuplicate({
        userId: input.userId,
        sourceFeed: input.sourceFeed ?? null,
        sourceRef: input.sourceRef ?? null,
      });
      if (exact) {
        return {
          block: true,
          reason: exact.reason,
          duplicateOfId: exact.itemId,
          status: 'NEW',
          delegateeId: null, delegateeName: null, delegateeEmail: null,
          missingSlots: [],
        };
      }

      const semantic = await findSemanticDuplicate({
        userId: input.userId,
        clientNumber: input.clientNumber,
        newTitle: input.title,
        newDescription: input.description ?? null,
        newDelegateeName: input.delegateeName ?? null,
        newDelegateeEmail: input.delegateeEmail ?? null,
      });
      if (semantic) {
        return {
          block: true,
          reason: semantic.reason,
          duplicateOfId: semantic.itemId,
          status: 'NEW',
          delegateeId: null, delegateeName: null, delegateeEmail: null,
          missingSlots: [],
        };
      }
    } catch { /* fall through — dedup failure must never break create */ }
  }

  // 2) Delegation normalisation.
  let delegateeId = input.delegateeId ?? null;
  let delegateeName = input.delegateeName ?? null;
  let delegateeEmail = input.delegateeEmail ?? null;

  // If caller didn't pass a delegatee, try the description.
  if (!delegateeName && !delegateeEmail && !delegateeId) {
    const parsed = parseDelegateeFromDescription(input.description ?? null);
    if (parsed) delegateeName = parsed;
  }

  // DEF-109 — "delegate this to brain" / "this item is for you" must PERSIST.
  //
  // On 2026-08-10 the owner said "this actionable item is for you delegated to
  // brain". Brain replied "Understood, Sir. I've updated the item" and stored
  // nothing: both delegatee fields stayed null, because "brain" is not a person
  // and had nowhere to land. Canonicalising here means the instruction survives
  // as a real stored value, which is what makes isBrainOwned() work downstream.
  const { canonicaliseDelegateeName, isBrainOwnerName } = await import('./brainOwnership');
  if (delegateeName && isBrainOwnerName(delegateeName)) {
    delegateeName = canonicaliseDelegateeName(delegateeName);
    // Brain has no mailbox. An address here would make isBrainOwned() treat the
    // item as a person's and put it back on the chase path.
    delegateeEmail = null;
    delegateeId = null;
  }

  const hasDelegation = !!(delegateeId || delegateeName || delegateeEmail);

  // Resolve delegateeId from delegateeEmail when possible (so the
  // Delegated filter can join on user id when the delegatee is an
  // internal user). Best-effort; missing match is fine for external
  // delegatees.
  if (!delegateeId && delegateeEmail) {
    try {
      const u = await prisma.user.findFirst({
        where: { clientNumber: input.clientNumber, email: delegateeEmail.toLowerCase() },
        select: { id: true },
      });
      if (u) delegateeId = u.id;
    } catch { /* ignore */ }
  }

  // 3) DRAFT routing — per user 2026-05-14: every open item should
  // have priority AND deadline; if either is missing the item is
  // PARKED as DRAFT and Brain asks via WhatsApp once a day for 5
  // days, warns on day 5, expires day 6.
  //
  // Delegation takes precedence over DRAFT — if it's delegated we
  // don't need a priority/due-date from the user; the delegatee
  // resolves the item. Only non-delegated items can be DRAFT.
  const missingSlots: Array<'priority' | 'dueDate'> = [];
  if (!input.priority) missingSlots.push('priority');
  if (!input.dueDate) missingSlots.push('dueDate');

  if (hasDelegation) {
    return {
      block: false,
      status: 'DELEGATED',
      delegateeId, delegateeName, delegateeEmail,
      missingSlots: [],
    };
  }

  if (missingSlots.length > 0) {
    return {
      block: false,
      status: 'DRAFT',
      delegateeId: null, delegateeName: null, delegateeEmail: null,
      missingSlots,
    };
  }

  return {
    block: false,
    status: 'NEW',
    delegateeId, delegateeName, delegateeEmail,
    missingSlots: [],
  };
}
