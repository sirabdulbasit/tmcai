/**
 * MyOS — Open Item Quality Gate.
 *
 * The centralised "should this become an open item?" check.
 *
 * Why this exists: Brain ingests email/whatsapp/calendar firehose and used to
 * mint an open_item for every signal that wasn't pure noise. Result: 2,460
 * NEW items, 71 critical, mostly junk — and because every open item
 * triggers follow-up nudges (3d/7d/14d), the user got chased over rows
 * that should never have been on their plate.
 *
 * The gate rejects auto-creates that don't carry a real ASK. Manual
 * user-clicked creates (Day Brief delegate, "+ New Item", split) bypass the
 * gate — those are explicit user intent.
 *
 * Signals required (any one passes):
 *   1. Action verb in title (review/approve/send/decide/...)
 *   2. Question mark in title or body (someone is asking the user something)
 *   3. Explicit due date provided
 *   4. archetype === 'reply_needed' (caller already classified this as an ask)
 *
 * Hard rejects (override signals):
 *   - intent ∈ { FYI, NOISE, INFORMATION } from the feed classifier
 *   - confidence < floor (default 0.65)
 *   - title looks like an automated digest / newsletter
 *
 * The gate returns a structured reason so callers can log + analytics can
 * count rejections. Telemetry of WHY items are rejected is how we tune the
 * heuristics over time.
 */

const ACTION_VERBS = [
  'review', 'approve', 'reject', 'sign', 'send', 'reply', 'respond',
  'draft', 'decide', 'complete', 'finish', 'prepare', 'schedule', 'book',
  'call', 'follow up', 'follow-up', 'followup', 'check', 'verify', 'confirm',
  'investigate', 'look into', 'plan', 'write', 'deliver', 'ship', 'submit',
  'pay', 'invoice', 'process', 'fix', 'resolve', 'address', 'handle',
  'arrange', 'organise', 'organize', 'set up', 'setup', 'prepare', 'create',
  'update', 'release', 'publish', 'finalize', 'finalise', 'close',
];

const NEWSLETTER_HINTS = [
  'newsletter', 'digest', 'weekly recap', 'monthly recap', 'unsubscribe',
  'view in browser', 'no-reply', 'noreply',
];

// Title patterns that look critical because of keywords ("Critical Patch
// Update", "Security Advisory", "[Plaud-AutoFlow] X Crisis: …") but are
// actually vendor / automated reports — never genuinely actionable for the
// user. Match conservatively against the start of the title.
const VENDOR_BULLETIN_PREFIXES = [
  'security advisory', 'critical patch update', 'security alert',
  'security bulletin', 'patch tuesday', 'cve-', 'security update available',
  'service advisory', 'system advisory',
];

// Notification patterns — informational events that report state changes
// the user did NOT request action on. "Docusign password changed", "X
// approved your Y", "You have a new Z". The user wants to KNOW these
// happened, not work on them.
const NOTIFICATION_PATTERNS = [
  /\bpassword (was )?(changed|reset|updated)\b/i,
  /\b(was|has been) approved\b/i,
  /\b(was|has been) submitted\b/i,
  /\b(was|has been) (received|delivered|sent|completed)\b/i,
  /^you (have|received) (a |new )/i,
  /^(invitation|invite):\s/i,           // calendar invites — already on cal
  /\bsuccessfully (signed|signed up|registered|enrolled|completed)\b/i,
];

// Dashboard nags from automation tools — recurring "X off track" /
// "objectives need attention" / "report is ready" sweeps that fire from
// service accounts on a schedule.
const DASHBOARD_NAG_PATTERNS = [
  /\bobjectives? (need|requires?) attention\b/i,
  /\boff[- ]track\b/i,
  /\breport (is )?ready\b/i,
  /\bweekly (summary|update|status|standup|review)\b/i,
  /\bmonthly (summary|update|status|review)\b/i,
  /\bdaily (summary|update|status|standup)\b/i,
  /\bauto[- ]?(generated|flow|report)\b/i,
  /^\[(plaud|autoflow|metrics?|analytics|dashboard|kpi)/i,
];

// Sender local-parts that always indicate automated/system mail. Catches
// the "oracle-security-alerts@oracle.com", "no-reply-foo-12345@*",
// "billing-system@*" patterns the broader noreply test misses.
const AUTOMATED_SENDER_LOCAL_HINTS = [
  'security-alert', 'security-alerts', 'security-bulletin', 'advisory',
  'advisories', 'notify', 'notifier', 'alerts', 'alert',
  'system', 'systems', 'monitoring', 'monitor', 'auto-', 'automation',
  'cronjob', 'scheduler', 'pipeline',
];

export interface QualifyInput {
  /** Title destined for the open item */
  title: string;
  /** Optional body / description for deeper signal */
  body?: string;
  /** Optional due date — its presence alone is enough to accept */
  dueDate?: Date | null;
  /** Caller-classified archetype (executorHelpers.classifyArchetypeFromPayload) */
  archetype?: string | null;
  /** Caller-classified intent (feedIntelligenceService) */
  intent?: string | null;
  /** Caller's confidence in the classification (0..1) */
  confidence?: number;
  /** Caller-supplied minimum confidence floor; defaults to 0.65 */
  minConfidence?: number;
  /** Sender email (used to skip newsletters / noreply) */
  senderEmail?: string | null;
}

export type QualifyVerdict = 'accept' | 'reject';

export interface QualifyResult {
  verdict: QualifyVerdict;
  reason: string;
  /** Tag for telemetry / debugging — short stable code */
  code:
    | 'action_verb'
    | 'question'
    | 'due_date'
    | 'archetype_reply_needed'
    | 'no_signal'
    | 'fyi_intent'
    | 'low_confidence'
    | 'newsletter'
    | 'vendor_bulletin'
    | 'notification_only'
    | 'dashboard_nag'
    | 'automated_sender'
    | 'user_marked_wrong_pattern'
    | 'empty_title';
}

const QUESTION_RE = /\?\s*$/;

export function qualifyAutoOpenItem(input: QualifyInput): QualifyResult {
  const title = (input.title ?? '').trim();
  if (title.length < 4) {
    return { verdict: 'reject', reason: 'title is empty or too short', code: 'empty_title' };
  }

  // Hard reject: pure-info intents from the feed classifier should never
  // become open items. They go to the wiki only.
  const intent = (input.intent ?? '').toUpperCase();
  if (intent === 'FYI' || intent === 'NOISE' || intent === 'INFORMATION') {
    return { verdict: 'reject', reason: `intent=${intent} is not actionable`, code: 'fyi_intent' };
  }

  // Hard reject: low-confidence LLM extractions. Default floor 0.65 (was 0.35
  // for meeting commitments — too low, hence the noise).
  const floor = input.minConfidence ?? 0.65;
  if (typeof input.confidence === 'number' && input.confidence < floor) {
    return {
      verdict: 'reject',
      reason: `confidence ${input.confidence.toFixed(2)} < ${floor}`,
      code: 'low_confidence',
    };
  }

  // Hard reject: looks like a newsletter / automated digest.
  const blob = `${title} ${input.body ?? ''}`.toLowerCase();
  const sender = (input.senderEmail ?? '').toLowerCase();
  if (
    sender.includes('noreply') ||
    sender.includes('no-reply') ||
    NEWSLETTER_HINTS.some((h) => blob.includes(h))
  ) {
    return { verdict: 'reject', reason: 'looks like newsletter / no-reply', code: 'newsletter' };
  }

  // Hard reject: vendor security/service bulletin — Oracle Critical Patch
  // Update, Microsoft Security Advisory, generic CVE notices. These read
  // urgent ("Critical Patch Update — April 2026") but never need the
  // user to do anything; they're for IT to read.
  const titleLowerForPrefix = title.toLowerCase();
  if (VENDOR_BULLETIN_PREFIXES.some((p) => titleLowerForPrefix.startsWith(p))) {
    return { verdict: 'reject', reason: 'vendor security/service bulletin', code: 'vendor_bulletin' };
  }

  // Hard reject: notification-only state changes — "Docusign password
  // changed", "X was approved", "Invitation: ...". Informational, not
  // actionable. The user gets these in their inbox and that's enough.
  if (NOTIFICATION_PATTERNS.some((re) => re.test(title))) {
    return { verdict: 'reject', reason: 'notification (informational state change)', code: 'notification_only' };
  }

  // Hard reject: dashboard nags from automated tools — "VM:: 4 objectives
  // off track", "[Plaud-AutoFlow] Strategic Crisis", "Weekly summary".
  // These are scheduled outputs from internal automation, not asks.
  if (DASHBOARD_NAG_PATTERNS.some((re) => re.test(title))) {
    return { verdict: 'reject', reason: 'dashboard nag / automated report', code: 'dashboard_nag' };
  }

  // Hard reject: sender's local-part is a known automation pattern. Catches
  // oracle-security-alerts@*, monitoring@*, system@*. The earlier noreply
  // test only checked for that exact substring; this widens the net.
  const localPart = sender.includes('@') ? sender.split('@')[0] : sender;
  if (AUTOMATED_SENDER_LOCAL_HINTS.some((h) => localPart!.includes(h))) {
    return { verdict: 'reject', reason: `sender local-part matches automated pattern`, code: 'automated_sender' };
  }

  // Accept paths — any single signal lets it through.
  if (input.dueDate instanceof Date && !Number.isNaN(input.dueDate.getTime())) {
    return { verdict: 'accept', reason: 'has explicit due date', code: 'due_date' };
  }
  if (input.archetype === 'reply_needed') {
    return { verdict: 'accept', reason: 'archetype=reply_needed', code: 'archetype_reply_needed' };
  }
  const titleLower = title.toLowerCase();
  if (QUESTION_RE.test(title) || titleLower.includes('?')) {
    return { verdict: 'accept', reason: 'title contains a question', code: 'question' };
  }
  if (ACTION_VERBS.some((v) => titleLower.startsWith(`${v} `) || titleLower.includes(` ${v} `))) {
    return { verdict: 'accept', reason: 'action verb in title', code: 'action_verb' };
  }

  return {
    verdict: 'reject',
    reason: 'no action verb, no question, no due date, no reply_needed archetype',
    code: 'no_signal',
  };
}
