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

  /** Confirm the side effects stuck (read-back) */
  async confirm(_ctx: HandlerContext, _output: unknown): Promise<boolean> {
    return true;
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
