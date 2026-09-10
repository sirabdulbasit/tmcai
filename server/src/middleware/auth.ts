import { Request, Response, NextFunction } from 'express';
import { validateToken, TokenUser } from '../services/authService';
import { checkSubscription } from '../services/licenseService';
import { runInTenantScope } from '../db/tenantContext';

// Extend Express Request to include authenticated user
declare global {
  namespace Express {
    interface Request {
      user?: TokenUser;
    }
  }
}

const TOKEN_COOKIE = 'tmcai_token';

/**
 * Authentication middleware — validates access token from HttpOnly cookie.
 * Attaches user to req.user if valid.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // If agentAuthMiddleware already authenticated this request via a
  // tenant-bound Bearer token + X-Tenant-Id, honor it and skip cookie check.
  if ((req as any).user?.clientNumber && (req as any).user?.isAgent) {
    return next();
  }

  const token = req.cookies?.[TOKEN_COOKIE] || extractBearerToken(req);

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await validateToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Check subscription expiry (skip for SuperAdmin — they manage the platform)
  if (!user.isSuperAdmin) {
    const sub = await checkSubscription(user.clientNumber);
    if (!sub.valid) {
      res.status(403).json({ error: sub.error, code: 'SUBSCRIPTION_EXPIRED' });
      return;
    }
  }

  req.user = user;
  // Run the rest of the request inside a tenant scope so the Prisma
  // middleware can auto-inject `clientNumber` on every read/write.
  // SA bypass: SuperAdmin requests run with bypass=true so cross-tenant
  // ops (admin tooling) aren't filtered.
  await runInTenantScope(
    {
      clientNumber: user.clientNumber,
      userId: user.id,
      bypass: !!user.isSuperAdmin,
    },
    async () => next(),
  );
}

/**
 * Optional auth — attaches user if token exists, but doesn't block.
 * Useful for endpoints that work with or without auth.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[TOKEN_COOKIE] || extractBearerToken(req);
  if (token) {
    const user = await validateToken(token);
    if (user) {
      req.user = user;
      await runInTenantScope(
        { clientNumber: user.clientNumber, userId: user.id, bypass: !!user.isSuperAdmin },
        async () => next(),
      );
      return;
    }
  }
  next();
}

/**
 * Admin-only middleware — must be used after requireAuth.
 */
/**
 * NOT SIGNED IN AND NOT ALLOWED ARE DIFFERENT FACTS (fixed 2026-09-10).
 *
 * This answered both with "Admin access required", and the Build Pulse deck renders that
 * string verbatim: *"Pulse unreadable (Admin access required) — showing the last good
 * frame, 174409s old."* The owner read it, reasonably, as a permissions problem and asked
 * about his access — while his account was `SA` (isAdmin true), active, and fine. What had
 * actually happened is that `optionalAuth` found no valid session, so `req.user` was
 * undefined and this branch fired on the FIRST condition.
 *
 * An error that names the wrong cause is worse than a vague one: it sends the reader to
 * inspect the thing that is not broken. Two conditions, two sentences.
 *
 * The STATUS CODE is deliberately left at 403 for both. 401 is the more correct semantic
 * for "not signed in", but this middleware guards many routes and some clients branch on
 * the code; changing it is a wider behavioural change than the bug being fixed here
 * warrants, and would belong with its own review. The message carries the distinction,
 * which is what the reader actually sees.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(403).json({ error: 'Not signed in — session expired or missing, sign in again' });
    return;
  }
  if (!req.user.isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isSuperAdmin) {
    res.status(403).json({ error: 'SuperAdmin access required' });
    return;
  }
  next();
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

export { TOKEN_COOKIE };
