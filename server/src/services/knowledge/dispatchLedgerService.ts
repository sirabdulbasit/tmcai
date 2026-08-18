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

  if (entries.length === 0) {
    return `${header}(no actions dispatched in the last ${hrs} hours)`;
  }

  const lines = entries.map((e) => {
    const when = e.at.toISOString().slice(5, 16).replace('T', ' ');
    const ok = TERMINAL_OK.has(e.status);
    const state = ok ? '✓' : e.status;
    const delivery = e.delivery ? ` [${e.delivery}]` : '';
    const ref = e.externalId ? ` id=${e.externalId.slice(-12)}` : '';
    return `- ${when} ${state} ${describe(e.actionType)}${e.summary ? `: ${e.summary}` : ''}${delivery}${ref}`;
  });

  return `${header}${lines.join('\n')}`;
}
