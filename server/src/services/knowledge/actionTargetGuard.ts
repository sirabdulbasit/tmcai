/**
 * actionTargetGuard — the "ground-or-ask" guard (Pillar 2, 2026-07-10).
 *
 * Basit: "fix brain permanently, don't want to follow error or each bug."
 *
 * Every reported bug shares one disease: when the brain can't ground a
 * TARGET (who to message, which contact, which record) it GUESSES —
 * substitutes the nearest contact, sends to a stale address, mutates the
 * wrong row. Per-verb code already resolves candidateIds, but the
 * guarantee was scattered across a dozen call sites; a new action type or
 * a missed path could silently substitute again (exactly how "ask status
 * of EXIM" reached the wrong person before the owner-routing fix).
 *
 * This module makes the guarantee STRUCTURAL and CENTRAL:
 *   - TARGET_MANIFEST declares, for every action that touches a human or
 *     a specific record, which slots are targets and how each is grounded.
 *   - verifyActionTargets() resolves each target against the DB, scoped to
 *     (userId, clientNumber). If a required target can't be grounded it
 *     returns { ok:false, marker } — the caller fails closed to an ask,
 *     NEVER dispatches.
 *   - The manifest is the single source of truth; an invariant test
 *     asserts every targeting ComposedAction type is declared here, so a
 *     newly-added action can't skip grounding by omission.
 *
 * Accept-conditions MIRROR each verb's existing dispatch logic exactly —
 * the guard can only ever AGREE with what the verb would already accept
 * (candidateId resolves, or a valid ad-hoc email/phone). It therefore
 * cannot falsely block a send the verb would have made; it only catches
 * the case a verb's own resolution would ALSO have rejected, and converts
 * the scattered bracketed errors into one consistent ground-or-ask gate.
 */
import prisma from '../../db/prisma';

export type TargetVerdict = { ok: true } | { ok: false; marker: string };

/** Action kinds that dispatch to a human or mutate a specific record.
 *  Everything NOT here (add_open_item, set_brain_name, record_preference)
 *  creates fresh state or has no external target — no substitution risk. */
export const TARGETING_ACTION_KINDS = [
  'notify_via_whatsapp',
  'send_email',
  'schedule_meeting',
  'delegate_open_item',
  'cancel_meeting',
  'reschedule_meeting',
  'update_open_item',
  'mark_open_item_done',
  'set_contact_scope',
  'mark_contact_inactive',
  'update_contact',
  'archive_wiki_page',
  'delete_wiki_page',
] as const;

export type TargetingActionKind = typeof TARGETING_ACTION_KINDS[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(s: unknown): boolean {
  return typeof s === 'string' && EMAIL_RE.test(s.trim());
}
function validPhone(s: unknown): boolean {
  if (typeof s !== 'string') return false;
  const cleaned = s.replace(/[\s\-()]/g, '');
  return /^\+?\d{10,15}$/.test(cleaned);
}

async function candidateResolves(id: unknown, userId: number, clientNumber: string): Promise<boolean> {
  if (typeof id !== 'string' || !id.trim()) return false;
  const { resolveCandidate } = await import('./candidateResolver');
  const r = await resolveCandidate(id.trim(), userId, clientNumber).catch(() => null);
  return r !== null;
}

async function openItemExists(id: unknown, userId: number, clientNumber: string): Promise<boolean> {
  if (typeof id !== 'string' || !id.trim()) return false;
  const row = await prisma.openItem.findFirst({
    where: { id: id.trim(), clientNumber, userId },
    select: { id: true },
  }).catch(() => null);
  return row !== null;
}

/**
 * Verify every target slot for an action grounds to a real record.
 * `slots` is the raw payload/slots object (same field names as the
 * ComposedAction). Returns ok, or a bracketed marker naming what
 * couldn't be grounded (answerSanitizer renders it human).
 */
export async function verifyActionTargets(
  actionKind: string,
  slots: Record<string, unknown>,
  userId: number,
  clientNumber: string,
): Promise<TargetVerdict> {
  const s = slots ?? {};
  const ask = (what: string): TargetVerdict => ({ ok: false, marker: `[target unresolved: ${what}]` });

  switch (actionKind) {
    case 'notify_via_whatsapp': {
      if (validPhone(s.recipientAdHocPhone)) return { ok: true };
      if (await candidateResolves(s.recipientCandidateId, userId, clientNumber)) return { ok: true };
      return ask('the WhatsApp recipient — name the exact contact or give a valid number');
    }
    case 'send_email': {
      const toIds = Array.isArray(s.toCandidateIds) ? s.toCandidateIds : [];
      const adHoc = Array.isArray(s.toAdHoc) ? s.toAdHoc : [];
      if (adHoc.some(validEmail)) return { ok: true };
      for (const id of toIds) {
        if (await candidateResolves(id, userId, clientNumber)) return { ok: true };
      }
      return ask('the email recipient — name the exact contact or give a valid email');
    }
    case 'schedule_meeting': {
      const ids = Array.isArray(s.attendeeCandidateIds) ? s.attendeeCandidateIds : [];
      const adHoc = Array.isArray(s.attendeeAdHocEmails) ? s.attendeeAdHocEmails : [];
      if (adHoc.some(validEmail)) return { ok: true };
      for (const id of ids) {
        if (await candidateResolves(id, userId, clientNumber)) return { ok: true };
      }
      return ask('the meeting attendee — name the exact contact or give a valid email');
    }
    case 'delegate_open_item': {
      if (!(await openItemExists(s.openItemId, userId, clientNumber))) {
        return ask('the open item to delegate — the reference is stale, name it again');
      }
      if (validEmail(s.delegateeAdHocEmail)) return { ok: true };
      if (await candidateResolves(s.delegateeCandidateId, userId, clientNumber)) return { ok: true };
      return ask('who to delegate to — name the exact contact or give a valid email');
    }
    // DEF-048 (2026-08-05): add_open_item may carry a delegatee ("ask Hamna
    // whether she's coming tomorrow"). A plain item needs no target and is
    // always allowed; one addressed to somebody must ground that person by the
    // same rule as delegate_open_item, so an unreachable ask is refused up
    // front rather than silently creating an item nobody will ever answer.
    case 'add_open_item': {
      const addressed = s.delegateeCandidateId != null || s.delegateeAdHocEmail != null;
      if (!addressed) return { ok: true };
      if (validEmail(s.delegateeAdHocEmail)) return { ok: true };
      if (await candidateResolves(s.delegateeCandidateId, userId, clientNumber)) return { ok: true };
      return ask('who to ask — name the exact contact or give a valid email');
    }
    case 'set_contact_scope':
    case 'mark_contact_inactive':
    case 'update_contact': {
      if (await candidateResolves(s.contactCandidateId, userId, clientNumber)) return { ok: true };
      return ask('which contact — name the exact person');
    }
    case 'update_open_item':
    case 'mark_open_item_done': {
      if (await openItemExists(s.openItemId, userId, clientNumber)) return { ok: true };
      return ask('which open item — the reference is stale, name it again');
    }
    case 'cancel_meeting':
    case 'reschedule_meeting': {
      // eventId is sourced from the artifacts block, not a candidate pool,
      // so substitution risk is low; require it be present + non-empty.
      // Full existence check happens in dispatch (findEventById) where a
      // real read is already performed.
      if (typeof s.eventId === 'string' && s.eventId.trim()) return { ok: true };
      return ask('which meeting — I need the event reference');
    }
    case 'archive_wiki_page':
    case 'delete_wiki_page': {
      if (typeof s.wikiPageId === 'string' && s.wikiPageId.trim()) return { ok: true };
      return ask('which page — I need the page reference');
    }
    default:
      // Non-targeting action (add_open_item, set_brain_name,
      // record_preference) — nothing to ground.
      return { ok: true };
  }
}
