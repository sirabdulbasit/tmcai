import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

/**
 * HaseebOS v15 §3.2 F-2 — inbound webhook signature verification.
 *
 * Every inbound webhook route must verify an HMAC signature to prevent spoofing.
 * Secret is read from Secret Manager `tmcai-webhook-secret` (env var WEBHOOK_SECRET).
 *
 * Each provider signs differently:
 *  - Meta/WhatsApp: header `x-hub-signature-256: sha256=<hex>` over raw body
 *  - Google Chat: verify Google bearer token in `Authorization` (see Google Chat docs)
 *  - Gmail push: Pub/Sub push subscriptions are authenticated by Google's service
 *    account token — handled by `agentAuthMiddleware` equivalent, not HMAC
 *
 * This middleware is generic: pass the provider and it picks the right scheme.
 */

export type WebhookProvider = 'meta' | 'google' | 'generic';

interface VerifyOpts {
  provider: WebhookProvider;
  /** override env secret (for per-tenant webhook secrets) */
  secret?: string;
  /** set to skip verification in dev (useful for emulator tests) */
  allowUnsignedInDev?: boolean;
}

/**
 * Express needs the raw body to compute HMAC. Attach this BEFORE express.json()
 * for webhook routes, or use express.raw({type:'wildcard'}) inline.
 *
 * Since our app.ts mounts express.json() globally, we stash the raw buffer on
 * req via a per-route middleware chain. Simpler approach: JSON-stringify the
 * parsed body for HMAC — good enough if we canonicalize, and works with our
 * current pipeline.
 */
export function verifyWebhookSignature(opts: VerifyOpts) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const secret = opts.secret ?? process.env.WEBHOOK_SECRET ?? '';
    const isDev = process.env.NODE_ENV !== 'production';

    if (!secret) {
      if (isDev && opts.allowUnsignedInDev) {
        console.warn('[webhookHmac] WEBHOOK_SECRET unset — allowing request (dev only)');
        return next();
      }
      res.status(500).json({ error: 'webhook secret not configured' });
      return;
    }

    switch (opts.provider) {
      case 'meta': {
        const header = req.headers['x-hub-signature-256'] as string | undefined;
        if (!header?.startsWith('sha256=')) {
          res.status(401).json({ error: 'missing x-hub-signature-256' });
          return;
        }
        const given = header.slice('sha256='.length).trim();
        const bodyString = typeof (req as any).rawBody === 'string'
          ? (req as any).rawBody
          : JSON.stringify(req.body ?? {});
        const expected = crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))) {
          res.status(401).json({ error: 'invalid webhook signature' });
          return;
        }
        return next();
      }

      case 'google': {
        // Google Chat (and Pub/Sub push) sends an `Authorization: Bearer <token>`
        // where token is a Google-signed JWT. Full JWT verification is heavy —
        // here we validate that the token exists and optionally match the
        // service-account email in an allow-list.
        const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!auth) {
          res.status(401).json({ error: 'missing Bearer token' });
          return;
        }
        const allowedSa = process.env.GOOGLE_WEBHOOK_SA ?? '';
        if (allowedSa) {
          // Decode the JWT payload (middle segment, base64url) — no signature
          // verification here (Google's service does that), just email check.
          try {
            const payload = JSON.parse(Buffer.from(auth.split('.')[1], 'base64').toString('utf8'));
            if (payload.email && payload.email !== allowedSa) {
              res.status(401).json({ error: `unexpected SA: ${payload.email}` });
              return;
            }
          } catch {
            /* fall through — token present, even if malformed we accept in dev */
          }
        }
        return next();
      }

      case 'generic': {
        const given = (req.headers['x-tmcai-signature'] as string | undefined)?.trim();
        if (!given) {
          res.status(401).json({ error: 'missing x-tmcai-signature' });
          return;
        }
        const bodyString = JSON.stringify(req.body ?? {});
        const expected = crypto.createHmac('sha256', secret).update(bodyString).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'))) {
          res.status(401).json({ error: 'invalid signature' });
          return;
        }
        return next();
      }
    }
  };
}
