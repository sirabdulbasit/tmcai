import Redis from 'ioredis';
import { REDIS_CONFIG } from '../config/redis';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(REDIS_CONFIG);
  client.on('error', (err) => {
    console.error('[Redis] connection error:', err.message);
  });
  client.on('connect', () => {
    console.log(`[Redis] connected to ${REDIS_CONFIG.host}:${REDIS_CONFIG.port}`);
  });
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}

export async function ping(): Promise<boolean> {
  try {
    const r = getRedis();
    const reply = await r.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}

export async function setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  const result = await r.set(key, value, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

export async function get(key: string): Promise<string | null> {
  return getRedis().get(key);
}

export async function del(key: string): Promise<number> {
  return getRedis().del(key);
}

export async function exists(key: string): Promise<boolean> {
  const result = await getRedis().exists(key);
  return result === 1;
}
