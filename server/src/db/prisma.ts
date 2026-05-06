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
});

export default prisma;
