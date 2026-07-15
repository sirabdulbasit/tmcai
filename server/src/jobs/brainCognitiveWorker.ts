/**
 * brainCognitiveWorker — schedules the continuous thinking loop.
 *
 * Every 30 minutes, for every active user with at least one connected
 * source connector, runs `runCognitiveTick` which produces observations
 * and a mind_state. Bounded by per-user rate so nothing spikes the LLM
 * bill even if the tenant has many users.
 *
 * First tick fires 90s after server boot (gives ingest time to warm
 * up), then every 30 min.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { runCognitiveTick } from '../services/knowledge/brainCognitiveEngine';

const log = createLogger('brain-cognitive-worker');

const FIRST_TICK_MS = 90_000;
const INTERVAL_MS = 30 * 60_000;
const PER_TICK_USER_CAP = 30;  // max users to process per tick (round-robin)

async function selectUsers(): Promise<Array<{ id: number; clientNumber: string }>> {
  // Active users with at least one connected connector — otherwise the
  // engine has nothing to think about.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT u.id, u.client_number AS "clientNumber"
       FROM users u
       JOIN user_connectors uc ON uc.user_id = u.id AND uc.status = 'connected'
      WHERE u.is_active = true
      LIMIT $1`,
    PER_TICK_USER_CAP,
  ).catch(() => []);
  return rows as any;
}

export async function runCognitiveCycle(): Promise<{ users: number; observations: number; durationMs: number }> {
  const t0 = Date.now();
  const users = await selectUsers();
  let observations = 0;
  for (const u of users) {
    try {
      const r = await runCognitiveTick(u.clientNumber, u.id);
      observations += r.observationsFiled;
    } catch (err: any) {
      log.warn('user tick failed', { userId: u.id, error: err.message });
    }
  }
  const durationMs = Date.now() - t0;
  if (users.length > 0) {
    log.info('cognitive cycle complete', { users: users.length, observations, durationMs });
  }
  return { users: users.length, observations, durationMs };
}

export function startBrainCognitiveWorker(): void {
  setTimeout(() => {
    runCognitiveCycle().catch((e) => log.warn('first cycle failed', { error: e.message }));
    setInterval(() => {
      runCognitiveCycle().catch((e) => log.warn('cycle failed', { error: e.message }));
    }, INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('brain cognitive worker scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
