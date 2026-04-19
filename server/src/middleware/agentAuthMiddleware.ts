import { Request, Response, NextFunction } from 'express';
import prisma from '../db/prisma';

/**
 * HaseebOS v15 — machine-to-machine auth for the ADK agent worker.
 *
 * The agent worker runs on Cloud Run (or localhost in dev) and calls back into
 * the platform over HTTP with `Authorization: Bearer <PLATFORM_API_TOKEN>` and
 * `X-Tenant-Id: <clientNumber>` on every request.
 *
 * This middleware:
 *  - Accepts the bearer token if it matches `process.env.PLATFORM_API_TOKEN`
 *  - Builds a synthetic `req.user` so downstream route handlers can read
 *    `clientNumber` / `userType='SA'` / `id` without distinguishing agent vs human
 *  - Records `X-Agent-Id` on the request for DecisionLog correlation
 *  - `user.id` maps to the tenant's first SA user so existing route checks
 *    (`if (!user?.id)`) pass. Attribution: the agent acts on behalf of that SA.
 *
 * Falls through to cookie-session auth if the header is absent or mismatched.
 */

const DEV_FALLBACK_TOKEN = 'dev-local-platform-token-change-me';

// Cached: tenant → SA userId. Avoids a DB hit on every agent request.
const saIdCache = new Map<string, number>();

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

export async function agentAuthMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();
  const token = header.slice('Bearer '.length).trim();
  const expected = process.env.PLATFORM_API_TOKEN || DEV_FALLBACK_TOKEN;

  if (!token || token !== expected) {
    return next();
  }

  const tenantId = (req.headers['x-tenant-id'] as string | undefined)?.trim();
  const agentId = (req.headers['x-agent-id'] as string | undefined)?.trim() || 'unknown';

  if (!tenantId) return next();

  let saId = 0;
  try {
    saId = await resolveSaId(tenantId);
  } catch {
    /* DB down — proceed with id=0; some routes will reject, which is safer than a lie */
  }

  (req as any).user = {
    id: saId,
    clientNumber: tenantId,
    userType: 'SA',
    isAgent: true,
    agentId,
  };

  next();
}
