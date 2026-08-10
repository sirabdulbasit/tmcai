import { GoogleGenAI } from '@google/genai';

let client: GoogleGenAI | null = null;
let clientKey = '';

/**
 * The shared client.
 *
 * Synchronous, because 17 call sites depend on it being so — intent, voice,
 * memory, images, agents. It cannot read the provider config itself (that read
 * is async), so `primeConfiguredGenAI()` is called once at boot to build the
 * configured client BEFORE any of them run. After that, every one of those call
 * sites gets the configured backend without changing a line.
 *
 * Relying on the main reasoning path happening to run first would have worked
 * by accident and broken the moment call order changed. Priming makes it a
 * property of startup instead of a coincidence.
 */
export function getGenAI(): GoogleGenAI {
  if (!client) {
    const useVertex = process.env.USE_VERTEX_AI === 'true';
    if (useVertex) {
      client = new GoogleGenAI({
        vertexai: true,
        project: process.env.GCP_PROJECT_ID || 'tmcai-491811',
        location: process.env.GCP_LOCATION || 'us-central1',
      });
    } else {
      client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
    }
  }
  return client;
}

/**
 * The client the SAVED configuration asks for, rather than the one an
 * environment variable happens to name.
 *
 * Owner, 2026-08-10: he wants to switch provider from the UI — pick Vertex,
 * paste a service account, press Verify — the way the VM portal already does.
 * `getGenAI()` above only ever read USE_VERTEX_AI, so switching backend meant
 * editing .env and redeploying.
 *
 * Cached on the settings that define it, so a Save swaps the client on the next
 * call without a restart, and an unchanged config does not rebuild it per turn.
 *
 * Falls back to `getGenAI()` on any failure. A misconfigured provider panel must
 * degrade to the previous behaviour, never to a Brain that cannot think.
 */
export async function getConfiguredGenAI(): Promise<GoogleGenAI> {
  try {
    const { getAiProviderConfig } = await import('./aiProviderConfig');
    const cfg = await getAiProviderConfig();
    if (cfg.provider !== 'vertex') return getGenAI();

    const project = (cfg.serviceAccount?.project_id as string)
      || process.env.GCP_PROJECT_ID || 'tmcai-491811';
    const key = `vertex|${project}|${cfg.region}|${cfg.serviceAccount ? 'sa' : 'adc'}`;
    if (client && clientKey === key) return client;

    client = new GoogleGenAI({
      vertexai: true,
      project,
      location: cfg.region,
      // With no stored service account we fall through to Application Default
      // Credentials, which is how this box is already set up
      // (GOOGLE_APPLICATION_CREDENTIALS). Both are legitimate; neither is
      // preferred in code.
      ...(cfg.serviceAccount ? { googleAuthOptions: { credentials: cfg.serviceAccount as any } } : {}),
    } as any);
    clientKey = key;
    return client;
  } catch {
    return getGenAI();
  }
}

/**
 * Build the configured client at boot, so the synchronous `getGenAI()` hands
 * out the right backend from the first call.
 *
 * Never throws: a provider that cannot be built must not stop the server from
 * starting. The fallback is the old env-var client, which is exactly the
 * behaviour that existed before any of this.
 */
export async function primeConfiguredGenAI(): Promise<string> {
  try {
    await getConfiguredGenAI();
    const { getAiProviderConfig } = await import('./aiProviderConfig');
    const cfg = await getAiProviderConfig();
    return cfg.provider === 'vertex'
      ? `vertex · ${cfg.model} · ${cfg.region}`
      : `${cfg.provider} · ${cfg.model}`;
  } catch (err) {
    return `fallback (${err instanceof Error ? err.message : 'unknown'})`;
  }
}

export function resetClient(): void {
  client = null;
  clientKey = '';
}
