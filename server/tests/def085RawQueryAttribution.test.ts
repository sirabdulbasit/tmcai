/**
 * DEF-085 — a failing raw query must say who it is, and a repeating one must
 * become a finding without anyone asking (Self-Healing rung 1,
 * capability_contract.md:214).
 *
 * The defect these tests are written against is measured, not hypothetical: a
 * raw query has failed every ~90s on this box since 2026-08-07 with SQLSTATE
 * 22021, 77,123 times, and DEF-085 stayed OPEN with "cause unknown" because the
 * log line named no call site, no SQL and no tenant.
 *
 * Each `it` below is one criterion. The mutation notes say what breaks the
 * assertion, because a test whose mutant survives is decoration.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  observeRawQuery,
  noteRawQueryFailure,
  reportRawQueryFinding,
  setRawQueryFindingReporter,
  extractSqlState,
  sqlShape,
  callSiteFrom,
  signatureOf,
  __resetRawQueryObservability,
  captureCallerStack,
  FINDING_THRESHOLD,
  FINDING_WINDOW_MS,
  RAW_QUERY_FAILED_KIND,
  OBSERVED_RAW_OPERATIONS,
  CALLER_STACK_FRAMES,
} from '../src/db/rawQueryObservability';
import { reportRawQueryFailureAsFinding } from '../src/services/selfheal/rawQueryFindingReporter';

const recordFinding = vi.fn(async () => 'finding-id');
vi.mock('../src/services/selfheal/healthFindingService', () => ({
  recordFinding: (...a: any[]) => recordFinding(...(a as [])),
}));
vi.mock('../src/db/tenantContext', () => ({
  currentTenant: () => ({ clientNumber: 'TMC-0001', userId: 2 }),
}));

beforeEach(() => {
  __resetRawQueryObservability();
  recordFinding.mockClear();
  // The server injects this at boot; tests do it explicitly. Anything that does
  // NOT inject stays in log-only mode, which is the state a one-shot script and
  // this suite are both in by default.
  setRawQueryFindingReporter(reportRawQueryFailureAsFinding);
});

/** The exact string Prisma produced on this box, kept verbatim as the fixture. */
const REAL_22021 =
  'Invalid `prisma.$queryRawUnsafe()` invocation:\n\n\nRaw query failed. ' +
  'Code: `22021`. Message: `ERROR: invalid byte sequence for encoding "UTF8": 0xe2 0x80`';

describe('DEF-085 — raw-query failure attribution', () => {
  it('names the SQLSTATE that the bare prisma:error line buried', () => {
    expect(extractSqlState(REAL_22021)).toBe('22021');
    // The extraction is generic, not 22021-specific: an undefined table is
    // just as unattributable. DEF-089 was a 42703 found only by luck.
    expect(extractSqlState('Raw query failed. Code: `42P01`.')).toBe('42P01');
    // Mutation: returning a hardcoded '22021' dies here.
    expect(extractSqlState('no code at all')).toBeNull();
  });

  it('reduces SQL to a shape and NEVER carries parameter values into the log', () => {
    // This is the privacy criterion, not a formatting one. Raw parameters in
    // this codebase carry WhatsApp bodies, e-mail addresses and contact names,
    // and this string reaches both a log line and a findings row.
    const leaky = `SELECT id FROM whatsapp_messages
       WHERE content = 'Sir, please send the invoice to basit@tmcltd.com'
         AND user_id = 2 LIMIT 10`;
    const shape = sqlShape(leaky);

    expect(shape).not.toContain('basit@tmcltd.com');
    expect(shape).not.toContain('Sir, please send the invoice');
    // The shape still identifies the query, which is the whole point.
    expect(shape).toContain('whatsapp_messages');
    expect(shape).toContain("content = '?'");
    // Mutation: dropping the number-stripping leaves `user_id = 2` and the
    // signature then splits per-user, so one broken query becomes many.
    expect(shape).toContain('user_id = ?');
    // Whitespace collapsed, so the same statement formatted differently is one
    // signature rather than several.
    expect(shape).not.toMatch(/\n|\s{2,}/);
  });

  it('strips bind placeholders so the shape is stable across drivers', () => {
    expect(sqlShape('SELECT * FROM t WHERE a = $1 AND b = $2')).toBe('SELECT * FROM t WHERE a = $? AND b = $?');
  });

  it('truncates a very long statement rather than writing an unbounded log line', () => {
    const long = `SELECT ${'x'.repeat(5000)} FROM t`;
    const shape = sqlShape(long);
    expect(shape.length).toBeLessThanOrEqual(201);
    expect(shape.endsWith('…')).toBe(true);
  });

  it('reports the CALLER as the call site, not the db layer or node_modules', () => {
    // The single fact ten days of DEF-085 was missing.
    const stack = [
      'Error',
      '    at observeRawQuery (/var/www/tmcai/server/src/db/rawQueryObservability.ts:210:23)',
      '    at /var/www/tmcai/server/src/db/prisma.ts:268:41',
      '    at PrismaClient._request (/var/www/tmcai/server/node_modules/@prisma/client/runtime/library.js:121:9)',
      '    at selectUsers (/var/www/tmcai/server/src/jobs/brainCognitiveWorker.ts:25:22)',
      '    at runCognitiveCycle (/var/www/tmcai/server/src/jobs/brainCognitiveWorker.ts:37:23)',
    ].join('\n');

    // Mutation: any of the three skips (this file, db/prisma, node_modules)
    // removed makes this assertion fail with that frame instead.
    expect(callSiteFrom(stack)).toBe('src/jobs/brainCognitiveWorker.ts:25');
  });

  it('resolves a dist path too, because production runs the compiled tree', () => {
    const stack = [
      'Error',
      '    at /var/www/tmcai/server/dist/jobs/attachmentBackfillWorker.js:95:18',
    ].join('\n');
    expect(callSiteFrom(stack)).toBe('dist/jobs/attachmentBackfillWorker.js:95');
  });

  it('says "unknown" rather than inventing a call site when the stack is unusable', () => {
    expect(callSiteFrom(undefined)).toBe('unknown');
    expect(callSiteFrom('Error\n    at /app/node_modules/x/y.js:1:1')).toBe('unknown');
  });

  it('groups the same broken query under one signature and different ones apart', () => {
    const a = signatureOf('22021', 'src/jobs/a.ts:10', 'SELECT ? FROM t');
    const b = signatureOf('22021', 'src/jobs/a.ts:10', 'SELECT ? FROM t');
    const c = signatureOf('22021', 'src/jobs/b.ts:99', 'SELECT ? FROM t');
    expect(a).toBe(b);
    // Mutation: dropping callSite from the signature merges two unrelated
    // broken queries into one finding and loses the attribution again.
    expect(a).not.toBe(c);
  });
});

describe('DEF-085 — repetition becomes a finding, once', () => {
  const fail = (n = 1) => {
    let last: any = null;
    for (let i = 0; i < n; i += 1) {
      last = noteRawQueryFailure({
        operation: '$queryRawUnsafe',
        sql: 'SELECT 1 FROM t WHERE x = $1',
        error: new Error(REAL_22021),
        stack: 'Error\n    at selectUsers (/var/www/tmcai/server/src/jobs/w.ts:25:22)',
      });
    }
    return last;
  };

  it('does not raise a finding on the first failure — a one-off is not a defect', () => {
    // A findings table full of handled one-offs is a table nobody reads, which
    // is the state that let DEF-085 hide in plain sight.
    expect(fail(1)!.crossedThreshold).toBe(false);
    expect(fail(1)!.crossedThreshold).toBe(false); // 2nd: still below
  });

  it(`raises exactly once when the same signature reaches ${FINDING_THRESHOLD}`, () => {
    const r = fail(FINDING_THRESHOLD);
    expect(r!.count).toBe(FINDING_THRESHOLD);
    expect(r!.crossedThreshold).toBe(true);
    // The 90-second failure must not produce 40 findings an hour.
    // Mutation: removing `reportedThisWindow` makes every later call true.
    expect(fail(1)!.crossedThreshold).toBe(false);
    expect(fail(10)!.crossedThreshold).toBe(false);
  });

  it('counts occurrences so the findings row can show the RATE, not just presence', () => {
    expect(fail(7)!.count).toBe(7);
  });

  it('re-arms in a new window, so a defect that is still failing tomorrow is said again', () => {
    fail(FINDING_THRESHOLD);
    const later = noteRawQueryFailure({
      operation: '$queryRawUnsafe',
      sql: 'SELECT 1 FROM t WHERE x = $1',
      error: new Error(REAL_22021),
      stack: 'Error\n    at selectUsers (/var/www/tmcai/server/src/jobs/w.ts:25:22)',
      now: Date.now() + FINDING_WINDOW_MS + 1,
    });
    expect(later!.count).toBe(1);          // window reset
    expect(later!.crossedThreshold).toBe(false);
  });

  it('writes NOTHING when no reporter is injected — log-only, so read-only scripts stay read-only', async () => {
    // `db/prisma.ts` is in the import closure of every operator script,
    // including the ones operatorScriptParity declares WRITE-FREE. The observer
    // must therefore be able to attribute a failure without being able to write.
    // Mutation: importing recordFinding directly into the observer instead of
    // injecting it makes smokeTenantIsolation write-reachable and turns
    // operatorScriptParity guard 9 red.
    setRawQueryFindingReporter(null);
    await reportRawQueryFinding({
      signature: 'sig', sqlState: '22021', callSite: 'src/jobs/w.ts:25',
      shape: 'SELECT ? FROM t', count: 3, crossedThreshold: true,
    });
    expect(recordFinding).not.toHaveBeenCalled();
  });

  it('writes the finding to the EXISTING selfheal surface under the documented kind', async () => {
    await reportRawQueryFinding({
      signature: '22021|src/jobs/w.ts:25|SELECT ? FROM t',
      sqlState: '22021', callSite: 'src/jobs/w.ts:25', shape: 'SELECT ? FROM t',
      count: 3, crossedThreshold: true,
    });
    expect(recordFinding).toHaveBeenCalledTimes(1);
    const arg: any = recordFinding.mock.calls[0][0];
    // `raw_query_failed` is the kind healthFindingService's own interface docs
    // named; this producer is what was missing.
    expect(arg.kind).toBe(RAW_QUERY_FAILED_KIND);
    expect(arg.kind).toBe('raw_query_failed');
    expect(arg.severity).toBe('error');
    expect(arg.clientNumber).toBe('TMC-0001');
    // Load-bearing: notifySevereFindings SKIPS findings with a null userId
    // (findingNotifier.ts:53), so omitting this makes the alert unreachable.
    // Mutation: dropping `userId` from the payload dies here.
    expect(arg.userId).toBe(2);
    // Signature as subject, so recordFinding's partial unique index collapses
    // repeats of THIS query while a different one still gets its own row.
    expect(arg.subjectId).toBe('22021|src/jobs/w.ts:25|SELECT ? FROM t');
    expect(arg.summary).toContain('src/jobs/w.ts:25');
    expect(arg.evidence.sqlState).toBe('22021');
    expect(arg.evidence.occurrencesInWindow).toBe(3);
  });

  it('cannot recurse when the findings write is itself the failing query', async () => {
    // Load-bearing, not defensive: recordFinding writes with $queryRaw, so if
    // THAT is what fails, reporting it would fail, which would report it.
    recordFinding.mockImplementationOnce(async () => {
      const r = noteRawQueryFailure({
        operation: '$queryRaw',
        sql: 'INSERT INTO brain_health_findings VALUES ($1)',
        error: new Error(REAL_22021),
        stack: 'Error\n    at recordFinding (/var/www/tmcai/server/src/services/selfheal/healthFindingService.ts:98:1)',
      })!;
      // Re-entrant attempt while the outer report is still in flight.
      await reportRawQueryFinding({ ...r, crossedThreshold: true });
      return 'finding-id';
    });

    await reportRawQueryFinding({
      signature: 'sig', sqlState: '22021', callSite: 'src/jobs/w.ts:25',
      shape: 'SELECT ? FROM t', count: 3, crossedThreshold: true,
    });

    // The inner call must have been refused by the guard.
    // Mutation: deleting the `reporting` flag makes this 2 and, in production,
    // unbounded.
    expect(recordFinding).toHaveBeenCalledTimes(1);
  });

  it('never throws out of the monitor, even on a hostile error object', () => {
    expect(() => noteRawQueryFailure({
      operation: '$queryRaw',
      sql: null as any,
      error: { get message() { throw new Error('hostile'); } },
    })).not.toThrow();
  });
});

describe('DEF-085 — the query path is unchanged', () => {
  it('passes a successful result through untouched', async () => {
    const rows = [{ id: 1 }];
    await expect(observeRawQuery('$queryRawUnsafe', 'SELECT 1', undefined, async () => rows)).resolves.toBe(rows);
    expect(recordFinding).not.toHaveBeenCalled();
  });

  it('RETHROWS the original error unchanged — it must never swallow', async () => {
    // DEF-085's own row names swallowing as "the DEF-085 laundering", and the
    // `.catch(() => [])` in brainCognitiveWorker is how a failing query became
    // an empty user list for a month.
    const original = new Error(REAL_22021);
    await expect(observeRawQuery('$queryRawUnsafe', 'SELECT 1', undefined, async () => { throw original; }))
      .rejects.toBe(original);          // identity, not just shape
  });

  it('still rethrows when the failure is the one that crosses the threshold', async () => {
    const boom = new Error(REAL_22021);
    for (let i = 0; i < FINDING_THRESHOLD; i += 1) {
      await expect(observeRawQuery('$queryRawUnsafe', 'SELECT 1 FROM t', undefined, async () => { throw boom; }))
        .rejects.toBe(boom);
    }
  });
});

/** Block and line comments removed, so a structural guard reads code only. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('DEF-085 — the interception has ONE implementation and no bypass', () => {
  // The `protection-with-two-implementations` rail. There are ~450 raw call
  // sites; the guard is only real if it sits at the client, and only stays real
  // if a newly added raw operation cannot slip past it.
  const prismaSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/db/prisma.ts'), 'utf8',
  );

  it('observes ALL FOUR raw operations the client exposes', () => {
    // Mutation: dropping an entry leaves that operation unattributed, which is
    // exactly the state DEF-085 lived in.
    expect([...OBSERVED_RAW_OPERATIONS].sort()).toEqual(
      ['$executeRaw', '$executeRawUnsafe', '$queryRaw', '$queryRawUnsafe'],
    );
  });

  it('routes them through the shared observer rather than a second copy', () => {
    const code = stripComments(prismaSrc);
    expect(code).toContain("from './rawQueryObservability'");
    // ONE wrapper over the shared list, not four hand-written copies.
    expect(code).toMatch(/for \(const op of OBSERVED_RAW_OPERATIONS\)/);
    expect((code.match(/observeRawQuery\(/g) ?? []).length).toBe(1);
  });

  it('captures the caller stack SYNCHRONOUSLY, outside the awaited callback', () => {
    // THE BUG THIS GUARDS. The first version captured inside observeRawQuery,
    // which a `query` extension runs from PrismaPromise.then — a microtask — so
    // the application frames were already gone and the live client reported
    // `callSite: "unknown"`. Capture must happen on the caller's own stack,
    // before the observer is entered.
    const code = stripComments(prismaSrc);
    const capture = code.indexOf('captureCallerStack()');
    const observe = code.indexOf('observeRawQuery(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(observe);
    // And the observer must take it as a parameter rather than making its own.
    const observerCode = stripComments(fs.readFileSync(
      path.resolve(__dirname, '../src/db/rawQueryObservability.ts'), 'utf8',
    ));
    expect(observerCode).toMatch(/export async function observeRawQuery<T>\(\s*operation: string,\s*sql: string,\s*callerStack: string \| undefined,/);
  });

  it('raises the stack-frame limit, since Prisma runtime frames crowd out the caller', () => {
    // Node's default of 10 truncated the frame we are after.
    expect(CALLER_STACK_FRAMES).toBeGreaterThanOrEqual(30);
    const stack = captureCallerStack();
    expect(stack).toContain('def085RawQueryAttribution');
  });

  it('keeps the findings WRITE out of prisma.ts own import closure', () => {
    // The inverted edge. If this file ever imports the findings service
    // directly, every write-free operator script becomes write-reachable.
    // Comments stripped FIRST. The un-stripped version of this assertion failed
    // on the module's own doc comment, which is the same trap
    // operatorScriptParity's WRITE regex fell into on a comment of mine: a guard
    // must read code, not prose about the code.
    const observerSrc = stripComments(fs.readFileSync(
      path.resolve(__dirname, '../src/db/rawQueryObservability.ts'), 'utf8',
    ));
    expect(observerSrc).not.toContain('healthFindingService');
    expect(observerSrc).not.toMatch(/from\s+'\.\.\/services\//);
    expect(observerSrc).toContain('setRawQueryFindingReporter');
  });

  it('reads only the statement text, never the parameters, when building the shape', () => {
    // sqlTextOf must not reach into values — that is the privacy boundary.
    const fn = /function sqlTextOf\([\s\S]*?\n}/.exec(prismaSrc)?.[0] ?? '';
    expect(fn).not.toMatch(/a\.values\[/);
    expect(fn).toContain('a.strings');
  });
});
