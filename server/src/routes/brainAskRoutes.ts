/**
 * MyOS Knowledge Center — /brain/ask
 *
 * Two-pass living-brain path (see docs/brain_schema.md §3.2):
 *
 *   Pass 1 (plan)    brainRetrievalPlanner decides which pages to open.
 *   Pass 2 (compose) brainComposer answers using only opened pages and
 *                    returns {answer, cites, gaps} as JSON.
 *
 * Sources shown to the UI = only pages the LLM actually cited. Any gap the
 * LLM names is filed as a `gap` wiki page so next week's Brain sees the
 * hole instead of bluffing again. Every turn appends one line to the
 * tenant_log.
 */
import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';
import { planRetrieval } from '../services/knowledge/brainRetrievalPlanner';
import { compose, openPagesForPlan } from '../services/knowledge/brainComposer';
import { appendTenantLog } from '../services/knowledge/tenantLogService';
import { rebuildTenantIndex } from '../services/knowledge/tenantIndexService';
import { recordGaps } from '../services/knowledge/gapPageService';

// Stopwords for gap self-heal: words that don't carry topic identity.
// We require at least one distinctive token to trigger a heal so a
// generic question doesn't archive every gap in the tenant.
const STOP_HEAL = new Set([
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
  'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'the', 'and', 'or', 'but', 'for', 'from', 'about',
  'tell', 'show', 'give', 'me', 'us', 'you', 'your',
  'this', 'that', 'these', 'those', 'any', 'some',
  'have', 'has', 'had', 'did', 'do', 'does', 'said',
]);

const router = Router();

router.use((req: Request, res: Response, next) => {
  if (!(req as any).user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  next();
});

/**
 * Two-pass query. See docs/brain_schema.md §3.2.
 *
 *   1. plan     — Gemini Flash reads schema + tenant_index + question and
 *                 returns a JSON retrieval plan (which pages to open, which
 *                 entities to look up, which FACL docs to read in full).
 *   2. compose  — main LLM receives ONLY the opened pages and persona, and
 *                 returns {answer, cites, gaps} as JSON. Sources surfaced to
 *                 the UI are exactly the cited page IDs.
 *
 * Side effects per turn:
 *   - Gaps filed as `gap` wiki pages (deduped, hit-counted).
 *   - One line appended to tenant_log.
 *   - tenant_index is rebuilt in the background (debounced 30s) so new
 *     pages become discoverable on the next turn.
 */
export interface BrainHistoryTurn {
  role: 'user' | 'brain' | 'artifact';
  text: string;
}

export interface BrainArtifactForCaller {
  kind: string;
  artifactId: string;
  summary: string;
  dispatchedAt: string;
}

export async function answerAsBrain(
  clientNumber: string,
  userId: number,
  question: string,
  history: BrainHistoryTurn[] = [],
  opts: { steeringHint?: string | null; channel?: 'web' | 'whatsapp' } = {},
): Promise<{ answer: string; sources: Array<{ type: string; id: any; snippet: string }>; gaps?: string[]; intent?: string; panel?: import('../services/knowledge/channelRenderer').PanelDirective | null; artifact?: BrainArtifactForCaller | null }> {
  // Trim history to the last 24 turns. Wider window than before so
  // role='artifact' entries from earlier in the session reach the
  // composer for cancel/reschedule resolution; conversation messages
  // are still capped at 6 inside compose's history block renderer.
  const trimmedHistory = history.slice(-24);
  const plan = await planRetrieval(
    clientNumber, userId, question,
    trimmedHistory
      .filter((h): h is { role: 'user' | 'brain'; text: string } => h.role !== 'artifact'),
  );
  const opened = await openPagesForPlan(clientNumber, userId, plan, question);

  // Quality Sprint 4: agentic read-only multi-step reader.
  // Triggers on chained-reasoning questions ("check X and tell me Y"
  // / "if so do Z"). Read-only: writes still go through linear path.
  const { looksLikeAgenticTurn, runAgenticReader } = await import('../services/knowledge/agenticReader');
  const useAgentic = looksLikeAgenticTurn(question);
  let result: Awaited<ReturnType<typeof compose>>;
  if (useAgentic) {
    try {
      const { getBrainPersona } = await import('../services/knowledge/brainPersonaService');
      const persona = await getBrainPersona(userId, clientNumber).catch(() => null);
      const agenticOut = await runAgenticReader({
        question, userId, clientNumber,
        systemPrompt: persona?.systemPreamble ?? '',
        history: trimmedHistory.filter((h): h is { role: 'user' | 'brain'; text: string } => h.role !== 'artifact'),
      });
      console.info('[brain-chat] agentic.completed', {
        userId, clientNumber,
        toolCallsExecuted: agenticOut.toolCallsExecuted,
        toolsUsed: agenticOut.toolsUsed,
        budgetExceeded: agenticOut.budgetExceeded,
      });
      result = {
        answer: agenticOut.answer,
        citedPageIds: [],
        gaps: [],
        sources: [],
        action: null,
        actionResult: null,
      };
    } catch (e: any) {
      console.warn('[brain-chat] agentic.failed - falling back to linear compose', {
        userId, error: e?.message,
      });
      result = await compose(clientNumber, userId, question, plan, opened, trimmedHistory, {
        steeringHint: opts.steeringHint ?? null,
        channel: opts.channel,
      });
    }
  } else {
    result = await compose(clientNumber, userId, question, plan, opened, trimmedHistory, {
      steeringHint: opts.steeringHint ?? null,
      channel: opts.channel,
    });
  }

  // Sprint 4B: validateBeforeRender — single consolidated safety pass.
  // Catches the runtime patterns that have caused user-visible failures
  // (empty promises, fabricated escalations, raw JSON leaks, raw LLM
  // provider error strings). Any block-severity violation rewrites
  // the answer with a bracketed status marker before it reaches the
  // channel renderer. Cheap (regex only); deterministic.
  try {
    const { validateBeforeRender } = await import('../services/knowledge/responseValidator');
    // Look up active pending status so preview_vs_done_confusion can fire.
    const { getActivePending } = await import('../services/knowledge/pendingActionService');
    const pendingForValidator = await getActivePending(userId, (opts.channel ?? 'web') as 'web' | 'whatsapp').catch(() => null);
    const validation = validateBeforeRender(result, {
      pendingStatus: pendingForValidator?.status ?? null,
    });
    if (!validation.ok && validation.replacement) {
      console.warn('[brain-chat] validateBeforeRender block', {
        userId, clientNumber,
        rules: validation.violations.filter((v) => v.severity === 'block').map((v) => v.rule),
        originalHead: result.answer.slice(0, 120),
      });
      result.answer = validation.replacement;
    } else if (validation.violations.length > 0) {
      // Warn-only: log + optionally rewrite for style-rule violations
      // whose suggestedReplacement is a safe in-place edit (e.g.
      // style_fake_enthusiasm strips the banned opener).
      const warns = validation.violations;
      console.info('[brain-chat] validateBeforeRender warn', {
        userId, clientNumber,
        rules: warns.map((v) => v.rule),
      });
      // Phase B: auto-apply the fake-enthusiasm strip. Other style
      // warns (vague_filler, over_hedging, no_next_move) are flagged
      // only — they need composer changes, not post-hoc rewrites.
      const fakeEnth = warns.find((v) => v.rule === 'style_fake_enthusiasm' && v.suggestedReplacement);
      if (fakeEnth?.suggestedReplacement && fakeEnth.suggestedReplacement.length > 10) {
        console.info('[brain-chat] auto-strip fake_enthusiasm opener', {
          userId, clientNumber,
          originalHead: result.answer.slice(0, 60),
          newHead: fakeEnth.suggestedReplacement.slice(0, 60),
        });
        result.answer = fakeEnth.suggestedReplacement;
      }
    }
  } catch (e: any) {
    // Validator failure must not break user reply. Log and ship as-is.
    console.warn('[brain-chat] validateBeforeRender threw', { userId, error: e?.message });
  }

  // Channel render — wraps the composer output in the per-channel
  // formatter so WhatsApp sees a terse one-paragraph answer while
  // web sees the full markdown.
  const channel = opts.channel ?? 'web';
  // Decide if a dashboard panel should accompany the answer (web only).
  // For WA we skip the decision entirely — the renderer drops panels.
  let panel: import('../services/knowledge/channelRenderer').PanelDirective | null = null;
  if (channel === 'web') {
    try {
      const { decidePanel } = await import('../services/knowledge/panelDecider');
      panel = await decidePanel({ userId, clientNumber, intent: plan.intent });
    } catch { /* non-critical — answer ships without a panel */ }
  }
  if (channel === 'whatsapp') {
    const { renderForChannel } = await import('../services/knowledge/channelRenderer');
    const rendered = renderForChannel(result, 'whatsapp');
    // Replace the prose with the rendered body but keep the rest of
    // the composer's output (sources etc.) for downstream side-effects.
    result.answer = rendered.body;
  }

  // Side effects (fire-and-forget — don't block the response on them)
  Promise.resolve().then(async () => {
    try {
      if (result.gaps.length > 0) {
        await recordGaps(clientNumber, userId, result.gaps, question);
      }
      // Phase D — file the answer back as an answer wiki page so repeat
      // questions find prior answers in the next turn's planner index.
      // Rule: only file COMPLETE answers. If this turn produced gaps,
      // the answer is by definition partial / missing-data and should
      // NOT become a reusable page — otherwise next time the question is
      // asked, the stale "I don't have it" page outranks real data.
      if (
        result.citedPageIds.length > 0
        && plan.intent !== 'casual'
        && (result.gaps?.length ?? 0) === 0
      ) {
        const { fileAnswer } = await import('../services/knowledge/answerPageService');
        await fileAnswer({
          clientNumber, userId, question,
          answer: result.answer, intent: plan.intent,
          citedPageIds: result.citedPageIds,
        });

        // Self-heal stale gap pages — if the user previously asked this
        // (or a near-identical) question and Brain logged a gap, that
        // gap is no longer real now that we just produced a complete
        // answer. Archive it so it stops dominating future retrieval.
        // Match by trigram similarity on the gap's triggering_question.
        const tokens = question.toLowerCase().match(/\b[a-z][a-z0-9]{2,}\b/g) ?? [];
        const distinctive = tokens.filter((t) => !STOP_HEAL.has(t)).slice(0, 6);
        if (distinctive.length >= 1) {
          await prisma.$executeRawUnsafe(
            `UPDATE wiki_pages
                SET status = 'deleted',
                    last_updated_at = NOW(),
                    last_updated_by = 'self_heal_gap',
                    metadata = jsonb_set(COALESCE(metadata,'{}'::jsonb), '{healedBy}', to_jsonb($3::text))
              WHERE client_number = $1 AND user_id = $2
                AND page_type = 'gap'
                AND status = 'active'
                AND (
                  similarity(metadata->>'lastAskedQuestion', $4) > 0.5
                  OR similarity(title, $4) > 0.5
                )`,
            clientNumber, userId, question.slice(0, 200), question,
          ).catch(() => 0);
        }
      }
      await appendTenantLog(clientNumber, userId, {
        kind: 'query',
        title: question.slice(0, 120),
        detail: `intent=${plan.intent} opened=${opened.length} cites=${result.citedPageIds.length} gaps=${result.gaps.length}`,
      });
      // Rebuild index lazily so brand-new gap/answer pages show up next turn.
      rebuildTenantIndex(clientNumber, userId).catch(() => {});
    } catch { /* best-effort */ }
  });

  // Surface the artifact (if this turn dispatched a successful action)
  // so the caller can persist it into session history for next-turn
  // cancel/reschedule resolution. result.actionResult and result.action
  // come from compose; map to a stable shape the caller can store.
  let artifact: BrainArtifactForCaller | null = null;
  if (
    result.actionResult &&
    result.actionResult.ok === true &&
    result.actionResult.artifactId &&
    result.action
  ) {
    artifact = {
      kind: result.action.type,
      artifactId: String(result.actionResult.artifactId),
      summary: result.actionResult.message?.slice(0, 200) ?? '',
      dispatchedAt: new Date().toISOString(),
    };
  }

  return {
    answer: result.answer,
    sources: result.sources,
    gaps: result.gaps,
    intent: plan.intent,
    panel,
    artifact,
  };
}

// ─── Route ────────────────────────────────────────────────────

// Phase E — persist a single user signal (accept/reject/delegate/edit/...).
// UI surfaces (Day Brief attention cards, draft cards) POST here on every
// click so preference inference has a history to read.
router.post('/signal', async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const s = req.body ?? {};
    if (!s.kind) return res.status(400).json({ error: 'kind required' });
    const { recordSignal } = await import('../services/knowledge/preferenceLearnerService');
    await recordSignal(user.clientNumber, user.id, {
      kind: s.kind,
      archetype: s.archetype,
      senderDomain: s.senderDomain,
      delegateeEmail: s.delegateeEmail,
      tone: s.tone,
      editRatio: typeof s.editRatio === 'number' ? s.editRatio : undefined,
      context: s.context,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Instructions — standing orders the user gives Brain. 6th layer of MyOS.
 *  Two scopes: 'client' (tenant-wide, admin-only) and 'user' (personal). */
function isAdmin(u: any): boolean {
  return u?.userType === 'SA' || u?.userType === 'AD';
}

router.post('/instructions', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const text = String(req.body?.text ?? '').trim();
  const scope = req.body?.scope === 'client' ? 'client' : 'user';
  if (!text) return res.status(400).json({ error: 'text required' });
  if (scope === 'client' && !isAdmin(user)) {
    return res.status(403).json({ error: 'client-scope instructions require admin' });
  }
  try {
    const { createInstructionFromText } = await import('../services/knowledge/instructionService');
    const r = await createInstructionFromText(user.clientNumber, user.id, text, scope);
    if (!r) return res.status(500).json({ error: 'failed to save instruction' });
    res.json({ id: r.id, scope: r.scope, structured: r.structured });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instructions', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '30'), 10) || 30, 100);
  try {
    const { getActiveInstructions } = await import('../services/knowledge/instructionService');
    const rows = await getActiveInstructions(user.clientNumber, user.id, limit);
    res.json({ instructions: rows, isAdmin: isAdmin(user) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/instructions/:id/status', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const status = String(req.body?.status ?? '');
  if (!['active', 'paused', 'fulfilled', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'invalid status' });
  }
  try {
    const { updateInstructionStatus } = await import('../services/knowledge/instructionService');
    const r = await updateInstructionStatus(user.clientNumber, user.id, id, status as any, { isAdmin: isAdmin(user) });
    if (!r.ok) {
      const code = r.reason === 'not found' ? 404 : 403;
      return res.status(code).json({ error: r.reason ?? 'update failed' });
    }
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Feedback (👍 / 👎) ────────────────────────────────────────
//
// Called by every Brain-produced surface (chat answer, brain action,
// draft, observation, attention card, criticality score). On 👎 the
// service fires a diagnosis LLM pass that files a feedback_diagnosis
// wiki page hypothesizing the failure category.
router.post('/feedback', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { subjectType, subjectId, rating, reason, context } = req.body ?? {};
  const allowedSubjects = ['chat_answer','brain_action','draft','observation','attention_card','criticality_score','other'];
  if (!allowedSubjects.includes(String(subjectType))) {
    return res.status(400).json({ error: 'invalid subjectType' });
  }
  if (!subjectId) return res.status(400).json({ error: 'subjectId required' });
  if (rating !== 'up' && rating !== 'down') return res.status(400).json({ error: 'rating must be "up" or "down"' });

  try {
    const { recordFeedback } = await import('../services/knowledge/feedbackService');
    // For chat_answer downvotes we run diagnosis SYNCHRONOUSLY so the UI
    // can decide whether to offer "Try again". Other surfaces stay
    // fire-and-forget (UI already navigated away by the time diagnosis
    // would finish).
    const awaitDiagnosis = subjectType === 'chat_answer' && rating === 'down';
    const r = await recordFeedback({
      clientNumber: user.clientNumber,
      userId: user.id,
      subjectType,
      subjectId: String(subjectId),
      rating,
      reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 800) : null,
      context: typeof context === 'object' && context ? context : undefined,
      awaitDiagnosis,
    });
    res.json({ ok: true, ...r });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Retry — re-compose a chat answer with diagnosis as steering ─────
//
// The chat retry loop. After a 👎 with a high-confidence diagnosis, the
// UI calls this endpoint with the original question + diagnosis fields.
// The composer is invoked with the diagnosis as a "Retry guidance" block,
// the new answer is returned alongside its cited sources. The UI shows
// it as a fresh message; the user can 👍 or 👎 the retry independently.
router.post('/retry', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  const diagnosis = req.body?.diagnosis ?? {};
  const category = String(diagnosis.category ?? '').slice(0, 60);
  const hypothesis = String(diagnosis.hypothesis ?? '').slice(0, 400);
  const likelyFix = String(diagnosis.likelyFix ?? '').slice(0, 400);
  if (!category && !hypothesis && !likelyFix) {
    return res.status(400).json({ error: 'diagnosis with at least category/hypothesis/likelyFix required' });
  }

  // Compose the steering hint — short structured block the LLM can use
  // as the highest-priority correction.
  const steeringHint = [
    category ? `Failure category: ${category}` : '',
    hypothesis ? `What went wrong: ${hypothesis}` : '',
    likelyFix ? `What to do differently: ${likelyFix}` : '',
  ].filter(Boolean).join('\n');

  // Optional history (so follow-ups still resolve correctly on retry)
  const rawHistory: any[] = Array.isArray(req.body?.history) ? req.body.history : [];
  const history: BrainHistoryTurn[] = rawHistory
    .filter((t) => t && (t.role === 'user' || t.role === 'brain') && typeof t.text === 'string')
    .map((t) => ({ role: t.role, text: String(t.text).slice(0, 2000) }));

  try {
    const out = await answerAsBrain(user.clientNumber, user.id, question, history, { steeringHint });
    res.json({
      question,
      answer: out.answer,
      sources: out.sources,
      gaps: out.gaps,
      intent: out.intent,
      retry: { category, applied: true },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** "What Brain learned this week" rollup — drives the Day Brief panel.
 *  Combines feedback counts, diagnoses by category, calibration state,
 *  and Brain's own self-recommendations. */
router.get('/learned', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const days = Math.min(parseInt(String(req.query.days ?? '7'), 10) || 7, 30);
  try {
    const { getLearningRollup } = await import('../services/knowledge/feedbackService');
    const rollup = await getLearningRollup(user.clientNumber, user.id, days);
    res.json(rollup);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** List recent 👎 diagnoses for this user — drives an "here's what I
 *  learned from what you disliked this week" summary on Day Brief. */
router.get('/feedback/diagnoses', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  try {
    const { listRecentDownDiagnoses, getFeedbackCounts } = await import('../services/knowledge/feedbackService');
    const [diagnoses, counts] = await Promise.all([
      listRecentDownDiagnoses(user.clientNumber, user.id, limit),
      getFeedbackCounts(user.clientNumber, user.id),
    ]);
    res.json({ diagnoses, counts });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── User Action Rules — friendly NL editor ─────────────────────
//
// Conservative + friendly: every new rule starts in DRAFT mode (Brain
// only LOGS what it would have done). The user explicitly promotes it
// to SUGGEST, then to AUTO. AUTO requires a typed confirmation phrase.

router.post('/action-rules/parse', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const { parseRuleFromNL } = await import('../services/userActionRuleService');
    const parsed = await parseRuleFromNL(text, user.clientNumber, user.id);
    if (!parsed) return res.status(422).json({ error: 'could not parse — rephrase or try a clearer trigger' });
    res.json({ parsed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/action-rules', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const body = req.body ?? {};
  if (!body.name || !body.triggerKind || !body.actionType) {
    return res.status(400).json({ error: 'name, triggerKind, actionType required' });
  }
  if (body.scope === 'client' && user.userType !== 'SA' && user.userType !== 'AD') {
    return res.status(403).json({ error: 'client-scope rules require admin' });
  }
  try {
    const { createRule } = await import('../services/userActionRuleService');
    const rule = await createRule({
      clientNumber: user.clientNumber,
      userId: user.id,
      scope: body.scope === 'client' ? 'client' : 'user',
      name: body.name,
      nlOriginal: body.nlOriginal ?? body.name,
      triggerKind: body.triggerKind,
      triggerCondition: body.triggerCondition ?? {},
      actionType: body.actionType,
      actionPayload: body.actionPayload ?? {},
      confidenceThreshold: body.confidenceThreshold,
    });
    res.json({ rule });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/action-rules', async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const { listRules } = await import('../services/userActionRuleService');
    const rules = await listRules(user.clientNumber, user.id);
    res.json({ rules });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/action-rules/:id/mode', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const mode = String(req.body?.mode ?? '');
  const confirmPhraseForAuto = req.body?.confirmPhraseForAuto;
  if (!['DRAFT','SUGGEST','AUTO'].includes(mode)) return res.status(400).json({ error: 'mode must be DRAFT|SUGGEST|AUTO' });
  try {
    const { setRuleMode } = await import('../services/userActionRuleService');
    const r = await setRuleMode(user.clientNumber, user.id, id, mode as any, {
      confirmPhraseForAuto,
      isAdmin: user.userType === 'SA' || user.userType === 'AD',
    });
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json({ ok: true, rule: r.rule });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/action-rules/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const { deleteRule } = await import('../services/userActionRuleService');
    const r = await deleteRule(user.clientNumber, user.id, String(req.params.id), {
      isAdmin: user.userType === 'SA' || user.userType === 'AD',
    });
    if (!r.ok) return res.status(400).json({ error: r.reason });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ask', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  // Optional conversation history — client sends the last few turns so
  // Brain can resolve follow-ups like "what kind of authorization?"
  // against the prior turn instead of treating each question in isolation.
  const rawHistory: any[] = Array.isArray(req.body?.history) ? req.body.history : [];
  const history: BrainHistoryTurn[] = rawHistory
    .filter((t) => t && (t.role === 'user' || t.role === 'brain') && typeof t.text === 'string')
    .map((t) => ({ role: t.role, text: String(t.text).slice(0, 2000) })); // bound each turn
  // Channel selector — 'web' (default) returns the full markdown
  // answer + sources + cites + gaps. 'whatsapp' compresses to a
  // single short paragraph. Per user 2026-05-16: same composer,
  // same conversation history, different render per channel.
  const channel = (String(req.body?.channel ?? 'web') === 'whatsapp') ? 'whatsapp' : 'web';
  try {
    const out = await answerAsBrain(user.clientNumber, user.id, question, history, { channel });
    if (channel === 'whatsapp') {
      // WA callers get the terse body only — no cites/gaps/intent
      // noise. They can read the audit via the web view if they
      // need to drill in.
      res.json({ question, answer: out.answer });
    } else {
      res.json({ question, answer: out.answer, sources: out.sources, gaps: out.gaps, intent: out.intent, panel: out.panel ?? null });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Quality Sprint 5e (2026-05-21): Server-Sent Events streaming
 * endpoint for the web Brain Chat.
 *
 * Streams the FINAL composed answer in chunks for a "progressive"
 * UX. The compose pipeline still runs in full (preview gate,
 * idempotency, validateBeforeRender, etc.) before any token streams
 * — those guarantees can't safely be bypassed for write actions.
 *
 * Event types emitted:
 *   - thinking: { stage: string }       // status updates during compose
 *   - chunk:    { text: string }        // incremental answer text
 *   - meta:     { sources, intent, panel } // sent before done
 *   - done:     {}                      // stream complete
 *   - error:    { message: string }
 *
 * Web UI consumes via EventSource. For action turns, the full
 * answer is sent in fewer / larger chunks (the user's already past
 * the "show me you're working" point). For read turns, smaller
 * chunks give the typing feel.
 *
 * Note: Gemini's true token-streaming would require refactoring
 * compose to emit tokens. That's a bigger change — this endpoint
 * delivers the streaming-UX win without the architectural risk.
 */
router.post('/ask-stream', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const question = String(req.body?.question ?? '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  const rawHistory: any[] = Array.isArray(req.body?.history) ? req.body.history : [];
  const history: BrainHistoryTurn[] = rawHistory
    .filter((t) => t && (t.role === 'user' || t.role === 'brain') && typeof t.text === 'string')
    .map((t) => ({ role: t.role, text: String(t.text).slice(0, 2000) }));
  const channel = (String(req.body?.channel ?? 'web') === 'whatsapp') ? 'whatsapp' : 'web';

  // SSE headers.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx: don't buffer SSE
  res.flushHeaders?.();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    (res as any).flush?.();
  };

  try {
    sendEvent('thinking', { stage: 'planning' });
    const out = await answerAsBrain(user.clientNumber, user.id, question, history, { channel });

    // Send metadata first so UI can hydrate cites/panel as the
    // text streams.
    sendEvent('meta', {
      intent: out.intent,
      sources: out.sources,
      panel: out.panel ?? null,
    });

    // Chunk the answer. For prose-heavy responses, 40-60 chars per
    // chunk feels natural. For very short answers (<200 chars), a
    // single chunk avoids artificial chop.
    const answer = out.answer ?? '';
    if (answer.length < 200) {
      sendEvent('chunk', { text: answer });
    } else {
      // Split at sentence boundaries when possible; fall back to word.
      const sentences = answer.split(/(?<=[.!?])\s+/);
      let buf = '';
      for (const s of sentences) {
        buf += (buf ? ' ' : '') + s;
        if (buf.length >= 60) {
          sendEvent('chunk', { text: buf });
          buf = '';
          // Tiny inter-chunk pause to make it feel natural.
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      if (buf) sendEvent('chunk', { text: buf });
    }

    sendEvent('done', {});
    res.end();
  } catch (err: any) {
    sendEvent('error', { message: err?.message ?? 'unknown' });
    res.end();
  }
});

/**
 * Delegatee picker — returns a ranked list of internal people + known
 * external contacts matching either a free-text search (`q`) or a work-item
 * archetype (`archetype` + `senderDomain`). Powers the Delegate modal.
 */
router.get('/people/suggest', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const q = String(req.query.q ?? '').trim();
  const archetype = String(req.query.archetype ?? 'reply_needed');
  const itemType = String(req.query.itemType ?? 'email');
  const senderDomain = req.query.senderDomain ? String(req.query.senderDomain).toLowerCase() : undefined;

  if (q.length > 0) {
    // Text search mode — fuzzy (pg_trgm similarity + substring OR) across
    // users / entities / delegation_logs / Google Contacts. Similarity
    // catches typos like "Assad" → "Asad Ahmed". Substring handles prefixes.
    const [users, contacts, delegatees, googleContacts] = await Promise.all([
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT id, name, email, department, job_description AS "jobDescription",
                GREATEST(similarity(COALESCE(name,''), $1),
                         similarity(COALESCE(email,''), $1),
                         similarity(COALESCE(department,''), $1)) AS sim
           FROM users
          WHERE client_number = $2 AND is_active = true AND id <> $3
            AND (
              COALESCE(name,'')  ILIKE '%' || $1 || '%'
              OR COALESCE(email,'') ILIKE '%' || $1 || '%'
              OR COALESCE(department,'') ILIKE '%' || $1 || '%'
              OR similarity(COALESCE(name,''),  $1) > 0.2
              OR similarity(COALESCE(email,''), $1) > 0.2
            )
          ORDER BY sim DESC LIMIT 8`,
        q, user.clientNumber, user.id,
      ).catch(() => []),
      prisma.$queryRawUnsafe<Array<any>>(
        `SELECT id, name, email, relationship_strength AS "relationshipStrength",
                GREATEST(similarity(COALESCE(name,''), $1),
                         similarity(COALESCE(email,''), $1)) AS sim
           FROM entities
          WHERE client_number = $2 AND entity_type = 'contact'
            AND (
              COALESCE(name,'')  ILIKE '%' || $1 || '%'
              OR COALESCE(email,'') ILIKE '%' || $1 || '%'
              OR similarity(COALESCE(name,''),  $1) > 0.2
              OR similarity(COALESCE(email,''), $1) > 0.2
            )
          ORDER BY sim DESC, relationship_strength DESC NULLS LAST LIMIT 5`,
        q, user.clientNumber,
      ).catch(() => []),
      prisma.$queryRawUnsafe<Array<{ name: string; email: string; n: number }>>(
        `SELECT COALESCE(delegatee_name, delegatee_email) AS name,
                delegatee_email AS email,
                COUNT(*)::int AS n
           FROM delegation_logs
          WHERE client_number = $1 AND user_id = $2
            AND (
              COALESCE(delegatee_name,'')  ILIKE '%' || $3 || '%'
              OR COALESCE(delegatee_email,'') ILIKE '%' || $3 || '%'
              OR similarity(COALESCE(delegatee_name,''),  $3) > 0.25
              OR similarity(COALESCE(delegatee_email,''), $3) > 0.25
            )
          GROUP BY delegatee_name, delegatee_email
          ORDER BY n DESC LIMIT 5`,
        user.clientNumber, user.id, q,
      ).catch(() => []),
      // Google Contacts (People API) — covers anyone the MD has ever emailed
      // even if they aren't a MyOS user, scribed contact, or prior delegatee.
      (async () => {
        try {
          const { searchGoogleContacts } = await import('../services/googleContactsService');
          const r = await searchGoogleContacts(user.id, q, 8);
          return r.contacts;
        } catch { return []; }
      })(),
    ]);

    // Deduplicate by email across sources. Rank order:
    //   1. MyOS users (internal colleagues, on the platform)
    //   2. Historical delegatees (already proven: MD has delegated to them)
    //   3. Google Workspace directory (internal, not on MyOS yet)
    //   4. Google "other contacts" (people you've emailed — likely external)
    //   5. Scribed external contacts (from wiki_scribe)
    // Delegation is usually internal, so internal sources rank higher.
    const seen = new Set<string>();
    const addIfNew = (email: string | null | undefined) => {
      if (!email) return false;
      const k = email.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    };

    const candidates: Array<any> = [];

    for (const u of users) {
      if (!addIfNew(u.email)) continue;
      candidates.push({
        kind: 'user', userId: u.id, name: u.name, email: u.email,
        note: u.department ? `${u.department}${u.jobDescription ? ' · ' + u.jobDescription.slice(0, 40) : ''}` : 'Internal (MyOS user)',
        score: 1,
      });
    }

    for (const d of delegatees) {
      if (!addIfNew(d.email)) continue;
      candidates.push({
        kind: 'history', userId: null, name: d.name, email: d.email,
        note: `Delegated ${d.n} time${d.n > 1 ? 's' : ''} before`,
        score: 0.8,
      });
    }

    // Separate Google directory (internal) from Google other/contacts (external)
    for (const g of googleContacts) {
      if (!addIfNew(g.email)) continue;
      const isInternal = g.source === 'directory';
      candidates.push({
        kind: isInternal ? 'directory' : 'google',
        userId: null, name: g.name, email: g.email,
        note: isInternal
          ? `Workspace directory${g.organization ? ' · ' + g.organization : ''}${g.role ? ' · ' + g.role : ''}`
          : `From your Google Contacts${g.organization ? ' · ' + g.organization : ''}`,
        score: isInternal ? 0.6 : 0.3,
      });
    }

    for (const c of contacts) {
      if (!addIfNew(c.email)) continue;
      candidates.push({
        kind: 'contact', userId: null, name: c.name, email: c.email,
        note: `External · ${c.relationshipStrength ?? 0} prior interactions`,
        score: 0.2,
      });
    }

    res.json({ candidates });
    return;
  }

  // Suggestion mode — ranked via People Intelligence
  const { suggestOwner } = await import('../services/knowledge/peopleIntelligenceService');
  const ranked = await suggestOwner({
    clientNumber: user.clientNumber,
    itemType: itemType as any,
    archetype: archetype as any,
    senderDomain,
    excludeUserId: user.id,
    limit: 8,
  });
  res.json({
    candidates: ranked.map((r) => ({
      kind: 'user', userId: r.userId, name: r.name, email: r.email,
      note: r.reasons.slice(0, 2).join(' · ') || 'internal',
      score: r.score,
    })),
  });
});

/** Knowledge Center — list top external contacts + accounts for the tenant */
router.get('/entities', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const type = (req.query.type as string) || 'contact'; // contact | account
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const rows = await prisma.entity.findMany({
    where: { clientNumber: user.clientNumber, entityType: type },
    orderBy: [{ relationshipStrength: 'desc' }, { lastInteraction: 'desc' }],
    take: limit,
    select: { id: true, name: true, email: true, company: true, role: true, relationshipStrength: true, lastInteraction: true },
  });
  res.json({ entities: rows });
});

/** Backfill wiki_scribe across recent feed_events for the current tenant. */
router.post('/scribe-backfill', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const days = Math.min(parseInt(String(req.body?.days ?? '30'), 10) || 30, 90);
  const { backfillFromRecentFeedEvents } = await import('../services/knowledge/wikiScribeService');
  const r = await backfillFromRecentFeedEvents(user.clientNumber, days);
  res.json(r);
});

/** Wiki health — status counts for the MD's wiki (UI can surface stale/orphan). */
router.get('/wiki/health', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { wikiHealth } = await import('../services/knowledge/wikiLinterService');
  const counts = await wikiHealth(user.clientNumber, user.id);
  res.json(counts);
});

/** Run the wiki linter on demand (normally fires hourly via cron). */
router.post('/wiki/lint', async (_req: Request, res: Response) => {
  const { lintAllWikiPages } = await import('../services/knowledge/wikiLinterService');
  const r = await lintAllWikiPages();
  res.json(r);
});

/** Graph neighborhood for a wiki page — outbound (pages this one links
 *  to) and inbound (pages that link to this one). Powers the "Linked
 *  pages" and "Referenced by" sections in the WikiPageDetail UI. */
router.get('/wiki/pages/:id/graph', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);

  // Outbound — what does this page point at?
  const outbound = await prisma.$queryRawUnsafe<any[]>(
    `SELECT w.id, w.title, w.page_type AS "pageType", w.user_id AS "userId",
            w.last_updated_at AS "lastUpdatedAt",
            l.link_type AS "linkType",
            SUBSTRING(COALESCE(w.body_markdown,''), 1, 180) AS snippet
       FROM wiki_page_links l
       JOIN wiki_pages w ON w.id = l.to_page_id
      WHERE l.from_page_id = $1
        AND w.client_number = $2
        AND w.status NOT IN ('superseded','deleted')
        AND (
          w.user_id = $3
          OR w.page_type IN ('org_doc','policy','project','decision','pattern','attachment_doc','entity_person','topic')
        )
      ORDER BY w.last_updated_at DESC
      LIMIT 40`,
    id, user.clientNumber, user.id,
  ).catch(() => []);

  // Inbound — who references this page?
  const inbound = await prisma.$queryRawUnsafe<any[]>(
    `SELECT w.id, w.title, w.page_type AS "pageType", w.user_id AS "userId",
            w.last_updated_at AS "lastUpdatedAt",
            l.link_type AS "linkType",
            SUBSTRING(COALESCE(w.body_markdown,''), 1, 180) AS snippet
       FROM wiki_page_links l
       JOIN wiki_pages w ON w.id = l.from_page_id
      WHERE l.to_page_id = $1
        AND w.client_number = $2
        AND w.status NOT IN ('superseded','deleted')
        AND (
          w.user_id = $3
          OR w.page_type IN ('org_doc','policy','project','decision','pattern','attachment_doc','entity_person','topic')
        )
      ORDER BY w.last_updated_at DESC
      LIMIT 40`,
    id, user.clientNumber, user.id,
  ).catch(() => []);

  res.json({ outbound, inbound });
});

/** Single wiki page read — includes tenant-shared types readable by any user. */
router.get('/wiki/pages/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const page = await prisma.wikiPage.findFirst({
    where: {
      id, clientNumber: user.clientNumber,
      OR: [
        { userId: user.id },
        { pageType: { in: ['org_doc', 'policy', 'project', 'decision', 'pattern', 'attachment_doc'] } },
      ],
    },
    select: {
      id: true, title: true, pageType: true, bodyMarkdown: true, status: true,
      lastUpdatedAt: true, lastUpdatedBy: true, inboundLinks: true, outboundLinks: true,
      sourceCount: true, metadata: true, userId: true,
    },
  });
  if (!page) return res.status(404).json({ error: 'not found' });
  res.json(page);
});

/** List wiki pages for the current user (+ tenant-shared types).
 *  Query params:
 *    type     — filter by pageType (e.g. 'org_doc', 'sender_history')
 *    q        — search string. When present, runs SEMANTIC vector search
 *               (embeddings) so a sentence like "demo system conclusions"
 *               matches an Otter transcript titled "CBL Demo — Dry Run".
 *               Falls back to title ILIKE if embeddings are missing.
 *    limit    — default 50, max 200
 *    offset   — pagination (only applies to the no-query list view)
 *  Returns { total, items: [{id, title, pageType, snippet, lastUpdatedAt, sourceCount, userId, score?}], counts }
 *  Powers the Wiki rail page. */
router.get('/wiki', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const type = req.query.type ? String(req.query.type) : null;
  const q = req.query.q ? String(req.query.q).trim() : '';
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
  // Visibility filter — three modes:
  //   'user'   → only this user's private pages
  //   'tenant' → only the shared tenant pages
  //   'all'    → both (default)
  const scope = (req.query.scope ? String(req.query.scope) : 'all').toLowerCase();

  // Visibility predicate (raw SQL fragment + matching params).
  // Always anchored on client_number; scope flag narrows further.
  // We keep client_number = $1 and user_id = $2 in fixed slots so the
  // downstream queries don't have to renumber positional args.
  let visibilitySql: string;
  if (scope === 'user') {
    visibilitySql = `wiki_pages.scope = 'user' AND wiki_pages.user_id = $2`;
  } else if (scope === 'tenant') {
    visibilitySql = `wiki_pages.scope = 'tenant'`;
  } else {
    visibilitySql = `(wiki_pages.scope = 'tenant' OR (wiki_pages.scope = 'user' AND wiki_pages.user_id = $2))`;
  }

  // Counts: by page type AND by scope. UI shows totals for each
  // sidebar section. Independent of q + type so filters always
  // reflect the full catalog the user can see.
  const counts = await prisma.$queryRawUnsafe<any[]>(
    `SELECT page_type AS "pageType", COUNT(*)::int AS n
       FROM wiki_pages
      WHERE client_number = $1
        AND status NOT IN ('superseded','deleted')
        AND page_type NOT IN ('tenant_index','tenant_log')
        AND ${visibilitySql}
      GROUP BY page_type
      ORDER BY n DESC`,
    user.clientNumber, user.id,
  ).catch(() => [] as any[]);

  // Scope-level counts for the Visibility section in the sidebar.
  // Always computed against the FULL visible set (user + tenant),
  // ignoring the active scope filter so the user can see how many
  // pages exist on each side.
  const scopeCounts = await prisma.$queryRawUnsafe<any[]>(
    `SELECT scope, COUNT(*)::int AS n
       FROM wiki_pages
      WHERE client_number = $1
        AND status NOT IN ('superseded','deleted')
        AND page_type NOT IN ('tenant_index','tenant_log')
        AND (scope = 'tenant' OR (scope = 'user' AND user_id = $2))
      GROUP BY scope`,
    user.clientNumber, user.id,
  ).catch(() => [] as any[]);
  const scopeMap = Object.fromEntries(scopeCounts.map((r) => [r.scope, Number(r.n)])) as { user?: number; tenant?: number };

  // ── Search mode (semantic) ─────────────────────────────────────
  if (q.length > 0) {
    const { searchWikiByVector } = await import('../services/knowledge/wikiEmbeddingService');
    const vectorHits = await searchWikiByVector(user.clientNumber, user.id, q, {
      limit: 40,
      // Don't exclude gap/answer here — the user explicitly typed a query,
      // they should see anything semantically related including prior answers.
      pageTypes: type ? [type] : undefined,
      minScore: 0.30,
    });

    // Also run a title ILIKE as a safety net for exact-phrase matches
    // that vector might miss (short specific codes like "SFML", "R-26-00081").
    const typeClause = type ? `AND page_type = $4` : '';
    const ilikeParams: any[] = [user.clientNumber, user.id, q];
    if (type) ilikeParams.push(type);
    const ilikeHits = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, title, page_type AS "pageType", user_id AS "userId", scope,
              SUBSTRING(COALESCE(body_markdown,''), 1, 220) AS snippet,
              last_updated_at AS "lastUpdatedAt", source_count AS "sourceCount"
         FROM wiki_pages
        WHERE client_number = $1
          AND status NOT IN ('superseded','deleted')
          AND page_type NOT IN ('tenant_index','tenant_log')
          AND ${visibilitySql}
          AND (title ILIKE '%' || $3 || '%' OR body_markdown ILIKE '%' || $3 || '%')
          ${typeClause}
        LIMIT 40`,
      ...ilikeParams,
    ).catch(() => [] as any[]);

    // Merge, dedupe by id, with semantic first then any ILIKE-only hits.
    const byId = new Map<string, any>();
    for (const h of vectorHits) {
      byId.set(h.id, {
        id: h.id,
        title: h.title,
        pageType: h.pageType,
        userId: h.userId,
        snippet: (h.bodyMarkdown ?? '').slice(0, 220),
        lastUpdatedAt: null,
        sourceCount: 0,
        score: h.score,
      });
    }
    for (const h of ilikeHits) {
      if (byId.has(h.id)) {
        // Keep the semantic score; just refresh snippet/date/count with DB values.
        const existing = byId.get(h.id)!;
        existing.lastUpdatedAt = h.lastUpdatedAt;
        existing.sourceCount = h.sourceCount;
        existing.snippet = h.snippet;
      } else {
        byId.set(h.id, { ...h, score: null });
      }
    }
    // Backfill lastUpdatedAt for vector-only hits (we didn't select it in the vector query).
    const missingDates = [...byId.values()].filter((r) => !r.lastUpdatedAt).map((r) => r.id);
    if (missingDates.length > 0) {
      const fill = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, last_updated_at AS "lastUpdatedAt", source_count AS "sourceCount"
           FROM wiki_pages WHERE id = ANY($1::text[])`,
        missingDates,
      ).catch(() => []);
      for (const f of fill) {
        const row = byId.get(f.id);
        if (row) {
          row.lastUpdatedAt = f.lastUpdatedAt;
          row.sourceCount = f.sourceCount ?? 0;
        }
      }
    }
    const merged = [...byId.values()]
      .sort((a, b) => {
        // Semantic-scored rows first (ordered by score desc), then ILIKE-only by recency.
        if (a.score != null && b.score != null) return b.score - a.score;
        if (a.score != null) return -1;
        if (b.score != null) return 1;
        return (b.lastUpdatedAt?.getTime?.() ?? 0) - (a.lastUpdatedAt?.getTime?.() ?? 0);
      })
      .slice(0, limit);
    res.json({
      total: merged.length, items: merged, counts, scopeCounts: scopeMap,
      searchMode: 'semantic',
    });
    return;
  }

  // ── Browse mode (no query) — list by newest ────────────────────
  const typeClause = type ? `AND page_type = $3` : '';
  const browseParams: any[] = [user.clientNumber, user.id];
  if (type) browseParams.push(type);
  const whereBase = `
    WHERE client_number = $1
      AND status NOT IN ('superseded','deleted')
      AND page_type NOT IN ('tenant_index','tenant_log')
      AND ${visibilitySql}
      ${typeClause}
  `;
  const totalRow = await prisma.$queryRawUnsafe<any[]>(
    `SELECT COUNT(*)::int AS n FROM wiki_pages ${whereBase}`,
    ...browseParams,
  ).catch(() => [{ n: 0 }]);
  const total = Number(totalRow[0]?.n ?? 0);

  const items = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, page_type AS "pageType", user_id AS "userId", scope,
            SUBSTRING(COALESCE(body_markdown,''), 1, 220) AS snippet,
            last_updated_at AS "lastUpdatedAt", source_count AS "sourceCount"
       FROM wiki_pages ${whereBase}
      ORDER BY last_updated_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    ...browseParams,
  ).catch(() => [] as any[]);

  res.json({ total, items, counts, scopeCounts: scopeMap, searchMode: 'browse' });
});

export default router;
