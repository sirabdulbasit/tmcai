import { Request, Response, NextFunction } from 'express';

// M8 — In production, only return err.message verbatim when the thrown
// error is of a known, user-safe class. For everything else (including
// bare Errors and Prisma-driven failures, which leak SQL fragments and
// internal identifiers), return a generic message bucketed by status.
// In development we keep the raw message so developers can diagnose.
const SAFE_ERROR_NAMES = new Set([
  'ValidationError',     // Zod / Joi / custom validators
  'ZodError',
  'UnauthorizedError',
  'ForbiddenError',
  'NotFoundError',
  'ConflictError',
  'RateLimitError',
]);

function genericMessageFor(status: number): string {
  if (status >= 500) return 'An unexpected error occurred. Please try again later.';
  if (status === 404) return 'Resource not found';
  if (status === 403) return 'Forbidden';
  if (status === 401) return 'Authentication required';
  if (status === 409) return 'Conflict';
  if (status === 429) return 'Too many requests';
  if (status >= 400) return 'Bad request';
  return 'Error';
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  const status = err.status || err.statusCode || 500;
  const requestId = (req as any).requestId;
  console.error('Unhandled error:', { status, name: err.name, message: err.message, requestId, path: req.path });

  if (process.env.NODE_ENV === 'production') {
    const isSafe = err.name && SAFE_ERROR_NAMES.has(err.name);
    const body: Record<string, unknown> = {
      error: isSafe ? (err.message || genericMessageFor(status)) : genericMessageFor(status),
    };
    if (requestId) body.requestId = requestId;
    res.status(status).json(body);
    return;
  }

  // Development: pass through for debuggability.
  res.status(status).json({ error: err.message || 'Internal server error', name: err.name, requestId });
}
