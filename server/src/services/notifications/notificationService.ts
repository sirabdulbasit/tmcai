import prisma from '../../db/prisma';
import { sendEmail } from '../emailService';
import { sendWhatsAppMessage } from '../adapters/whatsappAdapter';

export type NotificationChannel = 'email' | 'whatsapp' | 'in_app' | 'chat';

export interface EnqueueInput {
  clientNumber: string;
  recipientId: number;
  channel: NotificationChannel;
  payload: Record<string, unknown>;
  scheduledAt?: Date;
}

export async function enqueue(input: EnqueueInput): Promise<number> {
  const row = await prisma.notificationQueue.create({
    data: {
      clientNumber: input.clientNumber,
      recipientId: input.recipientId,
      channel: input.channel,
      payload: input.payload as any,
      scheduledAt: input.scheduledAt ?? new Date(),
    },
  });
  return row.id;
}

interface DrainOptions {
  batchSize?: number;
  maxRetries?: number;
}

export interface DrainResult {
  attempted: number;
  sent: number;
  failed: number;
  deferred: number;
}

/**
 * Pull pending notifications due now (scheduledAt <= now), dispatch each,
 * and update the row. Safe to call on a cron — claims via a status flip so
 * two drainers don't double-send.
 */
export async function drain(opts: DrainOptions = {}): Promise<DrainResult> {
  const batch = opts.batchSize ?? 25;
  const maxRetries = opts.maxRetries ?? 3;
  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let deferred = 0;

  // Claim a batch: flip `pending` → `sending` atomically so no other worker picks them up
  const claimable = await prisma.notificationQueue.findMany({
    where: { status: 'pending', scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: 'asc' },
    take: batch,
  });

  for (const row of claimable) {
    attempted += 1;
    const claim = await prisma.notificationQueue.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'sending' },
    });
    if (claim.count === 0) {
      deferred += 1;
      continue; // another worker got it
    }
    try {
      await dispatch(row);
      await prisma.notificationQueue.update({
        where: { id: row.id },
        data: { status: 'sent', sentAt: new Date() },
      });
      sent += 1;
    } catch (err: any) {
      const nextRetry = row.retryCount + 1;
      if (nextRetry >= maxRetries) {
        await prisma.notificationQueue.update({
          where: { id: row.id },
          data: { status: 'failed', failedAt: new Date(), errorMessage: err.message, retryCount: nextRetry },
        });
        failed += 1;
      } else {
        const backoffMs = Math.min(60_000, 1000 * 2 ** nextRetry);
        await prisma.notificationQueue.update({
          where: { id: row.id },
          data: {
            status: 'pending',
            retryCount: nextRetry,
            scheduledAt: new Date(Date.now() + backoffMs),
            errorMessage: err.message,
          },
        });
        deferred += 1;
      }
    }
  }

  return { attempted, sent, failed, deferred };
}

async function dispatch(row: {
  id: number;
  clientNumber: string;
  recipientId: number;
  channel: string;
  payload: unknown;
}): Promise<void> {
  const payload = (row.payload ?? {}) as Record<string, any>;
  switch (row.channel) {
    case 'email': {
      const user = await prisma.user.findUnique({ where: { id: row.recipientId }, select: { email: true, name: true } });
      if (!user?.email) throw new Error(`recipient user ${row.recipientId} has no email`);
      const body = payload.body ?? payload.text ?? JSON.stringify(payload);
      const html = typeof body === 'string' && body.trim().startsWith('<') ? body : `<p>${String(body)}</p>`;
      const ok = await sendEmail(user.email, payload.subject ?? 'Notification', html);
      if (!ok) throw new Error('sendEmail returned false');
      return;
    }
    case 'whatsapp': {
      const content = payload.body ?? payload.text ?? JSON.stringify(payload);
      // First try the tenant-level MyOS Notifier (preferred for Brain → user
      // messages). Falls back to the legacy per-user WhatsApp adapter when
      // no tenant notifier is configured or target phone isn't set.
      const recipient = await prisma.user.findUnique({
        where: { id: row.recipientId },
        select: { contactNumber: true, notificationPreferences: true },
      });
      const prefs = (recipient?.notificationPreferences as any) || {};
      const targetPhone = prefs.brain_channel?.whatsappNumber || recipient?.contactNumber;
      if (targetPhone) {
        const { sendViaNotifier } = await import('./whatsappNotifierService');
        const r = await sendViaNotifier(row.clientNumber, String(targetPhone), String(content));
        if (r.ok) return;
        // Notifier failed — fall through to legacy adapter
        console.warn(`[notifications] tenant notifier failed: ${r.error}; falling back to legacy`);
      }
      const r = await sendWhatsAppMessage(row.recipientId, String(content));
      if (!r.sent) throw new Error(r.reason ?? 'whatsapp send failed');
      return;
    }
    case 'in_app':
    case 'chat': {
      // In-app: the UI reads directly from notification_queue with status='sent'.
      // For now, just mark as sent without external dispatch.
      return;
    }
    default:
      throw new Error(`unknown channel "${row.channel}"`);
  }
}
