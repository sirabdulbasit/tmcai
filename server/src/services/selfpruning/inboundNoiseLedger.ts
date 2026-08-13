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
 * built before that number exists would be a guess dressed as a policy, and
 * there would be no way to tell afterwards whether it helped. So this increment
 * deliberately changes NO behaviour: it reads `brain_prompt_queue`, which is the
 * surface that actually reaches him, and produces the count.
 *
 * ── WHAT "REACHED" AND "ACTED" MEAN, EXACTLY ────────────────────────────────
 *
 * These are the two definitions the whole number rests on, so they are stated
 * before anything is built on them:
 *
 *   REACHED = `sent_at IS NOT NULL`. The row left the queue and went to a
 *   channel. A queued-but-never-sent prompt never troubled him and is not noise
 *   he had to read.
 *
 *   ACTED = `answered_at IS NOT NULL`. He replied to it.
 *
 * **`ignored` is therefore an UPPER BOUND on what he actually disregarded, not a
 * measurement of it.** He can act without answering — do the thing himself, act
 * on it in a later unrelated turn, or decide deliberately that the answer is no.
 * Every one of those reads as "ignored" here. That overstatement is acceptable
 * for finding a BURST (ten pushes from one stranger, zero answers, is noise on
 * any reading) and is not acceptable as evidence about a single message. The
 * distinction is in the rendered report too, because a number quoted to the owner
 * without its definition is how "43 of 76" became a fact nobody could check.
 *
 * Read-only, and that is enforced by test: this module performs no writes.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('inbound-noise');

/** Default lookback. A working day plus the overnight before it. */
const DEFAULT_WINDOW_HOURS = 36;

/**
 * How many pushes from one sender inside the window make it a burst.
 *
 * Three is deliberately low. CL-033 was ten, and a threshold tuned to ten would
 * only ever find the incident we already know about — the point of a counter is
 * to find the ones nobody has reported yet.
 */
const BURST_THRESHOLD = 3;

export interface NoiseGroup {
  /** Who or what generated the pushes. A phone/LID for counterpart replies, else
   *  the producing subsystem, because "sender" is not meaningful for a nudge Brain
   *  raised on its own. */
  senderKey: string;
  /** The kind of push — `metadata.source`, or the side-effect kind, or unknown.
   *  Grouping needs a subject class as well as a sender: two nudges about
   *  different items are not the same noise as ten copies of one thing. */
  subjectClass: string;
  /** Pushes that actually went to a channel. */
  reached: number;
  /** Pushes he replied to. */
  acted: number;
  /** `reached - acted`. An UPPER BOUND — see the header. */
  ignored: number;
  /** `ignored / reached`, 0 when nothing reached him. */
  ignoredShare: number;
  firstAt: Date | null;
  lastAt: Date | null;
  /** Minutes from first to last, so a burst can be described the way he saw it. */
  spanMinutes: number | null;
  /** True when this group is dense enough to be worth his attention as a group. */
  burst: boolean;
  /** Up to three verbatim questions, so the report can quote rather than assert. */
  samples: string[];
}

export interface NoiseSummary {
  clientNumber: string;
  userId: number;
  windowHours: number;
  since: Date;
  /** Every push that reached him in the window, across all groups. */
  totalReached: number;
  totalActed: number;
  totalIgnored: number;
  groups: NoiseGroup[];
  /** Groups over the burst threshold, worst first. The actionable subset. */
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

/** What the push was about, coarsely. */
function subjectClassOf(metadata: Record<string, unknown>, sideEffect: Record<string, unknown>): string {
  for (const v of [metadata.source, sideEffect.kind, metadata.tier]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'unclassified';
}

/**
 * Count the pushes that reached this owner, grouped by sender and subject.
 *
 * Tenant- AND user-scoped in the query itself (invariant #1): a noise report is
 * about one person's inbox, and a cross-tenant total would be both wrong and a
 * leak.
 */
export async function summariseInboundNoise(args: {
  clientNumber: string;
  userId: number;
  windowHours?: number;
  now?: Date;
}): Promise<NoiseSummary> {
  const windowHours = Math.max(1, args.windowHours ?? DEFAULT_WINDOW_HOURS);
  const nowMs = (args.now ?? new Date()).getTime();
  const since = new Date(nowMs - windowHours * 60 * 60 * 1000);

  const rows = await prisma.brainPromptQueue.findMany({
    where: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      queuedAt: { gte: since },
      // REACHED, per the header: only rows that actually went out.
      sentAt: { not: null },
    },
    select: {
      question: true, metadata: true, sideEffect: true,
      queuedAt: true, sentAt: true, answeredAt: true,
    },
    orderBy: { queuedAt: 'asc' },
    take: 500,
  }).catch((e: any) => {
    // A read that failed is not "no noise". Returning [] here would report a
    // clean inbox from a broken query, which is the DEF-085 laundering this
    // codebase keeps re-learning.
    log.warn('noise ledger read failed', { clientNumber: args.clientNumber, error: e?.message });
    throw e;
  });

  const byKey = new Map<string, NoiseGroup>();

  for (const r of rows) {
    const metadata = (r.metadata ?? {}) as Record<string, unknown>;
    const sideEffect = (r.sideEffect ?? {}) as Record<string, unknown>;
    const senderKey = senderKeyOf(metadata, sideEffect);
    const subjectClass = subjectClassOf(metadata, sideEffect);
    // Grouped on sender AND subject, joined by U+241F (SYMBOL FOR UNIT
    // SEPARATOR) so a sender whose name contains the separator cannot collide
    // with a different group.
    const key = `${senderKey}␟${subjectClass}`;

    let g = byKey.get(key);
    if (!g) {
      g = {
        senderKey, subjectClass,
        reached: 0, acted: 0, ignored: 0, ignoredShare: 0,
        firstAt: null, lastAt: null, spanMinutes: null,
        burst: false, samples: [],
      };
      byKey.set(key, g);
    }

    g.reached += 1;
    if (r.answeredAt) g.acted += 1;

    const at = r.sentAt ?? r.queuedAt;
    if (at) {
      if (!g.firstAt || at < g.firstAt) g.firstAt = at;
      if (!g.lastAt || at > g.lastAt) g.lastAt = at;
    }
    if (g.samples.length < 3 && typeof r.question === 'string' && r.question.trim()) {
      g.samples.push(r.question.trim().slice(0, 200));
    }
  }

  const groups = [...byKey.values()].map((g) => {
    g.ignored = g.reached - g.acted;
    g.ignoredShare = g.reached > 0 ? g.ignored / g.reached : 0;
    g.spanMinutes = g.firstAt && g.lastAt
      ? Math.round((g.lastAt.getTime() - g.firstAt.getTime()) / 60000)
      : null;
    // A burst is volume AND lack of engagement together. Five pushes he answered
    // every time are a working conversation, not noise.
    g.burst = g.reached >= BURST_THRESHOLD && g.ignored >= BURST_THRESHOLD;
    return g;
  });

  // Worst first: most ignored, then densest.
  groups.sort((a, b) => (b.ignored - a.ignored) || (b.reached - a.reached));

  return {
    clientNumber: args.clientNumber,
    userId: args.userId,
    windowHours,
    since,
    totalReached: groups.reduce((n, g) => n + g.reached, 0),
    totalActed: groups.reduce((n, g) => n + g.acted, 0),
    totalIgnored: groups.reduce((n, g) => n + g.ignored, 0),
    groups,
    bursts: groups.filter((g) => g.burst),
  };
}

/**
 * The report, for quoting back to the owner.
 *
 * Carries its own definitions. A number handed over without them invites exactly
 * the reading it cannot support — and `ignored` is an upper bound, which the
 * reader has to know to judge the figure at all.
 */
export function renderNoiseReport(s: NoiseSummary): string {
  const lines: string[] = [];
  lines.push(`# Inbound noise — last ${s.windowHours}h (since ${s.since.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  lines.push('');
  lines.push(`Pushes that reached you: ${s.totalReached}. You replied to ${s.totalActed}.`);
  lines.push('');
  lines.push('"Reached" = the push left the queue and went to a channel. "Replied to" ='
    + ' you answered it. Anything else counts as unanswered below, which OVERSTATES what'
    + ' you disregarded: acting without replying — doing it yourself, or deciding no —'
    + ' looks identical here.');

  if (s.totalReached === 0) {
    lines.push('');
    lines.push('Nothing reached you in this window.');
    return lines.join('\n');
  }

  if (s.bursts.length === 0) {
    lines.push('');
    lines.push(`No sender sent ${BURST_THRESHOLD} or more unanswered pushes in this window.`);
  } else {
    lines.push('');
    lines.push(`## Bursts (${BURST_THRESHOLD}+ pushes, ${BURST_THRESHOLD}+ unanswered)`);
    for (const g of s.bursts) {
      const span = g.spanMinutes != null ? `, over ${g.spanMinutes} min` : '';
      lines.push('');
      lines.push(`- **${g.senderKey}** · ${g.subjectClass} — ${g.reached} pushes${span},`
        + ` ${g.acted} answered, ${g.ignored} not.`);
      for (const q of g.samples) lines.push(`    · "${q}"`);
    }
  }

  lines.push('');
  lines.push('## Every group');
  for (const g of s.groups) {
    lines.push(`- ${g.senderKey} · ${g.subjectClass} — ${g.reached} reached,`
      + ` ${g.acted} answered (${Math.round(g.ignoredShare * 100)}% unanswered)`);
  }
  return lines.join('\n');
}
