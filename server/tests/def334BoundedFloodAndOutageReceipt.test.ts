/**
 * DEF-334 parts (2)/(3) `llm-fallback-unreceipted` — the flood is bounded at
 * its two chokepoints and a full provider outage announces itself once.
 *
 * Measured, twice, while neither existed: the 09-29→10-09 billing outage ran
 * ~2,500 all-provider failures/hour for days (the owner's reported "51MB every
 * ~6 hours") with zero receipts; 10-16's compound outage (gemini DNS + claude
 * credit-balance) drove 50 more silent fallbacks. Separately, two invalid raw
 * queries wrote 18,760 identical log lines in one day (DEF-337) and the 42703
 * odoo query still floods — every line past the first few carrying no new
 * information.
 *
 * Under test:
 *  part (2) — bounded log, no call-site enumeration:
 *   - the router truncates per-provider error bodies in the THROWN message
 *     (what every caller logs per call) while logging the FULL bodies itself
 *     once per window;
 *   - the raw-query observer logs at most LOG_CAP_PER_WINDOW lines per
 *     signature per window, keeps counting exactly, and the next window's
 *     first line carries the suppressed count — findings and the rethrow
 *     are unchanged;
 *  part (3) — the outage receipt:
 *   - after OUTAGE_THRESHOLD consecutive all-provider failures the injected
 *     reporter fires ONCE (realert-capped), carrying the full errors;
 *   - one success resets the latch; a failing reporter never changes the
 *     caller's error; the writer is injected at boot (DEF-085 pattern), and
 *     per tenant it writes a tenant-scoped critical `llm_provider_down`
 *     finding plus the direct SA/AD ops email (fixed wording is allowed
 *     here and only here: the trigger IS the model being unreachable).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({
  logs: [] as Array<{ name: string; level: string; msg: string; meta?: any }>,
  geminiImpl: (() => { throw new Error('unset'); }) as (...a: any[]) => any,
  tenants: [{ client_number: 'TMC-0001' }, { client_number: 'TMC-0002' }],
  findings: [] as any[],
  findingThrows: false,
  opsEmails: [] as any[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: (name: string) => {
    const mk = (level: string) => (msg: string, meta?: any) => state.logs.push({ name, level, msg, meta });
    return { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  },
}));
vi.mock('../src/services/claudeService', () => ({ callClaude: async () => { throw new Error('claude unavailable'); } }));
vi.mock('../src/services/geminiService', () => ({ callGemini: (...a: any[]) => state.geminiImpl(...a) }));
vi.mock('../src/services/llmSpendService', () => ({ recordLlmSpend: async () => {} }));
vi.mock('../src/db/prisma', () => {
  const p: any = {
    $queryRawUnsafe: async () => state.tenants,
    $executeRawUnsafe: async () => 0,
  };
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/services/selfheal/healthFindingService', () => ({
  recordFinding: async (input: any) => {
    state.findings.push(input);
    if (state.findingThrows) throw new Error('findings table down');
    return 'finding-id';
  },
}));
vi.mock('../src/services/notifications/adminOpsAlert', () => ({
  sendAdminOpsEmail: async (params: any) => {
    state.opsEmails.push(params);
    return { total: 1, results: [{ email: 'sa@tmcltd.com', ok: true, error: null }] };
  },
  escapeOpsHtml: (s: string) => s,
}));

import {
  callLLM, setLlmOutageReporter, __resetLlmOutageLatch,
  OUTAGE_THRESHOLD, ERROR_HEAD_CHARS,
} from '../src/services/llmRouter';
import {
  noteRawQueryFailure, __resetRawQueryObservability, LOG_CAP_PER_WINDOW, FINDING_WINDOW_MS,
} from '../src/db/rawQueryObservability';
import { reportLlmOutageAsAlert } from '../src/services/selfheal/llmOutageReporter';
import { windowedLogGate } from '../src/utils/boundedLog';

const BODY = `credit balance is too low ${'x'.repeat(400)}TAIL_MARKER`;
const failAll = () => { state.geminiImpl = () => { throw new Error(BODY); }; };
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  state.logs = [];
  state.findings = [];
  state.opsEmails = [];
  state.findingThrows = false;
  __resetLlmOutageLatch();
  __resetRawQueryObservability();
  setLlmOutageReporter(null);
  failAll();
});

const callOnce = () => callLLM('sys', 'msg', { providers: ['gemini'] }).catch((e) => e as Error);

describe('DEF-334 (2) — the thrown message is bounded; the full detail is logged once per window', () => {
  it('callers can only ever log the head: the thrown message truncates provider bodies', async () => {
    const err = await callOnce();
    expect((err as Error).message).toContain('All LLM providers failed: gemini[try1]:');
    expect((err as Error).message).not.toContain('TAIL_MARKER');
    expect((err as Error).message.length).toBeLessThan(ERROR_HEAD_CHARS + 80);
  });

  it('the router logs the FULL provider bodies itself, once per window, not once per call', async () => {
    for (let i = 0; i < 5; i++) await callOnce();
    const full = state.logs.filter((l) => l.name === 'llm-router' && l.msg.includes('full provider errors'));
    expect(full).toHaveLength(1);
    expect(JSON.stringify(full[0].meta.errors)).toContain('TAIL_MARKER');
  });

  it('raw-query log is capped per signature-window; counting continues; the next window reports the suppressed volume', () => {
    // One fixed stack for every occurrence — the signature groups on
    // (sqlState, callSite, shape), and a real broken query fails from ONE site.
    const stack = 'Error\n    at mirror (src/services/odooWikiMirror.ts:176:5)';
    let last: any = null;
    for (let i = 0; i < 8; i++) {
      last = noteRawQueryFailure({
        operation: '$queryRawUnsafe',
        sql: `SELECT DISTINCT client_number FROM system_config WHERE id = 7`,
        error: new Error('Code: `42703`. column does not exist'),
        stack,
        now: 1_000 + i,
      });
    }
    const lines = state.logs.filter((l) => l.name === 'raw-query' && l.msg === 'raw query failed');
    expect(lines).toHaveLength(LOG_CAP_PER_WINDOW);
    expect(lines[LOG_CAP_PER_WINDOW - 1].meta.note).toContain('log capped');
    expect(last.count).toBe(8); // the COUNT is exact even where the log is capped

    state.logs = [];
    noteRawQueryFailure({
      operation: '$queryRawUnsafe',
      sql: `SELECT DISTINCT client_number FROM system_config WHERE id = 7`,
      error: new Error('Code: `42703`. column does not exist'),
      stack,
      now: 1_000 + FINDING_WINDOW_MS + 5_000,
    });
    const first = state.logs.find((l) => l.name === 'raw-query' && l.msg === 'raw query failed');
    expect(first!.meta.suppressedLastWindow).toBe(8 - LOG_CAP_PER_WINDOW);
    expect(first!.meta.occurrences).toBe(1);
  });

  it('windowedLogGate: caps per key per window, counts exactly, surfaces the suppressed total on rollover, keys are independent', () => {
    const gate = windowedLogGate(2, 1_000);
    expect(gate('a', 0)).toEqual({ log: true, occurrences: 1, suppressedLastWindow: 0 });
    expect(gate('a', 10)).toEqual({ log: true, occurrences: 2, suppressedLastWindow: 0 });
    expect(gate('a', 20).log).toBe(false);
    expect(gate('a', 30).log).toBe(false);
    expect(gate('b', 40)).toEqual({ log: true, occurrences: 1, suppressedLastWindow: 0 }); // other keys unaffected
    expect(gate('a', 2_000)).toEqual({ log: true, occurrences: 1, suppressedLastWindow: 2 }); // the volume survives as a number
  });

  it('both measured flood sites (criticality fuseAndScore, triage llmReason) log through the gate', () => {
    for (const file of [
      '../src/services/triage/criticalityEngineService.ts',
      '../src/services/triage/triageReasoner.ts',
    ]) {
      const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
      expect(src).toContain('windowedLogGate');
      expect(src).toMatch(/const gate = fallbackLogGate\('(fuseAndScore|llmReason)'\);\s*\n\s*if \(gate\.log\)/);
    }
  });
});

describe('DEF-334 (3) — a full outage announces itself once, and recovery closes the latch', () => {
  it('the injected reporter fires on the Nth consecutive all-provider failure, once per realert window', async () => {
    const reports: any[] = [];
    setLlmOutageReporter(async (r) => { reports.push(r); });
    for (let i = 0; i < OUTAGE_THRESHOLD - 1; i++) await callOnce();
    expect(reports).toHaveLength(0);
    await callOnce();
    expect(reports).toHaveLength(1);
    expect(reports[0].consecutiveFailures).toBe(OUTAGE_THRESHOLD);
    expect(reports[0].errors.join('')).toContain('TAIL_MARKER'); // full bodies reach the alert
    await callOnce();
    expect(reports).toHaveLength(1); // realert-capped, not a flood about a flood
  });

  it('one success resets the latch — two blips around a recovery never alert', async () => {
    const reports: any[] = [];
    setLlmOutageReporter(async (r) => { reports.push(r); });
    await callOnce();
    await callOnce();
    state.geminiImpl = () => 'a healthy reply';
    await callLLM('sys', 'msg', { providers: ['gemini'] });
    failAll();
    await callOnce();
    await callOnce();
    expect(reports).toHaveLength(0);
    await callOnce(); // third consecutive since recovery
    expect(reports).toHaveLength(1);
  });

  it('a failing reporter never changes the caller error — the announcement is off the critical path', async () => {
    setLlmOutageReporter(async () => { throw new Error('alert channel down'); });
    let err: Error | null = null;
    for (let i = 0; i < OUTAGE_THRESHOLD; i++) err = (await callOnce()) as Error;
    expect(err!.message).toContain('All LLM providers failed');
    await flush();
    expect(state.logs.some((l) => l.msg === 'llm outage announcement failed')).toBe(true);
  });

  it('the writer: per active tenant, a tenant-scoped critical finding AND the direct ops email; a failing leg never aborts the other', async () => {
    state.findingThrows = true;
    await reportLlmOutageAsAlert({
      consecutiveFailures: 3, firstFailureAt: 1_760_000_000_000,
      errors: ['gemini[try1]: fetch failed', 'claude[try1]: credit balance too low'], purpose: 'triage',
    });
    expect(state.findings.map((f) => f.clientNumber)).toEqual(['TMC-0001', 'TMC-0002']);
    expect(state.findings[0]).toMatchObject({ kind: 'llm_provider_down', severity: 'critical', source: 'llm-router' });
    expect(state.opsEmails).toHaveLength(2); // email leg ran despite the findings table being down
    expect(state.opsEmails[0].html).toContain('credit balance too low'); // the facts, verbatim
  });

  it('the writer is injected at server boot (DEF-085 pattern — the router itself stays write-free)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
    expect(src).toContain("await import('./services/selfheal/llmOutageReporter')");
    expect(src).toContain('installLlmOutageReporter()');
    const router = fs.readFileSync(path.join(__dirname, '../src/services/llmRouter.ts'), 'utf8');
    expect(router).not.toMatch(/from '\.\.\/db\/prisma'|healthFindingService|adminOpsAlert/);
  });
});
