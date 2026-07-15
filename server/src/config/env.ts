// Validates required environment variables on startup.
//
// Policy:
//   - Security-critical vars: FAIL FAST in production, warn in dev.
//   - Feature-critical vars (Google Drive): warn in both — the service can
//     run without Drive, just with that feature disabled.
//   - AI provider keys: warn if none present (at-least-one rule).

// PLATFORM_API_TOKEN removed 2026-07-08 (E1): agent auth now uses
// tenant-bound tokens in agent_api_tokens (see agentAuthMiddleware.ts);
// the env token no longer grants anything, so boot must not require it.
const SECURITY_CRITICAL = [
  'DATABASE_URL',
  'ENCRYPTION_KEY',
] as const;

const FEATURE_REQUIRED = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_DRIVE_FOLDER_ID',
  'GOOGLE_INDEX_FILE_NAME',
];

/**
 * Throws in production when any security-critical env var is missing or too
 * short. In development we only warn, so local setup is ergonomic. Agent
 * bearer tokens are validated against `agent_api_tokens` in the DB
 * (see `agentAuthMiddleware.ts`), not against env.
 */
export function validateEnv(): void {
  const isProd = process.env.NODE_ENV === 'production';

  const securityMissing: string[] = [];
  for (const key of SECURITY_CRITICAL) {
    const val = process.env[key];
    if (!val) {
      securityMissing.push(`${key} (unset)`);
      continue;
    }
    // Minimum length: 32 chars for tokens/keys, any for DATABASE_URL.
    if (key !== 'DATABASE_URL' && val.length < 32) {
      securityMissing.push(`${key} (too short — need 32+ chars)`);
    }
  }
  if (securityMissing.length > 0) {
    const msg = `Security-critical env vars invalid: ${securityMissing.join(', ')}`;
    if (isProd) {
      // Fail fast. Better to refuse to boot than to silently accept weak config.
      throw new Error(msg);
    }
    console.warn(`⚠ [env] ${msg}`);
    console.warn('  (this would be fatal in NODE_ENV=production)');
  }

  const featureMissing = FEATURE_REQUIRED.filter(key => !process.env[key]);
  if (featureMissing.length > 0) {
    console.warn(`⚠ [env] Feature-required vars missing: ${featureMissing.join(', ')}`);
    console.warn('  Google Drive integration will be disabled until these are set.');
  }

  const availableProviders: string[] = [];
  if (process.env.GEMINI_API_KEY) availableProviders.push('Gemini Flash');
  if (process.env.GROQ_API_KEY) availableProviders.push('Groq');
  if (process.env.ANTHROPIC_API_KEY) availableProviders.push('Claude');
  if (process.env.OPENAI_API_KEY) availableProviders.push('GPT-4o');
  if (process.env.OPENROUTER_API_KEY) availableProviders.push('OpenRouter');

  if (availableProviders.length === 0) {
    console.warn('⚠ No AI API keys configured. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY');
  } else {
    console.log(`✓ AI providers available: ${availableProviders.join(', ')}`);
  }
}

export const env = {
  get port() { return parseInt(process.env.PORT || '4002', 10); },
  get clientUrl() { return process.env.CLIENT_URL || 'http://localhost:5174'; },
  get baseUrl() { return process.env.BASE_URL || 'https://tai.tmcltd.com'; },
  get nodeEnv() { return process.env.NODE_ENV || 'development'; },

  get googleClientId() { return process.env.GOOGLE_CLIENT_ID || ''; },
  get googleClientSecret() { return process.env.GOOGLE_CLIENT_SECRET || ''; },
  get googleRedirectUri() { return process.env.GOOGLE_REDIRECT_URI || 'http://localhost:4002/api/auth/google/callback'; },
  get googleDriveFolderId() { return process.env.GOOGLE_DRIVE_FOLDER_ID || ''; },
  get googleIndexFileName() { return process.env.GOOGLE_INDEX_FILE_NAME || 'TMC_Drive_Index.md'; },

  get anthropicApiKey() { return process.env.ANTHROPIC_API_KEY || ''; },
  get openaiApiKey() { return process.env.OPENAI_API_KEY || ''; },
  get openrouterApiKey() { return process.env.OPENROUTER_API_KEY || ''; },
  get geminiApiKey() { return process.env.GEMINI_API_KEY || ''; },
  // Separate keys per function — falls back to main GEMINI_API_KEY if not set
  get geminiEmbedKey() { return process.env.GEMINI_API_KEY_EMBED || process.env.GEMINI_API_KEY || ''; },
  get geminiPipelineKey() { return process.env.GEMINI_API_KEY_PIPELINE || process.env.GEMINI_API_KEY || ''; },
  get groqApiKey() { return process.env.GROQ_API_KEY || ''; },

  get indexRefreshIntervalMs() { return parseInt(process.env.INDEX_REFRESH_INTERVAL_MS || '300000', 10); },
  get maxContextChars() { return parseInt(process.env.MAX_CONTEXT_CHARS || '50000', 10); },
  get maxTokens() { return parseInt(process.env.MAX_TOKENS || '4096', 10); },
  get requestTimeoutMs() { return parseInt(process.env.REQUEST_TIMEOUT_MS || '120000', 10); },

  // RAG settings
  get ragEnabled() { return process.env.RAG_ENABLED !== 'false'; },
  get ragTopK() { return parseInt(process.env.RAG_TOP_K || '10', 10); },
  get ragMinScore() { return parseFloat(process.env.RAG_MIN_SCORE || '0.3'); },

  // PII settings
  get piiEnabled() { return process.env.PII_ENABLED !== 'false'; },
};
