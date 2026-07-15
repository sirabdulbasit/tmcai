/**
 * Multi-step plan executor.
 *
 * Brain decomposes a user request into a sequence of action steps, each
 * referencing a registered handler. The executor walks the plan in
 * order, persists each step's outcome, stops on the first failure, and
 * audit-trails the whole run.
 *
 * Conservative scope (v1):
 *   - Strictly sequential — no parallel branches.
 *   - Stop-on-failure semantics (steps after a failure are recorded as
 *     SKIPPED, not attempted).
 *   - Each step's output is available to subsequent steps as
 *     `${stepId}.output.X` placeholder substitution in the next step's
 *     payload — narrow but enough for "draft email then send the
 *     drafted body" / "create event then add attendees".
 *   - Honors the autonomy slider through `confidence` + `requiresApproval`
 *     on each step. If a step requires approval and isn't pre-approved
 *     (yet), execution pauses with status='waiting_approval'.
 *
 * Future (intentionally NOT in v1):
 *   - Conditionals / branches.
 *   - Parallel fan-out (we have a stub handler, but no executor support).
 *   - Plan rewriting after a failure.
 *   - Concurrent plan execution per user (one-at-a-time for now).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { executeViaRegistry } from './executeViaRegistry';
import { has as hasHandler } from './handlerRegistry';
import { audit } from '../auditLogService';
import crypto from 'crypto';

const log = createLogger('plan-executor');

export type PlanStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'waiting_approval';

export interface PlanStep {
  /** Local id within the plan — referenced by later steps for output piping. */
  id: string;
  actionType: string;
  payload: Record<string, unknown>;
  /** Human-friendly explanation, surfaced in audit log + UI. */
  rationale?: string;
  /** Brain's confidence in this step (0..1). Drives approval gating. */
  confidence?: number;
  /** Force a human review even if confidence is high. */
  requiresApproval?: boolean;
  /** Outcome — populated by the executor as we walk. */
  status?: PlanStepStatus;
  output?: unknown;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface Plan {
  id: string;
  clientNumber: string;
  userId: number;
  /** Short label of the original ask. */
  goal: string;
  /** The original user request that produced this plan (for audit). */
  origin: string;
  steps: PlanStep[];
  status: PlanStepStatus;
  createdAt: string;
  finishedAt?: string;
}

export interface ExecuteResult {
  plan: Plan;
  ranSteps: number;
  succeeded: number;
  failed: number;
  skipped: number;
}

/** Execute a plan top-to-bottom. Persists step state into agent_actions
 *  via the registry; the plan envelope itself lives as a wiki_page of
 *  type `plan` so it's queryable + retrievable like everything else. */
export async function executePlan(
  clientNumber: string, userId: number, planInput: Omit<Plan, 'createdAt' | 'status' | 'id'> & { id?: string },
): Promise<ExecuteResult> {
  // 0. Validate every step references a registered handler before we
  //    persist anything. Conservative: refuse the whole plan rather
  //    than running half of it then crashing.
  for (const s of planInput.steps) {
    if (!hasHandler(s.actionType)) {
      throw new Error(`unknown actionType "${s.actionType}" in step "${s.id}"`);
    }
  }

  const planId = planInput.id ?? `plan_${crypto.randomBytes(6).toString('hex')}`;
  const plan: Plan = {
    id: planId,
    clientNumber, userId,
    goal: planInput.goal,
    origin: planInput.origin,
    steps: planInput.steps.map((s) => ({ ...s, status: 'pending' })),
    status: 'running',
    createdAt: new Date().toISOString(),
  };

  // 1. File the plan as a wiki page so it's audit-trailed + retrievable.
  await prisma.wikiPage.create({
    data: {
      clientNumber, userId,
      pageType: 'plan',
      title: `Plan · ${plan.goal}`.slice(0, 300),
      bodyMarkdown: renderPlanBody(plan),
      metadata: {
        scope: 'user', authoredBy: 'plan_executor',
        planId, origin: plan.origin, goal: plan.goal,
        stepCount: plan.steps.length,
        steps: plan.steps,
      } as any,
      storage: 'postgres', status: 'active',
      lastUpdatedBy: 'plan_executor',
    },
  }).catch(() => {});

  await audit({
    clientNumber, actorId: userId, actorKind: 'user',
    action: 'brain.action.executed',
    subjectType: 'plan', subjectId: planId,
    details: { goal: plan.goal, steps: plan.steps.map((s) => s.actionType) },
  });

  // 2. Walk steps. Stop on failure or pending approval.
  let ranSteps = 0; let succeeded = 0; let failed = 0; let skipped = 0;
  const stepOutputs = new Map<string, unknown>();
  for (const step of plan.steps) {
    if (plan.status === 'failed' || plan.status === 'waiting_approval') {
      step.status = 'skipped';
      skipped++;
      continue;
    }
    step.startedAt = new Date().toISOString();

    // Approval gate — if step needs explicit approval, mark + halt.
    if (step.requiresApproval) {
      step.status = 'waiting_approval';
      plan.status = 'waiting_approval';
      log.info('plan paused for approval', { planId, stepId: step.id, actionType: step.actionType });
      break;
    }

    // Resolve `${stepId.output.X}` placeholders from earlier steps.
    const payload = resolvePayloadPlaceholders(step.payload, stepOutputs);

    step.status = 'running';
    ranSteps++;
    try {
      const r = await executeViaRegistry({
        actionType: step.actionType,
        clientNumber, userId,
        payload,
        confidence: step.confidence ?? 0.9,
        executedByAgent: `plan_executor:${planId}`,
        traceId: planId,
      });
      step.status = r.ok ? 'done' : 'failed';
      step.output = r.output;
      step.finishedAt = new Date().toISOString();
      if (r.ok) {
        succeeded++;
        stepOutputs.set(step.id, r.output);
      } else {
        failed++;
        step.error = r.error;
        plan.status = 'failed';
      }
    } catch (err: any) {
      step.status = 'failed';
      step.error = err.message;
      step.finishedAt = new Date().toISOString();
      failed++;
      plan.status = 'failed';
    }
  }

  if (plan.status === 'running') {
    plan.status = failed > 0 ? 'failed' : 'done';
  }
  plan.finishedAt = new Date().toISOString();

  // 3. Update the plan wiki page with final state.
  await prisma.wikiPage.updateMany({
    where: {
      clientNumber, userId, pageType: 'plan',
      title: `Plan · ${plan.goal}`.slice(0, 300),
    },
    data: {
      bodyMarkdown: renderPlanBody(plan),
      metadata: {
        scope: 'user', authoredBy: 'plan_executor',
        planId, origin: plan.origin, goal: plan.goal,
        stepCount: plan.steps.length, steps: plan.steps,
        finalStatus: plan.status, ranSteps, succeeded, failed, skipped,
      } as any,
      lastUpdatedAt: new Date(),
      lastUpdatedBy: 'plan_executor',
    },
  }).catch(() => {});

  log.info('plan finished', { planId, status: plan.status, ranSteps, succeeded, failed, skipped });
  return { plan, ranSteps, succeeded, failed, skipped };
}

/** Substitute placeholders like `${step1.output.body}` in a payload. */
function resolvePayloadPlaceholders(payload: any, stepOutputs: Map<string, unknown>): any {
  if (!payload) return payload;
  if (typeof payload === 'string') {
    return payload.replace(/\$\{([a-zA-Z0-9_]+)\.output(?:\.([a-zA-Z0-9_.]+))?\}/g, (_m, stepId, path) => {
      const out: any = stepOutputs.get(stepId);
      if (out == null) return '';
      if (!path) return typeof out === 'string' ? out : JSON.stringify(out);
      const parts = path.split('.');
      let cur: any = out;
      for (const p of parts) cur = cur?.[p];
      return cur == null ? '' : (typeof cur === 'string' ? cur : JSON.stringify(cur));
    });
  }
  if (Array.isArray(payload)) {
    return payload.map((v) => resolvePayloadPlaceholders(v, stepOutputs));
  }
  if (typeof payload === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(payload)) out[k] = resolvePayloadPlaceholders(v, stepOutputs);
    return out;
  }
  return payload;
}

function renderPlanBody(plan: Plan): string {
  const lines = [
    `# ${plan.goal}`,
    '',
    `**Plan id:** ${plan.id}`,
    `**Status:** ${plan.status}`,
    `**Started:** ${plan.createdAt}${plan.finishedAt ? ` · finished ${plan.finishedAt}` : ''}`,
    `**Origin:** ${plan.origin}`,
    '',
    '## Steps',
  ];
  for (const s of plan.steps) {
    const icon = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'waiting_approval' ? '⏸' : s.status === 'skipped' ? '⊘' : '·';
    lines.push(`- ${icon} **[${s.id}] ${s.actionType}** — ${s.rationale ?? ''}${s.error ? ` · error: ${s.error}` : ''}`);
  }
  return lines.join('\n');
}
