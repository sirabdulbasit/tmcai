/**
 * C-3 increment 1 — count what we pushed at the owner, and how much of it he
 * ever touched.
 *
 * CL-033: ten unactionable pushes from one unknown number in a single morning.
 * Self-Pruning scores 33 with `basis: absent`; suppression built before this
 * number exists would be a guess dressed as a policy. This module changes NO
 * behaviour: it reads `brain_prompt_queue`, the surface that actually reaches
 * him, and produces the count.
 *
 * ── THE GROUPING UNIT (corrected twice, and each correction is on the row) ──
 *
 * v1 (iter 25) grouped by PRODUCER LABEL: five nudges about five different
 * items read as one burst. v2 (iter 26) grouped sender-first, subject-second:
 * distinct items no longer merged, but the SAME item pushed by three
 * subsystems became three groups — so the instrument could not produce the
 * "one item, 13 pushes from three producers" finding my own build entry
 * quoted; I had computed it by hand (Codex iteration-26 HIGH #2).
 *
 * v3: the SUBJECT is the primary unit. An exact subject aggregates across all
 * producers, keeping a per-producer breakdown inside the group — "one item,
 * one voice" is measurable from the data itself. Rows with no identity group
 * by sender+class in a SEPARATE collection (`unattributed`) whose dense
 * clusters are `floods`, kept apart from `bursts` BY CONSTRUCTION: a consumer
 * of `bursts` can never suppress a class-level aggregate, because class-level
 * aggregates are not in it (Codex iteration-26 MEDIUM #4). Counterpart floods
 * like CL-033 live there — visible, quotable, not auto-actionable.
 *
 * ── IDENTITY, AND WHAT "EXACT" DOES AND DOES NOT MEAN ───────────────────────
 *
 * A subject key is `item:<openItemId>` / `thread:<threadId>` / `event:<id>`,
 * in that precedence. Thread keys are CANONICALISED to their item where the
 * thread row names one (a tenant-scoped read of `delegation_thread`), so a
 * push keyed by thread and a push keyed by its item count as one subject.
 * When that lookup fails the summary says `canonicalisationFailed: true` and
 * keys stay split — split is visible, not silently merged or silently wrong
 * (Codex iteration-26 MEDIUM #3, honestly partial: an event and an item that
 * are "the same thing" to a human have no join this code can read).
 *
 * ── DEFINITIONS THE NUMBER RESTS ON ─────────────────────────────────────────
 *
 *   REACHED = `sent_at` within [since, until]. Delivered; he had to read it.
 *   ACTED   = `answered_at IS NOT NULL`. He replied.
 *
 * `ignored` is an UPPER BOUND on what he disregarded, not a measurement —
 * acting without replying looks identical here — and the rendered report says
 * so. A burst/flood needs volume AND disengagement AND density; the span
 * bound is `selfpruning.burst_max_span_minutes` (behaviorConfig, REGISTERED —
 * iteration 26 read an unregistered key and a silent catch pinned the span to
 * the default, so the owner's override could never take effect).
 *
 * Read-only, enforced by test: this module performs no writes.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('inbound-noise');

/** Default lookback. A working day plus the overnight before it. */
const DEFAULT_WINDOW_HOURS = 36;

/** Pushes about one subject before it is burst-eligible. Deliberately low:
 *  a threshold tuned to CL-033's ten would only find the incident we know. */
const BURST_THRESHOLD = 3;

/** Fallback span bound when behaviorConfig itself is unreachable. */
const DEFAULT_BURST_MAX_SPAN_MINUTES = 24 * 60;

const PAGE_SIZE = 500;

/** Ceiling on rows read. At the ceiling the summary says TRUNCATED — and only
 *  when more rows actually exist: exactly HARD_ROW_CAP matches is a complete
 *  count, not a floor (Codex iteration-26 LOW #5). */
const HARD_ROW_CAP = 5000;

/** Per-producer slice inside a subject group. */
export interface ProducerSlice {
  producer: string;
  reached: number;
  acted: number;
}

/** One SUBJECT — an item/thread/event — aggregated across every producer. */
export interface SubjectGroup {
  /** `item:<id>` / `thread:<id>` / `event:<id>`, thread canonicalised to its
   *  item when the join exists. */
  subjectKey: string;
  /** Which subsystems pushed about it, so "three producers nag one item" is a
   *  fact the data states rather than arithmetic in a build entry. */
  producers: ProducerSlice[];
  reached: number;
  acted: number;
  /** `reached - acted`. An UPPER BOUND — see the header. */
  ignored: number;
  ignoredShare: number;
  firstAt: Date | null;
  lastAt: Date | null;
  spanMinutes: number | null;
  /** Volume AND disengagement AND density. Only subject groups can be bursts. */
  burst: boolean;
  samples: string[];
}

/** Rows with NO subject identity, grouped by sender+class. Never actionable. */
export interface UnattributedGroup {
  senderKey: string;
  subjectClass: string;
  reached: number;
  acted: number;
  ignored: number;
  ignoredShare: number;
  firstAt: Date | null;
  lastAt: Date | null;
  spanMinutes: number | null;
  /** Same density criteria as a burst, in a different field on a different
   *  type: a consumer cannot mistake it for an actionable subject burst. */
  flood: boolean;
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
  /** True only when rows BEYOND the cap exist. Totals are then a floor. */
  truncated: boolean;
  /** True when the thread→item join could not be READ at all. */
  canonicalisationFailed: boolean;
  /** Thread-keyed subjects that did not resolve to an item — the join returned
   *  no row, or a row with no item (or the read failed entirely). These may be
   *  split from their item-keyed twins, so counts for them are a FLOOR per
   *  subject, and increment 2 must not act on them. Empty means every thread
   *  identity in the window genuinely resolved. */
  unresolvedSubjects: string[];
  burstMaxSpanMinutes: number;
  /** Exact subjects, aggregated across producers. Worst first. */
  subjects: SubjectGroup[];
  /** The actionable subset: dense, disengaged, EXACT subjects only. */
  bursts: SubjectGroup[];
  /** Sender+class groups for rows carrying no identity. Worst first. */
  unattributed: UnattributedGroup[];
  /** Dense unattributed clusters (CL-033 lives here). NOT actionable:
   *  suppression on a class aggregate is forbidden by construction. */
  floods: UnattributedGroup[];
}

function senderKeyOf(metadata: Record<string, unknown>, sideEffect: Record<string, unknown>): string {
  const from = typeof metadata.from === 'string' ? metadata.from.trim() : '';
  if (from) return from;
  const source = typeof metadata.source === 'string' ? metadata.source.trim() : '';
  if (source) return `system:${source}`;
  const kind = typeof sideEffect.kind === 'string' ? sideEffect.kind.trim() : '';
  return kind ? `system:${kind}` : 'system:unclassified';
}

/** The producer label — what SENT the push. Breakdown/display, never the unit. */
function producerOf(metadata: Record<string, unknown>, sideEffect: Record<string, unknown>): string {
  for (const v of [metadata.source, sideEffect.kind, metadata.tier]) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return 'unclassified';
}

/** The subject identity a row carries, or null. Column first — a real FK —
 *  then the identity ids production metadata actually carries. */
function subjectKeyOf(
  openItemId: string | null,
  metadata: Record<string, unknown>,
  sideEffect: Record<string, unknown>,
): string | null {
  if (openItemId && openItemId.trim()) return `item:${openItemId.trim()}`;
  for (const [prefix, key] of [
    ['item', 'openItemId'], ['thread', 'threadId'], ['event', 'eventId'],
  ] as const) {
    for (const bag of [metadata, sideEffect]) {
      const v = bag[key];
      if (typeof v === 'string' && v.trim()) return `${prefix}:${v.trim()}`;
    }
  }
  return null;
}

/**
 * The behaviorConfig-driven span bound.
 *
 * The catch is for infrastructure failure ONLY. An `unknown behavior key`
 * rethrows: that is a build defect, and swallowing it is exactly how iteration
 * 26 shipped a "tunable" bound the owner could not tune (Codex HIGH #1).
 */
async function burstMaxSpanMinutes(clientNumber: string): Promise<number> {
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    const v = await getBehaviorValue('selfpruning.burst_max_span_minutes', { clientNumber });
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_BURST_MAX_SPAN_MINUTES;
  } catch (e: any) {
    if (/unknown behavior key/i.test(e?.message ?? '')) throw e;
    log.warn('behaviorConfig unreachable; using default span bound', { error: e?.message });
    return DEFAULT_BURST_MAX_SPAN_MINUTES;
  }
}

/**
 * Count the pushes DELIVERED to this owner in the window.
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
    id: bigint | number;
    question: string | null; openItemId: string | null;
    metadata: unknown; sideEffect: unknown;
    sentAt: Date | null; answeredAt: Date | null;
  };

  // Cursor pagination: the ORDERING is (sentAt, id); the cursor itself is the
  // unique `id` of the last row, which Prisma positions within that ordering.
  // Stated exactly because iteration 27 described this as a "compound (sentAt,
  // id) cursor", which it is not — a maintainer changing order or uniqueness
  // semantics on the strength of that description would break the page
  // boundary (Codex iteration-27 LOW #2). Skip-based pages were dropped because
  // they drift when rows are inserted mid-read. TRUNCATED is set only
  // when a row PAST the cap is actually seen: the loop reads one page beyond
  // the ceiling before deciding, so exactly-HARD_ROW_CAP is a complete count.
  const rows: Row[] = [];
  let truncated = false;
  let cursor: { id: bigint | number } | undefined;
  for (;;) {
    const page: Row[] = await prisma.brainPromptQueue.findMany({
      where: {
        clientNumber: args.clientNumber,
        userId: args.userId,
        // REACHED = delivered inside the window, both sides bounded.
        sentAt: { gte: since, lte: until },
      },
      select: {
        id: true, question: true, openItemId: true, metadata: true,
        sideEffect: true, sentAt: true, answeredAt: true,
      },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      ...(cursor ? { cursor, skip: 1 } : {}),
      take: PAGE_SIZE,
    }).catch((e: any) => {
      // A read that failed is not "no noise" (DEF-085).
      log.warn('noise ledger read failed', { clientNumber: args.clientNumber, error: e?.message });
      throw e;
    });
    rows.push(...page);
    if (rows.length > HARD_ROW_CAP) {
      truncated = true;
      rows.length = HARD_ROW_CAP;
      break;
    }
    if (page.length < PAGE_SIZE) break;
    cursor = { id: page[page.length - 1].id };
  }

  // ── canonicalise thread subjects to their item, where the join exists ────
  const threadIds = new Set<string>();
  for (const r of rows) {
    const key = subjectKeyOf(r.openItemId, (r.metadata ?? {}) as any, (r.sideEffect ?? {}) as any);
    if (key?.startsWith('thread:')) threadIds.add(key.slice('thread:'.length));
  }
  const threadToItem = new Map<string, string>();
  let canonicalisationFailed = false;
  if (threadIds.size > 0) {
    try {
      const threads: Array<{ id: string; openItemId: string | null }> =
        await prisma.delegationThread.findMany({
          where: { clientNumber: args.clientNumber, id: { in: [...threadIds] } },
          select: { id: true, openItemId: true },
        });
      for (const t of threads) if (t.openItemId) threadToItem.set(t.id, t.openItemId);
    } catch (e: any) {
      // The whole pass was unavailable. Split subjects stay visible in the
      // output; a silent merge or a thrown summary would both be worse.
      canonicalisationFailed = true;
      log.warn('thread→item canonicalisation failed; thread keys stay split', { error: e?.message });
    }
  }
  // Codex iteration-27 HIGH #1: a lookup that SUCCEEDS and resolves nothing is
  // the ordinary failure, and the flag above said "success" for it — a missing
  // thread row, or one with `openItemId: null`, silently left `thread:T` split
  // from its `item:X` twin. Every requested id that did not end up in the map is
  // therefore surfaced BY NAME, whatever the reason it failed. Success is
  // claimed only for identities that actually resolved.
  const unresolvedSubjects: string[] = [...threadIds]
    .filter((t) => !threadToItem.has(t))
    .map((t) => `thread:${t}`)
    .sort();

  const subjectsByKey = new Map<string, SubjectGroup & { producerMap: Map<string, ProducerSlice> }>();
  const unattributedBySender = new Map<string, Map<string, UnattributedGroup>>();

  for (const r of rows) {
    const metadata = (r.metadata ?? {}) as Record<string, unknown>;
    const sideEffect = (r.sideEffect ?? {}) as Record<string, unknown>;
    const producer = producerOf(metadata, sideEffect);
    const rawKey = subjectKeyOf(r.openItemId, metadata, sideEffect);
    const subjectKey = rawKey?.startsWith('thread:')
      ? (threadToItem.has(rawKey.slice(7)) ? `item:${threadToItem.get(rawKey.slice(7))}` : rawKey)
      : rawKey;

    const at = r.sentAt;
    const sample = typeof r.question === 'string' && r.question.trim()
      ? r.question.trim().slice(0, 200) : null;

    if (subjectKey) {
      // SUBJECT-PRIMARY: one item, one group, whatever pushed about it.
      let g = subjectsByKey.get(subjectKey);
      if (!g) {
        g = {
          subjectKey, producers: [], reached: 0, acted: 0, ignored: 0,
          ignoredShare: 0, firstAt: null, lastAt: null, spanMinutes: null,
          burst: false, samples: [], producerMap: new Map(),
        };
        subjectsByKey.set(subjectKey, g);
      }
      g.reached += 1;
      if (r.answeredAt) g.acted += 1;
      let slice = g.producerMap.get(producer);
      if (!slice) { slice = { producer, reached: 0, acted: 0 }; g.producerMap.set(producer, slice); }
      slice.reached += 1;
      if (r.answeredAt) slice.acted += 1;
      if (at) {
        if (!g.firstAt || at < g.firstAt) g.firstAt = at;
        if (!g.lastAt || at > g.lastAt) g.lastAt = at;
      }
      if (g.samples.length < 3 && sample) g.samples.push(sample);
    } else {
      const senderKey = senderKeyOf(metadata, sideEffect);
      let byClass = unattributedBySender.get(senderKey);
      if (!byClass) { byClass = new Map(); unattributedBySender.set(senderKey, byClass); }
      let u = byClass.get(producer);
      if (!u) {
        u = {
          senderKey, subjectClass: producer, reached: 0, acted: 0, ignored: 0,
          ignoredShare: 0, firstAt: null, lastAt: null, spanMinutes: null,
          flood: false, samples: [],
        };
        byClass.set(producer, u);
      }
      u.reached += 1;
      if (r.answeredAt) u.acted += 1;
      if (at) {
        if (!u.firstAt || at < u.firstAt) u.firstAt = at;
        if (!u.lastAt || at > u.lastAt) u.lastAt = at;
      }
      if (u.samples.length < 3 && sample) u.samples.push(sample);
    }
  }

  const finishTimes = (g: { reached: number; acted: number; ignored: number; ignoredShare: number; firstAt: Date | null; lastAt: Date | null; spanMinutes: number | null }) => {
    g.ignored = g.reached - g.acted;
    g.ignoredShare = g.reached > 0 ? g.ignored / g.reached : 0;
    g.spanMinutes = g.firstAt && g.lastAt
      ? Math.round((g.lastAt.getTime() - g.firstAt.getTime()) / 60000) : null;
  };
  const dense = (g: { reached: number; ignored: number; spanMinutes: number | null }) =>
    g.reached >= BURST_THRESHOLD && g.ignored >= BURST_THRESHOLD
    && g.spanMinutes != null && g.spanMinutes <= maxSpan;

  const subjects: SubjectGroup[] = [...subjectsByKey.values()].map((g) => {
    const { producerMap, ...rest } = g;
    rest.producers = [...producerMap.values()].sort((a, b) => b.reached - a.reached);
    finishTimes(rest);
    rest.burst = dense(rest);
    return rest;
  });
  subjects.sort((a, b) => (b.ignored - a.ignored) || (b.reached - a.reached));

  const unattributed: UnattributedGroup[] = [...unattributedBySender.values()]
    .flatMap((m) => [...m.values()])
    .map((u) => { finishTimes(u); u.flood = dense(u); return u; });
  unattributed.sort((a, b) => (b.ignored - a.ignored) || (b.reached - a.reached));

  const all = [...subjects, ...unattributed];
  return {
    clientNumber: args.clientNumber,
    userId: args.userId,
    windowHours,
    since,
    until,
    totalReached: all.reduce((n, g) => n + g.reached, 0),
    totalActed: all.reduce((n, g) => n + g.acted, 0),
    totalIgnored: all.reduce((n, g) => n + g.ignored, 0),
    truncated,
    canonicalisationFailed,
    unresolvedSubjects,
    burstMaxSpanMinutes: maxSpan,
    subjects,
    bursts: subjects.filter((g) => g.burst),
    unattributed,
    floods: unattributed.filter((u) => u.flood),
  };
}

/**
 * The report, for quoting back to the owner. Carries its own definitions —
 * `ignored` is an upper bound, and the reader has to know that to judge the
 * figure at all.
 */
export function renderNoiseReport(s: NoiseSummary): string {
  const lines: string[] = [];
  lines.push(`# Inbound noise — last ${s.windowHours}h (${s.since.toISOString().slice(0, 16).replace('T', ' ')} to ${s.until.toISOString().slice(0, 16).replace('T', ' ')} UTC)`);
  lines.push('');
  lines.push(`Pushes delivered to you: ${s.totalReached}. You replied to ${s.totalActed}.`);
  if (s.truncated) {
    lines.push('');
    lines.push(`⚠ TRUNCATED at ${HARD_ROW_CAP} rows — more exist, so these totals are a FLOOR, not a count.`);
  }
  if (s.canonicalisationFailed) {
    lines.push('');
    lines.push('⚠ Thread→item lookup failed: a subject may appear split between its thread and its item.');
  }
  if (s.unresolvedSubjects.length > 0) {
    lines.push('');
    lines.push(`⚠ ${s.unresolvedSubjects.length} thread identit${s.unresolvedSubjects.length === 1 ? 'y' : 'ies'} did not resolve to an item`
      + ` (${s.unresolvedSubjects.join(', ')}): their counts may be split from the item they belong to.`);
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

  const fmtProducers = (g: SubjectGroup) =>
    g.producers.map((p) => `${p.producer} ${p.reached}×`).join(', ');

  if (s.bursts.length > 0) {
    lines.push('');
    lines.push(`## Subject bursts (${BURST_THRESHOLD}+ pushes, ${BURST_THRESHOLD}+ unanswered, within ${s.burstMaxSpanMinutes} min)`);
    for (const g of s.bursts) {
      const span = g.spanMinutes != null ? `, over ${g.spanMinutes} min` : '';
      lines.push('');
      lines.push(`- **${g.subjectKey}** — ${g.reached} pushes from ${g.producers.length} producer(s) (${fmtProducers(g)})${span}, ${g.acted} answered, ${g.ignored} not.`);
      for (const q of g.samples) lines.push(`    · "${q}"`);
    }
  }

  if (s.floods.length > 0) {
    lines.push('');
    lines.push('## Sender floods (no subject identity — NOT auto-actionable; needs your eyes)');
    for (const u of s.floods) {
      const span = u.spanMinutes != null ? `, over ${u.spanMinutes} min` : '';
      lines.push('');
      lines.push(`- **${u.senderKey}** · ${u.subjectClass} — ${u.reached} pushes${span}, ${u.acted} answered, ${u.ignored} not.`);
      for (const q of u.samples) lines.push(`    · "${q}"`);
    }
  }

  if (s.bursts.length === 0 && s.floods.length === 0) {
    lines.push('');
    lines.push(`No subject or sender got ${BURST_THRESHOLD}+ unanswered pushes inside ${s.burstMaxSpanMinutes} minutes.`);
  }

  lines.push('');
  lines.push('## Every subject');
  for (const g of s.subjects) {
    lines.push(`- ${g.subjectKey} — ${g.reached} delivered via ${g.producers.length} producer(s) (${fmtProducers(g)}), ${g.acted} answered (${Math.round(g.ignoredShare * 100)}% unanswered)`);
  }
  if (s.unattributed.length > 0) {
    lines.push('');
    lines.push('## No subject identity (grouped by sender + class)');
    for (const u of s.unattributed) {
      lines.push(`- ${u.senderKey} · ${u.subjectClass} — ${u.reached} delivered, ${u.acted} answered (${Math.round(u.ignoredShare * 100)}% unanswered)`);
    }
  }
  return lines.join('\n');
}
