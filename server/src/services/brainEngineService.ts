/**
 * MyOS Brain Engine Service (v2 spec)
 *
 * The single orchestrator that runs the entire intelligence pipeline for a user.
 * Completely decoupled from the Day Brief — engine stores everything in DB,
 * brief reads pre-computed results only.
 *
 * 9 Steps:
 *   1. Lock engine (prevent concurrent runs)
 *   2. Ingest all connected feeds
 *   3. Score all open items
 *   4. ERG propagation (fire-and-forget from step 3)
 *   5. CEO Intent Summaries for stale items
 *   6. Action suggestions for top items (Sprint 3 — stub)
 *   7. Situation synthesis (Sprint 3 — stub)
 *   8. Update engine metadata
 *   9. Auto-push brief if configured
 */

import prisma from '../db/prisma';
import * as priorityScoreService from './priorityScoreService';
import createLogger from '../utils/logger';

const log = createLogger('brainEngine');

// ─── Main entry point ───────────────────────────────────────────

export async function runForUser(userId: number, clientNumber: string): Promise<{
  success: boolean;
  error?: string;
  duration?: number;
  itemsScored?: number;
}> {
  const startTime = Date.now();

  // Step 1: Lock engine — prevent concurrent runs
  const config = await prisma.brainConfig.findUnique({ where: { userId } }) as any;
  if (!config) {
    return { success: false, error: 'No BrainConfig found. Configure your brain first.' };
  }
  if (config.engineRunning) {
    return { success: false, error: 'Engine is already running. Please wait.' };
  }

  try {
    await prisma.brainConfig.update({
      where: { userId },
      data: { engineRunning: true } as any,
    });
    log.info('Engine started', { userId, clientNumber });

    // Step 2: Ingest all connected feeds
    // feedIntelligenceService classifies incoming items and creates/updates OpenItems
    let ingestedCount = 0;
    try {
      const feedIntelligence = await import('./feedIntelligenceService');
      // Get connected Gmail and classify unread emails
      const connectedConnectors = await prisma.userConnector.findMany({
        where: { userId, clientNumber, status: 'connected' },
        include: { connectorType: true },
      });

      for (const uc of connectedConnectors) {
        try {
          if (uc.connectorType.slug === 'gmail') {
            await ingestGmail(userId, clientNumber, feedIntelligence);
            ingestedCount++;
          }
          // Future: add ingestCalendar, ingestTasks, ingestWhatsApp, etc.
        } catch (err: any) {
          log.error('Feed ingestion failed', { connector: uc.connectorType.slug, error: err.message });
        }
      }
      log.info('Feed ingestion complete', { userId, connectorsProcessed: ingestedCount });
    } catch (err: any) {
      log.error('Feed ingestion phase failed', { userId, error: err.message });
    }

    // Step 3: Score all open items
    let itemsScored = 0;
    try {
      const openItems = await prisma.openItem.findMany({
        where: { userId, clientNumber, status: { in: ['open', 'in_progress', 'delegated', 'blocked'] } },
        select: { id: true },
      });
      // Score in batches to avoid overwhelming the DB
      for (const item of openItems) {
        try {
          await priorityScoreService.scoreOpenItem(item.id, clientNumber, userId);
          itemsScored++;
        } catch (err: any) {
          log.error('Item scoring failed', { itemId: item.id, error: err.message });
        }
      }
      log.info('Scoring complete', { userId, itemsScored });
    } catch (err: any) {
      log.error('Scoring phase failed', { userId, error: err.message });
    }

    // Step 4: ERG propagation — already wired into scoreOpenItem() (fire-and-forget)
    // No additional code needed here — propagation triggers automatically when score >= 6

    // Step 5: CEO Intent Summaries for stale items
    // Already wired into scoreOpenItem() (fire-and-forget when autoDelegate=true)
    // No additional code needed here

    // Step 6: Action suggestions for top items (Sprint 3)
    try {
      const { runForTopItems } = await import('./actionSuggestionService');
      const suggestionsGenerated = await runForTopItems(userId, clientNumber);
      log.info('Action suggestions generated', { userId, count: suggestionsGenerated });
    } catch (err: any) {
      log.error('Action suggestion phase failed', { userId, error: err.message });
    }

    // Step 7: Situation synthesis (Sprint 3)
    try {
      const { synthesiseAll } = await import('./situationService');
      const situationCount = await synthesiseAll(userId, clientNumber);
      log.info('Situations synthesized', { userId, count: situationCount });
    } catch (err: any) {
      log.error('Situation synthesis failed', { userId, error: err.message });
    }

    // Step 8: Update engine metadata
    const engineSchedule = config.engineSchedule;
    let nextRun: Date | null = null;
    if (engineSchedule) {
      try {
        nextRun = computeNextRun(engineSchedule, config.engineTimezone || 'Asia/Karachi');
      } catch {}
    }

    await prisma.brainConfig.update({
      where: { userId },
      data: {
        lastEngineRun: new Date(),
        nextEngineRun: nextRun,
        engineRunning: false,
      } as any,
    });

    const duration = Date.now() - startTime;
    log.info('Engine completed', { userId, duration: `${duration}ms`, itemsScored });

    // Step 9: Auto-push brief if configured
    if (config.briefDeliveryTime) {
      const now = new Date();
      const [hh, mm] = config.briefDeliveryTime.split(':').map(Number);
      const currentHH = now.getHours();
      const currentMM = now.getMinutes();
      // Push if within 30 minutes of configured delivery time
      if (Math.abs(currentHH * 60 + currentMM - (hh * 60 + mm)) <= 30) {
        log.info('Auto-pushing brief', { userId, deliveryTime: config.briefDeliveryTime });
        // Brief will be built on next user request or via WebSocket push (future)
      }
    }

    return { success: true, duration, itemsScored };

  } catch (err: any) {
    // Ensure lock is always released
    await prisma.brainConfig.update({
      where: { userId },
      data: { engineRunning: false } as any,
    }).catch(() => {});

    log.error('Engine failed', { userId, error: err.message });
    return { success: false, error: err.message };
  }
}

// ─── Gmail ingestion ────────────────────────────────────────────

async function ingestGmail(
  userId: number,
  clientNumber: string,
  feedIntelligence: typeof import('./feedIntelligenceService'),
): Promise<void> {
  try {
    const { getAuthenticatedClient } = await import('./integrationService');
    const { client, error } = await getAuthenticatedClient(userId);
    if (!client || error) return;

    const { google } = await import('googleapis');
    const gmail = google.gmail({ version: 'v1', auth: client });

    // Get last 24h of emails
    const today = new Date();
    const todayStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    const list = await gmail.users.messages.list({ userId: 'me', q: `after:${todayStr}`, maxResults: 30 });
    const messages = list.data.messages || [];

    for (const msg of messages.slice(0, 20)) {
      try {
        const full = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
        const headers = full.data.payload?.headers || [];
        const from = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const emailMatch = from.match(/<([^>]+)>/);
        const senderEmail = emailMatch ? emailMatch[1] : from.split(' ').pop() || '';
        const senderName = from.replace(/<.*>/, '').trim();

        await feedIntelligence.classifyFeedItem({
          sourceRef: msg.id!,
          source: 'gmail',
          connectorSlug: 'gmail',
          senderEmail,
          senderName,
          subject,
          body: `From: ${senderName}\nSubject: ${subject}`,
          receivedAt: new Date(Number(full.data.internalDate) || Date.now()),
          clientNumber,
          userId,
        });
      } catch {}
    }
  } catch (err: any) {
    log.error('Gmail ingestion error', { userId, error: err.message });
  }
}

// ─── Compute next cron run ──────────────────────────────────────

function computeNextRun(cronExpr: string, _timezone: string): Date | null {
  // Simple approximation — for accurate next-run, use a cron parser library
  // For now, estimate next run as 24h from now (daily) or 6h (frequent)
  const now = new Date();
  if (cronExpr.includes('*/6')) return new Date(now.getTime() + 6 * 60 * 60 * 1000);
  if (cronExpr.includes('*/12')) return new Date(now.getTime() + 12 * 60 * 60 * 1000);
  return new Date(now.getTime() + 24 * 60 * 60 * 1000); // default: 24h
}

// ─── Engine status check ────────────────────────────────────────

export async function getEngineStatus(userId: number): Promise<{
  running: boolean;
  lastRun: Date | null;
  nextRun: Date | null;
  schedule: string | null;
}> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } }) as any;
  return {
    running: config?.engineRunning ?? false,
    lastRun: config?.lastEngineRun ?? null,
    nextRun: config?.nextEngineRun ?? null,
    schedule: config?.engineSchedule ?? null,
  };
}
