import cron from 'node-cron';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('scheduler');
import { sendEmail } from './emailService';
import { getCachedSections, getDataLastUpdated } from './indexCacheService';
import { searchIndex } from './searchService';
import { buildSystemPrompt } from './promptService';
import { streamGemini } from './geminiService';
import { getUserProfile } from './userProfileService';

/**
 * SchedulerService — runs AI prompts on cron schedules and emails results.
 *
 * Each ScheduledTask has:
 * - A prompt (what to ask the AI)
 * - A cron expression (when to run)
 * - Notification emails (who to send the result to)
 *
 * Use cases:
 * - "Every Monday 9am, send me a project risk summary"
 * - "Daily at 8am, email the sales pipeline status to my manager"
 * - "Weekly, analyze overdue projects and notify the delivery team"
 */

const activeJobs = new Map<number, ReturnType<typeof cron.schedule>>();

/**
 * Execute a scheduled task: run the AI prompt and email the result.
 */
async function executeTask(taskId: number): Promise<void> {
  const task = await prisma.scheduledTask.findUnique({
    where: { id: taskId },
    include: { user: true },
  });

  if (!task || !task.isActive) return;

  log.info('Running task', { taskId: task.id, title: task.title });

  try {
    // Build context from current data
    const sections = getCachedSections();
    const context = searchIndex(task.prompt, sections);

    // Get user profile for personalized response
    const profile = await getUserProfile(task.userId);
    let profileBlock = '';
    if (profile?.jobDescription) profileBlock += `User role: ${profile.jobDescription}. `;
    if (profile?.instructions) profileBlock += `Instructions: ${profile.instructions}. `;

    const systemPrompt = profileBlock + buildSystemPrompt(context, getDataLastUpdated());

    // Generate response (non-streaming, collect full text)
    let result = '';
    await streamGemini(systemPrompt, task.prompt, (chunk) => { result += chunk; }, true);

    // Update task status
    await prisma.scheduledTask.update({
      where: { id: taskId },
      data: {
        lastRunAt: new Date(),
        lastResult: result.slice(0, 10000),
        lastError: null,
        nextRunAt: getNextRun(task.cronExpression),
      },
    });

    // Send email notifications
    const recipients: string[] = [];
    if (task.notifySelf && task.user.email) recipients.push(task.user.email);
    if (task.notifyEmail) {
      task.notifyEmail.split(',').map(e => e.trim()).filter(Boolean).forEach(e => recipients.push(e));
    }

    if (recipients.length > 0) {
      const subject = `TMC AI Report: ${task.title}`;
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto;">
          <h2 style="color: #cc6b4a;">${task.title}</h2>
          <p style="color: #666; font-size: 12px;">Scheduled report from TMC AI Intelligence · ${new Date().toLocaleString()}</p>
          <hr style="border: 1px solid #eee;">
          <div style="white-space: pre-wrap; line-height: 1.6;">${result.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
          <hr style="border: 1px solid #eee;">
          <p style="color: #999; font-size: 11px;">This is an automated report. Manage your schedules at TMC AI.</p>
        </div>
      `;

      for (const email of recipients) {
        await sendEmail(email, subject, html);
      }
    }

    log.info('Task completed', { taskId: task.id, emailsSent: recipients.length });
  } catch (err: any) {
    log.error('Task failed', { taskId: task.id, error: err.message });
    await prisma.scheduledTask.update({
      where: { id: taskId },
      data: { lastRunAt: new Date(), lastError: err.message },
    });
  }
}

/**
 * Schedule a task using node-cron.
 */
function scheduleTask(task: { id: number; cronExpression: string; isActive: boolean }): void {
  // Stop existing job if re-scheduling
  const existing = activeJobs.get(task.id);
  if (existing) { existing.stop(); activeJobs.delete(task.id); }

  if (!task.isActive) return;

  if (!cron.validate(task.cronExpression)) {
    log.error('Invalid cron expression', { cronExpression: task.cronExpression, taskId: task.id });
    return;
  }

  const job = cron.schedule(task.cronExpression, () => executeTask(task.id), { timezone: 'Asia/Karachi' });
  activeJobs.set(task.id, job);
  log.info('Scheduled task', { taskId: task.id, cronExpression: task.cronExpression });
}

/**
 * Load and schedule all active tasks from DB. Call on server startup.
 */
export async function initScheduler(): Promise<void> {
  const tasks = await prisma.scheduledTask.findMany({ where: { isActive: true } });
  for (const task of tasks) {
    scheduleTask(task);
  }
  log.info('Initialized', { activeTasks: tasks.length });

  // ── MyOS Phase 2/3 background jobs ────────────────────────

  // Idempotency key cleanup — daily 3am PKT
  cron.schedule('0 3 * * *', async () => {
    try {
      const { cleanupExpiredKeys } = await import('./actionIdempotencyService');
      const deleted = await cleanupExpiredKeys();
      if (deleted > 0) log.info('Idempotency cleanup', { deleted });
    } catch (err: any) { log.error('Idempotency cleanup failed', { error: err.message }); }
  }, { timezone: 'Asia/Karachi' });

  // Decision outcome assessment — daily 2am PKT
  cron.schedule('0 2 * * *', async () => {
    try {
      const { assessOutcomesForAllTenants } = await import('./decisionsLogService');
      await assessOutcomesForAllTenants();
      log.info('Decision outcome assessment completed');
    } catch (err: any) { log.error('Outcome assessment failed', { error: err.message }); }
  }, { timezone: 'Asia/Karachi' });

  // Pattern analysis — weekly Sunday 6am PKT
  cron.schedule('0 6 * * 0', async () => {
    try {
      const { runForAllTenants } = await import('./patternAnalysisService');
      await runForAllTenants();
      log.info('Pattern analysis completed');
    } catch (err: any) { log.error('Pattern analysis failed', { error: err.message }); }
  }, { timezone: 'Asia/Karachi' });

  // Thought pipeline weekly review — Friday 7am PKT
  cron.schedule('0 7 * * 5', async () => {
    try {
      const { generateWeeklyReviewsForAllTenants } = await import('./thoughtPipelineService');
      await generateWeeklyReviewsForAllTenants();
      log.info('Weekly reviews generated');
    } catch (err: any) { log.error('Weekly review generation failed', { error: err.message }); }
  }, { timezone: 'Asia/Karachi' });

  // Shadow scoring calibration — first Monday of each month, 7am PKT
  cron.schedule('0 7 1-7 * 1', async () => {
    try {
      const { runForAllTenants } = await import('./shadowScoringService');
      await runForAllTenants();
      log.info('Shadow scoring calibration completed');
    } catch (err: any) { log.error('Shadow scoring failed', { error: err.message }); }
  }, { timezone: 'Asia/Karachi' });

  // ── Per-user Brain Engine crons ─────────────────────────────
  await registerAllEngineCrons();
}

// ─── Dynamic per-user engine cron management ──────────────────

const activeEngineCrons = new Map<string, ReturnType<typeof cron.schedule>>();

async function registerAllEngineCrons(): Promise<void> {
  try {
    const configs = await prisma.$queryRawUnsafe(
      `SELECT user_id, client_number, engine_schedule, engine_timezone FROM brain_configs WHERE engine_schedule IS NOT NULL AND engine_running = false`
    ) as any[];

    for (const cfg of configs) {
      registerUserEngineCron(cfg.user_id, cfg.client_number, cfg.engine_schedule, cfg.engine_timezone || 'Asia/Karachi');
    }
    log.info('Engine crons registered', { count: configs.length });
  } catch (err: any) {
    log.error('Failed to register engine crons', { error: err.message });
  }
}

export function registerUserEngineCron(userId: number, clientNumber: string, schedule: string, timezone: string): void {
  const key = `engine:${clientNumber}:${userId}`;

  // Stop existing cron if any
  if (activeEngineCrons.has(key)) {
    activeEngineCrons.get(key)!.stop();
    activeEngineCrons.delete(key);
  }

  if (!schedule || !cron.validate(schedule)) return;

  const job = cron.schedule(schedule, async () => {
    try {
      const { runForUser } = await import('./brainEngineService');
      log.info('Engine cron triggered', { userId, clientNumber });
      await runForUser(userId, clientNumber);
    } catch (err: any) {
      log.error('Engine cron failed', { userId, error: err.message });
    }
  }, { timezone });

  activeEngineCrons.set(key, job);
  log.info('Engine cron registered', { userId, schedule, timezone });
}

export function stopUserEngineCron(userId: number, clientNumber: string): void {
  const key = `engine:${clientNumber}:${userId}`;
  if (activeEngineCrons.has(key)) {
    activeEngineCrons.get(key)!.stop();
    activeEngineCrons.delete(key);
  }
}

/**
 * Create a new scheduled task.
 */
export async function createScheduledTask(data: {
  clientNumber: string;
  userId: number;
  title: string;
  prompt: string;
  cronExpression: string;
  provider?: string;
  notifyEmail?: string;
  notifySelf?: boolean;
}) {
  if (!cron.validate(data.cronExpression)) {
    throw new Error(`Invalid cron expression: "${data.cronExpression}"`);
  }

  const task = await prisma.scheduledTask.create({
    data: {
      clientNumber: data.clientNumber,
      userId: data.userId,
      title: data.title,
      prompt: data.prompt,
      cronExpression: data.cronExpression,
      provider: data.provider || 'gemini-flash',
      notifyEmail: data.notifyEmail || null,
      notifySelf: data.notifySelf ?? true,
      nextRunAt: getNextRun(data.cronExpression),
    },
  });

  scheduleTask(task);
  return task;
}

/**
 * Update an existing scheduled task.
 */
export async function updateScheduledTask(taskId: number, userId: number, data: Partial<{
  title: string;
  prompt: string;
  cronExpression: string;
  provider: string;
  notifyEmail: string;
  notifySelf: boolean;
  isActive: boolean;
}>) {
  if (data.cronExpression && !cron.validate(data.cronExpression)) {
    throw new Error(`Invalid cron expression: "${data.cronExpression}"`);
  }

  const task = await prisma.scheduledTask.updateMany({
    where: { id: taskId, userId },
    data: {
      ...data,
      nextRunAt: data.cronExpression ? getNextRun(data.cronExpression) : undefined,
      updatedAt: new Date(),
    },
  });

  // Re-schedule
  const updated = await prisma.scheduledTask.findUnique({ where: { id: taskId } });
  if (updated) scheduleTask(updated);

  return task;
}

/**
 * Delete a scheduled task.
 */
export async function deleteScheduledTask(taskId: number, userId: number): Promise<void> {
  const existing = activeJobs.get(taskId);
  if (existing) { existing.stop(); activeJobs.delete(taskId); }
  await prisma.scheduledTask.deleteMany({ where: { id: taskId, userId } });
}

/**
 * List tasks for a user.
 */
export async function getUserTasks(userId: number) {
  return prisma.scheduledTask.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Run a task immediately (on demand).
 */
export async function runTaskNow(taskId: number, userId: number): Promise<void> {
  const task = await prisma.scheduledTask.findFirst({ where: { id: taskId, userId } });
  if (!task) throw new Error('Task not found');
  await executeTask(taskId);
}

function getNextRun(cronExpr: string): Date {
  // Simple approximation — node-cron doesn't expose next run time
  // Return now + estimated interval
  return new Date(Date.now() + 3600000); // placeholder: 1 hour from now
}
