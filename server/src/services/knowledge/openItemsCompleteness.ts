/**
 * DEF-224 — a summary that silently omits a category is a completeness claim
 * the owner cannot check.
 *
 * `B06-just-do-it` — *"Summarise my open items by priority"* — has drawn the
 * same judge complaint across three scored runs, most recently **C6 80**:
 *
 *   > "It only lists 'High Priority' and 'Medium Priority' items. It's unclear
 *   >  if there are 'Low Priority' or 'No Priority' items that were omitted, or
 *   >  if these are the only items."
 *
 * That is not a register quibble. The reply reads as a complete summary and the
 * owner has no way to tell whether the missing headings mean *"you have none"*
 * or *"I did not show you those"*. The same block feeds the day brief.
 *
 * **The model could not have got this right.** The block handed it thirty rows
 * ordered by `createdAt desc` and no statement of whether thirty was all of
 * them, and no statement of which priorities exist at all. An empty heading is
 * inferable from a page only when the page is known to be complete — the exact
 * principle DEF-197's `absenceIsInformative` established for push history, here
 * applied to the surface the owner reads most.
 *
 * So the completeness fact is computed where it is known — beside the query —
 * and stated. Nothing here interprets: it reports how many rows were shown, how
 * many exist, and the count in every bucket including the empty ones.
 */

/** How many rows the page carries. Exported so the guard reads the real value. */
export const OPEN_ITEMS_PAGE = 30;

/**
 * The buckets, in the order the owner thinks about them. `null` priority is a
 * real state in this schema (a DRAFT before its slots are filled), and it is
 * named rather than folded into "low" — folding it would be a small lie in a
 * line whose whole purpose is to be exact.
 */
export const PRIORITY_BUCKETS = ['critical', 'high', 'medium', 'low'] as const;

export interface PriorityTally {
  priority: string | null;
  _count: { _all: number };
}

/**
 * The header line. Two facts and no advice:
 *
 *   1. whether this page IS every active item, or only the newest N of M;
 *   2. the count in each bucket, zeros included.
 *
 * The zeros are the point. "critical=0 high=2 medium=2 low=0 unset=0" lets Brain
 * say "nothing low-priority" as a fact it was given. Omitting the zero buckets
 * would put it back where it started — inferring absence from a heading that is
 * not there.
 */
export function renderOpenItemsHeader(
  shown: number,
  tally: ReadonlyArray<PriorityTally> | null | undefined,
): string {
  const rows = Array.isArray(tally) ? tally : [];
  const countOf = (p: string | null) => rows
    .filter((r) => (p === null ? r.priority == null : String(r.priority ?? '').toLowerCase() === p))
    .reduce((n, r) => n + (r?._count?._all ?? 0), 0);

  const parts = PRIORITY_BUCKETS.map((p) => `${p}=${countOf(p)}`);
  parts.push(`unset=${countOf(null)}`);
  const total = rows.reduce((n, r) => n + (r?._count?._all ?? 0), 0);

  // A failed group-by yields no rows, and a total of 0 alongside a non-empty
  // page is impossible — so it means the tally is UNAVAILABLE, not that there
  // are no items. Saying "0 of 0" there would be a fabricated completeness
  // claim, which is the defect pointing the other way.
  const complete = total === 0
    ? 'The per-priority counts could not be read this turn, so DO NOT say a category is empty — '
      + 'say what is listed and that you cannot vouch for the rest.'
    : shown >= total
      ? `This is EVERY active open item (${total}). A category showing 0 below genuinely has none — `
        + 'you may say so.'
      : `INCOMPLETE: ${total} active items exist and only the newest ${shown} are listed. `
        + 'Do not describe this as a full summary, and do not say a category is empty.';

  return `# Your active open items (use id to update/delegate/mark_done; to message the OWNER of an item use its delegatee_candidateId)\n`
    + `Counts across ALL active items: ${parts.join(' ')}. ${complete}`;
}
