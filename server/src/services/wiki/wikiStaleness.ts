/**
 * What "stale" means for a wiki page — ONE definition, for every job that uses the word.
 *
 * Owner, 2026-08-24, acting on a redundancy audit. Three separate jobs lint wiki pages and all
 * three were scheduled from `server.ts`, each carrying its own cutoff:
 *
 *   jobs/wikiLintWorker.ts              STALE_THRESHOLD_MS = 60 days   ("Wiki Lint Report" page)
 *   services/knowledge/wikiLinterService.ts  STALE_DAYS = 60           (hourly status labels)
 *   services/wiki/wikiLintService.ts    STALE_CUTOFF_AGE_DAYS = 90     (nightly findings)
 *
 * That is not duplication, which is merely wasteful. It is TWO CONTRADICTORY ANSWERS to the same
 * question: a page 70 days old was labelled `stale` by the hourly job and simultaneously not
 * stale by the nightly one, so which answer you got depended on which job ran last. The same
 * shape as `fabricated-status` — Brain stating something about the world that another part of
 * the system would state differently.
 *
 * 60 wins for two reasons, not one: it was already the majority (two of three), and it is the
 * USER-VISIBLE one — it drives the status label on the page itself. Moving the label to match a
 * hidden report would have been the wrong way round.
 *
 * The three jobs are still three jobs; collapsing them is a separate change. What is fixed here
 * is that they can no longer disagree about the word.
 */

/** A page untouched for this many days is stale. The only definition. */
export const WIKI_STALE_DAYS = 60;

/** Same threshold in milliseconds, for callers comparing timestamps directly. */
export const WIKI_STALE_MS = WIKI_STALE_DAYS * 24 * 60 * 60 * 1000;

/** The cutoff instant: pages whose last update is before this are stale. */
export function wikiStaleCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - WIKI_STALE_MS);
}
