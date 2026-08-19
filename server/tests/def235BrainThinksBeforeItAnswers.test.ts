/**
 * DEF-235 — Brain thinks before it answers, and thinking never shortens the answer.
 *
 * Owner, 2026-08-19: "LLM should be thinking model of brain."
 *
 * It was not one. The conversational path ran gemini-2.5-pro with `thinkingBudget: 128` — the
 * smallest value the model accepts without a 400 — because Gemini bills thinking tokens
 * against `maxOutputTokens`. The two were competing for one pool and the answer won by making
 * the thinking negligible. Now the budget is ADDED to the answer's room, so they no longer
 * compete.
 *
 * The tests that matter here are the two guarding COST, not the one raising the budget:
 * `callGemini` serves `triage` at 58,539 Pro calls a fortnight against this path's 64. A
 * global default would have added roughly 120M billed thinking tokens for work that
 * classifies rather than reasons.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateContent = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class { models = { generateContent, countTokens: vi.fn() }; },
}));
// The service refuses to build a request without a key, and rightly so. `env.geminiApiKey` is
// a getter over process.env, so the variable is the seam. This test is about the SHAPE of the
// request and nothing leaves the box — generateContent is mocked above.
process.env.GEMINI_API_KEY = 'test-key-not-a-real-credential';

async function callWith(opts: any) {
  generateContent.mockReset();
  generateContent.mockResolvedValue({ text: 'ok' });
  vi.resetModules();
  const { callGemini } = await import('../src/services/geminiService');
  await callGemini('sys', 'user', opts);
  return generateContent.mock.calls[0]?.[0]?.config ?? {};
}

describe('DEF-235 — the thinking budget', () => {
  beforeEach(() => { generateContent.mockReset(); });

  it('is spent when a caller asks for it', async () => {
    const cfg = await callWith({ maxTokens: 2048, thinkingBudget: 4096 });
    expect(cfg.thinkingConfig.thinkingBudget).toBe(4096);
  });

  it('is ADDED to the answer room, never subtracted from it', async () => {
    // The whole defect in one assertion: with the old arithmetic a 4096-token budget left
    // nothing of a 2048 ceiling and the reply came back truncated.
    const cfg = await callWith({ maxTokens: 2048, thinkingBudget: 4096 });
    expect(cfg.maxOutputTokens).toBe(2048 + 4096);
    expect(cfg.maxOutputTokens).toBeGreaterThan(cfg.thinkingConfig.thinkingBudget);
  });

  it('leaves the answer room UNCHANGED versus no thinking at all', async () => {
    const withNone = await callWith({ maxTokens: 2048 });
    const withLots = await callWith({ maxTokens: 2048, thinkingBudget: 4096 });
    const answerRoom = (c: any) => c.maxOutputTokens - c.thinkingConfig.thinkingBudget;
    expect(answerRoom(withLots)).toBe(answerRoom(withNone));
  });

  it('DEFAULTS to the old minimum, so 58k triage calls are untouched', async () => {
    // The cost guard. `triage` does not pass thinkingBudget, and must keep paying nothing
    // extra. If a future change makes a real budget the default, this fails loudly.
    const cfg = await callWith({ maxTokens: 2048 });
    expect(cfg.thinkingConfig.thinkingBudget).toBe(128);
  });

  it('stays 0 on Flash even when a budget is requested — Flash rejects anything else', async () => {
    const cfg = await callWith({ maxTokens: 2048, flash: true, thinkingBudget: 4096 });
    expect(cfg.thinkingConfig.thinkingBudget).toBe(0);
    // And a Flash call must not silently buy a bigger output ceiling either.
    expect(cfg.maxOutputTokens).toBe(2048);
  });

  it('never sends 0 on Pro — the model 400s on it', async () => {
    // Observed 2026-05-20 on a real WhatsApp turn: "Budget 0 is invalid. This model only
    // works in thinking mode."
    const cfg = await callWith({ maxTokens: 2048, thinkingBudget: 0 });
    expect(cfg.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
  });
});

describe('DEF-235 — the conversational path is the one that thinks', () => {
  it('chat_compose asks for a real budget', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../src/services/knowledge/brainComposer.ts', import.meta.url), 'utf8');
    const call = src.slice(src.indexOf("purpose: 'chat_compose'") - 1200,
                           src.indexOf("purpose: 'chat_compose'") + 40);
    expect(call).toMatch(/thinkingBudget:\s*\d{3,}/);
  });

  it('the classifiers do NOT — this is the cost boundary', async () => {
    const fs = await import('fs');
    for (const [file, purpose] of [
      ['../src/services/knowledge/brainRetrievalPlanner.ts', 'retrieval_plan'],
      ['../src/services/knowledge/brainCognitiveEngine.ts', 'cognitive_mind_state'],
    ] as const) {
      const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
      const at = src.indexOf(`purpose: '${purpose}'`);
      expect(at, `${purpose} call site must exist`).toBeGreaterThan(-1);
      expect(src.slice(Math.max(0, at - 900), at),
        `${purpose} must not buy a thinking budget`).not.toMatch(/thinkingBudget/);
    }
  });
});
