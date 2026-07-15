/**
 * tenantScopeGuard — Prisma middleware that enforces user/tenant
 * isolation at the data-access layer.
 *
 * P0 (2026-05-22). Built in direct response to a cross-user data leak
 * where Basit saw Haseeb's emails and contacts because resolver +
 * feed queries filtered by `clientNumber` only (tenant-wide), not by
 * `userId` (per-user). With 95+ feedEvent / entity / openItem call
 * sites across the codebase, auditing each one is fragile. This
 * middleware enforces the boundary at the source:
 *
 *   1. Auth middleware sets currentTenant() on AsyncLocalStorage at
 *      request start.
 *   2. Prisma $extends intercepts reads on user-owned models.
 *   3. If the active where-clause lacks `userId` AND the model is in
 *      USER_SCOPED_MODELS, the middleware throws (or in soft mode,
 *      logs + injects the filter).
 *   4. Background jobs / cron tasks that legitimately need tenant-wide
 *      reads call `withSystemContext(...)` to opt out.
 *
 * This is the reviewer's recommendation #4 from the third-party review
 * and the cleanest implementation pattern for the "403 suspicious calls"
 * audit problem.
 *
 * Modes:
 *   - 'enforce' (production default after observation): throws on
 *     missing userId.
 *   - 'soft'   (rollout): logs the violation but doesn't throw,
 *     auto-injects userId. Use this initially to find violations
 *     without breaking flows.
 *   - 'off'    (escape hatch): no-op.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantContext {
  userId: number;
  clientNumber: string;
  /** Set to true for system tasks (cron, admin) that need cross-user
   *  reads. Bypasses enforcement. Use sparingly. */
  systemBypass?: boolean;
}

const ctx = new AsyncLocalStorage<TenantContext>();

/** Get the active tenant context for this request, if set. */
export function currentTenant(): TenantContext | undefined {
  return ctx.getStore();
}

/** Run a callback within a tenant context. The auth middleware
 *  should wrap every authenticated request in this. */
export function withTenant<T>(c: TenantContext, fn: () => T): T {
  return ctx.run(c, fn);
}

/** Convenience: run a function as the system (cross-user reads allowed).
 *  Use for cron jobs, admin endpoints, backfill scripts. */
export function withSystemContext<T>(clientNumber: string, fn: () => T): T {
  return ctx.run({ userId: -1, clientNumber, systemBypass: true }, fn);
}

/** Models whose rows are owned by a single user. Reads on these MUST
 *  filter by userId unless the caller is in systemBypass.
 *
 *  Models NOT in this list are tenant-shared by design (Tenant,
 *  TenantConnectorConfig, WikiPage with scope='tenant', etc.) and
 *  bypass the guard.
 */
const USER_SCOPED_MODELS = new Set([
  'FeedEvent',
  'OpenItem',
  'WhatsAppSession',
  'WhatsAppMessage',
  'BrainPendingAction',
  'BrainActionArtifact',
  'BrainUserMessage',
  'UserMemory',
  'UserResolutionAlias',
  'Person',
  // Entity is mixed — has scope='user' | 'tenant'. The application
  // layer handles this; we don't enforce at the middleware level
  // because tenant-scope entities are legitimately cross-user.
]);

const READ_OPERATIONS = new Set([
  'findMany', 'findFirst', 'findUnique',
  'findFirstOrThrow', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy',
]);

type ViolationMode = 'enforce' | 'soft' | 'off';

/** Build the Prisma $extends configuration that applies the guard
 *  to all USER_SCOPED_MODELS. Caller wires this into prisma client
 *  initialization. */
export function buildTenantScopeExtension(mode: ViolationMode = 'soft') {
  if (mode === 'off') return undefined;
  return {
    name: 'tenantScopeGuard',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          if (!USER_SCOPED_MODELS.has(model)) return query(args);
          if (!READ_OPERATIONS.has(operation)) return query(args);
          const tenant = currentTenant();
          if (tenant?.systemBypass) return query(args);
          // Check the where clause for userId presence.
          const w = args?.where ?? {};
          const hasUserId = hasUserIdFilter(w);
          if (hasUserId) return query(args);
          // Violation!
          const violation = {
            model, operation,
            userId: tenant?.userId ?? null,
            clientNumber: tenant?.clientNumber ?? null,
            stack: new Error().stack?.split('\n').slice(2, 6).join(' | '),
          };
          if (mode === 'enforce') {
            console.error('[tenantScope] BLOCKED query without userId', violation);
            throw new Error(`tenantScopeGuard: ${model}.${operation} missing userId in where clause`);
          }
          // Soft mode: log + inject userId if we have one in context.
          console.warn('[tenantScope] auto-injecting userId on unsafe query', violation);
          if (tenant?.userId && tenant.userId > 0) {
            const safeWhere = {
              AND: [
                w ?? {},
                { userId: tenant.userId },
              ],
            };
            return query({ ...args, where: safeWhere });
          }
          // No userId in context and unsafe query — let it through but log.
          return query(args);
        },
      },
    },
  } as const;
}

/** Recursively check whether a where-clause contains a userId filter
 *  at any nesting depth. Handles AND/OR/NOT compounds. */
function hasUserIdFilter(where: any): boolean {
  if (!where || typeof where !== 'object') return false;
  if ('userId' in where) {
    // Could be { userId: 5 } or { userId: { in: [5] } } — both count.
    const v = where.userId;
    return v !== undefined && v !== null;
  }
  if (Array.isArray(where.AND)) return where.AND.some(hasUserIdFilter);
  if (Array.isArray(where.OR)) {
    // ALL OR branches must include userId for safety.
    return where.OR.length > 0 && where.OR.every(hasUserIdFilter);
  }
  if (where.NOT) return hasUserIdFilter(where.NOT);
  return false;
}
