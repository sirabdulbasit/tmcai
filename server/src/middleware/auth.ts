import { Request, Response, NextFunction } from 'express';
import { validateToken, TokenUser } from '../services/authService';
import { checkSubscription } from '../services/licenseService';

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
  // HaseebOS v15: if agentAuthMiddleware already authenticated this request
  // via Bearer PLATFORM_API_TOKEN + X-Tenant-Id, honor it and skip cookie check.
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
  next();
}

/**
 * Optional auth — attaches user if token exists, but doesn't block.
 * Useful for endpoints that work with or without auth.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[TOKEN_COOKIE] || extractBearerToken(req);
  if (token) {
    const user = await validateToken(token);
    if (user) req.user = user;
  }
  next();
}

/**
 * Admin-only middleware — must be used after requireAuth.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
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
