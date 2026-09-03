/**
 * DEF-252 / DEF-289 / DEF-085 — a NUL must never reach a bind parameter.
 *
 * This is the guard for a defect that was filed THREE times over a month and
 * closed none of them, each round adding attribution rather than a cause. The
 * cause, reproduced against the live database, is one character: Postgres
 * `text` has no representation for U+0000, so a parameter carrying one fails
 * the entire query with SQLSTATE 22021 — ~200k times a day.
 *
 * These tests are on the pure functions, deliberately. The end-to-end proof was
 * run separately against the real database and the real client (all five
 * previously-failing cases pass, both raw paths, emoji unaffected) — a mocked
 * end-to-end test would have proved only that the mock behaves like the mock,
 * which is what let two earlier fixes this week be reported as working when
 * they were not.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeRawParam, sanitizeRawArgs, installRawParamSanitizers,
} from '../src/db/rawParamSanitizer';

const NUL = String.fromCharCode(0);

describe('DEF-252 — text Postgres cannot represent never reaches a parameter', () => {
  it('removes a NUL from the middle of a string', () => {
    const r = sanitizeRawParam('Sat' + NUL + 'ori');
    expect(r.value).toBe('Satori');
    expect(r.stripped).toBe(1);
  });

  it('removes several NULs and counts every one', () => {
    const r = sanitizeRawParam(NUL + 'a' + NUL + 'b' + NUL);
    expect(r.value).toBe('ab');
    expect(r.stripped).toBe(3);
  });

  it('leaves ordinary text identical, by identity', () => {
    const input = 'Satori — the IP strategy deck';
    const r = sanitizeRawParam(input);
    expect(r.value).toBe(input);
    expect(r.stripped).toBe(0);
  });

  it('leaves emoji and non-Latin script alone — they were never the problem', () => {
    // Verified against the live database: an emoji parameter succeeds. If this
    // stripped them it would be corrupting the owner's actual message text to
    // fix a bug emoji had no part in.
    for (const s of ['Satori \u{1F600}', 'حسیب', '日本語', 'Zoë']) {
      const r = sanitizeRawParam(s);
      expect(r.value).toBe(s);
      expect(r.stripped).toBe(0);
    }
  });

  it('replaces a lone surrogate rather than dropping it', () => {
    // It stood for a real character that arrived truncated. U+FFFD says that;
    // deletion would silently claim nothing was ever there.
    const r = sanitizeRawParam('Satori \uD800');
    expect(r.value).toBe('Satori �');
    expect(r.stripped).toBe(1);
  });

  it('keeps a VALID surrogate pair intact', () => {
    // The load-bearing half of the surrogate rule: an emoji IS a surrogate pair
    // in UTF-16, so a careless pattern would eat every emoji.
    const pair = '😀';
    expect(sanitizeRawParam(pair).value).toBe(pair);
    expect(sanitizeRawParam(pair).stripped).toBe(0);
  });

  it('passes non-strings through by identity', () => {
    const d = new Date();
    const buf = Buffer.from([0, 1, 2]);          // a real NUL byte, legitimately
    expect(sanitizeRawParam(d).value).toBe(d);
    expect(sanitizeRawParam(buf).value).toBe(buf);
    expect(sanitizeRawParam(null).value).toBeNull();
    expect(sanitizeRawParam(42).value).toBe(42);
  });

  it('never edits the statement text, only the parameters', () => {
    // A NUL in SQL text would be a different bug, and a layer that silently
    // rewrites statements is far more dangerous than the bug it fixes.
    const sql = 'SELECT ' + NUL + ' FROM t WHERE a = $1';
    const r = sanitizeRawArgs([sql, 'x' + NUL + 'y']);
    expect((r.value as unknown[])[0]).toBe(sql);
    expect((r.value as unknown[])[1]).toBe('xy');
  });

  it('returns the argument array by identity when nothing needed changing', () => {
    const args = ['SELECT 1 WHERE a = $1', 'clean'];
    expect(sanitizeRawArgs(args).value).toBe(args);
  });

  it('cleans a tagged-template Sql object in place', () => {
    // In place because Prisma reads `values` off this same object when it
    // builds the statement — a sanitized copy would be ignored and the NUL
    // would reach the server anyway.
    const sqlObj: any = { sql: 'SELECT $1', values: ['a' + NUL + 'b', 7] };
    const r = sanitizeRawArgs([sqlObj]);
    expect(r.stripped).toBe(1);
    expect(sqlObj.values).toEqual(['ab', 7]);
    expect((r.value as unknown[])[0]).toBe(sqlObj);
  });
});

describe('DEF-252 — the chokepoint is really installed', () => {
  const OPS = ['$queryRawUnsafe', '$queryRaw'] as const;

  it('wraps every operation and hands the cleaned parameters onward', async () => {
    const seen: unknown[][] = [];
    const client: Record<string, any> = {};
    for (const op of OPS) client[op] = (...a: unknown[]) => { seen.push(a); return Promise.resolve([]); };

    const wrapped = installRawParamSanitizers(client, OPS);
    expect(wrapped).toBe(OPS.length);

    await client.$queryRawUnsafe('SELECT $1', 'Sat' + NUL + 'ori');
    expect(seen[0][1]).toBe('Satori');
  });

  it('reports 0 wrapped when the operation is absent, rather than claiming success', () => {
    // The observer next to it learned this the hard way: an extended client is
    // a Proxy, and an assignment that silently does not take leaves the guard
    // installed in name only.
    expect(installRawParamSanitizers({}, OPS)).toBe(0);
  });

  it('does not swallow an error from the underlying call', () => {
    // A sanitizer that hides a real failure would recreate the DEF-085
    // laundering the observer's own row names as the thing to avoid.
    const boom = new Error('constraint violation');
    const client: Record<string, any> = { $queryRawUnsafe: () => Promise.reject(boom) };
    installRawParamSanitizers(client, ['$queryRawUnsafe']);
    return expect(client.$queryRawUnsafe('SELECT 1')).rejects.toBe(boom);
  });
});
