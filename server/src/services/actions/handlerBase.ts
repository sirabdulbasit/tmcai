import type { RiskTier } from '../risk/riskGatingService';

export type HandlerCategory =
  | 'communication'
  | 'calendar'
  | 'task'
  | 'crm'
  | 'lifecycle'
  | 'orchestration'
  | 'brain'
  | 'governance';

export type UndoStatus = 'none' | 'undoable' | 'undone' | 'expired';

/** How strongly a handler's confirm() proves the side effect landed.
 *  See ActionHandler.confirmationCapability(). */
export type ConfirmationCapability = 'provider_confirmed' | 'locally_confirmed' | 'unverifiable';

export interface HandlerContext {
  clientNumber: string;
  userId: number;
  openItemId?: string;
  entityId?: string;
  traceId?: string;
  executedByAgent?: string;
  /** AgentAction.id of the action that invoked this handler (for dependency-graph edge recording) */
  rootActionId?: number;
  /** Shared dependency-graph id so child handlers inherit the same group */
  dependencyGraphId?: string;
  payload: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

export interface DryRunResult {
  wouldSucceed: boolean;
  preview?: unknown;
  warnings?: string[];
}

export interface ExecutionOutput {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface HandlerMetadata {
  name: string;
  category: HandlerCategory;
  description: string;
  version: string;
  requiresConnector?: string;
}

export interface HealthStatus {
  healthy: boolean;
  message?: string;
  lastCheckedAt: string;
}

export interface ReverseOperation {
  handler: string;
  payload: Record<string, unknown>;
  note?: string;
}

export interface DependencySpec {
  /** handler names (action types) this handler logically depends on */
  dependsOn?: string[];
  /** handlers that should be triggered after this succeeds */
  triggers?: string[];
}

export abstract class ActionHandler {
  abstract metadata(): HandlerMetadata;

  /** JSON schema (or OpenAPI-subset) describing the expected payload shape */
  abstract schema(): Record<string, unknown>;

  /** Fields on this handler's output that must appear in the audit log */
  abstract auditFields(): string[];

  /** Can always run (LOW) by default; override for conditional tiers */
  riskLevel(_ctx: HandlerContext): RiskTier | Promise<RiskTier> {
    return 'MEDIUM';
  }

  /** Declared cross-handler dependencies for cascading undo */
  dependencies(_ctx: HandlerContext): DependencySpec | Promise<DependencySpec> {
    return {};
  }

  /** Pre-flight validation — no side effects */
  abstract validate(ctx: HandlerContext): Promise<ValidationResult>;

  /** Render a preview of what would happen — no side effects */
  abstract dryRun(ctx: HandlerContext): Promise<DryRunResult>;

  /** Prepare any state needed for execution (drafts, token refreshes, etc.) */
  async prepare(_ctx: HandlerContext): Promise<void> {
    /* default: no-op */
  }

  /** Execute the action (writes happen here) */
  abstract execute(ctx: HandlerContext): Promise<ExecutionOutput>;

  /** Confirm the side effects stuck (read-back against the system of
   *  record — provider API or DB). ABSTRACT by design (B2, 2026-07-08):
   *  the old `return true` default meant a handler with no real read-back
   *  was treated as confirmed. A missing confirmation must never read as
   *  success — every handler decides explicitly what "it actually
   *  happened" means for its side effect. Fail closed: return false when
   *  the record/receipt cannot be found. */
  abstract confirm(ctx: HandlerContext, output: unknown): Promise<boolean>;

  /** What confirm() can actually PROVE (audit 2026-07-14 #6):
   *    provider_confirmed — read-back against the external provider
   *      (message visible in Sent, event re-fetched from Calendar, …)
   *    locally_confirmed  — read-back against our own DB row (the
   *      side effect is internal, so the DB IS the system of record)
   *    unverifiable       — confirm() can only inspect the dispatch
   *      output; the provider offers no read-back. Executor records
   *      the action as 'unconfirmed', NEVER 'done'.
   *  Default is 'locally_confirmed' (most handlers verify a DB row);
   *  handlers with provider read-backs or no read-back at all MUST
   *  override so status honesty doesn't depend on prose. */
  confirmationCapability(): ConfirmationCapability {
    return 'locally_confirmed';
  }

  /** Produce the reverse operation record (enables cascading undo) */
  async undo(_ctx: HandlerContext, _output: unknown): Promise<ReverseOperation | null> {
    return null;
  }

  /** Is the external dependency currently reachable? */
  async health(): Promise<HealthStatus> {
    return { healthy: true, lastCheckedAt: new Date().toISOString() };
  }
}
