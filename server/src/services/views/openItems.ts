/**
 * Canonical view: open items.
 *
 * The ONE function every reader of a user's open-items list must call —
 * Action Center UI, Brain Chat composer snapshot, WhatsApp Brain, Day
 * Brief Open Items section, daily digest jobs.
 *
 * Wraps openItemsService.listItems so the lower-level filter / sort /
 * smoke-exclusion logic stays in one place. This file exposes a stable,
 * typed return shape so the LLM context block and the UI card renderer
 * can rely on the same fields.
 *
 * Per Basit 2026-05-20: "brain should have same knowledge, same feed,
 * same open item as it is showing in tai.tmcltd, brain chat or whatsap
 * chat all three conversation, information, sources should be the same."
 */
import * as openItemsService from '../openItemsService';

export interface OpenItemRow {
  id: string;
  itemNumber: number;
  title: string;
  status: string;
  priority: string;
  ownerId: number;
  delegateeId: number | null;
  delegateeName: string | null;
  delegateeEmail: string | null;
  dueDate: Date | null;
  sourceFeed: string | null;
  archetype: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GetOpenItemsOpts {
  /** Cap on rows returned. Default: no cap (the UI's "All" tab lists every
   *  active item). brainComposer passes 30; Day Brief picks top 3 from
   *  the resulting list. */
  limit?: number;
  /** Drop test/regression items (metadata.smoke=true). Default true. */
  excludeSmoke?: boolean;
  /** Optional priority filter. Default: all priorities included. */
  priority?: string;
  /** Optional explicit status set. Default: active statuses only
   *  (excluding closed / done / archived, case-insensitive). */
  statuses?: string[];
}

/**
 * Fetch a user's active open items. All callers — UI, Brain, jobs —
 * route through here.
 *
 * Defaults match the Action Center "All" tab:
 *   - every status except closed/done/archived (case-insensitive)
 *   - excluding smoke/test items
 *   - priority-first sort, then most-recently-created
 */
export async function getOpenItems(args: {
  clientNumber: string;
  userId: number;
  opts?: GetOpenItemsOpts;
}): Promise<OpenItemRow[]> {
  const { clientNumber, userId, opts } = args;
  const rows = await openItemsService.listItems(userId, clientNumber, {
    status: opts?.statuses as any,
    priority: opts?.priority as any,
    limit: opts?.limit,
    excludeSmoke: opts?.excludeSmoke ?? true,
  });
  // Project to the canonical typed shape so callers consuming this view
  // can't accidentally rely on raw Prisma fields. Future schema changes
  // need to update this projection explicitly — keeps the contract loud.
  return rows.map((r) => ({
    id: r.id,
    itemNumber: r.itemNumber,
    title: r.title,
    status: r.status,
    priority: r.priority,
    ownerId: r.ownerId,
    delegateeId: r.delegateeId ?? null,
    delegateeName: r.delegateeName ?? null,
    delegateeEmail: r.delegateeEmail ?? null,
    dueDate: r.dueDate ?? null,
    sourceFeed: r.sourceFeed ?? null,
    archetype: (r as any).archetype ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/** Convenience count — no row data. */
export async function countOpenItems(args: {
  clientNumber: string;
  userId: number;
  opts?: GetOpenItemsOpts;
}): Promise<number> {
  const rows = await getOpenItems(args);
  return rows.length;
}
