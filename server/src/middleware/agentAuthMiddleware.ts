import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('agentAuth');

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
 *
 * Security: the expected token is ONLY read from `process.env.PLATFORM_API_TOKEN`.
 * There is no hard-coded fallback — in production, boot fails if the env var
 * is missing. In development we log a loud warning and reject all agent
 * bearers rather than accepting a known string.
 */

const MIN_TOKEN_BYTES = 32;

// Cached: tenant → SA userId. Avoids a DB hit on every agent request.
const saIdCache = new Map<string, number>();

/** Read-and-validate the expected token once, at middleware-call time, from env. */
export function getExpectedAgentToken(): string | null {
  const raw = process.env.PLATFORM_API_TOKEN;
  if (!raw || raw.length < MIN_TOKEN_BYTES) return null;
  return raw;
}

/** Constant-time token comparison; safely handles unequal-length inputs. */
function tokensMatch(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

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

  const expected = getExpectedAgentToken();
  if (!expected) {
    // No valid token configured — never accept an agent bearer. Fall through
    // to cookie auth so human sessions still work (e.g. a developer running
    // locally without the env var set).
    log.warn('agent bearer rejected: PLATFORM_API_TOKEN missing or too short', {
      path: req.path,
    });
    return next();
  }

  if (!token || !tokensMatch(token, expected)) {
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

  // Run downstream in tenant scope so Prisma middleware auto-injects
  // clientNumber on tenant-scoped queries. Agent calls are scoped to
  // exactly the tenant they specified — no cross-tenant bypass.
  const { runInTenantScope } = await import('../db/tenantContext');
  await runInTenantScope(
    { clientNumber: tenantId, userId: saId || null, bypass: false },
    async () => next(),
  );
}
