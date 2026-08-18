/**
 * DEF-229 — the raw provider error code reached the owner.
 *
 * `iter-19-post-build.json`, `B08-bad-news`:
 *
 *     "…about a problem with your Google Calendar connection. **It reported
 *      'invalid_grant'** and the last successful sync was 76 hours ago."
 *
 * `invalid_grant` is an OAuth token from Google's SDK. Same class as
 * `priority=high` (DEF-220/DEF-227): machine vocabulary crossing into the reply.
 *
 * **It came from a live owner-facing surface**, not the benchmark.
 * `staleConnectorPing` sends a WhatsApp ping and interpolated the stored string
 * straight into it: `` const reason = row.last_oauth_error ? ` (${...})` : '' ``.
 *
 * **And a translator already existed.** `sanitizeScribeError` has done exactly
 * this job since it was written — *"surfacing that verbatim to admins tells them
 * nothing about what to do"* — and was **private to one admin route**. One
 * implementation, one caller, every other consumer leaking the code. That is the
 * shape `applyOpenItemUpdate`'s docblock named: *"the @lid resolver living
 * privately in one consumer … every new caller silently broken."*
 *
 * The CLASSIFICATION is shared; the PHRASING is not. The admin's sentences are
 * scribe-specific ("the Google Drive card", "Re-scribe") and would be wrong in a
 * ping about a calendar.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  classifyProviderError,
  ownerFacingCause,
} from '../src/services/connectors/providerErrorText';

const src = (rel: string) => {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  // Comments stripped: a guard must read code, not prose about it (DEF-195).
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
};

describe('DEF-229 — THE MEASURED CODE, translated', () => {
  it('`invalid_grant` becomes something he can act on', () => {
    expect(classifyProviderError('invalid_grant')).toBe('auth_expired');
    expect(ownerFacingCause('invalid_grant')).toBe('its access permission has expired');
  });

  it('and so does the wrapped SDK form he would actually have stored', () => {
    const wrapped = 'request to https://oauth2.googleapis.com/token failed, reason: invalid_grant';
    expect(classifyProviderError(wrapped)).toBe('auth_expired');
    expect(ownerFacingCause(wrapped)).toBe('its access permission has expired');
  });

  it('no owner-facing sentence contains provider vocabulary', () => {
    for (const raw of [
      'invalid_grant', 'invalid_token', 'Token has been expired or revoked',
      'insufficientPermissions', 'HTTP 403', '404 notFound',
      'ECONNREFUSED', 'quota exceeded', 'rate_limit 429',
    ]) {
      const out = ownerFacingCause(raw);
      expect(out, raw).toBeTruthy();
      expect(out!, raw).not.toMatch(/invalid_grant|invalid_token|403|404|429|ECONNREFUSED|quota|insufficientPermissions/i);
    }
  });
});

describe('DEF-229 — an untranslatable code says NOTHING, not the code', () => {
  it('unknown input yields null', () => {
    for (const raw of ['', null, undefined, 'weird internal blah 7788']) {
      expect(classifyProviderError(raw as string), String(raw)).toBe('unknown');
      expect(ownerFacingCause(raw as string), String(raw)).toBeNull();
    }
  });

  it('the ping OMITS the clause rather than pasting the code', () => {
    // A code he cannot act on is worse than silence, and the message already
    // tells him what to do next. This is the line that produced the defect.
    const job = src('src/jobs/staleConnectorPing.ts');
    expect(job, 'the raw interpolation is gone')
      .not.toMatch(/\$\{row\.last_oauth_error\}/);
    expect(job).toMatch(/const cause = ownerFacingCause\(row\.last_oauth_error\)/);
    expect(job).toMatch(/const reason = cause \? ` \$\{cause\[0\]\.toUpperCase\(\)\}\$\{cause\.slice\(1\)\}\.` : '';/);
  });
});

describe('DEF-229 — the ordering that decides what he is told to do', () => {
  it('an expiry wrapped in a 403 is auth, not permissions', () => {
    // Sent to the wrong branch he would be told to change an account setting
    // that is already correct. Order is load-bearing, so it is asserted.
    expect(classifyProviderError('403 invalid_grant: Token has been expired or revoked'))
      .toBe('auth_expired');
  });

  it('a plain 403 is still permissions', () => {
    expect(classifyProviderError('403 insufficientPermissions')).toBe('no_permission');
  });

  it('each remaining kind still classifies', () => {
    expect(classifyProviderError('404 file not found')).toBe('not_found');
    expect(classifyProviderError('ETIMEDOUT')).toBe('network');
    expect(classifyProviderError('Rate Limit Exceeded')).toBe('rate_limit');
  });
});

describe('DEF-229 — one classifier, two surfaces, unchanged admin phrasing', () => {
  const admin = src('src/routes/admin/clientConnectorRoutes.ts');

  it('the admin route classifies through the shared module', () => {
    expect(admin).toMatch(/import \{ classifyProviderError \} from '\.\.\/\.\.\/services\/connectors\/providerErrorText'/);
    expect(admin).toMatch(/switch \(classifyProviderError\(raw\)\)/);
  });

  it('its own regexes are gone — that copy is what drifted', () => {
    expect(admin).not.toMatch(/insufficientPermissions\|not authorized\|403/);
    expect(admin).not.toMatch(/oauth2\\\.googleapis\\\.com/);
  });

  it('but its scribe-specific SENTENCES are untouched', () => {
    // Sharing the phrasing would have put "click Re-connect on the Google Drive
    // card" into a WhatsApp ping about a calendar. Only the matching is shared.
    for (const sentence of [
      'click Re-connect on the Google Drive card to refresh authorisation.',
      'Open Change folder and paste the correct folder ID.',
      'Scribe failed. Try Re-connect, then Re-scribe.',
    ]) {
      expect(admin, sentence).toContain(sentence);
    }
  });

  it('the ping writes its OWN action, not the admin\'s', () => {
    const job = src('src/jobs/staleConnectorPing.ts');
    expect(job).toContain('Open Settings → Connectors and reconnect');
    expect(job, 'no scribe vocabulary on the owner path').not.toContain('Re-scribe');
  });
});
