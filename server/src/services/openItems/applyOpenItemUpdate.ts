/**
 * Shared open-item field update — the single implementation used by BOTH
 * the inline reasoning path and the confirmed-plan dispatcher.
 *
 * WHY IT IS SHARED (2026-08-04): `update_open_item` is in the action
 * registry, so the plan validator accepted it, the preview rendered it, and
 * the owner confirmed it — but `dispatchPendingDirect` had no case for that
 * kind, so the confirmed plan died with
 * `[Unknown pending action kind: updateopenitem]` and three dictated
 * priority+deadline updates were lost. A working implementation existed the
 * whole time, inline in the composer, unreachable from the confirmed path.
 *
 * That is the same shape as the @lid resolver living privately in one
 * consumer: one implementation, one caller, and every new caller silently
 * broken. Hence a shared module rather than a second copy.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
// DEF-227 — ONE vocabulary for "what was applied", shared with the inline
// composer branch. A second copy of the sentence here is what produced the
// defect this closes.
import {
  appliedChanges,
  actionAppliedMarker,
  type AppliedChange,
} from '../knowledge/actionReceipt';

const log = createLogger('open-item-update');

export interface OpenItemUpdateInput {
  clientNumber: string;
  userId: number;
  openItemId: string;
  title?: string;
  priority?: string;
  /** RAW user phrase ("friday", "tomorrow") — resolved server-side. */
  dueDateRaw?: string;
  note?: string;
}

export interface OpenItemUpdateResult {
  ok: boolean;
  /**
   * DEF-227 — what the OWNER reads. A provenance-stamped applied-marker whose
   * curated meaning is composed from the fields (DEF-220), not the machine
   * receipt. On the confirmed-plan path this value IS the reply, so leaving the
   * receipt here put `Updated "…": priority=high.` on his screen — the exact
   * string DEF-212, DEF-219 and DEF-220 were each written to eliminate, alive
   * in a second implementation none of them touched.
   */
  message: string;
  /**
   * The machine receipt, unchanged and still true by construction. DEF-144
   * ruled it stays the AUDIT record; it just stops being the sentence.
   */
  receipt?: string;
  /** The fields the database actually received, for callers that compose their own. */
  applied?: AppliedChange[];
  /** The item's title as it stands after the write. */
  title?: string;
  artifactId?: string;
}

const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);

/** Normalise the LLM's free-form priority word. 'normal' → 'medium' is the
 *  synonym users type most; anything unrecognised is ignored rather than
 *  guessed at. */
export function normalisePriority(raw: string | undefined): string | null {
  const p = String(raw ?? '').toLowerCase().trim();
  if (!p) return null;
  if (VALID_PRIORITIES.has(p)) return p;
  if (p === 'normal') return 'medium';
  return null;
}

export async function applyOpenItemUpdate(
  input: OpenItemUpdateInput,
): Promise<OpenItemUpdateResult> {
  const existing = await prisma.openItem.findFirst({
    where: { id: input.openItemId, clientNumber: input.clientNumber, userId: input.userId },
    select: { id: true, title: true, status: true, priority: true, dueDate: true, metadata: true },
  });
  if (!existing) {
    return { ok: false, message: '[update_open_item: id not found — reference may be stale, retry by title]' };
  }

  const data: any = {};
  if (input.title) data.title = input.title;
  if (input.note != null) data.description = input.note;

  const priority = normalisePriority(input.priority);
  if (priority) data.priority = priority;

  // Date math is a calculator's job, never the LLM's (Basit 2026-05-23):
  // reasoning emits the raw phrase and the server resolves it in the user's
  // timezone.
  if (input.dueDateRaw) {
    const { resolveDate } = await import('../knowledge/dateResolver');
    const iso = await resolveDate(input.dueDateRaw, input.userId);
    if (!iso) {
      return { ok: false, message: `[update_open_item: couldn't parse dueDate "${input.dueDateRaw}" — try a specific date]` };
    }
    data.dueDate = new Date(`${iso}T00:00:00Z`);
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, message: '[update_open_item: no recognised fields to update]' };
  }

  // A DRAFT becomes NEW once both required slots exist — this is what stops
  // Nexeo re-asking for a priority the owner already dictated.
  const md = (existing.metadata as any)?.draft;
  const willHavePriority = data.priority || (existing.priority && existing.priority !== 'medium');
  const willHaveDueDate = data.dueDate || existing.dueDate;
  if (existing.status === 'DRAFT' && willHavePriority && willHaveDueDate) {
    data.status = 'NEW';
    data.metadata = { ...(md ? { draft: null } : {}) };
  }

  await prisma.openItem.update({ where: { id: existing.id }, data });

  const changes: string[] = [];
  if (data.priority) changes.push(`priority=${data.priority}`);
  if (data.dueDate) changes.push(`due=${data.dueDate.toISOString().slice(0, 10)}`);
  if (data.title) changes.push(`title="${data.title}"`);
  if (data.status === 'NEW') changes.push('status=NEW (DRAFT completed)');
  log.info('open item updated', { openItemId: existing.id, changes });

  const receipt = `Updated "${data.title ?? existing.title}": ${changes.join(', ')}.`;
  const title = String(data.title ?? existing.title);
  const applied = appliedChanges(data as Record<string, unknown>);

  return {
    ok: true,
    artifactId: existing.id,
    // DEF-227 — the owner-facing value is the marker; the receipt travels
    // beside it for the ledger. When nothing in the shared vocabulary was
    // written there is no fact to compose, so the receipt stays the message —
    // the DEF-220 fail-closed rule, unchanged.
    //
    // MUTATION HONESTY: removing this guard kills no test today, because every
    // key this function can put in `data` except `metadata` is in the shared
    // vocabulary, and `metadata` is only ever set alongside `status`. So the
    // branch is unreachable NOW. It is kept rather than deleted — unlike the
    // genuinely redundant check DEF-221 removed — because the failure it
    // prevents is silent: `appliedMarkerMeaning` rejects a zero-field payload,
    // so a future internal-only field would mint an uncurated marker and the
    // owner would read the neutral fallback instead of the truth.
    message: applied.length > 0 ? actionAppliedMarker({ title, applied }) : receipt,
    receipt,
    applied,
    title,
  };
}
