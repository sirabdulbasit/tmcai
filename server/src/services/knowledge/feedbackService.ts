/**
 * Brain feedback — every surface where Brain produces something carries
 * a 👍 / 👎. We record the rating, and on 👎 we fire a diagnosis pass
 * that tries to explain *why* the user disliked it. Over time the
 * diagnoses feed back into retrieval, tone and criticality calibration.
 *
 * Storage model (both per-user):
 *   wiki_pages(pageType='feedback')              — raw rating + context
 *   wiki_pages(pageType='feedback_diagnosis')    — LLM-derived hypothesis
 *
 * The cognitive engine's `analyzeFeedback` (next step) rolls these up
 * into an observation when a pattern emerges ("3 drafts marked too
 * formal this week").
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('feedback');

export type FeedbackSubjectType =
  | 'chat_answer'
  | 'brain_action'
  | 'draft'
  | 'observation'
  | 'attention_card'
  | 'criticality_score'
  | 'other';

export type FeedbackRating = 'up' | 'down';

export interface RecordFeedbackInput {
  clientNumber: string;
  userId: number;
  subjectType: FeedbackSubjectType;
  subjectId: string;            // stable id of the thing being rated
  rating: FeedbackRating;
  reason?: string | null;       // optional user-typed reason
  /** Snapshot of what Brain showed — used to reconstruct context on diagnosis. */
  context?: Record<string, unknown>;
  /** When true (and rating='down'), run diagnosis SYNCHRONOUSLY and return
   *  it to the caller. Used by the in-the-moment retry loop on chat
   *  answers — the UI needs the diagnosis category to decide whether to
   *  offer "Try again". Default false (legacy fire-and-forget). */
  awaitDiagnosis?: boolean;
}

export interface DiagnosisSummary {
  pageId: string;
  category: string;
  hypothesis: string;
  likelyFix: string;
  confidence: number;
  affectedSubsystem: string;
}

export interface RecordFeedbackResult {
  feedbackPageId: string;
  diagnosisPageId?: string;
  /** Set when awaitDiagnosis=true and diagnosis ran successfully. */
  diagnosis?: DiagnosisSummary | null;
}

export async function recordFeedback(input: RecordFeedbackInput): Promise<RecordFeedbackResult> {
  const { clientNumber, userId, subjectType, subjectId, rating, reason, context } = input;

  const title = `${rating === 'up' ? '👍' : '👎'} ${subjectType} · ${subjectId.slice(0, 40)}`;
  const body = [
    `# ${title}`,
    '',
    `**Rating:** ${rating}`,
    `**Subject type:** ${subjectType}`,
    `**Subject id:** ${subjectId}`,
    `**When:** ${new Date().toISOString()}`,
    reason ? `\n## User reason\n${reason}` : '',
    context ? `\n## Context snapshot\n\`\`\`json\n${JSON.stringify(context, null, 2).slice(0, 4000)}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');

  const metadata = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    authoredBy: 'feedback_service',
    scope: 'user',
    rating,
    subjectType,
    subjectId,
    reason: reason ?? null,
    context: context ?? null,
    createdAt: new Date().toISOString(),
  };

  const created = await prisma.wikiPage.create({
    data: {
      clientNumber, userId,
      pageType: 'feedback',
      title: title.slice(0, 300),
      bodyMarkdown: body,
      metadata: metadata as any,
      storage: 'postgres', status: 'active',
      lastUpdatedBy: 'feedback_service',
    },
  });

  // Also record as a preference signal so the existing learner picks it up.
  void (async () => {
    try {
      const { recordSignal } = await import('./preferenceLearnerService');
      await recordSignal(clientNumber, userId, {
        kind: rating === 'up' ? 'feedback_up' : 'feedback_down',
        context: { subjectType, subjectId, reason: reason ?? null },
      });
    } catch { /* best effort */ }
  })();

  log.info('feedback recorded', { userId, rating, subjectType, subjectId, feedbackPageId: created.id });

  // 👎 → run diagnosis. Caller chooses sync (await result, used by the
  // chat retry loop) or async (legacy — UI doesn't wait).
  let diagnosisPageId: string | undefined;
  let diagnosisSummary: DiagnosisSummary | null = null;
  if (rating === 'down') {
    if (input.awaitDiagnosis) {
      try {
        const r = await diagnoseFailure({
          clientNumber, userId,
          feedbackPageId: created.id,
          subjectType, subjectId, reason, context,
        });
        if (r) {
          diagnosisPageId = r.pageId;
          diagnosisSummary = r;
        }
      } catch (err: any) {
        log.warn('diagnosis (sync) failed', { feedbackPageId: created.id, error: err.message });
      }
    } else {
      // Fire-and-forget — older surfaces (Day Brief, brain_action, etc.)
      void (async () => {
        try {
          await diagnoseFailure({
            clientNumber, userId,
            feedbackPageId: created.id,
            subjectType, subjectId, reason, context,
          });
        } catch (err: any) {
          log.warn('diagnosis (async) failed', { feedbackPageId: created.id, error: err.message });
        }
      })();
    }
  }

  return { feedbackPageId: created.id, diagnosisPageId, diagnosis: diagnosisSummary };
}

// ─── Diagnosis ─────────────────────────────────────────────────────

interface DiagnoseInput {
  clientNumber: string;
  userId: number;
  feedbackPageId: string;
  subjectType: FeedbackSubjectType;
  subjectId: string;
  reason?: string | null;
  context?: Record<string, unknown>;
}

const DIAGNOSIS_PROMPT = `You are Brain's self-diagnostic reasoner. The user just gave a 👎 to something you produced. Your job is to figure out WHY — not to defend the output, not to apologize, but to honestly classify the likely failure mode so future outputs can improve.

Output ONE JSON object, nothing else:

{
  "category":    "retrieval_miss" | "wrong_source" | "hallucination" | "too_verbose" | "too_terse" | "wrong_tone" | "missed_context" | "stale_data" | "wrong_person_scope" | "over_flagged_critical" | "under_flagged_critical" | "irrelevant" | "unclear" | "other",
  "hypothesis":  "2-3 sentences. What, concretely, went wrong based on the evidence. Be specific — cite the query, the source(s) used, the user's reason if given.",
  "likely_fix":  "1-2 sentences. What Brain should do differently next time. Keep it concrete and actionable.",
  "confidence":  0.0-1.0,
  "affected_subsystem": "retrieval" | "composer_prompt" | "criticality_engine" | "triage_reasoner" | "tone_service" | "instruction_matcher" | "other"
}

Rules:
- Never blame the user. Never output defensive phrasing like "the user may have misunderstood."
- If the user reason contradicts the category, trust the user reason.
- If you can't tell, category="unclear" and confidence ≤ 0.4. Don't pretend to know.
- For "hallucination", reference the specific claim that's unsupported.
- For "wrong_person_scope", reference whose context was used vs whose was asked about.`;

async function diagnoseFailure(input: DiagnoseInput): Promise<DiagnosisSummary | null> {
  // Reconstruct a compact context packet for the diagnostic LLM
  const reconstructed = await reconstructContext(input);
  const userMsg = [
    `Subject type: ${input.subjectType}`,
    `Subject id: ${input.subjectId}`,
    input.reason ? `\nUser's stated reason for 👎:\n${input.reason}` : '\n(user did not give a reason)',
    '',
    '═══ WHAT BRAIN SHOWED THE USER ═══',
    reconstructed,
  ].join('\n');

  try {
    const r = await callLLM(DIAGNOSIS_PROMPT, userMsg, {
      maxTokens: 600,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: input.userId, clientNumber: input.clientNumber,
      purpose: 'feedback_diagnosis',
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const obj = JSON.parse(m[0]);

    const body = [
      `# Diagnosis for 👎 on ${input.subjectType}`,
      '',
      `**Subject id:** ${input.subjectId}`,
      `**Linked feedback:** ${input.feedbackPageId}`,
      `**Category:** ${String(obj.category ?? 'unclear')}`,
      `**Affected subsystem:** ${String(obj.affected_subsystem ?? 'other')}`,
      `**Confidence:** ${Number(obj.confidence ?? 0).toFixed(2)}`,
      '',
      '## Hypothesis',
      String(obj.hypothesis ?? '(none)'),
      '',
      '## Likely fix',
      String(obj.likely_fix ?? '(none)'),
      input.reason ? `\n## User's stated reason\n${input.reason}` : '',
    ].filter(Boolean).join('\n');

    const created = await prisma.wikiPage.create({
      data: {
        clientNumber: input.clientNumber, userId: input.userId,
        pageType: 'feedback_diagnosis',
        title: `Diagnosis · ${String(obj.category ?? 'unclear')} · ${input.subjectType}`.slice(0, 300),
        bodyMarkdown: body,
        metadata: {
          schemaVersion: BRAIN_SCHEMA_VERSION,
          authoredBy: 'feedback_service',
          scope: 'user',
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          feedbackPageId: input.feedbackPageId,
          category: obj.category,
          affectedSubsystem: obj.affected_subsystem,
          confidence: Number(obj.confidence ?? 0),
          hypothesis: obj.hypothesis,
          likelyFix: obj.likely_fix,
          createdAt: new Date().toISOString(),
        } as any,
        storage: 'postgres', status: 'active',
        lastUpdatedBy: 'feedback_service',
      },
    });

    // Link feedback → diagnosis so the wiki graph renders the chain.
    await prisma.wikiPageLink.upsert({
      where: { fromPageId_toPageId_linkType: { fromPageId: input.feedbackPageId, toPageId: created.id, linkType: 'diagnosed_as' } } as any,
      update: {},
      create: {
        clientNumber: input.clientNumber, userId: input.userId,
        fromPageId: input.feedbackPageId, toPageId: created.id, linkType: 'diagnosed_as',
      },
    }).catch(() => {});

    log.info('feedback diagnosed', { feedbackPageId: input.feedbackPageId, diagnosisPageId: created.id, category: obj.category });

    // Calibration consumer — pipe the diagnosis into the criticality
    // calibration service. Idempotent on (user, diagnosisId). Categories
    // unrelated to criticality (retrieval_miss, hallucination, tone,
    // person_scope) are no-ops there. Fire-and-forget.
    void (async () => {
      try {
        const { applyDiagnosis } = await import('../triage/criticalityCalibrationService');
        await applyDiagnosis({
          clientNumber: input.clientNumber,
          userId: input.userId,
          diagnosisId: created.id,
          category: String(obj.category ?? 'unclear'),
          affectedSubsystem: String(obj.affected_subsystem ?? 'other'),
          confidence: Number(obj.confidence ?? 0.5),
        });
      } catch { /* best effort */ }
    })();

    return {
      pageId: created.id,
      category: String(obj.category ?? 'unclear'),
      hypothesis: String(obj.hypothesis ?? ''),
      likelyFix: String(obj.likely_fix ?? ''),
      confidence: Number(obj.confidence ?? 0),
      affectedSubsystem: String(obj.affected_subsystem ?? 'other'),
    };
  } catch (err: any) {
    log.warn('diagnoseFailure LLM failed', { feedbackPageId: input.feedbackPageId, error: err.message });
    return null;
  }
}

/**
 * Reconstruct what Brain showed the user. When the caller passed `context`
 * inline (e.g., the chat answer + cited sources), we use it. Otherwise we
 * try to pull the subject from its source table by id (agent_actions for
 * brain_action, wiki_pages for observation/draft).
 */
async function reconstructContext(input: DiagnoseInput): Promise<string> {
  if (input.context && Object.keys(input.context).length > 0) {
    return JSON.stringify(input.context, null, 2).slice(0, 3000);
  }
  switch (input.subjectType) {
    case 'brain_action':
    case 'draft': {
      const id = parseInt(input.subjectId, 10);
      if (!Number.isFinite(id)) return '(no subject snapshot available)';
      const a = await prisma.agentAction.findUnique({
        where: { id },
        select: { actionType: true, input: true, output: true, status: true },
      }).catch(() => null);
      return a ? JSON.stringify(a, null, 2).slice(0, 3000) : '(brain action not found)';
    }
    case 'observation':
    case 'attention_card':
    case 'chat_answer': {
      const page = await prisma.wikiPage.findUnique({
        where: { id: input.subjectId },
        select: { title: true, bodyMarkdown: true, metadata: true, pageType: true },
      }).catch(() => null);
      return page
        ? [`# ${page.title}  (${page.pageType})`, page.bodyMarkdown?.slice(0, 2400) ?? ''].join('\n')
        : '(no wiki page matching subjectId — possibly a conversational answer not yet filed)';
    }
    default:
      return '(no subject snapshot available)';
  }
}

// ─── Query helpers for UI ──────────────────────────────────────────

export async function listRecentDownDiagnoses(
  clientNumber: string,
  userId: number,
  limit = 20,
) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title,
            metadata->>'category' AS category,
            metadata->>'affectedSubsystem' AS subsystem,
            (metadata->>'confidence')::float AS confidence,
            metadata->>'hypothesis' AS hypothesis,
            metadata->>'likelyFix' AS likely_fix,
            metadata->>'subjectType' AS subject_type,
            metadata->>'subjectId' AS subject_id,
            last_updated_at AS updated_at
       FROM wiki_pages
      WHERE client_number = $1 AND user_id = $2
        AND page_type = 'feedback_diagnosis'
        AND status = 'active'
      ORDER BY last_updated_at DESC
      LIMIT $3`,
    clientNumber, userId, limit,
  ).catch(() => []);
  return rows;
}

/**
 * "What Brain learned this week" rollup. Combines:
 *   - 👍/👎 totals (last 7d)
 *   - Diagnoses by category (last 7d)
 *   - Criticality calibration state for this user
 *   - Top recommendations (≤ 3) Brain wants to make to itself
 * Used by the Day Brief panel of the same name.
 */
export interface LearningRollup {
  windowDays: number;
  feedback: { up: number; down: number };
  diagnosesByCategory: Array<{ category: string; n: number; latestHypothesis: string | null }>;
  recentDiagnoses: Array<{ id: string; title: string; category: string; hypothesis: string; likelyFix: string; subjectType: string; updatedAt: string }>;
  calibration: {
    timePressure: number; impact: number; relationshipRisk: number; cascade: number; patternAnomaly: number;
    thresholdShift: number; sampleCount: number; criticalThreshold: number;
  };
  brainSuggests: string[];
}

export async function getLearningRollup(
  clientNumber: string,
  userId: number,
  windowDays = 7,
): Promise<LearningRollup> {
  const sinceIso = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const fb = await prisma.$queryRawUnsafe<any[]>(
    `SELECT metadata->>'rating' AS rating, COUNT(*)::int AS n
       FROM wiki_pages
      WHERE client_number=$1 AND user_id=$2
        AND page_type='feedback' AND status='active'
        AND last_updated_at >= $3::timestamp
      GROUP BY rating`,
    clientNumber, userId, sinceIso,
  ).catch(() => []);
  const fbCounts = { up: 0, down: 0 };
  for (const r of fb) fbCounts[r.rating === 'up' ? 'up' : 'down'] = r.n;

  const cats = await prisma.$queryRawUnsafe<any[]>(
    `SELECT metadata->>'category' AS category, COUNT(*)::int AS n,
            (ARRAY_AGG(metadata->>'hypothesis' ORDER BY last_updated_at DESC))[1] AS latest_hypothesis
       FROM wiki_pages
      WHERE client_number=$1 AND user_id=$2
        AND page_type='feedback_diagnosis' AND status='active'
        AND last_updated_at >= $3::timestamp
      GROUP BY category
      ORDER BY n DESC LIMIT 8`,
    clientNumber, userId, sinceIso,
  ).catch(() => []);

  const recent = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title,
            metadata->>'category' AS category,
            metadata->>'hypothesis' AS hypothesis,
            metadata->>'likelyFix' AS likely_fix,
            metadata->>'subjectType' AS subject_type,
            last_updated_at AS updated_at
       FROM wiki_pages
      WHERE client_number=$1 AND user_id=$2
        AND page_type='feedback_diagnosis' AND status='active'
        AND last_updated_at >= $3::timestamp
      ORDER BY last_updated_at DESC LIMIT 5`,
    clientNumber, userId, sinceIso,
  ).catch(() => []);

  let calibration: any;
  try {
    const { getCalibration, getEffectiveCriticalThreshold } = await import('../triage/criticalityCalibrationService');
    const c = await getCalibration(clientNumber, userId);
    const thr = await getEffectiveCriticalThreshold(clientNumber, userId);
    calibration = { ...c, criticalThreshold: thr };
  } catch {
    calibration = { timePressure: 1, impact: 1, relationshipRisk: 1, cascade: 1, patternAnomaly: 1, thresholdShift: 0, sampleCount: 0, criticalThreshold: 0.8 };
  }

  // Compose Brain's self-recommendations from the categorical pattern.
  const brainSuggests: string[] = [];
  for (const c of cats.slice(0, 3)) {
    const n = c.n;
    switch (c.category) {
      case 'over_flagged_critical':
        brainSuggests.push(`I've been over-flagging ${n} item${n === 1 ? '' : 's'} as critical — calibrating threshold up to ${calibration.criticalThreshold.toFixed(2)}.`);
        break;
      case 'retrieval_miss':
        brainSuggests.push(`Missed retrieval ${n} time${n === 1 ? '' : 's'} this week — extending the fuzzy fallback for short proper nouns.`);
        break;
      case 'wrong_tone':
      case 'too_verbose':
      case 'too_terse':
        brainSuggests.push(`Tone mismatch noted ${n} time${n === 1 ? '' : 's'} — adjusting to your historical voice samples.`);
        break;
      case 'hallucination':
        brainSuggests.push(`Hallucination flagged ${n} time${n === 1 ? '' : 's'} — citing more strictly from opened pages only.`);
        break;
      case 'wrong_person_scope':
        brainSuggests.push(`Wrong-person scope ${n} time${n === 1 ? '' : 's'} — re-checking entity reconciliation.`);
        break;
      default:
        brainSuggests.push(`${n} ${String(c.category).replace(/_/g, ' ')} signal${n === 1 ? '' : 's'} — investigating.`);
    }
  }
  if (brainSuggests.length === 0 && fbCounts.up > 0) {
    brainSuggests.push(`${fbCounts.up} 👍 this week — keep doing what's working.`);
  }

  return {
    windowDays,
    feedback: fbCounts,
    diagnosesByCategory: cats.map((r) => ({ category: r.category, n: r.n, latestHypothesis: r.latest_hypothesis ?? null })),
    recentDiagnoses: recent.map((r) => ({
      id: r.id, title: r.title, category: r.category ?? 'unclear',
      hypothesis: r.hypothesis ?? '', likelyFix: r.likely_fix ?? '',
      subjectType: r.subject_type ?? 'other',
      updatedAt: new Date(r.updated_at).toISOString(),
    })),
    calibration,
    brainSuggests,
  };
}

export async function getFeedbackCounts(clientNumber: string, userId: number) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT metadata->>'rating' AS rating,
            metadata->>'subjectType' AS subject_type,
            COUNT(*)::int AS n
       FROM wiki_pages
      WHERE client_number = $1 AND user_id = $2
        AND page_type = 'feedback'
        AND status = 'active'
      GROUP BY rating, subject_type
      ORDER BY n DESC`,
    clientNumber, userId,
  ).catch(() => []);
  return rows;
}
