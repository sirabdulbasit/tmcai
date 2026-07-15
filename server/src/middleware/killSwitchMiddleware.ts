import { Request, Response, NextFunction } from 'express';
import { isActive } from '../services/safety/killSwitchService';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const BYPASS_PATHS = [
  '/api/v1/safety/kill-switch',
  '/api/safety/kill-switch',
  '/api/v1/auth/',
  '/api/auth/',
  '/api/v1/health',
  '/api/health',
];

export async function killSwitchMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!MUTATION_METHODS.has(req.method)) {
    return next();
  }
  if (BYPASS_PATHS.some((p) => req.path.startsWith(p))) {
    return next();
  }

  const clientNumber = (req as any).user?.clientNumber;
  if (!clientNumber) return next();

  try {
    const active = await isActive(clientNumber);
    if (active) {
      res.status(503).json({
        error: 'kill_switch_active',
        message: 'The kill switch is engaged for this tenant. All write operations are paused. Contact admin to release.',
      });
      return;
    }
  } catch (err: any) {
    console.error('[killSwitchMiddleware] check failed, failing open:', err.message);
  }
  next();
}
