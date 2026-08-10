/**
 * Brain Maturity — the daily morning report, on WhatsApp.
 *
 * Owner, 2026-08-10: *"daily morning i want you to send me Brain Maturity
 * comparing with yesterday"*, and, agreeing the shape: *"don't silent when
 * nothing changed, just give a message that nothing has changed for maturity of
 * brain"*.
 *
 * ── THE TWO DECISIONS THAT SHAPE THIS FILE ──────────────────────────────────
 *
 * 1. IT COMPARES YESTERDAY WITH THE DAY BEFORE — never a partial today. A
 *    morning report on a half-finished day shows an invented decline every
 *    single morning, and a metric that always falls is one the reader learns to
 *    ignore.
 *
 * 2. IT IS NEVER SILENT. A daily heartbeat is what makes the channel
 *    trustworthy; a report that only arrives when something is wrong teaches
 *    the owner to dread it, and one that only arrives on good news is
 *    propaganda. "Steady" is real information, and it is stated plainly.
 *
 * The register is deliberately Brain's own voice, in plain language — "I handle
 * part of an instruction and leave the rest", not "C6 66.2". The owner should
 * not need the standard open to read his own report.
 */

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('brain-maturity');

/**
 * The eight criteria in words a person reads over breakfast.
 *
 * Deliberately phrased as Brain admitting a fault about itself rather than a
 * dashboard describing a metric. A report that says "C6: 66.2" is a number; one
 * that says "I handle part of an instruction and leave the rest" is a
 * behaviour the owner can recognise from yesterday's conversation.
 */
const CRITERION_IN_PLAIN_WORDS: Record<string, string> = {
  C1: 'I claim things I have not actually done',
  C2: 'I state facts I was not given',
  C3: 'I lose the thread of what we were discussing',
  C4: 'I sound like a machine rather than a person',
  C5: 'I ask when I should just do it',
  C6: 'I handle part of an instruction and leave the rest',
  C7: 'I go quiet instead of telling you bad news',
  C8: 'I speak as you rather than as your assistant',
};

export interface MaturitySnapshot {
  clientNumber: string;
  snapshotDate: string;
  turnsScored: number;
  avgScore: number | null;
  criteriaAvg: Record<string, number>;
  llmCalls: number;
  llmUsd: number | null;
  msgsSent: number;
  msgsSuppressed: number;
  pagesTotal: number;
  pagesReachable: number;
  dbBytes: number | null;
  entities: number | null;
  healed: number;
  merged: number;
  openFindings: number;
}

/**
 * Measure one whole day and store it.
 *
 * `forDate` is a complete calendar day in the tenant's local frame. The point-
 * in-time figures (database size, pages reachable, open findings) are captured
 * as they are NOW, which is correct when this runs the morning after: they
 * describe the state that day left behind.
 */
export async function captureMaturitySnapshot(
  clientNumber: string,
  forDate: Date,
): Promise<MaturitySnapshot | null> {
  const day = forDate.toISOString().slice(0, 10);
  try {
    const [evals, spend, msgs, pages, dbSize, ents, healed, findings] = await Promise.all([
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT count(*)::int AS n, round(avg(overall_score)::numeric,1) AS avg
           FROM brain_response_evaluations
          WHERE client_number = $1 AND surface <> 'calibration' AND evaluated_at::date = $2::date`,
        clientNumber, day),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT count(*)::int AS n, round(sum(est_usd)::numeric,2) AS usd
           FROM llm_spend WHERE client_number = $1 AND created_at::date = $2::date`,
        clientNumber, day),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT count(*) FILTER (WHERE status = 'sent')::int AS sent,
                count(*) FILTER (WHERE status = 'suppressed')::int AS suppressed
           FROM brain_user_messages WHERE client_number = $1 AND created_at::date = $2::date`,
        clientNumber, day),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE embedding_model = 'gemini-embedding-001')::int AS reachable
           FROM wiki_pages WHERE client_number = $1`,
        clientNumber),
      prisma.$queryRawUnsafe<Array<any>>(`SELECT pg_database_size(current_database())::bigint AS b`),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT count(*)::int AS n FROM entities WHERE client_number = $1`, clientNumber),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT count(*)::int AS n FROM brain_health_findings
          WHERE client_number = $1 AND status = 'healed' AND healed_at::date = $2::date`,
        clientNumber, day),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT count(*)::int AS n FROM brain_health_findings WHERE client_number = $1 AND status = 'open'`,
        clientNumber),
    ]);

    const criteriaRows = await prisma.$queryRawUnsafe<Array<{ k: string; v: number }>>(
      `SELECT c.key AS k, round(avg((c.value->>'score')::numeric),1)::float AS v
         FROM brain_response_evaluations e, jsonb_each(e.criteria) c
        WHERE e.client_number = $1 AND e.surface <> 'calibration' AND e.evaluated_at::date = $2::date
        GROUP BY 1`,
      clientNumber, day,
    ).catch(() => []);

    const snap: MaturitySnapshot = {
      clientNumber,
      snapshotDate: day,
      turnsScored: evals[0]?.n ?? 0,
      avgScore: evals[0]?.avg != null ? Number(evals[0].avg) : null,
      criteriaAvg: Object.fromEntries(criteriaRows.map((r) => [r.k, Number(r.v)])),
      llmCalls: spend[0]?.n ?? 0,
      llmUsd: spend[0]?.usd != null ? Number(spend[0].usd) : null,
      msgsSent: msgs[0]?.sent ?? 0,
      msgsSuppressed: msgs[0]?.suppressed ?? 0,
      pagesTotal: pages[0]?.total ?? 0,
      pagesReachable: pages[0]?.reachable ?? 0,
      dbBytes: dbSize[0]?.b != null ? Number(dbSize[0].b) : null,
      entities: ents[0]?.n ?? null,
      healed: healed[0]?.n ?? 0,
      merged: 0, // filled by the pruning pass via recordMerges()
      openFindings: findings[0]?.n ?? 0,
    };

    // Upsert: a restart or a second pass on the same day corrects the row
    // rather than duplicating it.
    await prisma.$executeRawUnsafe(
      `INSERT INTO brain_maturity_snapshots
         (id, client_number, snapshot_date, turns_scored, avg_score, criteria_avg,
          llm_calls, llm_usd, msgs_sent, msgs_suppressed, pages_total, pages_reachable,
          db_bytes, entities, healed, merged, open_findings)
       VALUES (gen_random_uuid()::text, $1, $2::date, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (client_number, snapshot_date) DO UPDATE SET
         turns_scored = EXCLUDED.turns_scored, avg_score = EXCLUDED.avg_score,
         criteria_avg = EXCLUDED.criteria_avg, llm_calls = EXCLUDED.llm_calls,
         llm_usd = EXCLUDED.llm_usd, msgs_sent = EXCLUDED.msgs_sent,
         msgs_suppressed = EXCLUDED.msgs_suppressed, pages_total = EXCLUDED.pages_total,
         pages_reachable = EXCLUDED.pages_reachable, db_bytes = EXCLUDED.db_bytes,
         entities = EXCLUDED.entities, healed = EXCLUDED.healed,
         open_findings = EXCLUDED.open_findings`,
      clientNumber, day, snap.turnsScored, snap.avgScore, JSON.stringify(snap.criteriaAvg),
      snap.llmCalls, snap.llmUsd, snap.msgsSent, snap.msgsSuppressed,
      snap.pagesTotal, snap.pagesReachable, snap.dbBytes, snap.entities,
      snap.healed, snap.merged, snap.openFindings,
    );

    return snap;
  } catch (err) {
    log.warn('maturity snapshot failed', { err: err instanceof Error ? err.message : String(err), day });
    return null;
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** A movement worth a line in the report. */
interface Move { dir: '↑' | '↓'; text: string; magnitude: number }

const pct = (now: number, before: number): number =>
  before === 0 ? (now === 0 ? 0 : 100) : Math.round(((now - before) / before) * 100);

/** Only report a change a person would call a change. */
const MATERIAL_PCT = 10;

function mb(bytes: number | null): string {
  return bytes == null ? '?' : `${Math.round(bytes / 1_048_576)} MB`;
}

/**
 * Compare two days and describe what actually moved.
 *
 * Direction is assigned by MEANING, not by arithmetic: fewer LLM calls is an
 * improvement, fewer messages delivered is not. Getting that backwards would
 * make the report cheerfully celebrate Brain going silent.
 */
function describeMovement(today: MaturitySnapshot, prev: MaturitySnapshot): Move[] {
  const moves: Move[] = [];

  const callDelta = pct(today.llmCalls, prev.llmCalls);
  if (Math.abs(callDelta) >= MATERIAL_PCT && prev.llmCalls > 0) {
    moves.push({
      // Down is GOOD here — it means Brain stopped re-deriving what it knew.
      dir: callDelta < 0 ? '↑' : '↓',
      text: `Thinking — ${prev.llmCalls.toLocaleString()} → ${today.llmCalls.toLocaleString()} reasoning calls (${callDelta > 0 ? '+' : ''}${callDelta}%)`,
      magnitude: Math.abs(callDelta),
    });
  }

  const supDelta = pct(today.msgsSuppressed, prev.msgsSuppressed);
  if (Math.abs(supDelta) >= MATERIAL_PCT && (prev.msgsSuppressed > 0 || today.msgsSuppressed > 0)) {
    moves.push({
      dir: supDelta < 0 ? '↑' : '↓',
      text: `Communicating — ${prev.msgsSuppressed} → ${today.msgsSuppressed} messages blocked`,
      magnitude: Math.abs(supDelta),
    });
  }

  if (today.pagesTotal > 0 && prev.pagesTotal > 0) {
    const nowPct = Math.round((today.pagesReachable / today.pagesTotal) * 100);
    const wasPct = Math.round((prev.pagesReachable / prev.pagesTotal) * 100);
    if (Math.abs(nowPct - wasPct) >= 2) {
      moves.push({
        dir: nowPct > wasPct ? '↑' : '↓',
        text: `Memory — ${today.pagesReachable.toLocaleString()} of ${today.pagesTotal.toLocaleString()} pages reachable (${nowPct}%, was ${wasPct}%)`,
        magnitude: Math.abs(nowPct - wasPct),
      });
    }
  }

  if (today.dbBytes && prev.dbBytes) {
    const d = pct(today.dbBytes, prev.dbBytes);
    if (Math.abs(d) >= MATERIAL_PCT) {
      moves.push({
        dir: d < 0 ? '↑' : '↓',
        text: `Lighter — ${mb(prev.dbBytes)} → ${mb(today.dbBytes)}`,
        magnitude: Math.abs(d),
      });
    }
  }

  if (today.avgScore != null && prev.avgScore != null) {
    const d = Math.round(today.avgScore - prev.avgScore);
    if (Math.abs(d) >= 3) {
      moves.push({
        dir: d > 0 ? '↑' : '↓',
        text: `How well I answered — ${prev.avgScore} → ${today.avgScore} out of 100`,
        magnitude: Math.abs(d),
      });
    }
  }

  return moves.sort((a, b) => b.magnitude - a.magnitude);
}

/**
 * Build the message.
 *
 * Never returns empty. When nothing moved it says so in as many words — that
 * was the owner's explicit instruction, and a heartbeat that only beats on
 * change is not a heartbeat.
 */
export function renderMaturityMessage(
  today: MaturitySnapshot,
  prev: MaturitySnapshot | null,
  dateLabel: string,
): string {
  const lines: string[] = [];
  const overall = today.avgScore != null ? Math.round(today.avgScore) : null;

  const moves = prev ? describeMovement(today, prev) : [];
  const verdict = !prev ? 'first report'
    : moves.length === 0 ? '_nothing changed_'
    : moves.filter((m) => m.dir === '↑').length >= moves.filter((m) => m.dir === '↓').length
      ? '_improving_' : '_slipped_';

  lines.push(`*Brain Maturity — ${dateLabel}*`);
  lines.push(overall != null ? `Overall *${overall}/100* · ${verdict}` : `${verdict}`);

  if (moves.length > 0) {
    lines.push('');
    lines.push('*What moved*');
    for (const m of moves.slice(0, 4)) lines.push(`${m.dir} ${m.text}`);
  } else if (prev) {
    // The owner's instruction, honoured literally. Silence would read as a
    // broken report; vagueness would read as evasion.
    lines.push('');
    lines.push('*What moved*');
    lines.push('Nothing. My maturity is unchanged since yesterday —');
    lines.push('same reasoning cost, same memory reach, same quality.');
  }

  // Weakest two criteria, in Brain's own words.
  const weakest = Object.entries(today.criteriaAvg)
    .filter(([, v]) => v < 75)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 2);
  if (weakest.length > 0) {
    lines.push('');
    lines.push("*Where I'm still weak*");
    for (const [k, v] of weakest) {
      lines.push(`• ${CRITERION_IN_PLAIN_WORDS[k] ?? k} (${Math.round(v)}/100)`);
    }
  }

  const fixed: string[] = [];
  if (today.merged > 0) fixed.push(`${today.merged} duplicate contact${today.merged === 1 ? '' : 's'} merged`);
  if (today.healed > 0) fixed.push(`${today.healed} problem${today.healed === 1 ? '' : 's'} repaired`);
  if (fixed.length > 0) {
    lines.push('');
    lines.push('*What I fixed myself*');
    for (const f of fixed) lines.push(`• ${f}`);
  }

  lines.push('');
  lines.push(today.openFindings > 0
    ? `*Needs you* — ${today.openFindings} open finding${today.openFindings === 1 ? '' : 's'}.`
    : '*Needs you* — nothing.');

  lines.push('');
  lines.push('_Ask me "why" on any line._');
  return lines.join('\n');
}

/**
 * The morning job: measure yesterday, compare with the day before, send.
 *
 * Yesterday and the day before — never a partial today. A report on a
 * half-finished day invents a decline every morning, and a number that always
 * falls is one the reader stops believing.
 */
export async function sendMaturityReport(clientNumber: string, userId: number): Promise<boolean> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 3600_000);
  const dayBefore = new Date(now.getTime() - 48 * 3600_000);

  const today = await captureMaturitySnapshot(clientNumber, yesterday);
  if (!today) return false;
  await captureMaturitySnapshot(clientNumber, dayBefore).catch(() => null);

  const [prevRow] = await prisma.$queryRawUnsafe<Array<any>>(
    `SELECT * FROM brain_maturity_snapshots
      WHERE client_number = $1 AND snapshot_date = $2::date`,
    clientNumber, dayBefore.toISOString().slice(0, 10),
  ).catch(() => []);

  const prev: MaturitySnapshot | null = prevRow ? {
    clientNumber, snapshotDate: dayBefore.toISOString().slice(0, 10),
    turnsScored: prevRow.turns_scored, avgScore: prevRow.avg_score != null ? Number(prevRow.avg_score) : null,
    criteriaAvg: (prevRow.criteria_avg as any) ?? {},
    llmCalls: prevRow.llm_calls, llmUsd: prevRow.llm_usd != null ? Number(prevRow.llm_usd) : null,
    msgsSent: prevRow.msgs_sent, msgsSuppressed: prevRow.msgs_suppressed,
    pagesTotal: prevRow.pages_total, pagesReachable: prevRow.pages_reachable,
    dbBytes: prevRow.db_bytes != null ? Number(prevRow.db_bytes) : null,
    entities: prevRow.entities, healed: prevRow.healed, merged: prevRow.merged,
    openFindings: prevRow.open_findings,
  } : null;

  const label = yesterday.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const body = renderMaturityMessage(today, prev, label);

  const { brainContactsUser } = await import('../notifications/brainOutboundService');
  const r = await brainContactsUser({
    userId,
    kind: 'brain_daily_digest',
    summary: `Brain Maturity — ${label}`,
    body,
    urgency: 'low',
    channel: 'text',
    // One per user per day. Re-running the job cannot double-send.
    dedupKey: `maturity:${userId}:${today.snapshotDate}`,
  }).catch((err) => {
    log.warn('maturity report send failed', { userId, err: err?.message });
    return { sent: false } as any;
  });

  return !!r?.sent;
}
