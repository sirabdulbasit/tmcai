/**
 * Sender Quality Filter — decides whether an inbound sender should be
 * promoted into the user's Contacts list (an `entity_person` wiki page).
 *
 * Without this filter, every newsletter / no-reply / tracking-token
 * sender becomes a permanent contact. We had 515 contacts mostly noise
 * (anthropic <no-reply-dtdehyonk_nsh2a9k_h-da>, etc.). After the filter,
 * only senders that look like a real human or a stable business address
 * make it through.
 *
 * Two-pass design:
 *   1. isLikelyAutomated(email) — pattern match against well-known
 *      no-reply / notification / bounce / newsletter forms. Hard reject
 *      regardless of frequency.
 *   2. shouldCreateContact(input) — for senders that pass pass 1,
 *      check signal strength (sent-to history, frequency, manual
 *      flag). Returns 'create' / 'provisional' / 'skip'.
 *
 * Manual additions (+ Add contact, Google/Outlook import) bypass both
 * passes — explicit user intent always wins.
 */

// ─── Pattern reject ─────────────────────────────────────────────────

// Local-part exact matches (case-insensitive). These are universal
// patterns across email infrastructure where ZERO real humans use the
// address day-to-day. NOT included: 'support', 'help' — many small
// businesses use these for shared mailboxes where a real human signs
// off (e.g. "Henry @ Reclaim <support@reclaim.ai>"). Auto-rejecting
// them would lose real contacts. Vendor support noise can be cleaned
// up via the cleanup script if needed.
const REJECT_LOCAL_EXACT = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'do_not_reply',
  'mailer-daemon', 'mailerdaemon', 'postmaster',
  'bounce', 'bounces',
  'notifications', 'notification', 'notify',
  'alerts', 'alert',
  'news', 'newsletter', 'digest', 'marketing',
  'delivery', 'delivered', 'mailer', 'mail',
  'updates', 'update',
  'system', 'root',
]);

// Local-part PREFIXES that indicate auto-generated tracking addresses.
// e.g. "no-reply-dtdehyonk_nsh2a9k_h-da" from Anthropic newsletters.
const REJECT_LOCAL_PREFIX = [
  'no-reply-', 'noreply-', 'donotreply-', 'do-not-reply-',
  'newsletter-', 'news-', 'digest-', 'marketing-',
  'notification-', 'notifications-', 'notify-',
  'bounce-', 'bounces-',
  'mailer-', 'delivery-',
];

// Token-y local parts: ≥ 12 chars long AND ≥ 3 digits (real names
// almost never have 3+ digits in their email local part). Catches
// per-message tracking IDs without false-positiving on long names like
// "mohtashimjangda" or "aaddministration".
const TOKEN_REGEX = /^(?=(?:[^0-9]*[0-9]){3,})[a-z0-9]{12,}([_-][a-z0-9]+){0,3}$/i;

// Same-pattern endings — some providers use `<word>-noreply` or
// `<word>.no-reply` as the local part.
const REJECT_LOCAL_SUFFIX = [
  '-noreply', '-no-reply', '-donotreply', '-do-not-reply',
  '.noreply', '.no-reply',
];

export function isLikelyAutomated(email: string | null | undefined): boolean {
  if (!email) return false;
  // Some entity_person rows store the email as the full RFC2822 form
  // ("Anthropic <no-reply-xyz@mail.anthropic.com>") — strip everything
  // outside the angle brackets first, then any leading "Name " prefix.
  // Without this, prefix matches like 'no-reply-' fail because the
  // local-part is read as "<no-reply-xyz".
  let raw = String(email).trim().toLowerCase();
  const angle = raw.match(/<([^>]+@[^>]+)>/);
  if (angle) raw = angle[1]!.trim();
  const e = raw;
  if (!e.includes('@')) return false;
  const local = e.split('@')[0]!;

  if (REJECT_LOCAL_EXACT.has(local)) return true;
  for (const p of REJECT_LOCAL_PREFIX) if (local.startsWith(p)) return true;
  for (const s of REJECT_LOCAL_SUFFIX) if (local.endsWith(s)) return true;

  // Token-only local part (no recognisable name structure)
  if (TOKEN_REGEX.test(local) && !/^[a-z]+\.[a-z]+$/.test(local)) return true;

  // Names with high underscore/hyphen entropy and base64-like chunks
  // ("dtdehyonk_nsh2a9k_h-da" — 3+ separator-divided alphanum tokens
  // each ≥ 5 chars with mixed letters+digits)
  const parts = local.split(/[_-]/);
  if (parts.length >= 3) {
    const tokenLooking = parts.filter(
      (p) => p.length >= 5 && /[0-9]/.test(p) && /[a-z]/.test(p),
    ).length;
    if (tokenLooking >= 2) return true;
  }

  return false;
}

// ─── Signal-based gate (pass 2) ─────────────────────────────────────

export interface ContactDecisionInput {
  email: string | null;
  /** User's own domain — same-domain senders auto-accept */
  userDomain?: string | null;
  /** Has the user replied to this sender ever? */
  hasOutbound?: boolean;
  /** Total inbound messages from this sender (lifetime) */
  inboundCount?: number;
  /** Did this sender appear as a calendar attendee at a meeting the
   *  user attended? */
  isCalendarAttendee?: boolean;
  /** WhatsApp inbound senders are always treated as personal contacts */
  isWhatsApp?: boolean;
  /** Source channel — 'manual' / 'google_import' / 'microsoft_import'
   *  bypass all pattern + signal checks */
  importSource?: string;
}

export type ContactDecision = 'create' | 'skip';

/**
 * Decide whether a sender should be promoted to a contact.
 *
 *   manual / imported     → create (user intent wins)
 *   isLikelyAutomated     → skip (junk pattern)
 *   user has sent to them → create (bidirectional)
 *   ≥ 3 inbound           → create (real correspondent)
 *   same domain as user   → create (likely teammate)
 *   calendar attendee     → create
 *   whatsapp              → create
 *   else                  → skip (low-signal, junk-suspicion)
 */
export function shouldCreateContact(input: ContactDecisionInput): ContactDecision {
  const importSrc = input.importSource ?? '';
  if (importSrc === 'manual' || importSrc.endsWith('_import')) {
    return 'create';
  }
  if (input.isWhatsApp) return 'create';

  if (isLikelyAutomated(input.email)) return 'skip';

  if (input.hasOutbound) return 'create';
  if ((input.inboundCount ?? 0) >= 3) return 'create';
  if (input.isCalendarAttendee) return 'create';

  if (input.email && input.userDomain) {
    const senderDomain = input.email.split('@')[1]?.toLowerCase();
    if (senderDomain && senderDomain === input.userDomain.toLowerCase()) return 'create';
  }

  return 'skip';
}
