/**
 * DEF-303 — the real cause of the `22021` loop, after three misdiagnoses and one of mine.
 *
 * WHAT WAS HAPPENING. SQLSTATE 22021 (`invalid byte sequence for encoding "UTF8"`) has been
 * raised on this box roughly every 90 seconds since at least 2026-08-07 — 77,123 occurrences by
 * 08-17, 137,382 on 08-27, around 200k/day. It was filed three times (DEF-085 "cause unknown",
 * DEF-252 "not diagnosed", DEF-289 "not diagnosed from code") and closed none of them.
 *
 * THE CAUSE IS NOT IN THE DATA AND NOT IN THE PARAMETERS. It is `substring()` / `left()` applied
 * directly to a TOAST-**compressed** text column. Postgres can serve those with a PARTIAL
 * detoast, and the sliced prefix can end in the middle of a multi-byte character, which then
 * fails encoding validation. Measured against the live database on 2026-09-03, on the actual
 * failing rows:
 *
 *     pg_column_size(body_markdown) = 5867   octet_length = 14337   → compressed
 *
 *     left(body_markdown, 799)        OK
 *     left(body_markdown, 800)        FAIL 22021 (0xe2)
 *     left(body_markdown, 801)        OK
 *     SELECT body_markdown            OK          (full detoast, always fine)
 *     left(body_markdown || '', 800)  OK          (forced full detoast)
 *
 * Every one of those observations is explained by partial detoasting and by nothing else: the
 * failure depends on the CUT LENGTH rather than the content, it differs per row (another row
 * failed at 799 with lead byte 0xcd), and it disappears the moment the value is fully detoasted.
 * 45 rows across `wiki_pages` are affected today and the newest arrived at 11:26 on 2026-09-03,
 * so this is live, not residue.
 *
 * TWO WRONG DIAGNOSES ARE RECORDED HERE ON PURPOSE, because each looked conclusive:
 *
 *   1. MINE. A NUL in a bind parameter DOES raise exactly 22021, and I reproduced it against the
 *      live database, built `rawParamSanitizer.ts`, proved it end-to-end and shipped it in D-89.
 *      It fixes a real failure mode and it is worth keeping — but production kept raising 22021
 *      afterwards, which is the only reason I kept looking. A reproduction is not a diagnosis.
 *   2. Stored corruption. The bytes are genuinely valid: `convert_to` returns them, Node's
 *      strict `TextDecoder` accepts them, and reading the whole column succeeds. Rewriting the
 *      value through a round-trip changed nothing, which is what finally ruled the data out.
 *
 * WHY A HELPER AND NOT `|| ''` AT EACH SITE. The fix is small enough to look like noise — a
 * future editor tidying `body_markdown || ''` back to `body_markdown` would restore a 200k/day
 * error loop with no visible change in behaviour, because the query still returns rows for every
 * uncompressed value. Naming it makes the intent survive: this concatenation is load-bearing.
 * `tests/def303ToastSafeTruncation.test.ts` fails if any call site goes back to the raw form.
 */

/**
 * A SQL expression that truncates a possibly-compressed text column safely.
 *
 * `|| ''` is what does the work: it forces the value to be fully detoasted before truncation, so
 * `substring` never operates on a partially-decompressed slice. `COALESCE` keeps a NULL column
 * rendering as an empty string, which is what every call site already wanted.
 *
 * @param column the column expression, e.g. `body_markdown`
 * @param chars  how many characters to keep
 */
export function toastSafeSnippet(column: string, chars: number): string {
  if (!Number.isInteger(chars) || chars < 1) {
    throw new Error(`toastSafeSnippet: chars must be a positive integer, got ${chars}`);
  }
  return `SUBSTRING(COALESCE(${column},'') || '', 1, ${chars})`;
}
