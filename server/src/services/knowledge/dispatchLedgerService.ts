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
const LOOKBACK_HOURS = 36;

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
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
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

  const header = '# What you actually did (last 36h — the DISPATCH RECORD, not the conversation)\n'
    + 'This is the only valid source for "did you…?" / "have you…?" questions about your own\n'
    + 'actions. If something is not listed here, you did NOT do it in this window — say so.\n'
    + 'If it IS listed, you did, even if this conversation does not mention it.\n';

  if (entries.length === 0) {
    return `${header}(no actions dispatched in the last 36 hours)`;
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
