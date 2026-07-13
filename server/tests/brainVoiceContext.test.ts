import { describe, it, expect, vi, beforeEach } from 'vitest';

// A0-email — the specialized email composers (forward cover-notes, deadline
// inquiries, delegation chases) wrote in the user's voice via their own LLM
// calls, WITHOUT the brain's context: standing instructions, learned
// preferences, governed memories. Different rules per channel = the "two
// brains" fork, email edition. renderBrainVoiceContext is the single
// shared context source; withUserPrompts (the chokepoint every composer
// already calls) now carries it.

const resolveTenant = vi.fn(async () => 'tmc');
const getInstructions = vi.fn();
const renderInstr = vi.fn((rows: any[]) => rows.length ? `## Standing instructions\n- always cc finance` : '');
const getPrefs = vi.fn();
const renderPrefs = vi.fn(() => '## Learned preferences\n- terse replies preferred');
const governed = vi.fn(async () => '# Approved memories\n- Quote money in PKR');
// Fix 3 (2026-07-09) — spy on getOrCompute so tests can assert the
// cache key + TTL that renderBrainVoiceContext now wraps its work in.
// Default is pass-through: call compute() and return its result, so
// pre-existing value assertions keep working without knowing the
// cache exists.
const getOrComputeSpy = vi.fn(async (_key: string, _ttl: number, compute: () => Promise<any>) => compute());

vi.mock('../src/services/tenantScope', () => ({
  resolveClientNumberForUser: (...a: any[]) => resolveTenant(...a),
}));
vi.mock('../src/db/prisma', () => ({
  default: { userPrompt: { findMany: vi.fn(async () => []) } }, // no overlay rules in these tests
}));
vi.mock('../src/utils/redisClient', () => ({
  getOrCompute: (...a: any[]) => getOrComputeSpy(...(a as [string, number, () => Promise<any>])),
}));
vi.mock('../src/services/knowledge/instructionService', () => ({
  getActiveInstructions: (...a: any[]) => getInstructions(...a),
  renderInstructionsBlock: (...a: any[]) => renderInstr(...(a as [any[]])),
}));
vi.mock('../src/services/knowledge/preferenceLearnerService', () => ({
  getLearnedPreferences: (...a: any[]) => getPrefs(...a),
  renderPreferencesBlock: (...a: any[]) => renderPrefs(...(a as [any])),
}));
vi.mock('../src/services/learning/governedMemoriesBlock', () => ({
  renderGovernedMemoriesBlock: (...a: any[]) => governed(...a),
}));

import { renderBrainVoiceContext } from '../src/services/knowledge/brainVoiceContext';

beforeEach(() => {
  vi.clearAllMocks();
  resolveTenant.mockResolvedValue('tmc');
  getInstructions.mockResolvedValue([{ id: 'i1' }]);
  getPrefs.mockResolvedValue({ tone: 'casual' });
  governed.mockResolvedValue('# Approved memories\n- Quote money in PKR');
});

describe('renderBrainVoiceContext', () => {
  it('assembles instructions + learned preferences + governed memories for the user', async () => {
    const block = await renderBrainVoiceContext(2);
    expect(resolveTenant).toHaveBeenCalledWith(2);
    expect(getInstructions).toHaveBeenCalledWith('tmc', 2, expect.any(Number));
    expect(block).toContain('always cc finance');
    expect(block).toContain('terse replies preferred');
    expect(block).toContain('Quote money in PKR');
  });

  it('returns empty string when nothing is known (no prompt noise)', async () => {
    getInstructions.mockResolvedValue([]);
    getPrefs.mockResolvedValue(null);
    governed.mockResolvedValue('');
    expect(await renderBrainVoiceContext(2)).toBe('');
  });

  it('degrades per-block — one failing source never blocks the others', async () => {
    getInstructions.mockRejectedValue(new Error('db down'));
    const block = await renderBrainVoiceContext(2);
    expect(block).toContain('terse replies preferred');
    expect(block).not.toContain('always cc finance');
  });

  it('returns empty when the tenant cannot be resolved (fail quiet, not wrong)', async () => {
    resolveTenant.mockResolvedValue(null);
    expect(await renderBrainVoiceContext(2)).toBe('');
  });

  // ─────────────────────────────────────────────────────────────────
  // Fix 3 (2026-07-09) — cache hot-path reads.
  //
  // withUserPrompts is called on every specialized email compose, and
  // autonomousExecutor invokes it PER FEED EVENT during draft passes.
  // Previously each call ran a tenant lookup + three DB queries fully
  // uncached, while brainComposer caches the same sources via
  // getOrCompute with matching 60s TTLs. Wrapping the body in
  // getOrCompute(`voicecontext:${userId}`, 60, ...) closes the
  // asymmetry — same staleness bound as the composer caches.
  // ─────────────────────────────────────────────────────────────────

  it('wraps the compute in getOrCompute with the per-user cache key + 60s TTL', async () => {
    await renderBrainVoiceContext(2);
    expect(getOrComputeSpy).toHaveBeenCalled();
    const [key, ttl] = getOrComputeSpy.mock.calls[0]!;
    expect(key).toBe('voicecontext:2');
    expect(ttl).toBe(60);
  });

  it('varies the cache key by userId (no cross-user bleed)', async () => {
    await renderBrainVoiceContext(2);
    await renderBrainVoiceContext(5);
    const keys = getOrComputeSpy.mock.calls.map((c) => c[0]);
    expect(keys).toContain('voicecontext:2');
    expect(keys).toContain('voicecontext:5');
  });
});

describe('withUserPrompts carries the brain voice context', () => {
  it('appends brain-known context after overlay rules', async () => {
    const { withUserPrompts } = await import('../src/services/knowledge/userPromptService');
    const system = await withUserPrompts('BASE PROMPT', 2, 'delegation');
    expect(system).toContain('BASE PROMPT');
    expect(system).toContain('always cc finance');       // standing instruction
    expect(system).toContain('terse replies preferred'); // learned preference
    expect(system).toContain('Quote money in PKR');      // governed memory
  });

  it('returns just the base prompt when nothing is known', async () => {
    getInstructions.mockResolvedValue([]);
    getPrefs.mockResolvedValue(null);
    governed.mockResolvedValue('');
    const { withUserPrompts } = await import('../src/services/knowledge/userPromptService');
    const system = await withUserPrompts('BASE PROMPT', 999, 'delegation');
    expect(system).toBe('BASE PROMPT');
  });
});
