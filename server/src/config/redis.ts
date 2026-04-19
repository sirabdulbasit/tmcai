export const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
};

export const REDIS_KEY_PATTERNS = {
  killSwitch: (tenantId: string) => `kill_switch:${tenantId}`,
  idempotency: (tenantId: string, hash: string) => `idempotency:${tenantId}:${hash}`,
  circuitBreaker: (tenantId: string, service: string) => `circuit:${tenantId}:${service}`,
  rateLimit: (tenantId: string, endpoint: string) => `ratelimit:${tenantId}:${endpoint}`,
  cache: (tenantId: string, namespace: string, key: string) => `cache:${tenantId}:${namespace}:${key}`,
  feedPubGate: (tenantId: string, contentHash: string) => `feedpub:${tenantId}:${contentHash}`,
  feedPubRetry: (tenantId: string, feedEventId: string) => `feedpub:retry:${tenantId}:${feedEventId}`,
} as const;

export const REDIS_TTL = {
  idempotencyHours: 24,
  circuitBreakerOpenMinutes: 30,
  cacheDefaultMinutes: 15,
} as const;
