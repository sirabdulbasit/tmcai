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
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('push-history-block');

/**
 * DEF-199 — `item:<id>` → the owner's own title for it.
 *
 * WHY THIS EXISTS, and why DEF-198 could not work without it. The block used to
 * print a subject as the bare key `item:cmqauv4xx`: a real count, a real
 * timestamp, a real producer, and a name the model cannot pronounce. Asked
 * *"why did you remind me about that one twice?"* it still had to produce a
 * human sentence, so it took a TITLE from a different block (open items) and
 * attached THIS block's counts to it. That is how `B12-reminder-referent`
 * answered about "ShireMe Recruiting Portal Application Testing", then about
 * "Vision Metric's service sales package video" on the next run — two different
 * wrong items, same mechanism, because the wrong item is whatever title
 * happened to be nearby.
 *
 * DEF-198 responded by adding rules about choosing the right subject. Rules
 * cannot fix an unjoinable key: the join simply did not exist in the model's
 * context. This performs it — scoped by tenant AND user, because a title is
 * owner data and `openItem` is a user-owned model.
 *
 * READ-ONLY, and asserted as such by test.
 */
export async function resolveSubjectTitles(
  subjectKeys: string[],
  clientNumber: string,
  userId: number,
): Promise<Map<string, string>> {
  const ids = [...new Set(subjectKeys
    .filter((k) => k.startsWith('item:'))
    .map((k) => k.slice('item:'.length))
    .filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.openItem.findMany({
    where: { id: { in: ids }, clientNumber, userId },
    select: { id: true, title: true },
  });
  const resolved = new Map<string, string>();
  for (const r of rows) {
    // An empty/whitespace title is NOT a name. It must fall through to
    // "TITLE UNRESOLVED" rather than render as `""`, which would read to the
    // model as an item legitimately called nothing.
    const title = String(r.title ?? '').trim();
    if (title) resolved.set(`item:${r.id}`, title);
  }
  return resolved;
}

/** A prompt is a budget. Repeat-pushed subjects, worst first, capped. */
const MAX_SUBJECT_LINES = 12;

/** The question this block answers is "why more than once?", so a subject
 *  pushed a single time earns a count but not a line. */
const REPEAT_THRESHOLD = 2;

const HEADING = '# Your own push history — what YOU sent this owner (read from brain_prompt_queue)';

/**
 * Absence from the list below is only evidence when the list is COMPLETE.
 *
 * DEF-198. The rule "if the subject is absent, your record shows at most one
 * push" is a sound READ when every repeat-pushed subject is on the page. It
 * becomes a FABRICATION the moment the page is short of the truth — and this
 * renderer has four ways to be short: `repeats` is sliced to
 * `MAX_SUBJECT_LINES`, `truncated` means rows were never read at all,
 * `canonicalisationFailed` means one subject may be split across two keys, and
 * `unresolvedSubjects` means a thread never resolved to the item it belongs to.
 * In any of those states a subject can be missing from the list while having
 * been pushed ten times, so asserting "at most one" is a count nobody read —
 * the `fabricated-status` shape, wearing this block as its evidence.
 */
function absenceIsInformative(s: NoiseSummary, shown: number, repeatsTotal: number): boolean {
  return !s.truncated
    && !s.canonicalisationFailed
    && s.unresolvedSubjects.length === 0
    && shown === repeatsTotal;
}

/**
 * The standing instruction.
 *
 * DEF-198 — THE SUBJECT IS RESOLVED FROM THE CONVERSATION, NOT FROM THIS PAGE.
 * The first version said "answer from THIS block" and said nothing about WHICH
 * subject, so on *"why did you remind me about that one twice?"* the composer
 * narrated the block's listed subject instead of the item under discussion.
 * That is the measured `B12-reminder-referent` failure: the judge scored C1/C2/
 * C3/C6 at 60 with *"It claimed to send reminders for 'ShireMe Recruiting
 * Portal Application Testing' but the conversation clearly shows the reminder
 * was for 'Send the revised Fujairah pricing to Latif'"* and, on C3,
 * *"It essentially ignored the immediate context."* A context block that
 * outranks the conversation for the REFERENT is a guard destroying a correct
 * answer; this block supplies counts for the subject he means, and never
 * chooses the subject.
 */
function rulesFor(absenceInformative: boolean): string {
  const referent = [
    'THE SUBJECT IS HIS, NOT THIS BLOCK\'S — resolve it BEFORE you read the list. He usually names',
    'it by pronoun ("that one", "it"), meaning the item under discussion in the conversation you are',
    'already in. Resolve that referent from the conversation FIRST, then look THAT subject up below',
    'and answer about it. NEVER answer about a different subject because it is the one listed here:',
    'switching subjects is worse than admitting you cannot find his, because the count and the times',
    'will look authoritative while describing something he never asked about.',
  ];
  const read = [
    'These are rows with timestamps, not recollection. For the subject he means, name the producers',
    'and the times, and say the count.',
    '',
    'NAME AN ITEM ONLY FROM A TITLE PRINTED IN THIS LIST. Every subject below carries the owner\'s own',
    'title for it, in quotes. If the item he means is not listed below, say your record shows no repeat',
    'push for that item — do NOT take a title from another block (open items, the day brief, the',
    'transcript) and attach these counts to it. That is how a true count becomes a false statement:',
    'the number and the time stay correct while the thing they describe is something he never asked',
    'about, and he cannot tell from the reply that the join was guessed. A subject marked',
    'TITLE UNRESOLVED has no name you may use — report it as an item you cannot identify.',
  ];
  // The only branch in this block, and it exists because absence is evidence in
  // one state and a guess in the other.
  const absence = absenceInformative
    ? [
      'A subject pushed only once is NOT listed here individually — so if he asks about a repeat and',
      'the subject is absent below, your record shows at most one push and you should say exactly that',
      'rather than agreeing that it went twice.',
    ]
    : [
      'THIS LIST IS INCOMPLETE — see the ⚠ flags above. Absence proves NOTHING here: a subject can be',
      'missing below and still have been pushed many times. You may NOT say "at most one push" for a',
      'subject you cannot find. Say your record for that subject is incomplete for this window, and',
      'never agree to a count you did not read.',
    ];
  const cause = [
    'Never invent a cause for a duplicate: if the rows show',
    'two producers, the cause is two producers; if they show one producer twice, say that and say you',
    'do not know why it repeated. "I don\'t know" is correct here; a plausible mechanism you cannot',
    'read is a fabrication.',
  ];
  return [...referent, '', ...read, '', ...absence, ...cause].join('\n');
}

function shortTime(d: Date | null): string {
  return d ? d.toISOString().slice(0, 16).replace('T', ' ') : '?';
}

function subjectLine(g: SubjectGroup, titles: Map<string, string>): string {
  const producers = g.producers.map((p) => `${p.producer} ${p.reached}×`).join(', ');
  const span = g.spanMinutes != null ? `, spanning ${g.spanMinutes} min` : '';
  const title = titles.get(g.subjectKey);
  // DEF-199 — a subject is either NAMED here or explicitly unnameable. The old
  // bare key was the third option that produced the defect: nameless but
  // answerable-looking, so the model supplied a name from elsewhere.
  const subject = title
    ? `"${title}" (${g.subjectKey})`
    : `${g.subjectKey} [TITLE UNRESOLVED — never name this item]`;
  return `- ${subject} — ${g.reached} pushes delivered, ${g.acted} answered${span}`
    + `; first ${shortTime(g.firstAt)}, last ${shortTime(g.lastAt)} UTC`
    + `; producers: ${producers}`;
}

/** Render a summary that was successfully READ. Exported for tests so the
 *  rendering is asserted without a database. */
export function renderPushHistoryBlock(s: NoiseSummary, titles: Map<string, string> = new Map()): string {
  const repeats = s.subjects.filter((g) => g.reached >= REPEAT_THRESHOLD);
  const shown = repeats.slice(0, MAX_SUBJECT_LINES);
  const singles = s.subjects.length - repeats.length;

  const lines: string[] = [HEADING, ''];
  lines.push(`Window: last ${s.windowHours}h (to ${shortTime(s.until)} UTC).`
    + ` ${s.totalReached} pushes delivered, ${s.totalActed} answered by him.`);
  lines.push('');

  if (shown.length > 0) {
    lines.push(`Subjects he was pushed about more than once (${repeats.length} of ${s.subjects.length}):`);
    for (const g of shown) lines.push(subjectLine(g, titles));
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
  lines.push(rulesFor(absenceIsInformative(s, shown.length, repeats.length)));
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
    // DEF-199 — perform the join the model was previously left to guess. A
    // FAILED title read degrades to unnamed subjects (which the block then
    // forbids naming), never to a guess and never to losing the counts: the
    // count is still true and still worth stating, it just cannot be attached
    // to an item until the join succeeds.
    const titles = await resolveSubjectTitles(
      summary.subjects.map((g) => g.subjectKey), clientNumber, userId,
    ).catch((e: any) => {
      log.warn('subject title join failed; subjects render as unnameable rather than guessed', {
        clientNumber, userId, error: e?.message,
      });
      return new Map<string, string>();
    });
    return renderPushHistoryBlock(summary, titles);
  } catch (e: any) {
    log.warn('push history read failed; emitting UNAVAILABLE rather than a false zero', {
      clientNumber, userId, error: e?.message,
    });
    return renderPushHistoryUnavailable(e?.message ? String(e.message).slice(0, 120) : 'read error');
  }
}
