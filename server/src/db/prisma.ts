import { PrismaClient } from '@prisma/client';
import { currentTenant } from './tenantContext';

const base = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});

/**
 * Tenant isolation via Prisma's `$extends` query hook (Prisma v5/v6 API
 * — the legacy `$use` middleware was removed). Every read / update /
 * delete against a tenant-scoped model auto-injects the current
 * tenant's `clientNumber` filter, sourced from `tenantContext`'s
 * AsyncLocalStorage. Closes the 31 known-red `findUnique({where:{id}})`
 * data-leak paths that the test suite has been flagging.
 *
 * NOT included: tables that are intrinsically global (system_config,
 * connector_types, _prisma_migrations) or that don't carry a
 * clientNumber column.
 */
const TENANT_SCOPED_MODELS = new Set<string>([
  'User', 'WikiPage', 'WikiPageLink', 'FeedEvent',
  'OpenItem', 'OpenItemEmbedding', 'ItemStatusHistory',
  'AgentAction', 'DecisionLog', 'DelegationLog',
  'WhatsAppConnection', 'WhatsAppMessage', 'WhatsAppSession',
  'ShadowRule', 'PatternHidden', 'Entity',
  // Session intentionally NOT scoped here: the table has no clientNumber
  // column. Sessions are already tenant-isolated transitively via
  // userId → user.clientNumber. Including it broke session.create().
  'Conversation', 'Message',
  'BrainPersona', 'NotificationQueue', 'TenantWhatsappNotifier',
  'BrainUserMessage',
]);

const READ_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const WHERE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert']);

/**
 * P0 (2026-05-22) — USER-OWNED models. Reads on these MUST filter by
 * userId in addition to clientNumber. Without this, two users in the
 * same tenant see each other's data (exact failure on Basit/Haseeb
 * 2026-05-21). The extension below auto-injects userId from the
 * tenantContext on reads against these models.
 *
 * Entity is INTENTIONALLY EXCLUDED — it's mixed-scope (rows can be
 * scope='user' OR scope='tenant'). Application layer (contactResolver)
 * uses explicit scope-aware filters; auto-injecting userId here would
 * suppress legitimate scope='tenant' reads.
 *
 * WikiPage is also mixed-scope and excluded for the same reason.
 */
const USER_SCOPED_MODELS = new Set<string>([
  'FeedEvent', 'OpenItem', 'OpenItemEmbedding',
  'WhatsAppSession', 'WhatsAppMessage',
  'BrainPendingAction', 'BrainActionArtifact',
  'BrainUserMessage', 'BrainPromptQueue',
  'UserMemory', 'UserResolutionAlias',
  'Person', 'PersonFacet',
  'Conversation', 'Message',
  'PushSubscription', 'ScheduledTask',
  'UserConnector', 'AgentMemory',
  'MutedSender', 'UserPrompt', 'UserPromptOverlay',
  'PatternHidden', 'ThoughtEntry',
  'PersonalDocument', 'PersonalChunk',
  'RetrievalFeedback',
  'WhatsAppOutboundMessage',
]);

const prisma = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        // Wiki-page scope auto-injection (runs even when there's no
        // tenant context — e.g. boot-time backfill scripts). Any
        // create/upsert that doesn't explicitly set `scope` gets it
        // derived from pageType. See services/knowledge/wikiScope.ts.
        if (model === 'WikiPage' && (operation === 'create' || operation === 'upsert')) {
          const a: any = args ?? {};
          if (operation === 'create') {
            const data = a.data ?? {};
            if (data.scope === undefined && typeof data.pageType === 'string') {
              const { defaultScopeForPageType } = await import('../services/knowledge/wikiScope');
              args = { ...a, data: { ...data, scope: defaultScopeForPageType(data.pageType) } };
            }
          } else {
            const create = a.create ?? {};
            if (create.scope === undefined && typeof create.pageType === 'string') {
              const { defaultScopeForPageType } = await import('../services/knowledge/wikiScope');
              args = { ...a, create: { ...create, scope: defaultScopeForPageType(create.pageType) } };
            }
          }
        }

        if (!TENANT_SCOPED_MODELS.has(model)) return query(args);
        const scope = currentTenant();
        if (!scope || scope.bypass) return query(args);
        const cn = scope.clientNumber;
        if (!cn) return query(args);

        // Reads + write-with-where: inject clientNumber if absent.
        if (READ_OPS.has(operation) || WHERE_OPS.has(operation)) {
          const a: any = args ?? {};
          const where = a.where ?? {};
          if (where.clientNumber === undefined && where.client_number === undefined) {
            // findUnique only accepts unique-key shapes; we can't inject
            // a non-unique field. Strategy: for findUnique we do the
            // single-row query as-is, then verify clientNumber on the
            // returned row (post-filter). Same for findUniqueOrThrow.
            //
            // Subtlety: if the caller's `select` clause doesn't include
            // `clientNumber`, the returned row has `row.clientNumber ===
            // undefined`. A naive `row.clientNumber !== cn` check would
            // be falsy and silently drop a row that actually belongs to
            // the right tenant — see the "entity not found" bug from
            // setStars (which selected only `metadata`). Fix: when the
            // caller's select omits clientNumber, we add it ourselves,
            // do the verification, then strip it from the result before
            // returning.
            if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
              const a: any = args ?? {};
              const userSelect = a.select;
              const callerOmittedClientNumber =
                userSelect && typeof userSelect === 'object'
                  && userSelect.clientNumber !== true
                  && userSelect.client_number !== true;
              const patched = callerOmittedClientNumber
                ? { ...a, select: { ...userSelect, clientNumber: true } }
                : args;
              const row: any = await query(patched);
              if (!row) return row;
              if (row.clientNumber !== cn && row.client_number !== cn) {
                if (operation === 'findUniqueOrThrow') throw new Error('Tenant scope mismatch');
                return null as any;
              }
              if (callerOmittedClientNumber) {
                // Strip the field we added so the caller's projection
                // is exactly what they asked for.
                const { clientNumber: _strip, ...rest } = row;
                return rest;
              }
              return row;
            }
            const next = { ...a, where: { ...where, clientNumber: cn } };
            return query(next as any);
          }
        }

        // create / createMany: default clientNumber if absent.
        if (operation === 'create') {
          const a: any = args ?? {};
          const data = a.data ?? {};
          if (data.clientNumber === undefined && data.client_number === undefined) {
            return query({ ...a, data: { ...data, clientNumber: cn } } as any);
          }
        }
        if (operation === 'createMany') {
          const a: any = args ?? {};
          const items = Array.isArray(a.data) ? a.data : [a.data];
          const patched = items.map((d: any) =>
            d?.clientNumber === undefined && d?.client_number === undefined
              ? { ...d, clientNumber: cn }
              : d,
          );
          return query({ ...a, data: patched } as any);
        }

        return query(args);
      },
    },
  },
}).$extends({
  // P0 (2026-05-22) — USER-SCOPE injection for user-owned models.
  // Runs AFTER the tenant-scope extension above. For reads on
  // USER_SCOPED_MODELS, if the where-clause lacks userId AND we
  // have a userId in tenantContext, inject it. This closes the
  // cross-user leak class — Basit (user 2) was seeing Haseeb's
  // emails because feed queries filtered by clientNumber only.
  //
  // Logged as a warn so engineers can see when this fires and
  // either add explicit userId or call runWithoutTenant() for
  // legitimate cross-user reads.
  name: 'userScopeGuard',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (!USER_SCOPED_MODELS.has(model)) return query(args);
        if (!READ_OPS.has(operation)) return query(args);
        const scope = currentTenant();
        if (!scope || scope.bypass || !scope.userId) return query(args);
        const a: any = args ?? {};
        const where = a.where ?? {};
        // Check if userId is anywhere in the where-tree (top-level,
        // nested AND, nested OR). If yes, leave alone.
        if (hasUserIdAnywhere(where)) return query(args);
        // findUnique only accepts unique-key shapes; post-filter.
        if (operation === 'findUnique' || operation === 'findUniqueOrThrow') {
          const userSelect = a.select;
          const callerOmittedUserId =
            userSelect && typeof userSelect === 'object'
              && userSelect.userId !== true && userSelect.user_id !== true;
          const patched = callerOmittedUserId
            ? { ...a, select: { ...userSelect, userId: true } }
            : args;
          const row: any = await query(patched);
          if (!row) return row;
          if (row.userId !== scope.userId && row.user_id !== scope.userId) {
            console.warn('[userScope] findUnique tenant-match but wrong user', {
              model, expectedUserId: scope.userId, gotUserId: row.userId ?? row.user_id,
            });
            if (operation === 'findUniqueOrThrow') throw new Error('User scope mismatch');
            return null as any;
          }
          if (callerOmittedUserId) {
            const { userId: _u, ...rest } = row;
            return rest;
          }
          return row;
        }
        // findMany / findFirst / count / aggregate / groupBy: inject userId via AND.
        console.warn('[userScope] auto-injecting userId on unscoped read', { model, operation });
        const safeWhere = { AND: [where, { userId: scope.userId }] };
        return query({ ...a, where: safeWhere } as any);
      },
    },
  },
});

/** Recursively check if a where-clause has userId at any nesting depth. */
function hasUserIdAnywhere(where: any): boolean {
  if (!where || typeof where !== 'object') return false;
  if ('userId' in where || 'user_id' in where) {
    const v = where.userId ?? where.user_id;
    return v !== undefined && v !== null;
  }
  if (Array.isArray(where.AND)) return where.AND.some(hasUserIdAnywhere);
  if (Array.isArray(where.OR)) return where.OR.length > 0 && where.OR.every(hasUserIdAnywhere);
  if (where.NOT) return hasUserIdAnywhere(where.NOT);
  return false;
}

export default prisma;
