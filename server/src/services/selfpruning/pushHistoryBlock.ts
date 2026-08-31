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

/**
 * DEF-203 — is THIS turn actually about Brain's own pushes?
 *
 * THE REGRESSION THIS EXISTS TO UNDO, and it was mine. DEF-200 made the block
 * withhold subjects the conversation does not name, and print a loud
 * "NO SUBJECT IN YOUR PUSH RECORD MATCHES THE ITEM UNDER DISCUSSION" when none
 * matched. That was right for B12. It was catastrophic for `B03-pronoun-followup`,
 * which is not about pushes at all: asked *"And what about the second one?"*
 * about a Q3 headcount plan Brain had itself just named, Brain answered
 * *"I'm not finding anything under \"Q3 headcount plan\"."* — mean 98.1 -> 68.8,
 * C3 90 -> 30. The block's push-record miss was read as the ITEM not existing.
 *
 * That is `guard-destroys-the-answer` (8 occurrences in chart §3) and I built the
 * ninth. The root cause is not the wording: it is that a block answering ONE
 * question was injected on EVERY turn. A page of "I have no record of that"
 * sitting in front of a model that was asked something else will eventually be
 * repeated as a denial.
 *
 * So relevance is decided where the information is — in the question. The block
 * is built only when he is actually asking about repeat pushes; otherwise it is
 * absent, and an absent block cannot deny anything.
 *
 * Deliberately matched on the QUESTION, not the history: history routinely
 * mentions reminders, and gating on it would re-inject the block everywhere.
 */
const PUSH_QUESTION = new RegExp([
  'remind(?:ed|er|ers|ing)?',
  'push(?:ed|es|ing)?',
  'notif(?:y|ied|ication|ications)',
  'nudge[ds]?',
  'chase[ds]?',
  'ping(?:ed|ged)?',
  '\\btwice\\b', '\\bagain\\b', 'duplicate', 'double',
  'how many times', 'how often',
].join('|'), 'i');

export function questionIsAboutPushes(question: string): boolean {
  return PUSH_QUESTION.test(String(question ?? ''));
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
function incompletenessReasons(s: NoiseSummary, shown: number, repeatsTotal: number): string[] {
  const why: string[] = [];
  // DEF-201, Codex iteration-2 MEDIUM 3 — each reason NAMES ITSELF. The previous
  // text said "see the ⚠ flags above", which is a lie in the one case that has
  // no ⚠ of its own: a line-cap slice renders only "…and N more". Telling the
  // model to consult a warning that is not there weakens the instruction exactly
  // when the list was shortened.
  if (shown < repeatsTotal) why.push(`the list was cut to ${MAX_SUBJECT_LINES} lines and ${repeatsTotal - shown} repeat-pushed subject(s) are not shown`);
  if (s.truncated) why.push('rows were truncated before they were read (⚠ above)');
  if (s.canonicalisationFailed) why.push('a subject may be split across two keys (⚠ above)');
  if (s.unresolvedSubjects.length) why.push(`${s.unresolvedSubjects.length} thread(s) never resolved to an item (⚠ above)`);
  if (s.unattributed.length) why.push(`${s.unattributed.length} push group(s) carry no item/thread identity at all and are NOT in the list below`);
  if (s.floods.length) why.push(`${s.floods.length} flood group(s) are counted separately and are NOT in the list below`);
  return why;
}

function absenceIsInformative(s: NoiseSummary, shown: number, repeatsTotal: number): boolean {
  return !s.truncated
    && !s.canonicalisationFailed
    && s.unresolvedSubjects.length === 0
    // DEF-200, Codex iteration-2 finding 2 — and he was right. `NoiseSummary`
    // ALSO carries `unattributed` (pushes with no item/thread/event identity at
    // all) and `floods`. The repeat list is derived only from `s.subjects`, so a
    // subject can have been pushed five times, land in `unattributed` because it
    // never resolved to an identity, and be absent from the list below while the
    // block cheerfully authorised "your record shows at most one push". I listed
    // "four ways to be short" and missed the two that need no ⚠ of their own.
    && s.unattributed.length === 0
    && s.floods.length === 0
    && shown === repeatsTotal;
}

/**
 * DEF-200 — resolve the SUBJECT from the conversation, in code, before the
 * model sees any candidates.
 *
 * Codex, reviewing DEF-198: *"The code does not resolve or pass a subject
 * identity. It merely adds instructions telling the model to resolve one … The
 * measured mechanism is still `examples-outvote-the-instruction`: evidence
 * candidates and their exact times are concrete, while the conversation-first
 * rule is prose."* That is correct, and it is the whole reason two turns of
 * rules failed: as long as a page of other people's items sits in the context
 * with real counts and real timestamps, the model will answer from it.
 *
 * So the fix is not another sentence. It is to stop supplying the candidates.
 * This matches the owner's conversation against the subjects' REAL TITLES — the
 * join DEF-199 added, without which this could not be written — and the renderer
 * then shows ONLY what matched. When nothing matches, the block shows no subject
 * lines at all: there is then nothing to outvote the dialogue with.
 *
 * Conservative by construction. A title must be distinctive (>= 8 normalised
 * characters) to match, because a short title like "Call" would match half the
 * conversations in the world and a false match is worse than none: it would
 * re-create exactly the defect this closes.
 */
export function normaliseForMatch(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const MIN_DISTINCTIVE_TITLE = 8;

export function selectSubjectsForConversation(
  subjects: SubjectGroup[],
  titles: Map<string, string>,
  conversationText: string,
): SubjectGroup[] {
  const hay = normaliseForMatch(conversationText);
  if (!hay) return [];
  return subjects.filter((g) => {
    const title = titles.get(g.subjectKey);
    if (!title) return false;              // an unnameable subject can never be "the one he means"
    const needle = normaliseForMatch(title);
    return needle.length >= MIN_DISTINCTIVE_TITLE && hay.includes(needle);
  });
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
function rulesFor(absenceInformative: boolean, reasons: string[] = [], windowHours?: number): string {
  const referent = [
    'THE SUBJECT IS HIS, NOT THIS BLOCK\'S — resolve it BEFORE you read the list. He usually names',
    'it by pronoun ("that one", "it"), meaning the item under discussion in the conversation you are',
    'already in. Resolve that referent from the conversation FIRST, then look THAT subject up below',
    'and answer about it. NEVER answer about a different subject because it is the one listed here:',
    'switching subjects is worse than admitting you cannot find his, because the count and the times',
    'will look authoritative while describing something he never asked about.',
  ];
  // DEF-257 — THE ABSENCE CLAIM HAS EXACTLY ONE IMPLEMENTATION, and it is the
  // gated one below. This paragraph used to also say "if the item he means is
  // not listed below, say it was not pushed more than once" — unconditionally,
  // in every render, including the ones whose ABSENCE RULE was simultaneously
  // forbidding that exact sentence because the list was incomplete. Two rules,
  // one gated and one not, and the model free to obey either: that is
  // `protection-with-two-implementations` inside a single prompt block, and it
  // is how Codex's HIGH ("absence can still be asserted from an incomplete
  // identity partition") stayed alive after the gate was built. This paragraph
  // now DEFERS; only the ABSENCE RULE decides what absence means.
  const read = [
    'These are rows with timestamps, not recollection. For the subject he means, name the producers',
    'and the times, and say the count.',
    '',
    'NAME AN ITEM ONLY FROM A TITLE PRINTED IN THIS LIST. Every subject below carries the owner\'s own',
    'title for it, in quotes. If the item he means is not listed below, the ABSENCE RULE further down',
    'decides what you may say about that — nothing in this paragraph does. And never fill the gap',
    'yourself: do NOT take a title from another block (open items, the day brief, the',
    'transcript) and attach these counts to it. That is how a true count becomes a false statement:',
    'the number and the time stay correct while the thing they describe is something he never asked',
    'about, and he cannot tell from the reply that the join was guessed. A subject marked',
    'TITLE UNRESOLVED has no name you may use — report it as an item you cannot identify.',
  ];
  // The only branch in this block, and it exists because absence is evidence in
  // one state and a guess in the other.
  const absence = absenceInformative
    ? [
      'ABSENCE RULE — a subject pushed only once is NOT listed here individually, so if he asks about',
      'a repeat and the subject is absent below, it was pushed at most once and you should say exactly that',
      'rather than agreeing that it went twice.',
      '',
      // DEF-201, Codex iteration-2 directive 4 — this record is a WINDOW, not a
      // lifetime. "I only pushed that once" is a claim about all time; the rows
      // only support a claim about the last N hours, and the difference is the
      // whole `fabricated-status` class in miniature.
      `BOUND THAT CLAIM TO THE WINDOW. What is visible here covers the last ${windowHours ?? '?'}h only, so the`,
      'honest sentence is "I have no record of pushing that more than once IN THE LAST'
      + ` ${windowHours ?? '?'} HOURS" — never an unqualified "I only sent it once". If his reminder`,
      'could predate the window, say the window is what you can see.',
    ]
    : [
      'ABSENCE RULE — THIS LIST IS INCOMPLETE, for a reason that is stated rather than implied:',
      ...reasons.map((r) => `  • ${r}`),
      'Absence proves NOTHING here: a subject can be missing below and still have been pushed many',
      'times. You may NOT say "at most one push" for a subject you cannot find. Say that what you can',
      'see for that subject is incomplete for this window, and never agree to a count you did not read.',
    ];
  // DEF-213 — STATE THE FACT, NOT THE BOOKKEEPING.
  //
  // `B12-reminder-referent` C4 80 and C1 85, on one sentence: *"my own dispatch
  // log doesn't have a record of why that happened."* The judge called it "too
  // mechanical … explaining its internal workings" and, worse, said it "implies a
  // dispatch log exists and was checked, which isn't explicitly confirmed as an
  // actual action."
  //
  // He is echoing THIS BLOCK. It said "your record shows", "this record covers",
  // "say your own record is unavailable" — first-person machine vocabulary,
  // supplied by me, in the one place the model is told how to talk about this
  // subject. That is not a wish about behaviour it must choose to perform; it is
  // the source string it was copying, and removing the source removes the echo.
  //
  // The rule below is the general form, because deleting seven phrases without
  // it just invites the next one.
  const voice = [
    'SAY WHAT IS TRUE, NOT HOW YOU KNOW IT. Give him the fact and, where you do not have one, say',
    'plainly that you do not know. Do NOT narrate your own bookkeeping — no "my dispatch log", no',
    '"my records show", no "I checked my logs". Two reasons, and the second is the serious one:',
    'it reads like a machine describing its inside, and it ASSERTS a lookup he cannot verify and you',
    'may not have made. "I don\'t know why it went twice" is honest and complete; "my dispatch log has',
    'no record of why" claims a log, claims you read it, and says the same thing.',
  ];
  const cause = [
    'Never invent a cause for a duplicate: if the rows show',
    'two producers, the cause is two producers; if they show one producer twice, say that and say you',
    'do not know why it repeated. "I don\'t know" is correct here; a plausible mechanism you cannot',
    'read is a fabrication.',
  ];
  return [...referent, '', ...read, '', ...absence, ...cause, '', ...voice].join('\n');
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
export function renderPushHistoryBlock(
  s: NoiseSummary,
  titles: Map<string, string> = new Map(),
  conversationText?: string,
): string {
  const allRepeats = s.subjects.filter((g) => g.reached >= REPEAT_THRESHOLD);

  // DEF-200 — the resolver runs BEFORE anything is rendered. When the caller
  // supplies the conversation, only subjects the conversation actually names
  // survive into the prompt. Codex's directive, verbatim: the block "may supply
  // counts/timestamps only for the resolved subject; it must not let a different
  // repeated subject outvote recent dialogue."
  const scoped = conversationText !== undefined;
  const matched = scoped ? selectSubjectsForConversation(allRepeats, titles, conversationText!) : allRepeats;
  const repeats = matched;
  const shown = repeats.slice(0, MAX_SUBJECT_LINES);
  const singles = s.subjects.length - allRepeats.length;

  const lines: string[] = [HEADING, ''];
  lines.push(`Window: last ${s.windowHours}h (to ${shortTime(s.until)} UTC).`
    + ` ${s.totalReached} pushes delivered, ${s.totalActed} answered by him.`);
  lines.push('');

  // The no-match case is the one that mattered: B12 had a real push record and
  // none of it was about the item under discussion. Showing that record anyway
  // is what produced two different fabricated referents in two runs.
  if (scoped && shown.length === 0) {
    lines.push('YOUR PUSH RECORD HAS NO ENTRY FOR THE ITEM UNDER DISCUSSION.');
    lines.push('');
    // DEF-203 — the scope of this miss, stated before anything else, because
    // B03 proved the model will otherwise generalise it into a denial of the
    // ITEM. Brain answered "I'm not finding anything under \"Q3 headcount plan\""
    // about an item it had named one turn earlier: C3 90 -> 30.
    lines.push('THIS IS A STATEMENT ABOUT PUSH COUNTS ONLY. It is NOT evidence that the item does');
    lines.push('not exist, is not on his list, or cannot be found. The item may be perfectly real and');
    lines.push('present in your other blocks — this record only counts how many times you PUSHED it,');
    lines.push('and it has no row for it in this window. NEVER answer "I cannot find that item", "I');
    lines.push('have nothing under that name", or ask him to rename it on the strength of this block.');
    lines.push('');
    lines.push('If he asked why something was pushed more than once, say you have no repeat-push');
    lines.push('record for it. If he asked about the item itself, answer from the blocks that hold');
    lines.push('items and ignore this one entirely. The other subjects listed here are deliberately');
    lines.push('NOT listed here because they are not what he asked about — do not name one, and do not');
    lines.push('take a title from another block.');
    lines.push('');
    lines.push(rulesFor(false, incompletenessReasons(s, 0, allRepeats.length), s.windowHours));
    return lines.join('\n');
  }

  if (shown.length > 0) {
    lines.push(scoped
      ? `The subject(s) from THIS conversation that appear in your push record (${repeats.length}):`
      : `Subjects he was pushed about more than once (${repeats.length} of ${s.subjects.length}):`);
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
  lines.push(rulesFor(
    absenceIsInformative(s, shown.length, allRepeats.length),
    incompletenessReasons(s, shown.length, allRepeats.length),
    s.windowHours,
  ));
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
    'pushed. If he asks, say you cannot tell for this window rather than',
    'denying a push or guessing a cause.',
  ].join('\n');
}

/**
 * Build the block for this owner. Best-effort in the sense that it never
 * throws — but never silent about a failure either, for the reason in the
 * header.
 */
export async function buildPushHistoryBlock(
  userId: number,
  clientNumber: string,
  /**
   * DEF-200 — the conversation, so the SUBJECT can be resolved in code rather
   * than delegated to the model as an instruction. Optional so a caller with no
   * dialogue (a digest, a script) still gets the unscoped record; every live
   * composer path supplies it.
   */
  conversationText?: string,
  /**
   * DEF-203 — THIS turn's question. When supplied and it is not about pushes,
   * the block is not built at all: an absent block cannot deny an item the
   * owner asked about. Optional so a caller with no question keeps the old
   * behaviour.
   */
  question?: string,
): Promise<string> {
  // DEF-203 — the gate, before any read. Also saves a query on ~every turn.
  if (question !== undefined && !questionIsAboutPushes(question)) return '';
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
    return renderPushHistoryBlock(summary, titles, conversationText);
  } catch (e: any) {
    log.warn('push history read failed; emitting UNAVAILABLE rather than a false zero', {
      clientNumber, userId, error: e?.message,
    });
    return renderPushHistoryUnavailable(e?.message ? String(e.message).slice(0, 120) : 'read error');
  }
}
