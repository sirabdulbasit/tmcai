/**
 * DEF-229 — the raw provider error code reached the owner.
 *
 * `iter-19-post-build.json`, `B08-bad-news`, C1 90 / C2 90:
 *
 *     "I sent a WhatsApp notification at 04:07 UTC this morning about a problem
 *      with your Google Calendar connection. **It reported 'invalid_grant'** and
 *      the last successful sync was 76 hours ago."
 *
 * `invalid_grant` is an OAuth token from Google's SDK. It tells him nothing he
 * can act on, and it is the same class as `priority=high` (DEF-220/DEF-227):
 * machine vocabulary crossing into the reply.
 *
 * **It came from a live owner-facing surface, not the benchmark.**
 * `staleConnectorPing.ts:50` interpolated the stored string straight into a
 * WhatsApp ping:
 *
 *     const reason = row.last_oauth_error ? ` (${row.last_oauth_error})` : '';
 *
 * **AND A TRANSLATOR ALREADY EXISTED.** `sanitizeScribeError` in
 * `routes/admin/clientConnectorRoutes.ts` has done exactly this job since it was
 * written, and its own docblock states the principle: *"surfacing that verbatim
 * to admins tells them nothing about what to do."* It was **private to one admin
 * route** — one implementation, one caller, and every other consumer leaking the
 * raw code. That is the shape `applyOpenItemUpdate`'s docblock named when it was
 * created: *"the same shape as the @lid resolver living privately in one
 * consumer: one implementation, one caller, and every new caller silently
 * broken."*
 *
 * WHAT IS SHARED HERE IS THE CLASSIFICATION, NOT THE PHRASING. The admin's
 * sentences are scribe-specific — *"click Re-connect on the Google Drive card"*,
 * *"then Re-scribe"* — and would be wrong in a WhatsApp ping about a calendar.
 * The regexes are what drifted; each surface still writes its own action.
 */

export type ProviderErrorKind =
  | 'auth_expired'
  | 'no_permission'
  | 'not_found'
  | 'network'
  | 'rate_limit'
  | 'unknown';

/**
 * Classify a raw provider error. The ONE definition of these patterns.
 *
 * Order matters and is deliberate: an expired grant often arrives wrapped in a
 * 403, so auth is tested before permission, or every expiry would be reported
 * as a permissions problem and he would be sent to change a setting that is
 * already correct.
 */
export function classifyProviderError(raw: string | null | undefined): ProviderErrorKind {
  const s = String(raw ?? '');
  if (!s.trim()) return 'unknown';
  if (/oauth2\.googleapis\.com\/token|invalid_grant|invalid_token|Token has been expired|expired or revoked|refresh.*token/i.test(s)) {
    return 'auth_expired';
  }
  if (/insufficientPermissions|not authorized|unauthorized|403/i.test(s)) return 'no_permission';
  if (/404|notFound|file not found/i.test(s)) return 'not_found';
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(s)) return 'network';
  if (/quota|rate.?limit|429/i.test(s)) return 'rate_limit';
  return 'unknown';
}

/**
 * What the OWNER is told, in a sentence about his situation rather than the
 * provider's vocabulary. No connector name and no instruction — the caller owns
 * both, because "reconnect from Settings" and "click Re-connect on the Google
 * Drive card" are different surfaces.
 *
 * `unknown` returns **null**, and that is the important case: a code he cannot
 * act on is worse than silence, and every caller here already tells him what to
 * do next. Pasting `invalid_grant` in brackets added nothing but noise, which is
 * how this defect looked from his side.
 */
export function ownerFacingCause(raw: string | null | undefined): string | null {
  switch (classifyProviderError(raw)) {
    case 'auth_expired':
      return 'its access permission has expired';
    case 'no_permission':
      return 'the connected account no longer has permission';
    case 'not_found':
      return 'what it was reading is no longer there';
    case 'network':
      return 'it could not reach the provider';
    case 'rate_limit':
      return 'the provider is rate-limiting us';
    case 'unknown':
    default:
      return null;
  }
}
