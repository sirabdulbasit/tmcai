/**
 * Nexeo Self-Learning — Gap Detection Service (Phase 2)
 *
 * Mines patterns from Phase 1 data (interactions + feedback) and
 * proposes gap records for admin review. The detection algorithms
 * here are RULE-based (deterministic SQL aggregations) — Session 4's
 * 13 agents will layer LLM-driven detection on top, but rule-based
 * gives us reliable signals from day one without burning tokens.
 *
 * Hard rule: this service ONLY proposes. Gaps land in status='new'
 * and only flow forward when an admin approves them.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('gap-detection');

export interface DetectedGap {
  gapType: string;
  title: string;
  description: string;
  evidence: Record<string, unknown>;
  affectedSurfaces: string[];
  affectedConnectors: string[];
  affectedRoles: string[];
  frequencyCount: number;
  businessImpact: 'low' | 'medium' | 'high' | 'critical';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  brainConfidence: number;
  suggestedAction: string;
}

/**
 * Full sweep — runs all detection rules for a tenant and persists
 * new gap rows. Called by gapDetectionJob nightly (Session 4).
 */
export async function runGapDetection(clientNumber: string): Promise<{
  scanned: number;
  newGaps: number;
  existingGaps: number;
}> {
  const detected = [
    ...await detectRepeatedNegativeFeedback(clientNumber),
    ...await detectParityMismatch(clientNumber),
    ...await detectHighRiskPattern(clientNumber),
    ...await detectRepeatedFailedInteractions(clientNumber),
    ...await detectMissedHelpfulPatterns(clientNumber),
  ];

  let newGaps = 0;
  let existingGaps = 0;
  for (const gap of detected) {
    // Dedup: if an OPEN gap of the same type + similar title already
    // exists for this tenant, increment its frequency_count instead
    // of creating a duplicate.
    const existing = await prisma.brainDetectedGap.findFirst({
      where: {
        clientNumber,
        gapType: gap.gapType,
        title: gap.title,
        status: { in: ['new', 'under_review'] },
      },
    });
    if (existing) {
      await prisma.brainDetectedGap.update({
        where: { id: existing.id },
        data: {
          frequencyCount: existing.frequencyCount + gap.frequencyCount,
          evidence: gap.evidence as any,
          updatedAt: new Date(),
        },
      });
      existingGaps += 1;
    } else {
      await prisma.brainDetectedGap.create({
        data: {
          clientNumber,
          gapType: gap.gapType,
          title: gap.title,
          description: gap.description,
          evidence: gap.evidence as any,
          affectedSurfaces: gap.affectedSurfaces,
          affectedConnectors: gap.affectedConnectors,
          affectedRoles: gap.affectedRoles,
          frequencyCount: gap.frequencyCount,
          businessImpact: gap.businessImpact,
          riskLevel: gap.riskLevel,
          brainConfidence: gap.brainConfidence,
          suggestedAction: gap.suggestedAction,
        },
      });
      newGaps += 1;
    }
  }

  log.info('gap detection sweep complete', { clientNumber, scanned: detected.length, newGaps, existingGaps });
  return { scanned: detected.length, newGaps, existingGaps };
}

// ─── Detection rules ────────────────────────────────────────────

/**
 * Detect feedback types that have appeared ≥5 times in the last 14
 * days on the same surface — strong signal of a recurring quality
 * issue (hallucination, wrong priority, parity, etc.).
 */
async function detectRepeatedNegativeFeedback(clientNumber: string): Promise<DetectedGap[]> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{
    feedback_type: string;
    surface: string;
    count: bigint;
  }>>`
    SELECT bf.feedback_type, bill.surface, COUNT(*) AS count
    FROM brain_feedback bf
    LEFT JOIN brain_interaction_learning_logs bill ON bill.id = bf.interaction_id
    WHERE bf.client_number = ${clientNumber}
      AND bf.created_at >= ${since}
      AND bf.feedback_type IN (
        'incorrect', 'hallucinated', 'too_generic', 'wrong_priority',
        'wrong_tone', 'wrong_language', 'incomplete', 'privacy_concern'
      )
    GROUP BY bf.feedback_type, bill.surface
    HAVING COUNT(*) >= 5
  `;
  return rows.map((r) => ({
    gapType: feedbackTypeToGapType(r.feedback_type),
    title: `Repeated ${r.feedback_type} feedback on ${r.surface ?? 'unknown'}`,
    description:
      `${Number(r.count)} ${r.feedback_type} feedback rows in the last 14 days from interactions on ${r.surface ?? 'unknown surface'}. ` +
      `Pattern suggests Brain is consistently producing this failure mode on this surface.`,
    evidence: {
      feedbackType: r.feedback_type,
      surface: r.surface,
      count: Number(r.count),
      windowDays: 14,
    },
    affectedSurfaces: r.surface ? [r.surface] : [],
    affectedConnectors: [],
    affectedRoles: [],
    frequencyCount: Number(r.count),
    businessImpact: r.feedback_type === 'privacy_concern' ? 'critical'
      : r.feedback_type === 'hallucinated' ? 'high'
      : 'medium',
    riskLevel: r.feedback_type === 'privacy_concern' ? 'critical' : 'medium',
    brainConfidence: Math.min(0.6 + Number(r.count) * 0.05, 0.95),
    suggestedAction:
      r.feedback_type === 'hallucinated'
        ? `Review prompt/data block coverage for ${r.surface}. Add anti-fabrication guard if missing.`
        : r.feedback_type === 'parity_issue'
        ? `Audit the composer path for ${r.surface} against the canonical reasoningComposeWithTools.`
        : `Audit prompt instructions for ${r.surface} to address ${r.feedback_type}.`,
  }));
}

/** Cross-channel parity feedback specifically. */
async function detectParityMismatch(clientNumber: string): Promise<DetectedGap[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const count = await prisma.brainFeedback.count({
    where: {
      clientNumber,
      feedbackType: { in: ['parity_issue', 'cross_channel_tone_issue'] },
      createdAt: { gte: since },
    },
  });
  if (count < 3) return [];
  return [{
    gapType: 'parity_issue',
    title: 'Channel parity mismatches reported',
    description: `${count} parity / cross-channel-tone reports in the last 30 days. Same question producing different answers across web chat and WhatsApp violates the surface-parity rule.`,
    evidence: { count, windowDays: 30 },
    affectedSurfaces: ['web_chat', 'whatsapp_brain'],
    affectedConnectors: [],
    affectedRoles: [],
    frequencyCount: count,
    businessImpact: 'high',
    riskLevel: 'high',
    brainConfidence: 0.9,
    suggestedAction: 'Audit which composer path each surface uses. Verify both route through reasoningComposeWithTools.',
  }];
}

/** Critical-risk interactions accumulating. */
async function detectHighRiskPattern(clientNumber: string): Promise<DetectedGap[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const count = await prisma.brainInteractionLearningLog.count({
    where: {
      clientNumber,
      riskLevel: 'critical',
      createdAt: { gte: since },
    },
  });
  if (count < 1) return [];
  return [{
    gapType: 'security_issue',
    title: `${count} critical-risk Brain interactions in the last week`,
    description: `Brain classified ${count} interactions as critical-risk. Each requires audit — these should be rare. Cluster suggests either a new attack vector, mis-classification, or a behavior change.`,
    evidence: { count, windowDays: 7 },
    affectedSurfaces: [],
    affectedConnectors: [],
    affectedRoles: ['admin'],
    frequencyCount: count,
    businessImpact: 'critical',
    riskLevel: 'critical',
    brainConfidence: 0.85,
    suggestedAction: 'Review the brain_interaction_learning_logs rows with risk_level=critical for the last 7 days. Audit the call sites that triggered them.',
  }];
}

/** Interactions that returned status='failed'. */
async function detectRepeatedFailedInteractions(clientNumber: string): Promise<DetectedGap[]> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{
    surface: string;
    interaction_type: string;
    count: bigint;
  }>>`
    SELECT surface, interaction_type, COUNT(*) AS count
    FROM brain_interaction_learning_logs
    WHERE client_number = ${clientNumber}
      AND created_at >= ${since}
      AND status = 'failed'
    GROUP BY surface, interaction_type
    HAVING COUNT(*) >= 3
  `;
  return rows.map((r) => ({
    gapType: 'product_performance',
    title: `Repeated ${r.interaction_type} failures on ${r.surface}`,
    description: `${Number(r.count)} ${r.interaction_type} interactions failed on ${r.surface} in the last 7 days. May indicate an upstream LLM outage, broken connector, or bug in the composer path.`,
    evidence: {
      surface: r.surface,
      interactionType: r.interaction_type,
      count: Number(r.count),
      windowDays: 7,
    },
    affectedSurfaces: [r.surface],
    affectedConnectors: [],
    affectedRoles: [],
    frequencyCount: Number(r.count),
    businessImpact: 'medium',
    riskLevel: 'medium',
    brainConfidence: 0.75,
    suggestedAction: `Check PM2 logs for ${r.surface} ${r.interaction_type} errors during the affected window.`,
  }));
}

/** Repeated prompts where Brain didn't generate a useful response —
 *  detect by prompt similarity grouping (simplified: identical
 *  prompt text repeated by the same user across days). */
async function detectMissedHelpfulPatterns(clientNumber: string): Promise<DetectedGap[]> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{
    user_id: number;
    user_prompt: string;
    count: bigint;
  }>>`
    SELECT user_id, user_prompt, COUNT(*) AS count
    FROM brain_interaction_learning_logs
    WHERE client_number = ${clientNumber}
      AND created_at >= ${since}
      AND user_prompt IS NOT NULL
      AND LENGTH(user_prompt) > 10
      AND LENGTH(user_prompt) < 200
    GROUP BY user_id, user_prompt
    HAVING COUNT(*) >= 5
    LIMIT 20
  `;
  return rows.map((r) => ({
    gapType: 'workflow_automation',
    title: `User repeats the same prompt — automation candidate`,
    description: `User ${r.user_id} asked "${r.user_prompt.slice(0, 80)}" ${Number(r.count)} times in the last 30 days. Strong candidate for an automation, custom Day Brief section, or saved workflow.`,
    evidence: {
      userId: r.user_id,
      prompt: r.user_prompt,
      count: Number(r.count),
      windowDays: 30,
    },
    affectedSurfaces: ['web_chat', 'whatsapp_brain'],
    affectedConnectors: [],
    affectedRoles: [],
    frequencyCount: Number(r.count),
    businessImpact: 'medium',
    riskLevel: 'low',
    brainConfidence: 0.7,
    suggestedAction: 'Propose a Day Brief section / scheduled task / standing instruction that addresses this prompt automatically.',
  }));
}

function feedbackTypeToGapType(feedbackType: string): string {
  switch (feedbackType) {
    case 'incorrect':
    case 'hallucinated':       return 'product_performance';
    case 'privacy_concern':    return 'privacy_issue';
    case 'wrong_priority':     return 'triage_quality';
    case 'wrong_tone':
    case 'wrong_language':     return 'language_tone_issue';
    case 'cross_channel_tone_issue': return 'language_tone_issue';
    case 'parity_issue':       return 'parity_issue';
    case 'incomplete':
    case 'too_generic':        return 'ux_improvement';
    default:                   return 'product_performance';
  }
}

/** List gaps for the Detected Gaps Inbox UI. */
export async function listGaps(args: {
  clientNumber: string;
  status?: string;
  limit?: number;
}) {
  const where: any = { clientNumber: args.clientNumber };
  if (args.status && args.status !== 'all') where.status = args.status;
  return prisma.brainDetectedGap.findMany({
    where,
    orderBy: [{ frequencyCount: 'desc' }, { createdAt: 'desc' }],
    take: Math.min(args.limit ?? 100, 500),
  });
}

export async function approveGap(gapId: string, reviewerId: number, clientNumber: string) {
  const gap = await prisma.brainDetectedGap.findUnique({ where: { id: gapId } });
  if (!gap || gap.clientNumber !== clientNumber) return { ok: false, error: 'not found' };
  await prisma.brainDetectedGap.update({
    where: { id: gapId },
    data: { status: 'approved', reviewedBy: reviewerId, reviewedAt: new Date() },
  });
  return { ok: true };
}

export async function rejectGap(gapId: string, reviewerId: number, clientNumber: string) {
  const gap = await prisma.brainDetectedGap.findUnique({ where: { id: gapId } });
  if (!gap || gap.clientNumber !== clientNumber) return { ok: false, error: 'not found' };
  await prisma.brainDetectedGap.update({
    where: { id: gapId },
    data: { status: 'rejected', reviewedBy: reviewerId, reviewedAt: new Date() },
  });
  return { ok: true };
}
