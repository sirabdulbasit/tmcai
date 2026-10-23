// ═════════════════════════════════════════════════════════════════════════════
// interactionDistiller — DEF-348 `learn-distillation-inert`: the missing
// GENERATION layer between capture and governed memory.
//
// Measured 2026-10-23: 3,361 rows in brain_interaction_learning_logs,
// 2 governed memories, 0 proposals pending, 0 feedback rows EVER. Every
// existing generator needs a hand or a live chat: `correctionDistiller`
// fires only on BrainFeedback.correctedOutput (never once written),
// `standingPreferenceCapture` fires only inside a live conversation (the
// channel is dark), and the Settings propose route needs a click. So
// thousands of real exchanges accrue and none of the experience in them
// becomes memory — Learn scores 45 with "manifests nothing — structural".
//
// This sweep reads the UNDISTILLED interaction log (per-tenant cursor in
// system_config, fail-closed — the cursor advances only after a tenant's
// batch fully succeeds), groups exchanges per user, and asks the model —
// never a regex, per the no-hardcoded-judgement rule — to extract the few
// DURABLE preferences the user actually expressed across them. The DEF-149
// lesson is baked into the prompt: imperatives to act, one-off requests and
// single-value corrections are NOT preferences and must be rejected.
//
// Proposals go through learningService.proposeMemory with
// sourceType 'interaction_distillation', which is DELIBERATELY NOT in
// AUTO_ACTIVATE_SOURCES: that set's own contract says sources without heavy
// pre-filtering in front of them stay out, and a preference MINED from
// history has weaker provenance than one the owner stated with a durability
// marker in his own words. Everything this proposes lands pending_approval —
// visible in Settings with its source receipt, activated only by his hand.
//
// Guardrails enforced (the four, named): tenant/user scope (per-tenant
// cursor, per-user groups, proposals carry both), target grounding
// (synthetic `benchmark`-surface rows are excluded; every proposal carries
// sourceReferenceId = the interaction row it distilled from),
// irreversible-needs-confirmation (pending_approval, never self-activating),
// no-claim-without-a-receipt (the run returns exact counts and logs one
// line the nightly prints).
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('interaction-distiller');

export const DISTILL_CURSOR_KEY = 'learn.interaction_distill.cursor';
export const PROPOSE_CONFIDENCE_FLOOR = 0.6; // same bar proposeMemory's docs name for proposing
export const MAX_ROWS_PER_TENANT_PER_RUN = 200;
export const MAX_PROPOSALS_PER_USER_PER_RUN = 3; // a cap, so the approval queue is never flooded (machinery-outbids-the-human)
const EXCHANGE_HEAD_CHARS = 400;

const DISTILL_SYSTEM = `You read a batch of REAL exchanges between a user and their AI assistant and extract the few DURABLE PREFERENCES the user expressed — rules they would want applied to all future behaviour.

A durable preference is something the user stated as a standing rule ("always…", "never…", "from now on…", "I prefer…") or demonstrably repeated across several exchanges. The following are NOT preferences and must be rejected: a one-off request or command ("chase her again", "delete that item"), a question, a single factual correction (a name, a date, a number), or anything you are inferring from a single ambiguous message.

Return JSON only — an array (possibly empty) of at most 3 items:
[{"title": "<short imperative rule, max 80 chars>", "content": "<1-3 sentence instruction the assistant can follow next time>", "confidence": <0..1 — how clearly the exchanges express a repeatable preference>, "sensitivity": "<normal|sensitive>"}]

Mark "sensitive" anything touching money, credentials, health, relationships or third parties' private matters. When in doubt, return fewer items with honest confidence — an empty array is a good answer for a batch with no durable signal.`;

interface InteractionRow {
  id: string;
  userId: number;
  userPrompt: string | null;
  brainResponse: string | null;
  userOutcome: string | null;
  createdAt: Date;
}

export interface DistillDeps {
  /** Injectable for tests; defaults to llmRouter.callLLM. */
  callLlm?: (sys: string, user: string, opts: any) => Promise<{ text: string }>;
  /** Injectable for tests; defaults to learningService.proposeMemory. */
  proposeMemory?: (args: any) => Promise<{ id: string; status: string }>;
  /** Injectable for tests; default to configService get/setConfig. */
  getConfig?: (clientNumber: string, key: string) => Promise<string | null>;
  setConfig?: (clientNumber: string, key: string, value: string) => Promise<void>;
}

export interface DistillRunResult {
  tenants: number;
  scanned: number;
  groups: number;
  proposed: number;
  skippedDuplicate: number;
  belowFloor: number;
  tenantsFailed: number;
}

function renderExchanges(rows: InteractionRow[]): string {
  return rows.map((r, i) => {
    const u = (r.userPrompt ?? '').slice(0, EXCHANGE_HEAD_CHARS);
    const b = (r.brainResponse ?? '').slice(0, EXCHANGE_HEAD_CHARS);
    const outcome = r.userOutcome ? ` [user outcome: ${r.userOutcome}]` : '';
    return `--- exchange ${i + 1}${outcome} ---\nUser: ${u}\nAssistant: ${b}`;
  }).join('\n');
}

/**
 * One distillation pass over every tenant's undistilled interactions.
 * Fail-closed per tenant: any error inside a tenant's batch leaves that
 * tenant's cursor untouched, so the same rows are retried next run; other
 * tenants are unaffected.
 */
export async function distillInteractions(deps: DistillDeps = {}): Promise<DistillRunResult> {
  const callLlm = deps.callLlm ?? (await import('../llmRouter')).callLLM;
  const propose = deps.proposeMemory ?? (await import('./learningService')).proposeMemory;
  const cfg = deps.getConfig ?? (await import('../configService')).getConfig;
  const setCfg = deps.setConfig ?? (async (c: string, k: string, v: string) => {
    const { setConfig } = await import('../configService');
    await setConfig(c, k, v, false, 'DEF-348 interaction-distillation watermark');
  });

  const out: DistillRunResult = {
    tenants: 0, scanned: 0, groups: 0, proposed: 0,
    skippedDuplicate: 0, belowFloor: 0, tenantsFailed: 0,
  };

  const tenants = await prisma.brainInteractionLearningLog.groupBy({
    by: ['clientNumber'],
  }).catch(() => [] as Array<{ clientNumber: string }>);

  for (const t of tenants) {
    const clientNumber = t.clientNumber;
    out.tenants += 1;
    try {
      const cursorRaw = await cfg(clientNumber, DISTILL_CURSOR_KEY);
      const cursor = cursorRaw ? new Date(cursorRaw) : new Date(0);

      const rows: InteractionRow[] = await prisma.brainInteractionLearningLog.findMany({
        where: {
          clientNumber,
          createdAt: { gt: cursor },
          // Target grounding: synthetic traffic must never become memory.
          surface: { not: 'benchmark' },
          userPrompt: { not: null },
        },
        orderBy: { createdAt: 'asc' },
        take: MAX_ROWS_PER_TENANT_PER_RUN,
        select: { id: true, userId: true, userPrompt: true, brainResponse: true, userOutcome: true, createdAt: true },
      });
      if (rows.length === 0) continue;
      out.scanned += rows.length;

      const byUser = new Map<number, InteractionRow[]>();
      for (const r of rows) {
        const list = byUser.get(r.userId) ?? [];
        list.push(r);
        byUser.set(r.userId, list);
      }

      // Existing titles (any status) — a near-duplicate proposal every night
      // would itself be the flood this pipeline must never become.
      const existing = await prisma.governedBrainMemory.findMany({
        where: { clientNumber },
        select: { userId: true, title: true },
      });
      const existingTitles = new Set(existing.map((m) => `${m.userId ?? 'tenant'}|${m.title.trim().toLowerCase()}`));

      for (const [userId, group] of byUser) {
        out.groups += 1;
        const r = await callLlm(DISTILL_SYSTEM, `Exchanges (${group.length}):\n${renderExchanges(group)}`, {
          maxTokens: 500,
          userId,
          clientNumber,
          purpose: 'learn_interaction_distill',
        });
        const jsonMatch = /\[[\s\S]*\]/.exec(r.text ?? '');
        if (!jsonMatch) continue; // no array = nothing durable found; fine
        let candidates: any[] = [];
        try { candidates = JSON.parse(jsonMatch[0]); } catch { continue; }
        if (!Array.isArray(candidates)) continue;

        let proposedForUser = 0;
        for (const c of candidates) {
          if (proposedForUser >= MAX_PROPOSALS_PER_USER_PER_RUN) break;
          const title = String(c?.title ?? '').slice(0, 80).trim();
          const content = String(c?.content ?? '').slice(0, 400).trim();
          const confidence = Number(c?.confidence ?? 0);
          if (!title || !content) continue;
          if (!(confidence >= PROPOSE_CONFIDENCE_FLOOR)) { out.belowFloor += 1; continue; }
          const dedupKey = `${userId}|${title.toLowerCase()}`;
          if (existingTitles.has(dedupKey)) { out.skippedDuplicate += 1; continue; }

          const sensitivity: 'normal' | 'sensitive' = c?.sensitivity === 'sensitive' ? 'sensitive' : 'normal';
          const mem = await propose({
            clientNumber,
            userId,
            memoryScope: 'user',
            memoryType: 'distilled_preference',
            title,
            content,
            confidenceScore: confidence,
            sensitivityLevel: sensitivity,
            // NOT chat_standing_preference — that sourceType is the marker
            // that the durability pre-filters ran, and it earns
            // self-activation. This content is mined from history, so it
            // keeps the human gate: createdByBrain + a non-auto source
            // → pending_approval, always.
            sourceType: 'interaction_distillation',
            sourceReferenceId: group[0].id,
            createdByBrain: true,
          });
          existingTitles.add(dedupKey);
          proposedForUser += 1;
          out.proposed += 1;
          log.info('interaction preference proposed', { clientNumber, userId, memoryId: mem.id, status: mem.status, title });
        }
      }

      // Every group for this tenant succeeded — advance the watermark to the
      // last row actually read. On any throw above, the catch below leaves
      // the cursor where it was and the same rows are retried next night.
      const maxCreatedAt = rows[rows.length - 1].createdAt;
      await setCfg(clientNumber, DISTILL_CURSOR_KEY, maxCreatedAt.toISOString());
    } catch (e: any) {
      out.tenantsFailed += 1;
      log.warn('tenant distillation failed — cursor NOT advanced, will retry next run', {
        clientNumber, error: String(e?.message ?? e).slice(0, 200),
      });
    }
  }
  return out;
}
