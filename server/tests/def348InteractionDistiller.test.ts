/**
 * DEF-348 `learn-distillation-inert` — the interaction distiller turns
 * captured experience into governed-memory PROPOSALS, human-gated.
 *
 * Measured before this existed (2026-10-23): 3,361 interaction-log rows,
 * 2 governed memories, 0 proposals pending, 0 BrainFeedback rows ever — every
 * existing generator needed a hand (UI propose, hand-rewrite feedback) or a
 * live chat (standing-preference capture), so thousands of real exchanges
 * accrued and none became memory.
 *
 * Under test:
 *  - a user's exchange batch produces proposals ONLY above the confidence
 *    floor, capped per user, deduped against existing titles, with the
 *    tenant/user scope and the non-auto-activating sourceType on every row;
 *  - the per-tenant cursor is FAIL-CLOSED: it advances only when the whole
 *    tenant batch succeeds, and an LLM failure holds it for retry;
 *  - synthetic `benchmark`-surface rows are excluded at the query
 *    (target-grounding: synthetic traffic must never become memory);
 *  - an empty batch spends nothing (no LLM call, no cursor write).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  logs: [] as any[],
  tenants: [] as Array<{ clientNumber: string }>,
  rowsByTenant: {} as Record<string, any[]>,
  existingMemories: [] as Array<{ userId: number | null; title: string }>,
  findManyWheres: [] as any[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => {
    const mk = (level: string) => (msg: string, meta?: any) => state.logs.push({ level, msg, meta });
    return { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  },
}));
vi.mock('../src/db/prisma', () => {
  const p: any = {
    brainInteractionLearningLog: {
      groupBy: async () => state.tenants,
      findMany: async (args: any) => {
        state.findManyWheres.push(args.where);
        return state.rowsByTenant[args.where.clientNumber] ?? [];
      },
    },
    governedBrainMemory: {
      findMany: async () => state.existingMemories,
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

import {
  distillInteractions, DISTILL_CURSOR_KEY,
  MAX_PROPOSALS_PER_USER_PER_RUN, PROPOSE_CONFIDENCE_FLOOR,
} from '../src/services/learning/interactionDistiller';

const row = (id: string, userId: number, prompt: string, at: string) => ({
  id, userId, userPrompt: prompt, brainResponse: 'ok', userOutcome: null, createdAt: new Date(at),
});

function harness(llmText: string | Error) {
  const proposed: any[] = [];
  const cursors: Record<string, string> = {};
  const llmCalls: any[] = [];
  return {
    proposed, cursors, llmCalls,
    deps: {
      callLlm: async (_sys: string, user: string) => {
        llmCalls.push(user);
        if (llmText instanceof Error) throw llmText;
        return { text: llmText };
      },
      proposeMemory: async (args: any) => { proposed.push(args); return { id: `m-${proposed.length}`, status: 'pending_approval' }; },
      getConfig: async () => null,
      setConfig: async (c: string, _k: string, v: string) => { cursors[c] = v; },
    },
  };
}

beforeEach(() => {
  state.logs = []; state.tenants = []; state.rowsByTenant = {};
  state.existingMemories = []; state.findManyWheres = [];
});

describe('DEF-348 — captured experience becomes governed-memory proposals, human-gated', () => {
  it('proposes above the floor with full scope + the non-auto sourceType, drops below-floor, and advances the cursor on success', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.rowsByTenant['TMC-0001'] = [
      row('i1', 2, 'From now on always give me amounts in PKR', '2026-10-20T10:00:00Z'),
      row('i2', 2, 'what is the open items count?', '2026-10-21T10:00:00Z'),
    ];
    const h = harness(JSON.stringify([
      { title: 'Always report amounts in PKR', content: 'Use PKR for all monetary amounts.', confidence: 0.85, sensitivity: 'normal' },
      { title: 'Maybe likes short replies', content: 'Possibly prefers brevity.', confidence: 0.3 },
    ]));
    const r = await distillInteractions(h.deps);
    expect(r).toMatchObject({ tenants: 1, scanned: 2, groups: 1, proposed: 1, belowFloor: 1, tenantsFailed: 0 });
    expect(h.proposed).toHaveLength(1);
    expect(h.proposed[0]).toMatchObject({
      clientNumber: 'TMC-0001',
      userId: 2,
      memoryScope: 'user',
      sourceType: 'interaction_distillation', // NOT the self-activating class
      createdByBrain: true,
      sourceReferenceId: 'i1',
    });
    expect(h.proposed[0].confidenceScore).toBeGreaterThanOrEqual(PROPOSE_CONFIDENCE_FLOOR);
    // cursor advanced to the LAST row read
    expect(h.cursors['TMC-0001']).toBe(new Date('2026-10-21T10:00:00Z').toISOString());
  });

  it('FAIL-CLOSED: an LLM failure holds the cursor (rows retried next run) and fails only that tenant', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.rowsByTenant['TMC-0001'] = [row('i1', 2, 'always CC my assistant', '2026-10-20T10:00:00Z')];
    const h = harness(new Error('provider down'));
    const r = await distillInteractions(h.deps);
    expect(r.tenantsFailed).toBe(1);
    expect(r.proposed).toBe(0);
    expect(h.cursors).toEqual({}); // cursor NOT advanced — no silent skip of unprocessed experience
  });

  it('caps proposals per user per run and dedupes against existing memory titles', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.rowsByTenant['TMC-0001'] = [row('i1', 2, 'several standing rules', '2026-10-20T10:00:00Z')];
    state.existingMemories = [{ userId: 2, title: 'Rule one' }];
    const many = Array.from({ length: 6 }, (_, i) => ({
      title: `Rule ${['one', 'two', 'three', 'four', 'five', 'six'][i]}`,
      content: 'Do the thing consistently.',
      confidence: 0.9,
    }));
    const h = harness(JSON.stringify(many));
    const r = await distillInteractions(h.deps);
    expect(r.skippedDuplicate).toBe(1);                       // 'Rule one' already exists
    expect(r.proposed).toBe(MAX_PROPOSALS_PER_USER_PER_RUN);  // capped, never a flood
    expect(h.proposed.map((p) => p.title)).toEqual(['Rule two', 'Rule three', 'Rule four']);
  });

  it('excludes synthetic benchmark traffic at the query and spends nothing on an empty batch', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.rowsByTenant['TMC-0001'] = [];
    const h = harness('[]');
    const r = await distillInteractions(h.deps);
    expect(state.findManyWheres[0].surface).toEqual({ not: 'benchmark' }); // target grounding
    expect(state.findManyWheres[0].createdAt).toEqual({ gt: new Date(0) });
    expect(h.llmCalls).toHaveLength(0); // no rows → no LLM spend
    expect(h.cursors).toEqual({});      // nothing read → nothing advanced
    expect(r.proposed).toBe(0);
  });

  it('a sensitive candidate is proposed as sensitive (proposeMemory then forces the human gate regardless)', async () => {
    state.tenants = [{ clientNumber: 'TMC-0001' }];
    state.rowsByTenant['TMC-0001'] = [row('i1', 2, 'never mention my salary to anyone', '2026-10-20T10:00:00Z')];
    const h = harness(JSON.stringify([
      { title: 'Never disclose salary details', content: 'Do not reveal salary info to anyone.', confidence: 0.95, sensitivity: 'sensitive' },
    ]));
    await distillInteractions(h.deps);
    expect(h.proposed[0].sensitivityLevel).toBe('sensitive');
  });

  it('the nightly wires distillation BEFORE the sweep and a distill failure cannot kill the night', () => {
    const fs = require('fs'); const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../src/scripts/nexeoLearnSweep.ts'), 'utf8');
    const distillAt = src.indexOf('distillInteractions()');
    const sweepAt = src.indexOf('sweepQualifyingMemories({ dryRun })');
    expect(distillAt).toBeGreaterThan(-1);
    expect(sweepAt).toBeGreaterThan(distillAt); // generation first, then activation sweep
    expect(src).toContain('sweep continues'); // the catch that keeps the night alive
  });
});
