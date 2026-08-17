/**
 * C-3 — Brain's OWN push history, in its context.
 *
 * ── THE FINDING THIS EXISTS TO FIX ──────────────────────────────────────────
 *
 * Benchmark case `B12-reminder-referent` asks the owner's real question —
 * *"Why did you remind me about that one twice?"* — and Brain answered:
 *
 *   "My apologies, Sir. It looks like my reminder job ran twice for that item,
 *    causing the duplicate message. I don't have a specific reason recorded for
 *    the duplication."
 *
 * The judge marked that down three ways: C1 85 ("presented as a fact… slight
 * fabrication"), C2 85 ("doesn't ground this in actual system logs or events it
 * can access"), C4 80 (canned). All three are one defect: **Brain guessed,
 * because its own push history was not in front of it.**
 *
 * The rows were always there. `brain_prompt_queue` records every push that
 * reached him, with the producer that sent it and the time it went. C-3
 * increment 1 (DEF-170) already turns those rows into per-subject counts with a
 * per-producer breakdown — and then hands them to `nexeoInboundNoiseReport.ts`,
 * a CLI script. The owner cannot run a CLI script, so the measurement never
 * reached the surface where he asks the question. This module connects it.
 *
 * This is the same repair as DEF-037/DEF-165 in a different question. There,
 * "did you inform Hamna?" was answered from the trimmed transcript and so came
 * out "No Sir, I have not" an hour after the email went out; the fix read
 * `brain_action_artifacts` instead, and "did I?" became a lookup. Here "why
 * twice?" becomes a lookup. Same shape, same reason, same rule: the answer
 * comes from a row with a timestamp, not from inference.
 *
 * ── WHY IT IS NOT A SECOND IMPLEMENTATION ───────────────────────────────────
 *
 * `summariseInboundNoise` is called, never reimplemented. `protection-with-two-
 * implementations` stands at 11 occurrences and a second push-counting rule
 * would be the 12th. The grouping unit, the REACHED/ACTED definitions, the
 * thread→item canonicalisation and the `unresolvedSubjects` honesty all come
 * from that one function; this file only chooses what a prompt can afford to
 * read and how to say it.
 *
 * ── FAIL-CLOSED, IN THE DIRECTION THAT MATTERS ──────────────────────────────
 *
 * The failure to avoid is not an absent block — it is a block that says "zero"
 * when the truth is "not known". DEF-085's lesson, verbatim on that row: *a
 * read that failed is not "no noise"*. So a failed read emits an explicit
 * UNAVAILABLE block rather than silence or a false zero, because silence lets
 * the model infer and a false zero makes it deny a push that happened. That is
 * Codex's #4 requirement applied to Brain's own state: unconfirmed reads must
 * surface as unknown, never as success prose.
 *
 * Read-only. Enforced by test: this module performs no writes.
 */
import { summariseInboundNoise, type NoiseSummary, type SubjectGroup } from './inboundNoiseLedger';
import createLogger from '../../utils/logger';

const log = createLogger('push-history-block');

/** A prompt is a budget. Repeat-pushed subjects, worst first, capped. */
const MAX_SUBJECT_LINES = 12;

/** The question this block answers is "why more than once?", so a subject
 *  pushed a single time earns a count but not a line. */
const REPEAT_THRESHOLD = 2;

const HEADING = '# Your own push history — what YOU sent this owner (read from brain_prompt_queue)';

/** The standing instruction. Without it the block is just more context the
 *  model may narrate loosely; with it, the block is the only permitted source
 *  for a repeat-push claim. */
const RULES = [
  'These are rows with timestamps, not recollection. When he asks why something reached him',
  'more than once, answer from THIS block: name the producers and the times, and say the count.',
  'A subject pushed only once is NOT listed here individually — so if he asks about a repeat and',
  'the subject is absent below, your record shows at most one push and you should say exactly that',
  'rather than agreeing that it went twice. Never invent a cause for a duplicate: if the rows show',
  'two producers, the cause is two producers; if they show one producer twice, say that and say you',
  'do not know why it repeated. "I don\'t know" is correct here; a plausible mechanism you cannot',
  'read is a fabrication.',
].join('\n');

function shortTime(d: Date | null): string {
  return d ? d.toISOString().slice(0, 16).replace('T', ' ') : '?';
}

function subjectLine(g: SubjectGroup): string {
  const producers = g.producers.map((p) => `${p.producer} ${p.reached}×`).join(', ');
  const span = g.spanMinutes != null ? `, spanning ${g.spanMinutes} min` : '';
  return `- ${g.subjectKey} — ${g.reached} pushes delivered, ${g.acted} answered${span}`
    + `; first ${shortTime(g.firstAt)}, last ${shortTime(g.lastAt)} UTC`
    + `; producers: ${producers}`;
}

/** Render a summary that was successfully READ. Exported for tests so the
 *  rendering is asserted without a database. */
export function renderPushHistoryBlock(s: NoiseSummary): string {
  const repeats = s.subjects.filter((g) => g.reached >= REPEAT_THRESHOLD);
  const shown = repeats.slice(0, MAX_SUBJECT_LINES);
  const singles = s.subjects.length - repeats.length;

  const lines: string[] = [HEADING, ''];
  lines.push(`Window: last ${s.windowHours}h (to ${shortTime(s.until)} UTC).`
    + ` ${s.totalReached} pushes delivered, ${s.totalActed} answered by him.`);
  lines.push('');

  if (shown.length > 0) {
    lines.push(`Subjects he was pushed about more than once (${repeats.length} of ${s.subjects.length}):`);
    for (const g of shown) lines.push(subjectLine(g));
    if (repeats.length > shown.length) {
      lines.push(`- …and ${repeats.length - shown.length} more repeat-pushed subject(s) not listed.`);
    }
  } else {
    lines.push('No subject was pushed to him more than once in this window.');
  }

  if (singles > 0) {
    lines.push('');
    lines.push(`${singles} further subject(s) were pushed exactly once and are not listed individually.`);
  }

  // Increment 1's honesty flags travel WITH the number. A count the model
  // presents as complete when it is a floor is the same defect in a new place.
  if (s.truncated) {
    lines.push('');
    lines.push('⚠ TRUNCATED — more rows exist than were read, so every count above is a FLOOR, not a total.');
  }
  if (s.canonicalisationFailed) {
    lines.push('');
    lines.push('⚠ The thread→item lookup failed, so one subject may appear split across two keys and its count under-stated.');
  }
  if (s.unresolvedSubjects.length > 0) {
    lines.push('');
    lines.push(`⚠ ${s.unresolvedSubjects.length} thread identit${s.unresolvedSubjects.length === 1 ? 'y' : 'ies'} did not resolve to an item`
      + ` (${s.unresolvedSubjects.slice(0, 5).join(', ')}${s.unresolvedSubjects.length > 5 ? ', …' : ''}):`
      + ' their counts may be split from the item they belong to and are a floor per subject.');
  }

  lines.push('');
  lines.push(RULES);
  return lines.join('\n');
}

/** The block for a read that could NOT be performed. Explicitly not "zero". */
export function renderPushHistoryUnavailable(reason: string): string {
  return [
    HEADING,
    '',
    `UNAVAILABLE — your push record could not be read (${reason}).`,
    '',
    'This is NOT the same as "nothing was sent". You do not know how many times he was',
    'pushed. If he asks, say your own record is unavailable for this window rather than',
    'denying a push or guessing a cause.',
  ].join('\n');
}

/**
 * Build the block for this owner. Best-effort in the sense that it never
 * throws — but never silent about a failure either, for the reason in the
 * header.
 */
export async function buildPushHistoryBlock(userId: number, clientNumber: string): Promise<string> {
  try {
    const summary = await summariseInboundNoise({ clientNumber, userId });
    return renderPushHistoryBlock(summary);
  } catch (e: any) {
    log.warn('push history read failed; emitting UNAVAILABLE rather than a false zero', {
      clientNumber, userId, error: e?.message,
    });
    return renderPushHistoryUnavailable(e?.message ? String(e.message).slice(0, 120) : 'read error');
  }
}
