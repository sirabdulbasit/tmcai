/**
 * DEF-365 — the Nexeo adapter for the vendored @tmc/ai-integration framework
 * (src/vendor/ai-integration, commit c0a6ebe). Owner ruling 2026-10-30: the
 * framework is adopted "till mapping" — sources, extraction, network guards,
 * field inventory, recipes / periods / aggregate. Destinations, approval and
 * versioning, the run engine, the scheduler, the routes and the client stay
 * Nexeo's. So this adapter implements only the ports that path needs, thinly:
 *
 *  - tenant binding: a framework TenantId IS a Nexeo clientNumber; every port
 *    method re-checks it and binds its query to it (the framework never infers
 *    a tenant from a record — ports.ts);
 *  - LlmProvider over llmRouter.callLLM (spend, fallback and timeouts stay the
 *    router's; tools and streaming are refused, not faked);
 *  - secret access over store/secretStore (encrypted, tenant-scoped; setSecret
 *    keeps Nexeo's "test first / pause first" rules);
 *  - store reads: the integration row as a framework IntegrationRecord.
 *
 * Google account rule: the framework's Drive/Sheets OAuth (configureOAuth,
 * accessTokenFor — a per-integration consent) is deliberately NOT wired.
 * Nexeo reads a private sheet only through the tenant's designated account,
 * resolved with userId null (sources/gsheetReader.ts); nothing here can hand
 * the framework any other account's token. def365IntegrationFramework.test.ts
 * pins that no Nexeo module imports those framework functions.
 *
 * Nothing under engine/** imports this file (it reaches the model layer).
 */
import prisma from '../../../db/prisma';
import { callLLM, type CallLlmOpts } from '../../llmRouter';
import { getSecret as storeGetSecret, setSecret as storeSetSecret } from '../store/secretStore';
import type {
  AiProviderSource,
  IntegrationRecord,
  IntegrationStore,
  TenantId,
} from '../../../vendor/ai-integration/ports';
import type { ChatOptions, ChatResponse, LlmProvider, PingResult } from '../../../vendor/ai-integration/ai/llmProvider';

/** clientNumber column: VARCHAR(20). */
const CN_RE = /^[A-Za-z0-9_-]{1,20}$/;

/** A framework tenant, as a Nexeo clientNumber — or a throw. Never a default. */
export function tenantOf(tenant: TenantId): string {
  const cn = typeof tenant === 'number' ? String(tenant) : tenant;
  if (typeof cn !== 'string' || !CN_RE.test(cn)) throw new Error('A framework call arrived without a valid tenant.');
  return cn;
}

// ── AI ────────────────────────────────────────────────────────────────────

export interface NexeoLlmOptions {
  /** llmRouter spend label, e.g. 'integration_mapping'. */
  purpose: string;
  providers?: CallLlmOpts['providers'];
  timeoutMs?: number;
}

const PROVIDER_KEY: Record<string, LlmProvider['providerKey']> = {
  gemini: 'google', 'gemini-flash': 'google', claude: 'anthropic', openai: 'openai',
};

/** One prompt string from the framework's messages (callLLM takes one user message). */
export function flattenMessages(messages: ChatOptions['messages']): string {
  if (messages.length === 1 && messages[0]!.role === 'user') return messages[0]!.content;
  return messages.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
}

/** The framework's LlmProvider for ONE tenant, over llmRouter.callLLM. */
export function nexeoLlmProvider(cn: string, opts: NexeoLlmOptions): LlmProvider {
  const tenant = tenantOf(cn);
  const first = opts.providers?.[0] ?? 'gemini';
  return {
    providerKey: PROVIDER_KEY[first] ?? 'google',
    model: String(first),
    async chat(o: ChatOptions): Promise<ChatResponse> {
      if (o.tools?.length) throw new Error('Tool calls are not available through the Nexeo LLM router.');
      if (o.tenantKey !== undefined && tenantOf(o.tenantKey) !== tenant) {
        throw new Error('A model call was made for a different tenant than its provider.');
      }
      const reply = await callLLM(o.systemPrompt, flattenMessages(o.messages), {
        clientNumber: tenant,
        purpose: opts.purpose,
        ...(opts.providers ? { providers: opts.providers } : {}),
        ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        ...(o.maxOutputTokens ? { maxTokens: o.maxOutputTokens } : {}),
        ...(o.thinkingBudget !== undefined ? { thinkingBudget: o.thinkingBudget } : {}),
      });
      return {
        text: reply.text,
        toolCalls: [],
        // The router estimates and records spend itself; the framework gets no
        // second, possibly different, count.
        usage: { inputTokens: 0, outputTokens: 0 },
        modelUsed: String(reply.provider),
        // callLLM reports no finish reason; the framework treats 'unknown' as
        // not-finished-normally, so its own truncation guards stay on.
        finishReason: 'unknown',
      };
    },
    async ping(): Promise<PingResult> {
      return { ok: true, latencyMs: 0, message: 'Routed through Nexeo llmRouter (health is the router\'s).' };
    },
  };
}

export function nexeoAiProviderSource(opts: NexeoLlmOptions): AiProviderSource {
  return { forTenant: async (tenant) => nexeoLlmProvider(tenantOf(tenant), opts) };
}

// ── Store: secrets and reads ──────────────────────────────────────────────

/** The secret half of the framework's IntegrationStore, over secretStore. */
export const nexeoSecrets: Pick<IntegrationStore, 'getSecret' | 'setSecret'> = {
  getSecret: async (tenant, id) => storeGetSecret(tenantOf(tenant), String(id)),
  async setSecret(tenant, id, secret) {
    // secretStore refuses without the server key and keeps Nexeo's rules.
    await storeSetSecret(tenantOf(tenant), String(id), secret);
  },
};

/** IntegrationStore.get: the row as the framework sees it, tenant-bound. */
export async function getIntegrationRecord(tenant: TenantId, id: IntegrationRecord['id']): Promise<IntegrationRecord | null> {
  const cn = tenantOf(tenant);
  const row = await prisma.integrationSync.findFirst({
    where: { id: String(id), clientNumber: cn },
    select: {
      id: true, clientNumber: true, name: true, adminBrief: true, purpose: true, sourceKind: true,
      apiConfig: true, secretSetAt: true, status: true, frequency: true, changeCapPct: true,
    },
  });
  if (!row) return null;
  const api = (row.apiConfig ?? null) as Record<string, unknown> | null;
  const auth = api && typeof api.auth === 'object' && api.auth ? (api.auth as Record<string, unknown>) : null;
  const scheme = typeof auth?.scheme === 'string' ? auth.scheme.toUpperCase() : 'NONE';
  return {
    id: row.id,
    tenantId: row.clientNumber,
    name: row.name,
    brief: row.adminBrief ?? row.purpose ?? null,
    target: 'kpi',
    sourceMode: row.sourceKind === 'api' ? 'api' : 'file',
    baseUrl: api && typeof api.baseUrl === 'string' ? api.baseUrl : null,
    authType: (['NONE', 'BEARER', 'BASIC', 'API_KEY', 'OAUTH2'].includes(scheme) ? scheme : 'NONE') as IntegrationRecord['authType'],
    authExtra: null, // Nexeo never hands the framework connection details it would act on.
    fieldRemarks: {},
    status: (['DRAFT', 'ACTIVE', 'PAUSED'].includes(row.status) ? row.status : 'DRAFT') as IntegrationRecord['status'],
    frequency: (['daily', 'weekly', 'monthly', 'once'].includes(row.frequency) ? row.frequency : 'weekly') as IntegrationRecord['frequency'],
    changeCapPct: row.changeCapPct,
  };
}
