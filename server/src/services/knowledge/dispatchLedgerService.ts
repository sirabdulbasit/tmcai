/**
 * DEF-037 — what Brain actually DID, read from the record.
 *
 * The failure this exists to end, in the owner's words: *"did you inform hamna
 * about items delegated to her?"* → *"No Sir, I have not. I don't have a
 * contact entry for 'Hamna Latif'."* Brain had emailed her an hour earlier
 * (messageId 19fd12e8abc16d71) and held both her email and phone.
 *
 * It was not lying. It genuinely could not see its own past. The only place
 * dispatches reached the prompt was `renderArtifactsBlock(history)`, which
 * filters the CONVERSATION TRANSCRIPT for `role === 'artifact'` turns. Once an
 * action falls out of the trimmed history window — an hour and a dozen turns —
 * it is gone, and the model answers "did I?" by inference.
 *
 * The row was in `brain_action_artifacts` the whole time.
 *
 * Same root cause as DEF-019 ("my WhatsApp connection is degraded" while the DB
 * said connected for four days) and both DEF-034 denials. One class, one fix:
 *
 *     "DID I DO X?" IS A LEDGER QUERY, NEVER A TRANSCRIPT READ.
 *
 * Everything here is `observed` in provenance terms — a row that exists, with
 * an id and a timestamp. Nothing is inferred, so nothing in this block can be
 * a fabrication. That is the point: give the model facts it cannot make up.
 */
import prisma from '../../db/prisma';
import { promptSubjectItemId } from '../brainPrompts/brainPromptQueueService';
import { curatedMarkerMeaning } from './answerSanitizer';
import { isSystemMarker, stripMarkerEnvelope } from './systemMarker';
import createLogger from '../../utils/logger';

const log = createLogger('dispatch-ledger');

/** How far back "recently" reaches. Long enough to cover a working day, so
 *  "did you send that this morning?" is answerable at 6pm — the 08-05 failure
 *  was a one-hour gap and the transcript window had already lost it. */
async function lookbackHours(clientNumber: string): Promise<number> {
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    return await getBehaviorValue('brain.dispatch_ledger_lookback_hours', { clientNumber });
  } catch { return 36; }
}

const TERMINAL_OK = new Set(['succeeded', 'completed', 'sent']);

/** Human label per action type. Deliberately verb-first and past tense: the
 *  block is a record of things that HAPPENED. */
function describe(actionType: string): string {
  switch (actionType) {
    case 'send_email': return 'Emailed';
    case 'notify_via_whatsapp': return 'WhatsApped';
    case 'delegate_open_item': return 'Delegated';
    case 'add_open_item': return 'Created item';
    case 'update_open_item': return 'Updated item';
    case 'schedule_meeting': return 'Scheduled';
    case 'cancel_meeting': return 'Cancelled';
    case 'reschedule_meeting': return 'Rescheduled';
    case 'create_contact': return 'Saved contact';
    case 'update_contact': return 'Updated contact';
    default: return actionType.replace(/_/g, ' ');
  }
}

/** Pull the recipient/subject out of a stored payload without trusting its
 *  shape — payloads are JSON and have changed over time. */
function summarisePayload(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, any>;
  const bits: string[] = [];
  for (const key of ['recipientName', 'delegateeName', 'titleHint', 'title', 'subject', 'name']) {
    if (typeof p[key] === 'string' && p[key].trim()) { bits.push(p[key].trim()); break; }
  }
  for (const key of ['recipientPhone', 'recipientAdHocPhone', 'toAdHoc']) {
    const v = Array.isArray(p[key]) ? p[key][0] : p[key];
    if (typeof v === 'string' && v.trim()) { bits.push(v.trim()); break; }
  }
  return bits.join(' · ').slice(0, 120);
}

export interface LedgerEntry {
  at: Date;
  actionType: string;
  status: string;
  summary: string;
  externalId: string | null;
  delivery: string | null;
}

/** Every dispatch this user made recently, newest first. Facts only. */
export async function getRecentDispatches(
  userId: number,
  clientNumber: string,
  limit = 25,
): Promise<LedgerEntry[]> {
  const since = new Date(Date.now() - (await lookbackHours(clientNumber)) * 60 * 60 * 1000);
  try {
    const rows = await (prisma as any).brainActionArtifact.findMany({
      where: { userId, clientNumber, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        createdAt: true, actionType: true, status: true, payload: true,
        artifactExtId: true, errorMessage: true,
      },
    });

    // Delivery state for anything that went out over WhatsApp, from the acks
    // recorded by DEF-052. A tick is ground truth; "I think it sent" is not.
    const waIds = rows
      .filter((r: any) => r.actionType === 'notify_via_whatsapp' && r.artifactExtId)
      .map((r: any) => r.artifactExtId as string);
    const acks = waIds.length
      ? await prisma.whatsAppMessage.findMany({
        where: { messageId: { in: waIds }, direction: 'outbound' },
        select: { messageId: true, status: true },
      }).catch(() => [])
      : [];
    const ackByeId = new Map(acks.map((a: any) => [a.messageId, a.status]));

    return rows.map((r: any) => ({
      at: r.createdAt,
      actionType: r.actionType,
      status: r.status,
      summary: summarisePayload(r.payload) || (r.errorMessage ?? '').slice(0, 80),
      externalId: r.artifactExtId ?? null,
      delivery: r.artifactExtId ? (ackByeId.get(r.artifactExtId) ?? null) : null,
    }));
  } catch (error: any) {
    log.warn('ledger read failed', { userId, error: error?.message?.slice(0, 200) });
    return [];
  }
}

/**
 * DEF-293 — the deck tag `Answered a nudge, then asked which item Brain meant;
 * Brain could not name the item it had just acted on and offered unrelated
 * items` (DEF-280 + DEF-282, one class).
 *
 * CL-046, measured: Brain nudged him about the InDrive kickoff, he replied
 * "done", and thirty seconds later — asked *"what you got it?"* — Brain offered
 * two unrelated "Approve new team members" items. Session 21: his "Done" was
 * REFUSED by the transition matrix, and asked *"which approval?"* Brain again
 * named unrelated items. Both halves were STORED the whole time:
 * `brain_prompt_queue` holds the question Brain asked, when, and his answer;
 * `item_status_history` holds every attempted transition WITH the recorded
 * rejection reason (`recordHistory(..., 'rejected', …)`). Neither ever reached
 * the model's context — a context-block gap, not a storage gap, exactly like
 * DEF-037's "did you inform Hamna?" and fixed in the same place: this block,
 * which both composer paths already read, so no path can drift.
 *
 * Titles are JOINED (DEF-199): a bare `openItemId` invites a borrowed name,
 * which is this very defect. Read-only; every query (clientNumber, userId)-
 * scoped; a FAILED read renders as unavailable, never as a false "none"
 * (DEF-085).
 */
/**
 * DEF-301 — what he actually RECEIVED, not the machinery, and expanded BEFORE truncation.
 *
 * A notification's stored `question` can be a system marker. The live block was rendering
 * `[selfpruning_withdrawn: {"count":1,"titles":[...]}]` as though Brain had asked him that. He
 * never saw those characters — `answerSanitizer` expands the marker into curated prose on the
 * way out — so the record and the conversation disagreed, and the record is what the model
 * reasons from. That is how a follow-up gets answered about a string the owner never read.
 *
 * TWO THINGS DEFEATED THE OBVIOUS VERSION OF THIS FIX, and both were found by re-rendering the
 * block against live data rather than by reading it:
 *
 *   1. `systemMarker()` prefixes an INVISIBLE sentinel, and `isWholeMarker` /
 *      `curatedMarkerMeaning` both anchor on `[`. So they silently returned false and null
 *      against the real stored text. `isSystemMarker` / `stripMarkerEnvelope` are the
 *      sentinel-aware API the delivery path already uses.
 *   2. The question was being truncated to 120 chars BEFORE expansion, which cuts the marker's
 *      closing brace and makes its parser correctly reject it. So the expansion has to happen
 *      here, on the full text, and the truncation afterwards.
 *
 * Reuses the EXISTING expander rather than adding a parallel one, which would drift from the
 * constructor — `protection-with-two-implementations`, ten occurrences deep here.
 */
function shownQuestion(raw: string | null | undefined): string {
  const text = String(raw ?? '');
  const bare = isSystemMarker(text) ? stripMarkerEnvelope(text).trim() : text;
  // No `isWholeMarker` gate. It looked like the right guard and is the WRONG one: its pattern is
  // `\[[^\]]{2,200}\]`, which excludes `]`, so it returns false for every marker whose JSON body
  // contains an array — which is most of them, including the one that produced this defect.
  // `curatedMarkerMeaning` already returns null for anything it does not recognise, so it IS the
  // gate. Verified both against the real stored string: gate false, meaning correct.
  const meaning = curatedMarkerMeaning(bare);
  return (meaning ?? bare).slice(0, 120);
}

interface RecentInteractions {
  prompts: Array<{
    at: Date | null; question: string; hasItem: boolean; itemTitle: string | null;
    isThirdPartyQuote: boolean;
    itemOrigin: { feed: string | null; ref: string | null; createdAt: Date | null;
      sender: string | null; senderIsOpaqueId?: boolean; eventAt: Date | null } | null;
    answeredAt: Date | null; answerText: string | null; state: string;
  }> | null;   // null = the read failed (unavailable ≠ none)
  // DEF-311 — every outbound Brain actually SENT him, from the DEF-108
  // chokepoint's own audit table. Draft-asks, reminders and digests go
  // brainContactsUser → brain_user_messages and NEVER enter brainPromptQueue,
  // so "what is this?" about a just-received draft-ask used to resolve
  // against the nearest queue row — a different, older message.
  sends: Array<{ at: Date; kind: string; summary: string }> | null;
  transitions: Array<{
    at: Date; hasItem: boolean; itemTitle: string | null;
    itemOrigin: { feed: string | null; ref: string | null; createdAt: Date | null;
      sender: string | null; senderIsOpaqueId?: boolean; eventAt: Date | null } | null;
    fromStatus: string; toStatus: string;
    outcome: string; reason: string | null;
  }> | null;
}

async function getRecentInteractions(
  userId: number,
  clientNumber: string,
  since: Date,
): Promise<RecentInteractions> {
  // Deferred into the chain: a mock or client missing the model would throw
  // SYNCHRONOUSLY on property access, before .catch exists — the exact gap
  // DEF-274's fix recorded. Promise.resolve().then() makes the catch total.
  const promptRows = await Promise.resolve().then(() => prisma.brainPromptQueue.findMany({
    where: {
      clientNumber, userId,
      OR: [{ sentAt: { gte: since } }, { answeredAt: { gte: since } }],
    },
    orderBy: { id: 'desc' },
    take: 10,
    select: {
      question: true, openItemId: true, sentAt: true, queuedAt: true,
      answeredAt: true, answerText: true, state: true,
      // DEF-306 — needed by `promptSubjectItemId`. `preactive_due_nudge` records its subject in
      // `metadata.openItemId` and writes NOTHING to the column, so a join on the column alone
      // misses exactly the nudges he replies to.
      metadata: true,
    },
  })).catch(() => null);

  const transitionRows = await Promise.resolve().then(() => prisma.itemStatusHistory.findMany({
    where: { clientNumber, userId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      openItemId: true, fromStatus: true, toStatus: true,
      outcome: true, reason: true, createdAt: true,
    },
  })).catch(() => null);

  // DEF-311 — the third record: what was actually DELIVERED, from the one
  // audit table every outbound passes (DEF-108's chokepoint). `brain_prompt`
  // rows are excluded for one reason only: a queue-driven prompt already
  // renders above WITH his answer, and the same ask appearing twice would
  // re-create the two-lines-one-referent noise. Every other kind — the
  // draft-asks, reminders, digests, relays — exists ONLY here, which is
  // DEF-311's whole defect.
  const sendRows = await Promise.resolve().then(() => prisma.brainUserMessage.findMany({
    where: {
      clientNumber, userId,
      createdAt: { gte: since },
      status: { in: ['sent', 'partial'] },
      kind: { not: 'brain_prompt' },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { kind: true, summary: true, createdAt: true },
  })).catch(() => null);

  // DEF-306 — read the subject through the ACCESSOR, not off the column.
  //
  // He quoted a due-nudge and asked "from where you get it?", and Brain said "The record doesn't
  // show where it originally came from". Three things were true at once: the item held
  // `source_feed='gchat'` with a message ref; the open-items block is a 30-row window and that
  // item ranked 63rd of 93, so it was not in context; and THIS block, which did name the nudge,
  // joined on `open_item_id` — which is NULL on `preactive_due_nudge` rows because that producer
  // records its subject in `metadata.openItemId` instead. So the one block that knew the referent
  // could not resolve it.
  //
  // `promptSubjectItemId` was written for precisely this (DEF-120) and reads both places. Using
  // it here rather than adding a second lookup: its own doc says a guard consulting one place
  // "protects some producers and silently ignores others", which is what this block was doing.
  const ids = [...new Set([
    ...(promptRows ?? []).map((p) => promptSubjectItemId(p as any)),
    ...(transitionRows ?? []).map((t) => t.openItemId),
  ].filter((x): x is string => !!x))];
  // DEF-306 — the referent's PROVENANCE travels with the referent.
  //
  // He quoted a nudge and asked "from where you get it?", and Brain answered "The record doesn't
  // show where it originally came from". The record showed it perfectly well: that item carries
  // `source_feed='gchat'` with a message ref and a 2026-08-29 date. What happened is that the
  // open-items block is a WINDOW — `take: OPEN_ITEMS_PAGE` (30), ordered by newest first — and
  // the item ranked **63rd of 93** active items, so it was never in front of the model. Absence
  // from a page was reported as absence from the world, which is DEF-037's class exactly, and
  // DEF-260's own comment predicted the shape: "the answer depended on which block had run".
  //
  // Fixed HERE rather than by enlarging the page, because enlarging it only moves the cliff. This
  // join already resolves the titles of the items Brain recently prompted about — at most ten —
  // so it is the one place that knows the referent by id. Carrying `sourceFeed`/`sourceRef` on
  // the same rows puts the provenance next to the thing a follow-up is about, at no extra query.
  const titleRows = ids.length
    ? await Promise.resolve().then(() => prisma.openItem.findMany({
      where: { id: { in: ids }, clientNumber, userId },
      select: {
        id: true, title: true, sourceFeed: true, sourceRef: true, createdAt: true,
        // DEF-313 — the author. `source_feed_event_id` is populated on 94 of 95 live items and
        // the feed event carries `sender_name`/`sender_email`; the join was simply never made on
        // the answer path, which is why "to whom did i do this chat?" had no answer while the
        // record held one.
        sourceFeedEventId: true,
      } as any,
    })).catch(() => [] as Array<{
      id: string; title: string | null; sourceFeed?: string | null;
      sourceRef?: string | null; createdAt?: Date | null; sourceFeedEventId?: string | null;
    }>)
    : [];

  // DEF-313 — one more read, for the half of "background" that was missing.
  //
  // Owner, 2026-09-04: *"brain don't know the proper background"*, and *"it said 'Plan session
  // for thursday' taken from google chat, but didnt tell me to whom i talked"*. Measured that
  // day: the item is `gmail`, its feed event's sender is `Basit Ahmed <basit.ahmed@tmcltd.com>`
  // and its `event_at` is 01 Sep — an email, from him. Brain had never read past `source_feed`.
  //
  // Two facts are added here and they are deliberately kept apart:
  //   · WHO it came from, and WHEN IT HAPPENED (`event_at`)
  //   · when BRAIN FIRST RECORDED it (`createdAt`) — already carried
  // Collapsing those is the other half of the same complaint: Brain answered "September 2nd",
  // its own ingest date, for an email written on the 1st. "When I learned it" is not "when it
  // happened", and a background answer that gives the first is answering a different question.
  const feedIds = [...new Set(titleRows
    .map((r: any) => r.sourceFeedEventId).filter((x: any): x is string => !!x))];
  const feedRows: any[] = feedIds.length
    ? await Promise.resolve().then(() => (prisma as any).feedEvent.findMany({
      where: { id: { in: feedIds }, clientNumber },
      select: { id: true, senderName: true, senderEmail: true, eventAt: true },
    })).catch(() => [])
    : [];
  const feedById = new Map(feedRows.map((f: any) => [f.id, f]));
  const titles = new Map(titleRows
    .filter((r) => String(r.title ?? '').trim())
    .map((r) => [r.id, String(r.title).trim()]));
  const provenance = new Map(titleRows.map((r: any) => {
    const f = r.sourceFeedEventId ? feedById.get(r.sourceFeedEventId) : null;
    // Prefer a name, fall back to an address. An OPAQUE PROVIDER ID IS NOT A NAME: all 25 live
    // gchat items store their sender as `users/1124…`, and rendering that as though it were a
    // person is the DEF-121 mistake — a fabricated-looking identifier reads as actionable, which
    // is worse than admitting the gap. It is passed through labelled as unidentified so the
    // model says so instead of inventing a person, and so the gap is visible rather than silent.
    const raw = f ? (f.senderName ?? f.senderEmail ?? null) : null;
    const opaque = !!raw && /^users\/\d+$/.test(String(raw));
    return [r.id, {
      feed: r.sourceFeed ? String(r.sourceFeed) : null,
      ref: r.sourceRef ? String(r.sourceRef) : null,
      createdAt: r.createdAt ?? null,
      sender: raw ? String(raw) : null,
      senderIsOpaqueId: opaque,
      eventAt: f?.eventAt ?? null,
    }];
  }));

  return {
    sends: sendRows === null ? null : sendRows.map((r) => ({
      at: r.createdAt, kind: String(r.kind), summary: String(r.summary ?? '').slice(0, 160),
    })),
    prompts: promptRows === null ? null : promptRows.map((p) => ({
      // DEF-301 — `sentAt` alone left the two most recent lines rendering their date as `?`,
      // because a prompt can be answered without ever having been marked sent. An undated line
      // is not a cosmetic problem here: the referent rule below says "the most recent line above
      // is the thing he means", and an undated line cannot be ordered. `queuedAt` is NOT NULL.
      at: p.sentAt ?? p.queuedAt,
      question: shownQuestion(p.question),
      // DEF-301 — "no item was involved" and "there is an item but I could not find its title"
      // are different facts and were collapsed into one. Carried separately so the renderer can
      // stop telling the model "you asked about an item" about prompts that had no item.
      hasItem: !!promptSubjectItemId(p as any),
      // DEF-313 — whose words are these? Used ONLY to label the background block, never to
      // decide the referent: the referent stays item-based so a relay producer that forgets
      // these markers still cannot become a referent. Labelling may fail open; the referent
      // may not.
      isThirdPartyQuote: (() => {
        const m: any = (p as any).metadata ?? {};
        return m.provenance === 'quoted_third_party'
          || m.source === 'unattached_counterpart_reply'
          || !!m.from;
      })(),
      itemTitle: (() => { const k = promptSubjectItemId(p as any); return k ? (titles.get(k) ?? null) : null; })(),
      itemOrigin: (() => { const k = promptSubjectItemId(p as any); return k ? (provenance.get(k) ?? null) : null; })(),
      answeredAt: p.answeredAt, answerText: p.answerText ? String(p.answerText).slice(0, 80) : null,
      state: p.state,
    })),
    transitions: transitionRows === null ? null : transitionRows.map((t) => ({
      at: t.createdAt,
      hasItem: !!t.openItemId,
      itemTitle: t.openItemId ? (titles.get(t.openItemId) ?? null) : null,
      itemOrigin: t.openItemId ? (provenance.get(t.openItemId) ?? null) : null,
      fromStatus: t.fromStatus, toStatus: t.toStatus,
      outcome: t.outcome, reason: t.reason,
    })),
  };
}

/**
 * The prompt block. An EMPTY block is meaningful and must be rendered as such:
 * "nothing dispatched" is a fact, and omitting the block entirely would let the
 * model fall back on inference — which is the whole defect.
 */
export async function buildDispatchLedgerBlock(
  userId: number,
  clientNumber: string,
): Promise<string> {
  const entries = await getRecentDispatches(userId, clientNumber);

  const hrs = await lookbackHours(clientNumber);
  const header = `# What you actually did (last ${hrs}h — the DISPATCH RECORD, not the conversation)\n`
    + 'This is the only valid source for "did you…?" / "have you…?" questions about your own\n'
    + 'actions. If something is not listed here, you did NOT do it in this window — say so.\n'
    + 'If it IS listed, you did, even if this conversation does not mention it.\n'
    // ── DEF-226 — EVERY ROW HERE IS YOU ─────────────────────────────────────
    //
    // The regression guard fired on `B12-reminder-referent`, C8 100 → 80, with
    // the judge naming it exactly: *"the reference to 'the system' creating the
    // duplicate feels like it's trying to distance itself from the action,
    // rather than owning it."* The reply was "It looks like THE SYSTEM sent you
    // a duplicate reminder" — after three consecutive runs in which the same
    // case said "I sent the reminder twice."
    //
    // The rows below are subjectless event lines (`- 08-17 12:04 ✓ WhatsApped:
    // …`). A model reading a log of events can narrate them in the third person
    // without ever making a false statement, and that is what happened.
    //
    // DEF-165 put the CAUSE boundary here rather than in the rulebook, on the
    // finding that "a constraint placed next to the data outranks one placed in
    // a rulebook". This is the AGENT boundary, and it belongs in the same place
    // for the same reason. They are different questions: DEF-165's paragraph
    // forbids naming "a system glitch" as the CAUSE, and says nothing about who
    // performed the action.
    + '\nEVERY LINE BELOW IS SOMETHING **YOU** DID. There is no other actor in this record:\n'
    + '"the system", "an automated process", "a background job" and "the platform" are you,\n'
    + 'described from outside. Say "I sent it", never "the system sent it" — the second\n'
    + 'disowns your own action and he has to work out that you mean yourself. Owning a\n'
    + 'mistake plainly ("I sent it twice, and I don\'t know why") is the whole of what is\n'
    + 'wanted here; distancing yourself from it is not modesty, it is inaccuracy.\n'
    // ── DEF-165 — the boundary this block never stated ──────────────────────
    //
    // Codex's iteration-18 HIGH #2. Asked "Why did you remind me about that one
    // twice?", Brain answered "That was a system stutter on my end" — with this
    // block in the prompt saying nothing had been dispatched. Iteration 18 put
    // "don't diagnose yourself" in the core rulebook and it lost: a general rule
    // twenty blocks away does not compete with an unanswered question in front of
    // the model, which fills the silence.
    //
    // So the boundary is stated HERE, beside the evidence, in the block whose
    // authority the model already honours for "did you…?". The lesson of
    // `examples-outvote-the-instruction` (DEF-138) run forwards: a constraint
    // placed next to the data outranks one placed in a rulebook.
    //
    // It is deliberately about the SHAPE of the record rather than a list of
    // forbidden words — Codex was explicit that chasing "glitch/stutter/sync/job"
    // synonyms with a regex is not the fix, and the regex in `responseValidator`
    // guards cures, not causes.
    // DEF-166 / Codex iteration-20 MEDIUM #4: this said WHY is "nowhere else
    // either", which this builder cannot know — it establishes only that the
    // dispatch artifact has no cause field. A health finding or a scheduler row
    // may well contain one, and instructing the model to say "not recorded" while
    // such evidence sits elsewhere in the prompt would make it withhold what it
    // has. Scoped to this record, with the deferral to other evidence explicit.
    + '\nWHY something happened is NOT in THIS record. It has no cause field, no error\n'
    + 'attribution and no root-cause log. So when asked WHY you did something — why a\n'
    + 'reminder went twice, why a message was late — report what this record shows, then\n'
    + 'check whether any OTHER block above carries a recorded cause (a health finding, a\n'
    + 'scheduler or job record). If one does, use it and cite it. If none does, say plainly\n'
    + 'that the cause is not recorded.\n'
    // ── DEF-228 — THE MENU WAS THE SOURCE ───────────────────────────────────
    //
    // This paragraph used to enumerate four candidate causes — "a system
    // glitch", "a sync issue", "a duplicate job", "a stutter on my end" — as
    // examples of what NOT to say. `iter-18-post-build.json` measured the
    // result: *"It looks like **a stutter on my end** caused the duplicate
    // reminder. I can see I sent it twice, but I don't have a record of why it
    // repeated."* C1 85, the judge calling it "a slight contradiction". The
    // model took a phrase off the list this block printed. `iter-14` produced
    // the same phrase.
    //
    // That is `examples-outvote-the-instruction` (DEF-138) in the production
    // prompt, and I have fixed the identical mistake in my own GUARDS three
    // times (DEF-213's list, DEF-214's `17:07`, DEF-226's whole-block regex)
    // without once fixing it here.
    //
    // IT DOES NOT REVERSE DEF-213 OR DEF-226, and the distinction is the whole
    // finding: those two named a phrase THE OWNER HAD ALREADY RECEIVED ("my
    // dispatch log", "the system sent it"), which removes ambiguity about a
    // sentence that exists. This one enumerated HYPOTHETICALS for a cause the
    // model has to invent, which is a menu. Name what he got; never list what
    // he might get.
    //
    // So the prohibition stays and the menu goes, replaced by the TEST — any
    // sentence naming a mechanism is invented, whatever the mechanism is.
    + 'Naming ANY mechanism is a fabricated finding, however technical or modest it\n'
    + 'sounds — if your sentence explains HOW it happened, you invented the how, because\n'
    + 'this record does not contain one. "I sent it twice — I can see that, but I do not\n'
    + 'have a record of why" is the complete and correct answer.\n';

  const dispatchLines = entries.length === 0
    ? `(no actions dispatched in the last ${hrs} hours)`
    : entries.map((e) => {
      const when = e.at.toISOString().slice(5, 16).replace('T', ' ');
      const ok = TERMINAL_OK.has(e.status);
      const state = ok ? '✓' : e.status;
      const delivery = e.delivery ? ` [${e.delivery}]` : '';
      const ref = e.externalId ? ` id=${e.externalId.slice(-12)}` : '';
      return `- ${when} ${state} ${describe(e.actionType)}${e.summary ? `: ${e.summary}` : ''}${delivery}${ref}`;
    }).join('\n');

  // DEF-293 — the two interaction records this block never carried (rationale
  // on getRecentInteractions above). Rendered every turn, because an absent
  // record is what let the model offer unrelated items with confidence.
  const since = new Date(Date.now() - hrs * 60 * 60 * 1000);
  const ix = await getRecentInteractions(userId, clientNumber, since);
  const when = (d: Date | null) => (d ? d.toISOString().slice(5, 16).replace('T', ' ') : '?');
  /**
   * DEF-301 — three distinct facts, previously two of them collapsed into one sentence that
   * asserted the third.
   *
   * The old renderer produced "you asked about an item whose title is not on record — report it
   * as one you cannot name, never borrow a title" for EVERY prompt with no `openItemId`. Most of
   * those prompts were never about an item at all — they are relayed messages and notifications —
   * so the line stated a false premise (that an item exists) and then argued policy inside a data
   * row. DEF-273 is exactly this lesson: a block that supplies evidence must not also argue about
   * what may be done with it, because the prose wins. The rule now lives in the header only.
   */
  /**
   * DEF-306 — where the item came from, rendered beside its name.
   *
   * "from where you get it?" is answered from this, and the alternative is what happened: the
   * item was 63rd of 93 in a 30-row window, so it was absent from context and Brain reported
   * that as absent from the record.
   */
  const originOf = (o: {
    feed: string | null; ref: string | null; createdAt: Date | null;
    sender?: string | null; senderIsOpaqueId?: boolean; eventAt?: Date | null;
  } | null) => {
    if (!o || (!o.feed && !o.createdAt)) return '';
    const bits: string[] = [];
    if (o.feed) bits.push(`came in via ${o.feed}`);
    // DEF-313 — WHO, next to the channel it arrived on. This is the whole of "background": the
    // channel alone was never an answer to "to whom did i do this chat?".
    if (o.sender) {
      bits.push(o.senderIsOpaqueId
        ? `from a ${o.feed ?? 'chat'} participant I have NOT yet identified (provider id ${o.sender}) `
          + '— say exactly that, never guess a name and never borrow one from elsewhere'
        : `from ${o.sender}`);
    }
    // DEF-313 — when it HAPPENED, kept separate from when Brain recorded it. He was told
    // "September 2nd" for an email written on the 1st, because only the ingest date was carried.
    if (o.eventAt) bits.push(`sent ${when(o.eventAt)}`);
    if (o.createdAt) bits.push(`which I first recorded ${when(o.createdAt)}`);
    // The ref is a thread/message id. Included because it is the actual answer to "from where",
    // and truncated because it is an identifier, not prose.
    if (o.ref) bits.push(`ref ${String(o.ref).slice(0, 60)}`);
    return ` [${bits.join(', ')}]`;
  };

  const nameOf = (r: { hasItem: boolean; itemTitle: string | null }) => {
    if (r.itemTitle) return `"${r.itemTitle}"`;
    if (r.hasItem) return 'an item that is on record but whose title I could not read';
    return 'nothing on the item list — this was a message or notification, not an item';
  };

  // ↻ DEF-293 (iteration 72) — Codex's LOW finding on the shipped diff, and its
  // own directive #5: "the most recent line above" used to span TWO separately
  // sorted sub-blocks (prompts, then transitions), so the single most-recent
  // interaction could top EITHER block and the model had to compare rendered
  // timestamps to know which. "Most recent" is now true BY CONSTRUCTION: one
  // merged list, newest first. A prompt sorts by its newest fact — the answer
  // when one exists — because "the thing he means" after answering is the
  // exchange, not the moment the question was queued.
  // DEF-313 — the referent set may contain ONLY lines that name one of his items.
  //
  // Owner, 2026-09-04: *"the replies brain is corelating with Hamna Latif, which is totally
  // wrong"*. He is right, and Brain was obeying its instructions. The rule below says "the TOP
  // line is the most recent thing between you"; the live list's top line was
  // `Hamna Latif Bhutta replied: "Apn Ghar hi"` — a THIRD PARTY'S words, relayed, carrying no
  // item — so that is what it named. SIX of the ten lines were not candidate answers at all:
  // four counterpart relays, a self-prune marker and a connector warning.
  //
  // DEF-293 already made this list correctly time-ordered and the defect happened anyway,
  // which is the proof that ordering is not the fix: a correctly ordered list of the WRONG KIND
  // of thing still puts the wrong thing first. The list conflated *what Brain told him* with
  // *what other people told Brain*, and then ranked them against each other by time, so a
  // stranger's "Apn Ghar hi" outranked the reminder he was actually asking about.
  //
  // The discriminator is an INVARIANT, not a list of excluded sources: **does this line name an
  // open item?** His follow-ups — "which one?", "what is this?", "from where you get it?" — are
  // questions ABOUT AN ITEM, and a line with no item cannot answer one. A relay producer added
  // next month is excluded without being listed anywhere, which is the guardrail shape
  // BRAIN_VISION requires ("an invariant about ANY action, never a list of which are allowed").
  // Enumerating `provenance: 'quoted_third_party'` instead would be an allow-list with the usual
  // hole: the first producer that forgets the marker becomes the next Hamna.
  //
  // Non-item lines are NOT dropped — dropping them would lose real context, and a bare "yes"
  // after a non-item question still needs them. They move to a clearly labelled background
  // section that the referent rule does not range over.
  type MergedLine = { at: Date | null; line: string; isReferentCandidate: boolean };
  const promptRows: MergedLine[] | null = ix.prompts === null ? null : ix.prompts.map((p) => {
    const answered = p.answeredAt
      ? `→ HE ANSWERED ${when(p.answeredAt)}${p.answerText ? `: "${p.answerText}"` : ''}`
      : `— ${p.state}, no answer yet`;
    return {
      at: p.answeredAt ?? p.at,
      // DEF-313 — a relayed message is not something "you asked". Rendering every line with
      // that prefix is how `Hamna Latif Bhutta replied: "Apn Ghar hi"` came to sit under the
      // heading "Your recent interactions with him" reading as Brain's own words. A block whose
      // rows contradict its own header is `prompt-contradicts-itself`, already twice recorded.
      line: p.isThirdPartyQuote
        ? `- ${when(p.at)} SOMEONE ELSE'S WORDS, relayed to you (not yours, not about an item): "${p.question}" ${answered}`
        : `- ${when(p.at)} you asked, re ${nameOf(p)}${originOf(p.itemOrigin)}: "${p.question}" ${answered}`,
      isReferentCandidate: p.hasItem,
    };
  });
  const transitionRows: MergedLine[] | null = ix.transitions === null ? null : ix.transitions.map((t) => {
    const verdict = t.outcome === 'accepted'
      ? '✓'
      : `REFUSED${t.reason ? ` — recorded reason: ${t.reason}` : ''}`;
    return {
      at: t.at,
      line: `- ${when(t.at)} status change, ${nameOf(t)}${originOf(t.itemOrigin)}: ${t.fromStatus} → ${t.toStatus} ${verdict}`,
      // A status change is always about an item — that is what it is.
      isReferentCandidate: true,
    };
  });

  // A FAILED read stays distinguishable from an empty one (DEF-085): the
  // readable half still renders, and the unreadable half is NAMED.
  const unreadable: string[] = [];
  if (promptRows === null) unreadable.push('the prompts-you-asked record');
  if (transitionRows === null) unreadable.push('the item-status-change record');
  if (ix.sends === null) unreadable.push('the messages-you-sent record');
  const unreadableNote = unreadable.length
    ? `\n(${unreadable.join(' and ')} could not be read — for that part say you cannot tell, do not guess)`
    : '';

  const allLines = [...(promptRows ?? []), ...(transitionRows ?? [])]
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));
  // DEF-313 — one sort, then one split. Sorting each half separately would rebuild exactly the
  // two-separately-sorted-sub-blocks problem DEF-293 removed.
  const merged = allLines.filter((m) => m.isReferentCandidate).map((m) => m.line);
  const background = allLines.filter((m) => !m.isReferentCandidate).map((m) => m.line);

  let interactionBody: string;
  if (merged.length > 0) {
    interactionBody = merged.join('\n') + unreadableNote;
  } else if (unreadable.length >= 2) {
    // ↻ DEF-311 — generic over the record count: the hardcoded "neither" broke
    // the moment a third record joined. Name what is unreadable, whatever N is.
    interactionBody = `(${unreadable.join(' and ')} could not be read — say you cannot tell, do not guess)`;
  } else if (unreadable.length === 1) {
    interactionBody = `(nothing in the readable record for the last ${hrs}h)${unreadableNote}`;
  } else {
    interactionBody = `(you asked him nothing about one of his items in the last ${hrs}h)`;
  }

  // DEF-313 — the background half, labelled for what it is. These lines were previously mixed
  // into the list above under the heading "Your recent interactions with him", which is how a
  // third party's WhatsApp message came to read as something Brain had said to him.
  const backgroundBlock = background.length
    ? '\n\nALSO IN THE WINDOW, and NONE of it names one of his items — this is background, '
      + 'NOT a referent.\nLines marked SOMEONE ELSE\'S WORDS were written by other people and '
      + 'relayed to him; they are\nnot yours and not his. Never answer "which item did you '
      + 'mean?" or "where did this come\nfrom?" using a line from this block:\n'
      + background.join('\n')
    : '';

  // DEF-311 — the deck tag: `Asked "what is this?" about the message he had
  // just received and Brain answered about a different, older one — never said
  // two were outstanding`. These are Brain's OWN outbound messages, so they are
  // valid referents for a MESSAGE question — but they name no open item, so
  // they must not join the item-referent list (DEF-313's invariant), and they
  // are not other people's words, so they must not sit under the background
  // block's "never answer from here". A third, labelled section, with its own
  // rule beside it.
  const sendsBlock = ix.sends === null
    ? ''
    : ix.sends.length === 0
      ? `\n\nMESSAGES YOU SENT HIM (delivery record): none besides the prompts above in the last ${hrs}h.\n`
      : '\n\nMESSAGES YOU SENT HIM — NEWEST FIRST (from brain_user_messages, the delivery record'
        + ' every outbound passes; prompts with his answers are listed above instead):\n'
        + ix.sends.map((r) => `- ${when(r.at)} you sent [${r.kind.replace(/_/g, ' ')}]: ${r.summary}`).join('\n')
        + '\n\nWHEN HE ASKS "what is this?" ABOUT A MESSAGE HE JUST RECEIVED, the referent is the'
        + '\nNEWEST line across this section and the prompts above — never an older message when a'
        + '\nnewer one exists. If MORE THAN ONE went out recently, SAY so and name the newest'
        + '\nrather than silently picking one: answering about the wrong message without naming'
        + '\nthe other is the exact failure he reported.\n';

  const interactions = '\n\n## Your recent interactions with him ABOUT HIS ITEMS — NEWEST FIRST (prompts you asked, from brain_prompt_queue; status changes you attempted, from item_status_history)\n'
    // DEF-301 — the never-borrow-a-title rule, stated ONCE here instead of inside every row.
    + 'Where a line names no title, you do not have one: say so rather than borrowing a title\n'
    + 'from elsewhere in your context.\n'
    + `${interactionBody}${sendsBlock}${backgroundBlock}\n`
    // The referent rule lives NEXT TO the referents, per DEF-165's finding that
    // a constraint beside the data outranks one in a rulebook. This is target
    // grounding, not wording: what he means is a fact these rows carry.
    + '\nWHEN HE FOLLOWS UP on one of these — "what you got it?", "which one?", "which\n'
    + 'approval?", "what is this?", "from where you get it?", a bare correction seconds after\n'
    + 'answering you — THE REFERENT IS IN THE ITEM LIST ABOVE, which is NEWEST FIRST: its TOP\n'
    + 'line is the default reading of what he means. Name that item by its quoted title.\n'
    // DEF-313 — the referent may never be drawn from the background block. Stated here, beside
    // the data, per DEF-165: a constraint next to the rows outranks one in a rulebook.
    + 'NEVER take the referent from the background block: those lines name no item, and some\n'
    + 'of them are other people\'s words. Answering "which item?" with a relayed message from\n'
    + 'someone else is the exact failure he reported on 2026-09-04.\n'
    // DEF-313 — background is now a real answer, so the rule for it is stated too.
    + 'WHEN HE ASKS WHERE AN ITEM CAME FROM or WHO IT WAS WITH, the origin is on that item\'s\n'
    + 'own line: give the channel, the person and the date it was SENT — and say plainly when\n'
    + 'the sender is a provider id you have not resolved to a person. "first recorded" is when\n'
    + 'YOU logged it, which is NOT when it happened; never offer the one as the other.\n'
    + 'A REFUSED line is the answer to "why isn\'t it closed" — report its recorded\n'
    + 'reason, in your own words. Never offer other items from elsewhere in your context\n'
    + 'while a line here matches the moment: offering unrelated items when the referent is\n'
    + 'on record is how you lost him before.\n';

  return `${header}${dispatchLines}${interactions}`;
}
