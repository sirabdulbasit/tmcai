import { describe, it, expect, vi, beforeEach } from 'vitest';

// D3 — daily RiskFlagDoc was computed and filed, never surfaced: risks were
// discovered and silently archived. The notify_user_risk registry handler
// routes risk outreach through the executor — so it is autonomy-gated (D1,
// initiator:'brain'), audited as an AgentAction, and confirmed against the
// prompt queue (B2).

const enqueueMock = vi.fn(async () => ({ status: 'queued', promptId: 'bp_1' }));
const queueFindFirst = vi.fn();

vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueueMock(...a),
}));
vi.mock('../src/db/prisma', () => ({
  default: { brainPromptQueue: { findFirst: (...a: any[]) => queueFindFirst(...a) } },
}));

import { NotifyUserRiskHandler } from '../src/services/actions/handlers/brain/notifyUserRisk';

const ctx = {
  clientNumber: 'tmc', userId: 2,
  payload: {
    docId: 'risk:tmc:2:2026-07-08',
    summary: '2 high-severity risks: FACL payment overdue; Haseeb silent 9 days.',
    highSeverityCount: 2,
  },
};

beforeEach(() => vi.clearAllMocks());

describe('NotifyUserRiskHandler', () => {
  it('execute enqueues a deduped high-criticality brain prompt', async () => {
    const h = new NotifyUserRiskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 2, clientNumber: 'tmc',
      criticality: 'high',
      dedupKey: 'risk-outreach:risk:tmc:2:2026-07-08',
    }));
    expect((out.output as any).dedupKey).toBe('risk-outreach:risk:tmc:2:2026-07-08');
  });

  it('execute treats queue dedup as ok (already surfaced today)', async () => {
    enqueueMock.mockResolvedValue({ status: 'duplicate', reason: 'dedup_key already queued' });
    const h = new NotifyUserRiskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    expect((out.output as any).status).toBe('duplicate');
  });

  it('confirm re-reads the queue row by dedupKey — fail closed when absent', async () => {
    const h = new NotifyUserRiskHandler();
    queueFindFirst.mockResolvedValueOnce({ id: 'bp_1' });
    expect(await h.confirm(ctx as any, { dedupKey: 'risk-outreach:risk:tmc:2:2026-07-08' })).toBe(true);
    queueFindFirst.mockResolvedValueOnce(null);
    expect(await h.confirm(ctx as any, { dedupKey: 'risk-outreach:risk:tmc:2:2026-07-08' })).toBe(false);
  });

  it('validate rejects a payload without docId or summary', async () => {
    const h = new NotifyUserRiskHandler();
    const r = await h.validate({ ...ctx, payload: {} } as any);
    expect(r.valid).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────
  // Fix 2 (2026-07-09) — hardcoded prose on a user-facing surface.
  //
  // The prior renderQuestion appended "Reply here or open the Day Brief
  // for details." — hardcoded English pretending to be Brain, violating
  // NEXEO_SPEC.md rule 4 (every Brain-surface reply is LLM-generated OR
  // a bracketed system marker). The handler comment ALSO lied — it
  // claimed the summary was "LLM-narrated upstream", but riskRadar
  // built the summary via buildSummary()'s hardcoded template while
  // the real LLM narrative was available (config.narrate) and unused.
  //
  // Fix: pass the LLM narrative in the dispatch payload; the handler
  // prefers it as the question body. When absent, emit a fully bracketed
  // system digest — no unbracketed trailing prose ever.
  // ─────────────────────────────────────────────────────────────────

  it('renders the LLM narrative as the question body when present in payload', async () => {
    const h = new NotifyUserRiskHandler();
    const narrative = 'Sir, two things need eyes today — Fahim missed the FACL payment window and Haseeb has been quiet for nine days.';
    const withNarrative = { ...ctx, payload: { ...ctx.payload, narrative } };
    await h.execute(withNarrative as any);
    const question = String(enqueueMock.mock.calls[0]?.[0]?.question ?? '');
    expect(question).toContain(narrative);
    // No hardcoded English trailer (rule 4).
    expect(question).not.toMatch(/Reply here or open the Day Brief for details\./);
  });

  it('falls back to a fully-bracketed system digest when no narrative — no unbracketed prose', async () => {
    const h = new NotifyUserRiskHandler();
    const withoutNarrative = { ...ctx, payload: { ...ctx.payload, narrative: null } };
    await h.execute(withoutNarrative as any);
    const question = String(enqueueMock.mock.calls[0]?.[0]?.question ?? '');
    // Fully bracketed prefix — the marker rule.
    expect(question).toMatch(/^\[risk radar\]/);
    // Summary and Day Brief pointer stay inside brackets, never free prose.
    expect(question).toContain(ctx.payload.summary);
    expect(question).toContain('[details on Day Brief]');
    // Zero unbracketed sentences following the bracketed portion.
    expect(question).not.toMatch(/Reply here or open the Day Brief for details\./);
    expect(question).not.toMatch(/[.!?]\s+[A-Z][^[]+[.!?]\s*$/); // any trailing free sentence
  });

  it('bracketed fallback also fires when narrative is undefined (missing key)', async () => {
    const h = new NotifyUserRiskHandler();
    await h.execute(ctx as any); // ctx.payload has no `narrative` field
    const question = String(enqueueMock.mock.calls[0]?.[0]?.question ?? '');
    expect(question).toMatch(/^\[risk radar\]/);
  });

  it('bracketed fallback also fires when narrative is an empty string (trim guard)', async () => {
    const h = new NotifyUserRiskHandler();
    await h.execute({ ...ctx, payload: { ...ctx.payload, narrative: '   ' } } as any);
    const question = String(enqueueMock.mock.calls[0]?.[0]?.question ?? '');
    expect(question).toMatch(/^\[risk radar\]/);
  });
});
