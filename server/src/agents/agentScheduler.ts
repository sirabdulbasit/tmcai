// ═════════════════════════════════════════════════════════════════════════════
// agentScheduler.ts — Runs agents on their configured schedules
//
// Supports: once, hourly, daily, weekly, monthly, custom cron
// Each agent runs independently. Failed agents don't affect others.
// Circuit breaker: 3 consecutive failures → agent auto-paused (fired temporarily)
// ═════════════════════════════════════════════════════════════════════════════

import cron from 'node-cron';
import prisma from '../db/prisma';
import { executeAgentRun } from './agentExecutionEngine';
import { checkCircuitBreaker } from './agentFrameworkService';
import { leaderOnly } from '../utils/leaderLock';
import createLogger from '../utils/logger';

const log = createLogger('agentScheduler');

// Active cron jobs per agent
const activeJobs = new Map<number, any>();

// ─── Initialize all agent schedules on server startup ─────────────────────────

export async function initializeAgentScheduler(): Promise<void> {
  // Clean up zombie runs — any run stuck in 'running' for more than 5 minutes is dead
  const zombies = await prisma.$executeRawUnsafe(
    `UPDATE agent_runs SET status = 'failed', error = 'Server restarted during execution', completed_at = NOW()
     WHERE status = 'running' AND started_at < NOW() - INTERVAL '5 minutes'`,
  );
  log.info('Cleaned up zombie runs', { affected: zombies });

  const agents = await prisma.$queryRawUnsafe(
    `SELECT id, name, schedule, client_number FROM agents WHERE is_active = TRUE AND schedule IS NOT NULL`,
  ) as any[];

  log.info(`Initializing ${agents.length} scheduled agents`);

  for (const agent of agents) {
    scheduleAgent(agent.id, agent.name, agent.schedule);
  }
}

// ─── Schedule a single agent ──────────────────────────────────────────────────

export function scheduleAgent(agentId: number, agentName: string, schedule: string): void {
  // Stop existing schedule if any
  unscheduleAgent(agentId);

  if (!schedule) return;

  // Parse schedule — support human-readable AND cron format
  const cronExpr = parseToCron(schedule);
  if (!cronExpr || !cron.validate(cronExpr)) {
    log.warn('Invalid schedule', { agentId, agentName, schedule, cronExpr });
    return;
  }

  // C3 — keyed by agent id so each agent fires on exactly one replica per
  // tick. Different agents run in parallel.
  const job = cron.schedule(cronExpr, () => leaderOnly(`agent:${agentId}`, async () => {
    try {
      // Check if agent is still active
      const agents = await prisma.$queryRawUnsafe(
        `SELECT is_active, error_count, user_id, client_number, notify_email, notify_whatsapp
         FROM agents WHERE id = $1`, agentId,
      ) as any[];

      if (!agents.length || !agents[0].is_active) {
        log.info('Agent no longer active — unscheduling', { agentId, agentName });
        unscheduleAgent(agentId);
        return;
      }

      // Check circuit breaker (3 consecutive errors)
      const { open } = await checkCircuitBreaker(agentId);
      if (open) {
        log.warn('Agent circuit breaker OPEN', { agentId, agentName });
        // Notify boss that agent is paused due to errors
        await notifyAgentError(agents[0], agentName,
          `${agentName} has been auto-paused after 3 consecutive errors. Please check and reset.`);
        return;
      }

      log.info('Agent scheduled run', { agentId, agentName });
      const result = await executeAgentRun(agentId, 'scheduled');

      // If run failed, notify boss
      if (!result.success && result.error) {
        await notifyAgentError(agents[0], agentName,
          `${agentName} encountered an error during scheduled run: ${result.error}`);
      }
    } catch (err: any) {
      // NEVER let the cron job crash — log and continue
      log.error('Agent scheduled run crashed (non-fatal)', { agentId, agentName, error: err.message });
      try {
        const agents = await prisma.$queryRawUnsafe(`SELECT user_id, client_number, notify_email, notify_whatsapp FROM agents WHERE id = $1`, agentId) as any[];
        if (agents.length) {
          await notifyAgentError(agents[0], agentName, `${agentName} crashed during execution: ${err.message}`);
        }
      } catch {}
    }
  }), { timezone: 'Asia/Karachi' });

  activeJobs.set(agentId, job);
  log.info('Agent scheduled as background job', { agentId, agentName, schedule, cronExpr });

  // Update next_run_at
  updateNextRunAt(agentId, cronExpr).catch(() => {});
}

// ─── Unschedule an agent ──────────────────────────────────────────────────────

export function unscheduleAgent(agentId: number): void {
  const job = activeJobs.get(agentId);
  if (job) {
    job.stop();
    activeJobs.delete(agentId);
  }
}

// ─── Parse human-readable schedule to cron ────────────────────────────────────

function parseToCron(schedule: string): string | null {
  const s = schedule.toLowerCase().trim();

  // Already a valid cron expression
  if (cron.validate(s)) return s;

  // Human-readable patterns
  if (s === 'every minute' || s === 'every 1 minute') return '* * * * *';
  if (s === 'every 5 minutes') return '*/5 * * * *';
  if (s === 'every 10 minutes') return '*/10 * * * *';
  if (s === 'every 15 minutes') return '*/15 * * * *';
  if (s === 'every 30 minutes' || s === 'every half hour') return '*/30 * * * *';
  if (s === 'hourly' || s === 'every hour') return '0 * * * *';
  if (s === 'daily' || s === 'every day') return '0 9 * * *'; // 9 AM
  if (s === 'twice daily') return '0 9,17 * * *'; // 9 AM + 5 PM
  if (s === 'weekly' || s === 'every week') return '0 9 * * 1'; // Monday 9 AM
  if (s === 'monthly' || s === 'every month') return '0 9 1 * *'; // 1st of month 9 AM
  if (s === 'every morning' || s === 'morning') return '0 8 * * *'; // 8 AM
  if (s === 'every evening' || s === 'evening') return '0 18 * * *'; // 6 PM

  // "every X minutes/hours"
  const everyMin = s.match(/every (\d+) min/);
  if (everyMin) return `*/${everyMin[1]} * * * *`;
  const everyHour = s.match(/every (\d+) hour/);
  if (everyHour) return `0 */${everyHour[1]} * * *`;

  // "daily at 9am" / "daily at 14:00"
  const dailyAt = s.match(/daily at (\d{1,2}):?(\d{2})?\s*(am|pm)?/i);
  if (dailyAt) {
    let hour = parseInt(dailyAt[1]);
    if (dailyAt[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
    if (dailyAt[3]?.toLowerCase() === 'am' && hour === 12) hour = 0;
    const min = dailyAt[2] ? parseInt(dailyAt[2]) : 0;
    return `${min} ${hour} * * *`;
  }

  // "monday at 9am" / "every monday 9am"
  const dayMap: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  for (const [day, num] of Object.entries(dayMap)) {
    const dayMatch = s.match(new RegExp(`${day}\\s+(?:at\\s+)?(\\d{1,2}):?(\\d{2})?\\s*(am|pm)?`, 'i'));
    if (dayMatch) {
      let hour = parseInt(dayMatch[1]);
      if (dayMatch[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      const min = dayMatch[2] ? parseInt(dayMatch[2]) : 0;
      return `${min} ${hour} * * ${num}`;
    }
  }

  return null; // Unrecognized — let caller handle
}

// ─── Calculate next run time ──────────────────────────────────────────────────

async function updateNextRunAt(agentId: number, cronExpr: string): Promise<void> {
  // Simple approximation — real next run time from cron library
  const now = new Date();
  let nextRun: Date | null = null;

  // Parse cron parts
  const parts = cronExpr.split(' ');
  if (parts.length === 5) {
    const [min, hour] = parts;
    if (hour !== '*' && min !== '*') {
      nextRun = new Date(now);
      nextRun.setHours(parseInt(hour.split('/')[0]) || 0);
      nextRun.setMinutes(parseInt(min.split('/')[0]) || 0);
      nextRun.setSeconds(0);
      if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
    }
  }

  if (nextRun) {
    await prisma.$executeRawUnsafe(
      `UPDATE agents SET next_run_at = $1 WHERE id = $2`, nextRun, agentId,
    );
  }
}

// ─── Hire (activate) an agent ─────────────────────────────────────────────────

export async function hireAgent(agentId: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE agents SET is_active = TRUE, error_count = 0, updated_at = NOW() WHERE id = $1`, agentId,
  );
  const agent = await prisma.$queryRawUnsafe(
    `SELECT id, name, schedule FROM agents WHERE id = $1`, agentId,
  ) as any[];
  if (agent[0]?.schedule) {
    scheduleAgent(agentId, agent[0].name, agent[0].schedule);
  }
  log.info('Agent hired (activated)', { agentId });
}

// ─── Fire (deactivate) an agent ───────────────────────────────────────────────

export async function fireAgent(agentId: number, reason: string, firedBy: number): Promise<void> {
  unscheduleAgent(agentId);
  await prisma.$executeRawUnsafe(
    `UPDATE agents SET is_active = FALSE, last_error = $1, updated_at = NOW() WHERE id = $2`,
    `Fired by user ${firedBy}: ${reason}`, agentId,
  );
  log.info('Agent fired (deactivated)', { agentId, reason, firedBy });
}

// ─── Get all active jobs ──────────────────────────────────────────────────────

export function getActiveAgentCount(): number {
  return activeJobs.size;
}

// ─── Notify boss about agent errors (email + WhatsApp) ────────────────────────

async function notifyAgentError(
  agentRow: { user_id: number; client_number: string; notify_email: boolean; notify_whatsapp: boolean },
  agentName: string,
  errorMessage: string,
): Promise<void> {
  // Email notification
  if (agentRow.notify_email) {
    try {
      const userRows = await prisma.$queryRawUnsafe(`SELECT email FROM users WHERE id = $1`, agentRow.user_id) as any[];
      if (userRows[0]?.email) {
        const { sendEmail } = await import('../services/emailService');
        await sendEmail(
          userRows[0].email,
          `[${agentName}] Error Alert`,
          `<div style="font-family:Arial;padding:20px;max-width:600px;margin:auto;">
            <h2 style="color:#ef4444;">Agent Error: ${agentName}</h2>
            <p style="color:#333;line-height:1.6;">${errorMessage}</p>
            <p style="color:#888;font-size:13px;margin-top:16px;">
              Visit <a href="https://tai.tmcltd.com/agents">My Team</a> to check the agent status and reset if needed.
            </p>
            <hr style="border:1px solid #eee;margin:16px 0;"/>
            <p style="color:#aaa;font-size:11px;">TMC AI Intelligence Platform</p>
          </div>`,
        );
      }
    } catch (e: any) { log.error('Error notification email failed', { error: e.message }); }
  }

  // WhatsApp notification
  if (agentRow.notify_whatsapp) {
    try {
      const { sendWhatsAppMessage } = await import('../services/whatsapp/WhatsAppManager');
      const connections = await prisma.$queryRawUnsafe(
        `SELECT phone_number FROM whatsapp_connections WHERE user_id = $1 AND status = 'active'`, agentRow.user_id,
      ) as any[];
      for (const conn of connections) {
        await sendWhatsAppMessage({
          clientNumber: agentRow.client_number,
          to: conn.phone_number,
          message: `*${agentName}* — Error Alert:\n\n${errorMessage}\n\nCheck tai.tmcltd.com/agents to review.`,
        });
      }
    } catch (e: any) { log.error('Error notification WhatsApp failed', { error: e.message }); }
  }
}
