/**
 * DEF-333 increment 2 — the binding survives history trimming.
 *
 * Rule 1a (increment 1) reads Brain's unanswered question from the history
 * block, so once the question scrolls out of the trimmed window the binding
 * has nothing to bind to (Codex it-78(3) §3, the named remainder, directed
 * in §6.3). This increment carries the live `awaiting_reply` row — at most
 * ONE per user by the queue's partial unique index — as an authoritative
 * block rendered ABOVE the history.
 *
 * Under test:
 *  - a live awaiting_reply row renders the block: Brain's own question,
 *    the rule-1a binding language, AND the over-binding escape hatch
 *    (a clear new request stays a request — the §3 MEDIUM's direction);
 *  - the read is tenant+user scoped;
 *  - no row → null (composition proceeds untouched);
 *  - a failed read fails OPEN → null, never a throw into compose;
 *  - the renderer places the block above the history (source-pinned,
 *    the def222 pattern — reasoningCompose is private).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({
  row: null as any,
  lastWhere: null as any,
  throwOnRead: false,
}));

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const brainPromptQueue = {
    findFirst: async ({ where }: any) => {
      state.lastWhere = where;
      if (state.throwOnRead) throw new Error('db down');
      return state.row;
    },
  };
  const p: any = new Proxy(
    { brainPromptQueue },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

import { buildAwaitingAnswerBlock } from '../src/services/knowledge/brainComposer';

beforeEach(() => {
  state.row = {
    question: 'Basit, quick one — what priority and deadline should I put on "Define rules"?',
    sentAt: new Date(Date.now() - 90 * 60_000),
  };
  state.lastWhere = null;
  state.throwOnRead = false;
});

describe('DEF-333 inc 2 — the awaiting-answer block', () => {
  it('renders Brain\'s own question with the binding language, tenant+user scoped', async () => {
    const block = await buildAwaitingAnswerBlock('TMC-0001', 2);
    expect(block).toContain("YOU ARE AWAITING THE USER'S ANSWER");
    expect(block).toContain('what priority and deadline should I put');
    expect(block).toContain('Core rule 1a applies to THIS question');
    expect(block).toContain('even when it is');
    expect(state.lastWhere.clientNumber).toBe('TMC-0001');
    expect(state.lastWhere.userId).toBe(2);
    expect(state.lastWhere.state).toBe('awaiting_reply');
  });

  it('carries the over-binding escape hatch — a clear new request stays a request (the §3 MEDIUM direction)', async () => {
    const block = await buildAwaitingAnswerBlock('TMC-0001', 2);
    expect(block).toContain('clearly an unrelated new request, handle that request');
    expect(block).toContain('never force-fit');
  });

  it('no awaiting row → null, composition untouched', async () => {
    state.row = null;
    await expect(buildAwaitingAnswerBlock('TMC-0001', 2)).resolves.toBeNull();
  });

  it('a failed read fails OPEN — null, never a throw into compose', async () => {
    state.throwOnRead = true;
    await expect(buildAwaitingAnswerBlock('TMC-0001', 2)).resolves.toBeNull();
  });

  it('the renderer places the block ABOVE the history window (source-pinned)', () => {
    const raw = fs.readFileSync(
      path.join(__dirname, '../src/services/knowledge/reasoningCompose.ts'), 'utf8',
    );
    const render = raw.indexOf('input.dataBlocks.awaitingAnswer) parts.push');
    const history = raw.indexOf('if (input.history.length > 0)');
    expect(render).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(render); // above the history block
  });
});
