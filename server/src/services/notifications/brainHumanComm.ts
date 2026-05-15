/**
 * brainHumanComm — Brain↔user WhatsApp voice helpers.
 *
 * Per user 2026-05-15: "communication of brain with user on whatsapp,
 * it should be very smart, intelligent and humanly interaction, user
 * shouldnt feel that he is talking to any program".
 *
 * What this provides:
 *
 *   1) phraseFor(...) — picks a template variant from a small set so
 *      the user doesn't see byte-identical phrasing day after day.
 *      Variation is deterministic per (kind, item-id, day) so the
 *      same item gets the same phrasing within a day but a different
 *      one tomorrow — feels alive, not random.
 *
 *   2) addressUser(user) — returns a first-name greeting (Basit) when
 *      the persona has one, empty string otherwise. Used at message
 *      start. Avoids the "Hey," opener every time.
 *
 *   3) signOff(kind) — context-appropriate closing. Different for
 *      asks ("just reply with the answer"), nudges (nothing — the
 *      colleague's reply IS the closing), brief delivery ("anything
 *      you want me to drill into?").
 *
 *   4) rememberPending(userId, pending) / fetchPending(userId) —
 *      Redis-backed short-term memory of "the last thing Brain asked
 *      or suggested via WhatsApp". So when the user replies "do it"
 *      / "yes" / "go ahead", the inbound parser can look up what
 *      "it" refers to.
 *
 * Brain-rule: no fixed regex panel for tone classification. The
 * variants are written by hand to sound human; the LLM isn't called
 * just to vary phrasing (would be cost without value). Picking
 * which variant is structural plumbing keyed on (kind, item, day).
 */
import prisma from '../../db/prisma';
import { getRedis } from '../../utils/redisClient';

export type PendingKind =
  | 'open_item_draft_ask'         // Brain asked the user for priority/deadline
  | 'open_item_internal_nudge'    // Brain asked an internal delegatee about progress
  | 'open_item_owner_chase'       // Brain asked the owner to chase an external delegatee
  | 'open_item_dedup_prompt'      // Brain asked "add as checklist to existing X?"
  | 'day_brief';                  // Brain delivered the day brief, user is replying about it

export interface PendingContext {
  kind: PendingKind;
  /** The artifact id this pending message refers to (open_item_id,
   *  feed_event_id, brief_id, etc.). Inbound parser uses this to act. */
  refId: string;
  /** Human-readable label, used when echoing back ("doing 'Revisit
   *  Phoenix pricing' now"). */
  refTitle?: string;
  /** Free-form metadata the parser may need (e.g. delegateeId for a
   *  nudge prompt, missingSlots[] for a draft ask). */
  meta?: Record<string, unknown>;
  /** When this pending lapses — typically 24h from creation. */
  expiresAt: string;
}

const PENDING_TTL_SECONDS = 24 * 60 * 60;

/** Pick a deterministic-but-rotating index across N variants. The
 *  "day" component changes once per UTC day so the same item gets a
 *  different phrasing tomorrow without being random. Hash the
 *  combination so adjacent items don't share the same variant. */
function pickVariant(kind: string, itemKey: string, dayOffset = 0, n = 3): number {
  const day = Math.floor(Date.now() / (24 * 60 * 60 * 1000)) + dayOffset;
  const s = `${kind}::${itemKey}::${day}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** First-name addressee when available; otherwise empty. Brain's
 *  persona service stores userFirstName on the persona record. */
export async function addressUser(userId: number): Promise<string> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    if (!u?.name) return '';
    const first = u.name.split(/\s+/)[0];
    return first || '';
  } catch {
    return '';
  }
}

/** Compose a draft-ask body with variation. Days 0-3 are casual
 *  asks; day 4 picks up urgency; day 5 is the explicit warning. */
export function phraseDraftAsk(args: {
  userFirstName: string;
  itemTitle: string;
  missingSlots: Array<'priority' | 'dueDate'>;
  dayIndex: number;
  itemId: string;
}): string {
  const { userFirstName, itemTitle, missingSlots, dayIndex, itemId } = args;
  const both = missingSlots.includes('priority') && missingSlots.includes('dueDate');
  const slotPhrase = both
    ? 'a priority and a deadline'
    : missingSlots.includes('priority') ? 'a priority' : 'a deadline';

  const greet = userFirstName ? `${userFirstName}, ` : '';
  const warn = dayIndex === 5;

  if (warn) {
    return [
      `${greet}last call on this one — I still need ${slotPhrase} for:`,
      `"${itemTitle}"`,
      `If I don't hear today, I'll let it drop. Reply with the priority (critical / high / medium / low) and/or a date, or "skip" to drop it.`,
    ].join('\n\n');
  }

  // Days 0-4: rotate among 3 variants per day so daily nudges don't
  // feel identical to yesterday's.
  const variant = pickVariant('draft_ask', itemId, 0, 3);
  const leads = [
    `${greet}quick one — what ${slotPhrase} should I put on this?\n\n"${itemTitle}"`,
    `${greet}still tracking this one — could I get ${slotPhrase}?\n\n"${itemTitle}"`,
    `${greet}haven't pinned this down yet — ${slotPhrase}?\n\n"${itemTitle}"`,
  ];
  const tails = [
    `Reply with whatever fits (e.g. "high tomorrow 5pm") or "skip" to drop it.`,
    `Just reply with the answer — date phrases like "Friday" or "next week" work.`,
    `Either format is fine — "high", "Fri 6pm", or "skip" to drop.`,
  ];
  return `${leads[variant]}\n\n${tails[variant]}`;
}

/** Internal-delegatee nudge wording. The colleague is a Nexeo user;
 *  Brain is speaking on the owner's behalf, identified clearly so
 *  there's no impersonation. */
export function phraseInternalNudge(args: {
  delegateeFirstName: string;
  ownerFirstName: string;
  itemTitle: string;
  ageDays: number;
  itemId: string;
}): string {
  const { delegateeFirstName, ownerFirstName, itemTitle, ageDays, itemId } = args;
  const greet = delegateeFirstName ? `Hey ${delegateeFirstName}, ` : 'Hey, ';
  const aged = ageDays === 1 ? '1 day' : `${ageDays} days`;
  const onBehalf = ownerFirstName ? `${ownerFirstName} asked me to check in` : 'a quick check-in';
  const variant = pickVariant('internal_nudge', itemId, 0, 3);
  const variants = [
    `${greet}${onBehalf} on this — any update?\n\n"${itemTitle}"\n\nIt's been open for ${aged}.`,
    `${greet}${onBehalf}: where are we with "${itemTitle}"? It's been ${aged} now.`,
    `${greet}wanted to bump this one — "${itemTitle}" has been open ${aged}. Anything to share?`,
  ];
  return variants[variant];
}

/** Owner-chase prompt when delegatee is external (Brain can't ping
 *  them directly per the never-speaks-as-user rule). */
export function phraseOwnerChase(args: {
  userFirstName: string;
  delegateeName: string;
  itemTitle: string;
  ageDays: number;
  itemId: string;
}): string {
  const { userFirstName, delegateeName, itemTitle, ageDays, itemId } = args;
  const greet = userFirstName ? `${userFirstName}, ` : '';
  const aged = ageDays === 1 ? '1 day' : `${ageDays} days`;
  const variant = pickVariant('owner_chase', itemId, 0, 3);
  const variants = [
    `${greet}${delegateeName} hasn't moved on this in ${aged}:\n\n"${itemTitle}"\n\nWant me to draft you a quick follow-up to send them?`,
    `${greet}heads up — "${itemTitle}" with ${delegateeName} has been quiet for ${aged}. Should I draft a nudge?`,
    `${greet}${delegateeName} still hasn't responded on "${itemTitle}" (${aged} now). Send a nudge?`,
  ];
  return variants[variant];
}

/** Store a pending context so the inbound WhatsApp parser knows what
 *  "do it" / "yes" / "go ahead" refers to. TTL 24h. */
export async function rememberPending(userId: number, pending: Omit<PendingContext, 'expiresAt'>): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const expiresAt = new Date(Date.now() + PENDING_TTL_SECONDS * 1000).toISOString();
  const full: PendingContext = { ...pending, expiresAt };
  try {
    // Single key, latest-pending only. Earlier pending is overwritten.
    // If the user has multiple Brain asks open, the most recent is the
    // one a bare "do it" reply resolves against — which matches user
    // expectations (replies to the most recent thing).
    await redis.set(`wa_brain_pending:${userId}`, JSON.stringify(full), 'EX', PENDING_TTL_SECONDS);
  } catch { /* non-critical — Brain still works, just no continuity */ }
}

export async function fetchPending(userId: number): Promise<PendingContext | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(`wa_brain_pending:${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingContext;
    // Belt-and-braces: even with Redis TTL, double-check expiry in case
    // a clock skew or serialised state outlasts the key.
    if (new Date(parsed.expiresAt).getTime() < Date.now()) return null;
    return parsed;
  } catch { return null; }
}

export async function clearPending(userId: number): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try { await redis.del(`wa_brain_pending:${userId}`); } catch { /* fine */ }
}

/**
 * Resolve a user's reply against the most recent pending context.
 * Returns null if no pending OR the reply isn't an obvious resolution
 * of one. Doesn't try to interpret content (priority parsing etc.) —
 * that lives in the per-kind handler. Just answers: "does this reply
 * mean 'act on the pending one'?"
 *
 * Affirmative phrases (English + Roman Urdu): "yes", "yeah", "ok",
 * "do it", "go ahead", "go", "go for it", "let's do it", "haan", "ji",
 * "theek hai", "thik hai", "bilkul", "yup", "yep", "sure", "carry on",
 * "send", "send it", "yes please", "yes proceed", "proceed", "confirm".
 *
 * Negative phrases (treat as drop/skip): "no", "nah", "skip", "drop",
 * "cancel", "stop", "not now", "later", "nahi", "nai", "nahin", "rok".
 *
 * NEITHER = null (caller treats as fresh message, not a resolution).
 */
const AFFIRM_RE = /^\s*(yes\b|yeah\b|yep\b|yup\b|ok\b|okay\b|do it\b|go ahead\b|go\b|go for it\b|let'?s do it\b|haan\b|jee\b|ji\b|theek hai\b|thik hai\b|bilkul\b|sure\b|carry on\b|send\b|send it\b|proceed\b|confirm\b|please proceed\b|yes please\b)/i;
const NEGATE_RE = /^\s*(no\b|nah\b|skip\b|drop\b|cancel\b|stop\b|not now\b|later\b|nahi\b|nai\b|nahin\b|rok\b)/i;

export function classifyReplyToPending(text: string): 'affirm' | 'negate' | 'other' {
  if (AFFIRM_RE.test(text)) return 'affirm';
  if (NEGATE_RE.test(text)) return 'negate';
  return 'other';
}
