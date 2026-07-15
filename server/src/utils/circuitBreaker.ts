import CircuitBreaker from 'opossum';
import { getRedis } from './redisClient';
import { REDIS_KEY_PATTERNS, REDIS_TTL } from '../config/redis';

export interface BreakerOptions {
  name: string;
  /** timeout (ms) for each call */
  timeout?: number;
  /** failure rate % that trips the breaker */
  errorThresholdPercentage?: number;
  /** volume threshold before stats count */
  volumeThreshold?: number;
  /** how long the breaker stays OPEN (ms) */
  resetTimeout?: number;
}

const DEFAULTS: Required<Omit<BreakerOptions, 'name'>> = {
  timeout: 15_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 30_000,
};

const breakers = new Map<string, CircuitBreaker<any[], any>>();

export function wrap<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  opts: BreakerOptions,
): (...args: TArgs) => Promise<TResult> {
  const key = opts.name;
  const cached = breakers.get(key);
  if (cached) return (...args: TArgs) => cached.fire(...args) as Promise<TResult>;

  const breaker = new CircuitBreaker<TArgs, TResult>(fn, {
    timeout: opts.timeout ?? DEFAULTS.timeout,
    errorThresholdPercentage: opts.errorThresholdPercentage ?? DEFAULTS.errorThresholdPercentage,
    volumeThreshold: opts.volumeThreshold ?? DEFAULTS.volumeThreshold,
    resetTimeout: opts.resetTimeout ?? DEFAULTS.resetTimeout,
    name: opts.name,
  });

  breaker.on('open', () => recordState(opts.name, 'OPEN').catch(() => {}));
  breaker.on('halfOpen', () => recordState(opts.name, 'HALF_OPEN').catch(() => {}));
  breaker.on('close', () => recordState(opts.name, 'CLOSED').catch(() => {}));
  breaker.on('timeout', () => console.warn(`[circuit:${opts.name}] timeout`));
  breaker.on('reject', () => console.warn(`[circuit:${opts.name}] call rejected (breaker open)`));

  breakers.set(key, breaker);
  return (...args: TArgs) => breaker.fire(...args) as Promise<TResult>;
}

async function recordState(name: string, state: 'OPEN' | 'HALF_OPEN' | 'CLOSED'): Promise<void> {
  try {
    const key = REDIS_KEY_PATTERNS.circuitBreaker('system', name);
    const ttl = state === 'OPEN' ? REDIS_TTL.circuitBreakerOpenMinutes * 60 : 3600;
    await getRedis().set(key, JSON.stringify({ state, ts: Date.now() }), 'EX', ttl);
  } catch {
    /* ignore — Redis optional */
  }
  console.log(`[circuit:${name}] state=${state}`);
}

export function getAllBreakerStatus(): Array<{ name: string; state: string }> {
  return Array.from(breakers.entries()).map(([name, b]) => ({
    name,
    state: b.opened ? 'OPEN' : b.halfOpen ? 'HALF_OPEN' : 'CLOSED',
  }));
}
