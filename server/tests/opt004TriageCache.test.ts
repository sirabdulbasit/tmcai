/**
 * OPT-004 — the triage decision cache, and the spend attribution that lets it
 * be measured.
 *
 * Measured on production 2026-08-27, for ONE user (TMC-0001):
 *
 *   purpose=triage   08-19  2,439 calls  10.9M input tokens  $15.23
 *                    08-20  3,727 calls  16.6M input tokens  $23.26
 *                    08-21  2,981 calls  13.3M input tokens  $18.73
 *
 * against a feed of 4,877 events in total, growing by ~42/day. All time,
 * `triage` is 487,178 calls and $1,759.67 — 82% of every dollar this system has
 * ever spent on inference. At ~$15/day for one user that is ~$450/user/month.
 *
 * A cache already existed: an in-process Map with a 1-hour TTL. It failed twice
 * over — it died on every pm2 restart, and a 1-hour TTL re-reasons an unchanged
 * May email every hour it is looked at, forever.
 *
 * What these assertions defend, in order of how badly each would hurt:
 *
 *  1. TENANT AND USER ISOLATION. Both are inside the hash, not just columns. A
 *     triage decision names people and drafts replies to them; serving one
 *     across either boundary is the worst shape this cache could take.
 *  2. A CHANGED INPUT MUST MISS. The key is the exact prompt the model sees, so
 *     a new reply on the thread, a closed open item, or a fresh user decision
 *     misses by construction with no invalidation to remember. The OLD key —
 *     dedupHash plus a fingerprint of sender/subject/preview only — would serve
 *     a decision derived from thread context that had since moved on.
 *  3. A FALLBACK IS NEVER CACHED. Caching "the LLM was down" would freeze a
 *     transient outage into a fortnight of degraded triage.
 *  4. SPEND IS ATTRIBUTABLE. `llm_spend.feed_event_id` was NULL on all
 *     2,608,563 rows, so no saving could be shown per event — only asserted.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'crypto';

const srcPath = (...p: string[]) => join(__dirname, '..', 'src', ...p);
const reasoner = readFileSync(srcPath('services', 'triage', 'triageReasoner.ts'), 'utf-8');
const router = readFileSync(srcPath('services', 'llmRouter.ts'), 'utf-8');
const spend = readFileSync(srcPath('services', 'llmSpendService.ts'), 'utf-8');
const suggester = readFileSync(srcPath('services', 'triage', 'triageSuggester.ts'), 'utf-8');
const criticality = readFileSync(srcPath('services', 'triage', 'criticalityEngineService.ts'), 'utf-8');

import { __triageCacheInternals } from '../src/services/triage/triageReasoner';
const { buildCacheKey } = __triageCacheInternals;

/** Mirror of the implementation's key derivation, asserted against it below.
 *
 *  NUL separates the fields, not a space: a space can occur inside a tenant id
 *  or a prompt, so `("TMC-0001 5", "X")` and `("TMC-0001", "5 X")` would hash
 *  identically. NUL cannot appear in any of the four fields, so the boundaries
 *  are unambiguous. Same convention as the fusion cache. */
const key = (version: string, clientNumber: string, userId: number, prompt: string) =>
  crypto.createHash('sha256')
    .update(`${version}\u0000${clientNumber}\u0000${userId}\u0000${prompt}`)
    .digest('hex');

const ctx = (clientNumber: string, userId: number) => ({ clientNumber, userId }) as any;

describe('OPT-004 — cache key correctness', () => {
  it('derives the key from version + tenant + user + the full prompt', () => {
    const prompt = 'Subject: invoice overdue\nFrom: a@b.com';
    expect(buildCacheKey(ctx('TMC-0001', 5), prompt))
      .toBe(key(__triageCacheInternals.TRIAGE_PROMPT_VERSION, 'TMC-0001', 5, prompt));
  });

  it('gives two tenants different keys for a byte-identical prompt', () => {
    const prompt = 'Subject: invoice overdue\nFrom: a@b.com';
    expect(buildCacheKey(ctx('TMC-0001', 5), prompt))
      .not.toBe(buildCacheKey(ctx('TMC-0009', 5), prompt));
  });

  it('gives two USERS of one tenant different keys — a decision names people', () => {
    // This is the deliberate difference from the OPT-003 precedent, which scopes
    // by tenant alone. A triage decision carries a rationale about a person and
    // a suggested reply addressed to them; sharing it between two colleagues
    // would leak content for a saving it does not produce.
    const prompt = 'Subject: invoice overdue\nFrom: a@b.com';
    expect(buildCacheKey(ctx('TMC-0001', 5), prompt))
      .not.toBe(buildCacheKey(ctx('TMC-0001', 6), prompt));
  });

  it('is stable for identical inputs — otherwise it never hits', () => {
    const prompt = 'Subject: contract\nFrom: x@y.com';
    expect(buildCacheKey(ctx('TMC-0001', 5), prompt)).toBe(buildCacheKey(ctx('TMC-0001', 5), prompt));
  });

  it('misses when the THREAD has moved on — the old key did not', () => {
    // The whole invalidation strategy in one assertion. The previous key was
    // dedupHash + sha256(sender, subject, preview): a new reply on the thread
    // changed none of those three, so the stale decision was served for an hour
    // after the situation changed. Keying on the prompt makes it miss.
    const before = 'Subject: contract\n--- Recent thread ---\nTHEM: can you confirm?';
    const after = 'Subject: contract\n--- Recent thread ---\nTHEM: can you confirm?\nYOU: confirmed';
    expect(buildCacheKey(ctx('TMC-0001', 5), before)).not.toBe(buildCacheKey(ctx('TMC-0001', 5), after));
  });

  it('misses when the user has just decided something about this sender', () => {
    // `recentDecisionCounts` is rendered into the prompt, so the explicit
    // invalidation on the apply-decision path is belt-and-braces, not the
    // mechanism. Verified here so the belt is not removed on the assumption
    // that the braces are doing the work.
    const before = 'Past MD decisions on this sender: delegate=2';
    const after = 'Past MD decisions on this sender: delegate=3';
    expect(buildCacheKey(ctx('TMC-0001', 5), before)).not.toBe(buildCacheKey(ctx('TMC-0001', 5), after));
  });

  it('gives a different key when the prompt VERSION changes', () => {
    // Without this, improving the triage prompt would be silently undone by
    // answers cached from before the improvement.
    const prompt = 'identical prompt text';
    expect(key('v1', 'TMC-0001', 5, prompt)).not.toBe(key('v2', 'TMC-0001', 5, prompt));
  });
});

describe('OPT-004 — the cache survives what the old one did not', () => {
  it('is durable, not an in-process Map that dies with the process', () => {
    // The defect being fixed: a 1-hour Map, wiped by every pm2 restart, on a
    // tree that restarts often.
    expect(reasoner).toContain('prisma.triageDecisionCache.findUnique');
    expect(reasoner).toContain('prisma.triageDecisionCache.upsert');
  });

  it('holds decisions for days, not one hour', () => {
    const ttl = reasoner.match(/TRIAGE_CACHE_TTL_DAYS = (\d+)/);
    expect(ttl).toBeTruthy();
    expect(Number(ttl![1])).toBeGreaterThanOrEqual(7);
  });

  it('checks the prompt version on READ, not only on write', () => {
    const readBlock = reasoner.slice(reasoner.indexOf('triageDecisionCache.findUnique'));
    expect(readBlock.slice(0, 900)).toContain('promptVersion === TRIAGE_PROMPT_VERSION');
  });

  it('enforces the TTL on read, so a stale decision is never served', () => {
    const readBlock = reasoner.slice(reasoner.indexOf('triageDecisionCache.findUnique'));
    expect(readBlock.slice(0, 900)).toContain('TRIAGE_CACHE_TTL_DAYS');
  });

  it('never lets a cache failure break triage', () => {
    // A cache that can break the thing it accelerates is worse than no cache.
    const readBlock = reasoner.slice(
      reasoner.indexOf('triageDecisionCache.findUnique'),
      reasoner.indexOf('const decision = await llmReason'),
    );
    expect(readBlock).toContain('catch');
    expect(readBlock).toContain('reasoning live');
  });

  it('accounts hits without adding latency to the hit', () => {
    const readBlock = reasoner.slice(reasoner.indexOf('triageDecisionCache.findUnique'));
    expect(readBlock.slice(0, 1400)).toMatch(/void prisma\.triageDecisionCache\.update/);
  });

  it('NEVER caches the deterministic fallback', () => {
    // The write must sit in the success path, above the catch. If it ever moves
    // below, an LLM outage becomes a fortnight of "LLM unavailable".
    const writeAt = reasoner.indexOf('void writeCache(');
    const fallbackAt = reasoner.indexOf('return fallback(ctx);');
    expect(writeAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(writeAt).toBeLessThan(fallbackAt);
  });

  it('evicts, so the cache cannot become the next llm_spend', () => {
    // OPT-001: 791 MB of indexes on a table nobody queried. A cache that never
    // evicts is a second copy of the data growing forever.
    expect(reasoner).toContain('export async function sweepTriageDecisionCache');
    const sweep = reasoner.slice(reasoner.indexOf('export async function sweepTriageDecisionCache'));
    expect(sweep).toContain('promptVersion: { not: TRIAGE_PROMPT_VERSION }');
    expect(sweep).toContain('createdAt: { lt: cutoff }');
  });

  it('keeps the explicit invalidation path working on BOTH layers', () => {
    // briefRoutes calls this when the user acts on a card, and does not await
    // it. L1 must therefore clear synchronously, and the L2 delete must never
    // throw into a caller — a failed eviction cannot fail a user's click.
    const inv = reasoner.slice(reasoner.indexOf('export function invalidateReasonerCache'));
    expect(inv.slice(0, 700)).toContain('cache.clear()');
    expect(inv.slice(0, 700)).toContain('triageDecisionCache.deleteMany');
    expect(inv.slice(0, 700)).toMatch(/\.catch\(/);
  });
});

describe('OPT-004 — spend attribution', () => {
  it('lets a caller name the feed event a call was made about', () => {
    expect(router).toMatch(/feedEventId\?: string \| null;/);
  });

  it('carries it all the way to the llm_spend row', () => {
    // The gap being closed: the column existed and every call site ignored it,
    // so 2,608,563 rows had feed_event_id NULL and no optimisation could be
    // shown to have worked.
    const call = router.slice(router.indexOf('void recordLlmSpend'), router.indexOf('void recordLlmSpend') + 400);
    expect(call).toContain('feedEventId');
    const write = spend.slice(spend.indexOf('prisma.llmSpend.create'), spend.indexOf('prisma.llmSpend.create') + 500);
    expect(write).toContain('feedEventId: p.feedEventId ?? null');
  });

  it('populates it on the two purposes that are 97% of spend', () => {
    // triage ($1,759.67, 82%) and criticality_fuse ($324.74, 15%).
    const triageCall = reasoner.slice(reasoner.indexOf("purpose: 'triage'"), reasoner.indexOf("purpose: 'triage'") + 200);
    expect(triageCall).toContain('feedEventId: ctx.feedEventId');
    const fuseCall = criticality.slice(
      criticality.indexOf("purpose: 'criticality_fuse'"),
      criticality.indexOf("purpose: 'criticality_fuse'") + 200,
    );
    expect(fuseCall).toContain('feedEventId: input.feedEventId');
  });

  it('gets a real event id at the triage call site, not a placeholder', () => {
    const call = suggester.slice(suggester.indexOf('await reasonAboutEvent(dedupHash, {'));
    expect(call.slice(0, 300)).toContain('feedEventId: row.id');
  });
});
