/**
 * Which inference backend Brain runs on — read from config, not hardcoded.
 *
 * Owner, 2026-08-10: he wants the provider switchable from the UI, the way the
 * VM portal already does it — pick Vertex, paste a service-account JSON, set a
 * region, press Verify.
 *
 * Until now the answer was a constant. `llmRouter` hardcoded
 * `['gemini', 'gemini-flash', 'claude']` and `config/models.ts` hardcoded the
 * model ids, so changing backend meant an edit and a deploy. That is also why
 * two failures this week were invisible for so long: when `text-embedding-004`
 * was retired and when the Anthropic key ran out of credit, nothing surfaced
 * either fact, because nothing was watching a thing that could not change.
 *
 * ── APPLICATION-LEVEL, NEVER PER-TENANT ─────────────────────────────────────
 * Deliberate, and the same choice ShireMe made. One Brain, one backend: if
 * tenants could each pick a model, "why did Brain answer differently" would be
 * unanswerable, and a per-tenant service account would multiply the number of
 * private keys in the database by the number of customers.
 *
 * The service-account JSON is a private key. It is stored `is_sensitive`, masked
 * on read, and never returned to a browser once saved.
 */

import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { MODEL_GEMINI, MODEL_GEMINI_FLASH, MODEL_CLAUDE } from '../config/models';

const log = createLogger('ai-provider');

export type AiProvider = 'gemini' | 'vertex' | 'claude' | 'openai' | 'openrouter' | 'custom';

export interface AiProviderConfig {
  provider: AiProvider;
  /** Full-strength reasoning model. */
  model: string;
  /** Cheaper/faster sibling for high-volume judgement work. */
  flashModel: string;
  /** Vertex only. */
  region: string;
  serviceAccount: Record<string, unknown> | null;
  /** True when everything this provider needs is actually present. */
  ready: boolean;
  /** Why it is not ready, when it is not. */
  reason?: string;
}

const DEFAULTS: AiProviderConfig = {
  // Falls back to exactly what the code did before this file existed, so an
  // empty config table changes nothing.
  provider: 'gemini',
  model: MODEL_GEMINI,
  flashModel: MODEL_GEMINI_FLASH,
  region: 'us-central1',
  serviceAccount: null,
  ready: true,
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; cfg: AiProviderConfig } | null = null;

/** Drop the cache so a Save in the UI takes effect without a restart. */
export function clearAiProviderCache(): void {
  cache = null;
}

async function readKeys(): Promise<Record<string, string>> {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: ['ai_provider', 'ai_model', 'ai_service_account_json', 'ai_region'] } },
    select: { key: true, value: true },
  }).catch(() => [] as Array<{ key: string; value: string }>);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * The active configuration.
 *
 * Never throws and never returns something unusable: a malformed service
 * account marks the config NOT ready with a reason rather than crashing the
 * reasoning path. A backend that cannot be reached should degrade to a clear
 * message, not to a stack trace on the owner's phone.
 */
export async function getAiProviderConfig(): Promise<AiProviderConfig> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.cfg;

  const keys = await readKeys();
  const provider = (keys.ai_provider?.trim().toLowerCase() as AiProvider) || DEFAULTS.provider;
  const model = keys.ai_model?.trim() || DEFAULTS.model;
  const region = keys.ai_region?.trim() || DEFAULTS.region;

  let serviceAccount: Record<string, unknown> | null = null;
  let reason: string | undefined;

  if (provider === 'vertex') {
    const raw = keys.ai_service_account_json?.trim();
    if (raw) {
      try {
        serviceAccount = JSON.parse(raw);
      } catch {
        reason = 'the service account JSON stored in settings is not valid JSON';
      }
    }
    // An absent SA is not an error: GOOGLE_APPLICATION_CREDENTIALS on the box is
    // an equally valid way to authenticate, and is how this server is already
    // set up. Only say "not ready" when NEITHER is available.
    if (!serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS && !reason) {
      reason = 'Vertex is selected but no service account JSON is stored and GOOGLE_APPLICATION_CREDENTIALS is not set';
    }
  }

  const cfg: AiProviderConfig = {
    provider,
    model,
    // The flash sibling is derived rather than configured: asking the owner to
    // keep two model ids in step is a way to end up with a mismatched pair.
    flashModel: provider === 'vertex' || provider === 'gemini'
      ? (model.includes('flash') ? model : model.replace(/-pro\b/, '-flash'))
      : MODEL_GEMINI_FLASH,
    region,
    serviceAccount,
    ready: !reason,
    reason,
  };

  cache = { at: Date.now(), cfg };
  return cfg;
}

/**
 * Try the configured backend for real and report what happened, in the words
 * the owner should see.
 *
 * A real generate call, not a credential check: a valid key with no quota, a
 * retired model and a region that does not host the model all pass an auth
 * check and fail in production. Two of those three have bitten this project
 * this week.
 */
export async function verifyAiProvider(): Promise<{ ok: boolean; message: string; detail?: string }> {
  const cfg = await getAiProviderConfig();
  if (!cfg.ready) return { ok: false, message: cfg.reason ?? 'configuration incomplete' };

  try {
    if (cfg.provider === 'vertex') {
      const { GoogleAuth } = await import('google-auth-library');
      const auth = new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        ...(cfg.serviceAccount ? { credentials: cfg.serviceAccount as any } : {}),
      });
      const projectId = (cfg.serviceAccount?.project_id as string)
        ?? process.env.GCP_PROJECT_ID
        ?? await auth.getProjectId();
      const client = await auth.getClient();
      const token = (await client.getAccessToken()).token;
      if (!token) return { ok: false, message: 'could not obtain a Google access token' };

      const url = `https://${cfg.region}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${cfg.region}/publishers/google/models/${cfg.model}:generateContent`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'reply with OK' }] }] }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) {
        const body = (await r.text()).slice(0, 300);
        return {
          ok: false,
          message: `Vertex rejected the call (HTTP ${r.status})`,
          // The raw body names the actual cause — wrong region, model not
          // enabled, missing IAM role — and guessing at it would waste the
          // owner's time.
          detail: body,
        };
      }
      return { ok: true, message: `Connected to vertex · model "vertex/${cfg.model}" in ${cfg.region}. Integration is working.` };
    }

    if (cfg.provider === 'gemini') {
      const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
      if (!key) return { ok: false, message: 'GEMINI_API_KEY is not configured' };
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'reply with OK' }] }] }),
          signal: AbortSignal.timeout(25_000),
        },
      );
      if (!r.ok) return { ok: false, message: `Gemini rejected the call (HTTP ${r.status})`, detail: (await r.text()).slice(0, 300) };
      return { ok: true, message: `Connected to gemini · model "${cfg.model}". Integration is working.` };
    }

    if (cfg.provider === 'claude') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { ok: false, message: 'ANTHROPIC_API_KEY is not configured' };
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model || MODEL_CLAUDE, max_tokens: 16, messages: [{ role: 'user', content: 'say OK' }] }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!r.ok) return { ok: false, message: `Anthropic rejected the call (HTTP ${r.status})`, detail: (await r.text()).slice(0, 300) };
      return { ok: true, message: `Connected to claude · model "${cfg.model || MODEL_CLAUDE}". Integration is working.` };
    }

    return { ok: false, message: `provider "${cfg.provider}" is not implemented yet` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('provider verification failed', { provider: cfg.provider, err: msg });
    return { ok: false, message: 'the check could not complete', detail: msg.slice(0, 300) };
  }
}
