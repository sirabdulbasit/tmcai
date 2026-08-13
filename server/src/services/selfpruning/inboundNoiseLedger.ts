/**
 * C-3 increment 1 — count what we pushed at the owner, and how much of it he
 * ever touched.
 *
 * ── WHY A COUNTER IS THE FIRST INCREMENT ────────────────────────────────────
 *
 * CL-033: ten unactionable pushes from one unknown number in a single morning,
 * every one of which he had to read. The owner's words: *"A professional
 * assistant does not hand its principal ten copies of noise."*
 *
 * Self-Pruning scores 33 with `basis: absent` — nothing in this codebase can
 * currently answer "how much of what I sent you was worth sending?". Suppression
 * built before that number exists would be a guess dressed as a policy. So this
 * increment deliberately changes NO behaviour: it reads `brain_prompt_queue`,
 * the surface that actually reaches him, and produces the count.
 *
 * ── THE MEASUREMENT UNIT (corrected, Codex iteration-25 HIGH #1) ────────────
 *
 * The first version grouped by PRODUCER LABEL (`metadata.source`), so one due
 * nudge each for five different items read as one five-push "burst" — and my
 * build entry claimed twenty pushes concerned "the same overdue item" on the
 * strength of three samples, which that key could not support. Producer label
 * is what SENT the push, not what it was ABOUT.
 *
 * The subject is now the actual item/thread identity the row carries — the
 * `openItemId` column, else the identity ids in metadata. A row with no
 * identity falls into an explicit LOW-CONFIDENCE bucket (`subjectExact:
 * false`): it is still counted, but the report says the grouping is by class
 * only, and increment 2 must not suppress from a class-level aggregate
 * (Codex directive #4).
 *
 * ── WHAT "REACHED" AND "ACTED" MEAN, EXACTLY ────────────────────────────────
 *
 *   REACHED = `sent_at` within the window. It went to a channel during the
 *   period the report claims to describe (HIGH #2: the first version windowed
 *   on `queuedAt`, so the heading said "what reached you" while the filter
 *   selected when internal work entered the queue).
 *
 *   ACTED = `answered_at IS NOT NULL`. He replied to it.
 *
 * **`ignored` is therefore an UPPER BOUND on what he actually disregarded, not
 * a measurement of it.** He can act without answering — do the thing himself,
 * or decide the answer is no. That overstatement is acceptable for finding a
 * BURST and is not acceptable as evidence about a single message; the rendered
 * report says so, because a number quoted without its definition is how
 * "43 of 76" became a fact nobody could check.
 *
 * A burst additionally requires DENSITY (Codex MEDIUM #4): volume without a
 * bounded span conflates three monthly notices with three pushes in five
 * minutes. The span bound is behaviorConfig-driven with a safe default.
 *
 * Read-only, and that is enforced by test: this module performs no writes.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('inbound-noise');

/** Default lookback. A working day plus the overnight before it. */
const DEFAULT_WINDOW_HOURS = 36;

/**
 * How many pushes about one subject inside the window make it burst-eligible.
 *
 * Three is deliberately low. CL-033 was ten, and a threshold tuned to ten would
 * only ever find the incident we already know about.
 */
const BURST_THRESHOLD = 3;

/** Fallback for the burst's maximum span when behaviorConfig is unreachable:
 *  one day. Three unanswered pushes inside a day is a pattern; three across a
 *  month is a cadence. */
const DEFAULT_BURST_MAX_SPAN_MINUTES = 24 * 60;

/** Page size per query. */
const PAGE_SIZE = 500;

/** Absolute ceiling across pages. Past this the summary is TRUNCATED and says
 *  so — a silently capped count understates noise for exactly the high-volume
 *  owner the counter exists to protect (Codex MEDIUM #3). */
const HARD_ROW_CAP = 5000;

export interface NoiseGroup {
  /** Who or what generated the pushes. A phone/LID for counterpart replies,
   *  else the producing subsystem. */
  senderKey: string;
  /** What the pushes were ABOUT: `item:<id>` / `thread:<id>` / `event:<id>`
   *  when the row carries identity, else `class:<producer label>`. */
  subjectKey: string;
  /** True when `subjectKey` is a real identity. False = the low-confidence
   *  bucket: grouped by producer class only, because the rows carry no id.
   *  Suppression must never act on a `false` group's aggregate. */
  subjectExact: boolean;
  /** The producer label, kept for display either way. */
  subjectClass: string;
  /** Pushes delivered in the window. */
  reached: number;
  /** Pushes he replied to. */
  acted: number;
  /** `reached - acted`. An UPPER BOUND — see the header. */
  ignored: number;
  /** `ignored / reached`, 0 when nothing reached him. */
  ignoredShare: number;
  firstAt: Date | null;
  lastAt: Date | null;
  /** Minutes from first to last DELIVERY, so a burst is described the way he
   *  experienced it. */
  spanMinutes: number | null;
  /** Volume AND disengagement AND density together. */
  burst: boolean;
  /** Up to three verbatim questions, so the report can quote rather than
   *  assert. Three samples never prove what the other N are about — the
   *  subject key does that now — they exist to make the count recognisable. */
  samples: string[];
}

export interface NoiseSummary {
  clientNumber: string;
  userId: number;
  windowHours: number;
  since: Date;
  until: Date;
  totalReached: number;
  totalActed: number;
  totalIgnored: number;
  /** True when HARD_ROW_CAP stopped the read early. Totals are then a floor,
   *  not a count, and the report says so. */
  truncated: boolean;
  /** The span bound used for burst classification, for the report. */
  burstMaxSpanMinutes: number;
  groups: NoiseGroup[];
  /** Groups over the burst threshold, worst first. */
  bursts: NoiseGroup[];
}

/** The sender, when the push came from a person; otherwise the subsystem. */
function senderKeyOf(metadata: Record<string, unknown>, sideEffect: Record<string, unknown>): string {
  const from = typeof metadata.from === 'string' ? metadata.from.trim() : '';
  if (from) return from;
  const source = typeof metadata.source === 'string' ? metadata.source.trim() : '';
  if (source) return `system:${source}`;
  const kind = typeof sideEffect.kind === 'string' ? sideEffect.kind.trim() : '';
  return kind ? `system:${kind}` : 'system:unclassified';
}

/** The producer label — what SENT the push. Display only; never the unit. */
function subjectClassOf(metadata: Record<string, unknown>, sideEffect: Record<string, unknown>): string {
  for (const v of [metadata.source, sideEffect.kind, metadata.tier]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'unclassified';
}

/**
 * What the push was ABOUT. The column first — it is a real foreign key — then
 * the identity ids production metadata actually carries (verified against live
 * rows: openItemId, threadId, eventId).
 */
function subjectKeyOf(
  openItemId: string | null,
  metadata: Record<string, unknown>,
  sideEffect: Record<string, unknown>,
): { subjectKey: string; subjectExact: true } | null {
  if (openItemId && openItemId.trim()) return { subjectKey: `item:${openItemId.trim()}`, subjectExact: true };
  for (const [prefix, key] of [
    ['item', 'openItemId'], ['thread', 'threadId'], ['event', 'eventId'],
  ] as const) {
    for (const bag of [metadata, sideEffect]) {
      const v = bag[key];
      if (typeof v === 'string' && v.trim()) return { subjectKey: `${prefix}:${v.trim()}`, subjectExact: true };
    }
  }
  return null;
}

/** The behaviorConfig-driven span bound, with a safe fallback. */
async function burstMaxSpanMinutes(clientNumber: string): Promise<number> {
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    const v = await getBehaviorValue('selfpruning.burst_max_span_minutes', { clientNumber });
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_BURST_MAX_SPAN_MINUTES;
  } catch { return DEFAULT_BURST_MAX_SPAN_MINUTES; }
}

/**
 * Count the pushes DELIVERED to this owner in the window, grouped by sender and
 * subject identity.
 *
 * Tenant- AND user-scoped in the query itself (invariant #1).
 */
export async function summariseInboundNoise(args: {
  clientNumber: string;
  userId: number;
  windowHours?: number;
  now?: Date;
}): Promise<NoiseSummary> {
  const windowHours = Math.max(1, args.windowHours ?? DEFAULT_WINDOW_HOURS);
  const until = args.now ?? new Date();
  const since = new Date(until.getTime() - windowHours * 60 * 60 * 1000);
  const maxSpan = await burstMaxSpanMinutes(args.clientNumber);

  type Row = {
    question: string | null; openItemId: string | null;
    metadata: unknown; sideEffect: unknown;
    sentAt: Date | null; answeredAt: Date | null;
  };

  // Paginated: a fixed take was a silent bias against exactly the high-volume
  // owner this exists for. Past HARD_ROW_CAP the summary says TRUNCATED rather
  // than pretending the floor is the count.
  const rows: Row[] = [];
  let truncated = false;
  for (let skip = 0; ; skip += PAGE_SIZE) {
    const page: Row[] = await prisma.brainPromptQueue.findMany({
      where: {
        clientNumber: args.clientNumber,
        userId: args.userId,
        // REACHED = delivered inside the window (HIGH #2: the event the report
        // claims to describe, not when work entered the queue).
        sentAt: { gte: since, lte: until },
      },
      select: {
        question: true, openItemId: true, metadata: true, sideEffect: true,
        sentAt: true, answeredAt: true,
      },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      skip,
      take: PAGE_SIZE,
    }).catch((e: any) => {
      // A read that failed is not "no noise". Returning [] would report a clean
      // inbox from a broken query (DEF-085).
      log.warn('noise ledger read failed', { clientNumber: args.clientNumber, error: e?.message });
      throw e;
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (rows.length >= HARD_ROW_CAP) { truncated = true; break; }
  }

  // Nested map — sender, then subject — so no delimiter exists to collide
  // (Codex LOW #5: `a␟b + c` vs `a + b␟c` merged under a joined string key).
  const bySender = new Map<string, Map<string, NoiseGroup>>();

  for (const r of rows) {
    const metadata = (r.metadata ?? {}) as Record<string, unknown>;
    const sideEffect = (r.sideEffect ?? {}) as Record<string, unknown>;
    const senderKey = senderKeyOf(metadata, sideEffect);
    const subjectClass = subjectClassOf(metadata, sideEffect);
    const identity = subjectKeyOf(r.openItemId, metadata, sideEffect);
    const subjectKey = identity?.subjectKey ?? `class:${subjectClass}`;
    const subjectExact = identity?.subjectExact ?? false;

    let subjects = bySender.get(senderKey);
    if (!subjects) { subjects = new Map(); bySender.set(senderKey, subjects); }
    let g = subjects.get(subjectKey);
    if (!g) {
      g = {
        senderKey, subjectKey, subjectExact, subjectClass,
        reached: 0, acted: 0, ignored: 0, ignoredShare: 0,
        firstAt: null, lastAt: null, spanMinutes: null,
        burst: false, samples: [],
      };
      subjects.set(subjectKey, g);
    }

    g.reached += 1;
    if (r.answeredAt) g.acted += 1;

    const at = r.sentAt; // non-null by the query; delivery time, per HIGH #2.
    if (at) {
      if (!g.firstAt || at < g.firstAt) g.firstAt = at;
      if (!g.lastAt || at > g.lastAt) g.lastAt = at;
    }
    if (g.samples.length < 3 && typeof r.question === 'string' && r.question.trim()) {
      g.samples.push(r.question.trim().slice(0, 200));
    }
  }

  const groups = [...bySender.values()].flatMap((m) => [...m.values()]).map((g) => {
    g.ignored = g.reached - g.acted;
    g.ignoredShare = g.reached > 0 ? g.ignored / g.reached : 0;
    g.spanMinutes = g.firstAt && g.lastAt
      ? Math.round((g.lastAt.getTime() - g.firstAt.getTime()) / 60000)
      : null;
    // Volume AND disengagement AND density. Five pushes he answered every time
    // are a working conversation; three unanswered notices a month apart are a
    // cadence, not a flood (MEDIUM #4).
    g.burst = g.reached >= BURST_THRESHOLD
      && g.ignored >= BURST_THRESHOLD
      && g.spanMinutes != null
      && g.spanMinutes <= maxSpan;
    return g;
  });

  groups.sort((a, b) => (b.ignored - a.ignored) || (b.reached - a.reached));

  return {
    clientNumber: args.clientNumber,
    userId: args.userId,
    windowHours,
    since,
    until,
    totalReached: groups.reduce((n, g) => n + g.reached, 0),
    totalActed: groups.reduce((n, g) => n + g.acted, 0),
    totalIgnored: groups.reduce((n, g) => n + g.ignored, 0),
    truncated,
    burstMaxSpanMinutes: maxSpan,
    groups,
    bursts: groups.filter((g) => g.burst),
  };
}

/**
 * The report, for quoting back to the owner. Carries its own definitions —
 * `ignored` is an upper bound and the reader has to know that to judge the
 * figure at all.
 */
export function renderNoiseReport(s: NoiseSummary): string {
  const lines: string[] = [];
  lines.push(`# Inbound noise — last ${s.windowHours}h (${s.since.toISOString().slice(0, 16).replace('T', ' ')} to ${s.until.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  lines.push('');
  lines.push(`Pushes delivered to you: ${s.totalReached}. You replied to ${s.totalActed}.`);
  if (s.truncated) {
    lines.push('');
    lines.push(`⚠ TRUNCATED at ${HARD_ROW_CAP} rows — these totals are a FLOOR, not a count.`);
  }
  lines.push('');
  lines.push('"Delivered" = sent to a channel inside this window. "Replied to" = you answered'
    + ' it. Anything else counts as unanswered below, which OVERSTATES what you disregarded:'
    + ' acting without replying — doing it yourself, or deciding no — looks identical here.');

  if (s.totalReached === 0) {
    lines.push('');
    lines.push('Nothing reached you in this window.');
    return lines.join('\n');
  }

  if (s.bursts.length === 0) {
    lines.push('');
    lines.push(`No subject got ${BURST_THRESHOLD}+ unanswered pushes inside ${s.burstMaxSpanMinutes} minutes.`);
  } else {
    lines.push('');
    lines.push(`## Bursts (${BURST_THRESHOLD}+ pushes, ${BURST_THRESHOLD}+ unanswered, within ${s.burstMaxSpanMinutes} min)`);
    for (const g of s.bursts) {
      const span = g.spanMinutes != null ? `, over ${g.spanMinutes} min` : '';
      const confidence = g.subjectExact ? '' : ' — grouped by CLASS, not item: these rows carry no id, so this may span several subjects';
      lines.push('');
      lines.push(`- **${g.senderKey}** · ${g.subjectKey} — ${g.reached} pushes${span},`
        + ` ${g.acted} answered, ${g.ignored} not.${confidence}`);
      for (const q of g.samples) lines.push(`    · "${q}"`);
    }
  }

  lines.push('');
  lines.push('## Every group');
  for (const g of s.groups) {
    const conf = g.subjectExact ? '' : ' (class-only)';
    lines.push(`- ${g.senderKey} · ${g.subjectKey}${conf} — ${g.reached} delivered,`
      + ` ${g.acted} answered (${Math.round(g.ignoredShare * 100)}% unanswered)`);
  }
  return lines.join('\n');
}
