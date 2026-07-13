import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('agentAuth');

/**
 * Machine-to-machine auth for the ADK agent worker.
 *
 * The agent worker calls back into the platform with
 * `Authorization: Bearer <token>` and `X-Tenant-Id: <clientNumber>`.
 *
 * E1 (2026-07-08): tokens are provisioned PER TENANT in `agent_api_tokens`
 * (sha256 hash of the raw token — raw values are never stored). The
 * middleware verifies the token↔tenant binding:
 *   - token bound to the requested tenant  → synthetic SA `req.user`,
 *     audit log, downstream runs inside that tenant's Prisma scope
 *   - KNOWN token + tenant it is NOT bound to (or missing X-Tenant-Id)
 *     → 403, request ends here. No scope is entered — this is the
 *     cross-tenant impersonation the old env-token model allowed.
 *   - unknown bearer → fall through to cookie/session auth untouched
 *
 * The legacy single `PLATFORM_API_TOKEN` env var no longer grants access.
 * Provision tokens with `npm run provision:agent-token -- <clientNumber> <label>`.
 */

async function resolveSaId(clientNumber: string): Promise<number> {
  const hit = saIdCache.get(clientNumber);
  if (hit !== undefined) return hit;
  const sa = await prisma.user.findFirst({
    where: { clientNumber, userType: 'SA', isActive: true },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  const id = sa?.id ?? 0;
  saIdCache.set(clientNumber, id);
  return id;
}

// Cached: tenant → SA userId. Avoids a DB hit on every agent request.
const saIdCache = new Map<string, number>();

export function hashAgentToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export async function agentAuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  const token = header.slice('Bearer '.length).trim();
  if (!token) return next();

  const tokenHash = hashAgentToken(token);
  const tenantId = (req.headers['x-tenant-id'] as string | undefined)?.trim();
  const agentId = (req.headers['x-agent-id'] as string | undefined)?.trim() || 'unknown';

  // 1. Is this token bound to the tenant it claims?
  let bound: { id: string } | null = null;
  try {
    bound = tenantId
      ? await prisma.agentApiToken.findFirst({
          where: { tokenHash, clientNumber: tenantId, isActive: true },
          select: { id: true },
        })
      : null;
  } catch (err: any) {
    // DB down — fail CLOSED for agent auth (do not guess a tenant), but
    // let non-agent bearers continue to other auth layers.
    log.error('agent token lookup failed', { error: err.message });
    return next();
  }

  if (!bound) {
    // 2. Not bound. Distinguish "known token, wrong tenant" (attack or
    //    misconfig → hard 403, audit) from "not an agent token at all"
    //    (fall through — could be another bearer scheme).
    const known = await prisma.agentApiToken
      .findFirst({ where: { tokenHash, isActive: true }, select: { id: true, clientNumber: true } })
      .catch(() => null);
    if (known) {
      log.warn('AGENT AUTH REJECTED — token not bound to requested tenant', {
        tokenId: known.id, boundTenant: known.clientNumber,
        requestedTenant: tenantId ?? '(missing X-Tenant-Id)',
        agentId, path: req.path,
      });
      res.status(403).json({ error: 'token not authorized for this tenant' });
      return;
    }
    return next();
  }

  // 3. Bound token — audit every agent auth with its tenant.
  log.info('agent auth ok', { tokenId: bound.id, tenant: tenantId, agentId, path: req.path });
  void prisma.agentApiToken
    .updateMany({ where: { id: bound.id }, data: { lastUsedAt: new Date() } })
    .catch(() => { /* best effort */ });

  let saId = 0;
  try {
    saId = await resolveSaId(tenantId!);
  } catch {
    /* DB hiccup — proceed with id=0; some routes will reject, which is safer than a lie */
  }

  (req as any).user = {
    id: saId,
    clientNumber: tenantId,
    userType: 'SA',
    isAgent: true,
    agentId,
  };

  // Run downstream in tenant scope so Prisma middleware auto-injects
  // clientNumber on tenant-scoped queries. Agent calls are scoped to
  // exactly the tenant their token was provisioned for.
  const { runInTenantScope } = await import('../db/tenantContext');
  await runInTenantScope(
    { clientNumber: tenantId!, userId: saId || null, bypass: false },
    async () => next(),
  );
}
