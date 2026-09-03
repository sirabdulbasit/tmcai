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
interface RecentInteractions {
  prompts: Array<{
    at: Date | null; question: string; itemTitle: string | null;
    answeredAt: Date | null; answerText: string | null; state: string;
  }> | null;   // null = the read failed (unavailable ≠ none)
  transitions: Array<{
    at: Date; itemTitle: string | null; fromStatus: string; toStatus: string;
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
      question: true, openItemId: true, sentAt: true,
      answeredAt: true, answerText: true, state: true,
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

  const ids = [...new Set([
    ...(promptRows ?? []).map((p) => p.openItemId),
    ...(transitionRows ?? []).map((t) => t.openItemId),
  ].filter((x): x is string => !!x))];
  const titleRows = ids.length
    ? await Promise.resolve().then(() => prisma.openItem.findMany({
      where: { id: { in: ids }, clientNumber, userId },
      select: { id: true, title: true },
    })).catch(() => [] as Array<{ id: string; title: string | null }>)
    : [];
  const titles = new Map(titleRows
    .filter((r) => String(r.title ?? '').trim())
    .map((r) => [r.id, String(r.title).trim()]));

  return {
    prompts: promptRows === null ? null : promptRows.map((p) => ({
      at: p.sentAt, question: String(p.question ?? '').slice(0, 120),
      itemTitle: p.openItemId ? (titles.get(p.openItemId) ?? null) : null,
      answeredAt: p.answeredAt, answerText: p.answerText ? String(p.answerText).slice(0, 80) : null,
      state: p.state,
    })),
    transitions: transitionRows === null ? null : transitionRows.map((t) => ({
      at: t.createdAt,
      itemTitle: t.openItemId ? (titles.get(t.openItemId) ?? null) : null,
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
  const nameOf = (t: string | null) => (t
    ? `"${t}"`
    : 'an item whose title is not on record — report it as one you cannot name, never borrow a title');

  const promptLines = ix.prompts === null
    ? '(this record could not be read — say you cannot tell, do not guess)'
    : ix.prompts.length === 0
      ? `(you asked him nothing in the last ${hrs}h)`
      : ix.prompts.map((p) => {
        const answered = p.answeredAt
          ? `→ HE ANSWERED ${when(p.answeredAt)}${p.answerText ? `: "${p.answerText}"` : ''}`
          : `— ${p.state}, no answer yet`;
        return `- ${when(p.at)} you asked about ${nameOf(p.itemTitle)}: "${p.question}" ${answered}`;
      }).join('\n');

  const transitionLines = ix.transitions === null
    ? '(this record could not be read — say you cannot tell, do not guess)'
    : ix.transitions.length === 0
      ? `(no item status changes attempted in the last ${hrs}h)`
      : ix.transitions.map((t) => {
        const verdict = t.outcome === 'accepted'
          ? '✓'
          : `REFUSED${t.reason ? ` — recorded reason: ${t.reason}` : ''}`;
        return `- ${when(t.at)} ${nameOf(t.itemTitle)}: ${t.fromStatus} → ${t.toStatus} ${verdict}`;
      }).join('\n');

  const interactions = '\n\n## What you recently ASKED him, and what he answered (from brain_prompt_queue)\n'
    + `${promptLines}\n`
    + '\n## Item status changes you attempted (from item_status_history)\n'
    + `${transitionLines}\n`
    // The referent rule lives NEXT TO the referents, per DEF-165's finding that
    // a constraint beside the data outranks one in a rulebook. This is target
    // grounding, not wording: what he means is a fact these rows carry.
    + '\nWHEN HE FOLLOWS UP on one of these — "what you got it?", "which one?", "which\n'
    + 'approval?", a bare correction seconds after answering you — THE REFERENT IS IN THIS\n'
    + 'RECORD: the most recent line above is the thing he means. Name that item by its quoted\n'
    + 'title. A REFUSED line is the answer to "why isn\'t it closed" — report its recorded\n'
    + 'reason, in your own words. Never offer other items from elsewhere in your context\n'
    + 'while a line here matches the moment: offering unrelated items when the referent is\n'
    + 'on record is how you lost him before.\n';

  return `${header}${dispatchLines}${interactions}`;
}
