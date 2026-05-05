/**
 * MyOS — Delegatee email producer.
 *
 * When an open item is delegated to someone (delegateeEmail is set) but
 * has no dueDate, this producer emails the delegatee asking for a target
 * date. The reply is captured by the inbound feed handler (matched on
 * Gmail threadId) which parses the date and updates the item.
 *
 * Why this is a separate channel from the prompt queue:
 *   - The prompt queue handles Brain → USER conversations (WhatsApp).
 *   - Brain → DELEGATEE conversations are email-only because we have
 *     no WhatsApp identity for arbitrary recipients. Emails are sent
 *     FROM the user's Gmail (via sendUserEmail) so the delegatee sees
 *     a normal email from someone they already correspond with — no
 *     "MyOS" / bot branding.
 *
 * Loop:
 *   1. Producer finds eligible items (DELEGATED + delegateeEmail set +
 *      dueDate IS NULL + sourceFeed != null + within lookback + not
 *      already inquired).
 *   2. Compose a short, plain email asking "by when?", CC the user.
 *   3. Send via gmailService.sendUserEmail. Capture (messageId, threadId).
 *   4. Stamp metadata.deadlineInquiry on the open item with the
 *      thread ids + sentAt + status='sent'.
 *   5. When a reply lands on that thread, the inbound handler parses
 *      the body for a date phrase, updates dueDate, and notifies the
 *      user via the prompt queue (free_form_note).
 *
 * Producer is conservative — at most one inquiry per item ever (the
 * metadata stamp is the dedup key). If the delegatee never replies,
 * the followup worker eventually nudges the user via WhatsApp.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { sendUserEmail } from '../gmailService';

const log = createLogger('delegatee-email-producer');

const LOOKBACK_HOURS = Number(process.env.DELEGATEE_EMAIL_LOOKBACK_HOURS ?? '24');
const MAX_PER_USER_PER_RUN = Number(process.env.DELEGATEE_EMAIL_MAX_PER_RUN ?? '5');

export interface DelegateeEmailResult {
  scanned: number;
  sent: number;
  skipped: number;
  errors: number;
}

export async function runDelegateeEmailSweep(): Promise<DelegateeEmailResult> {
  const out: DelegateeEmailResult = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);

  // Candidates: DELEGATED, has delegateeEmail, no dueDate, came from a
  // connector signal, recent, no prior inquiry.
  // metadata?'deadlineInquiry' returns true ONLY when the key exists, so
  // NOT(metadata ? 'deadlineInquiry') filters out items already asked.
  const candidates = await prisma.$queryRawUnsafe<Array<{
    id: string; user_id: number; client_number: string; title: string;
    description: string | null; delegatee_email: string;
    delegatee_name: string | null;
  }>>(
    `SELECT id, user_id, client_number, title, description,
            delegatee_email, delegatee_name
       FROM open_items
      WHERE status = 'DELEGATED'
        AND delegatee_email IS NOT NULL
        AND due_date IS NULL
        AND source_feed IS NOT NULL
        AND created_at >= $1
        AND NOT (metadata ? 'deadlineInquiry')
      ORDER BY created_at ASC
      LIMIT 200`,
    since,
  ).catch((err) => { log.warn('candidate query failed', { err: err.message }); return [] as any[]; });
  out.scanned = candidates.length;

  // Per-user budget so a flood of new delegations doesn't fire 30 emails
  // in one sweep.
  const usedByUser = new Map<number, number>();

  for (const c of candidates) {
    const used = usedByUser.get(c.user_id) ?? 0;
    if (used >= MAX_PER_USER_PER_RUN) {
      out.skipped += 1;
      continue;
    }

    try {
      const user = await prisma.user.findFirst({
        where: { id: c.user_id },
        select: { name: true, email: true, integrationEmail: true },
      });
      const myEmail = user?.integrationEmail ?? user?.email ?? null;

      const subject = `Quick question: when can you have this back?`;
      const body = composeDelegateeEmail({
        toName: c.delegatee_name,
        fromUserName: user?.name ?? null,
        itemTitle: c.title,
      });

      const cc = myEmail && myEmail !== c.delegatee_email ? myEmail : undefined;
      const r = await sendUserEmail(c.user_id, c.delegatee_email, subject, body, cc);
      if (!r.success) {
        out.errors += 1;
        log.warn('send failed', { itemId: c.id, error: r.error });
        continue;
      }

      // Stamp the inquiry on the open item. Atomic update — concurrent
      // sweep calls wouldn't double-send because the metadata flag becomes
      // visible to the next candidate query.
      await prisma.$executeRawUnsafe(
        `UPDATE open_items
            SET metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{deadlineInquiry}',
              $1::jsonb,
              true
            )
          WHERE id = $2`,
        JSON.stringify({
          status: 'sent',
          messageId: r.messageId ?? null,
          threadId: r.threadId ?? null,
          sentAt: new Date().toISOString(),
          to: c.delegatee_email,
          cc: cc ?? null,
        }),
        c.id,
      ).catch((err) => log.warn('metadata stamp failed', { itemId: c.id, err: err.message }));

      usedByUser.set(c.user_id, used + 1);
      out.sent += 1;
    } catch (err: any) {
      out.errors += 1;
      log.warn('inquiry failed', { itemId: c.id, err: err.message });
    }
  }

  if (out.scanned > 0 || out.sent > 0) {
    log.info('delegatee email sweep complete', out as unknown as Record<string, unknown>);
  }
  return out;
}

/**
 * Compose a short, plain email asking the delegatee for a target date.
 * Tone is intentionally low-key — no MyOS / Brain branding, no formal
 * subject line shouting URGENT. Reads like a quick personal note from
 * the user.
 */
export function composeDelegateeEmail(args: {
  toName: string | null;
  fromUserName: string | null;
  itemTitle: string;
}): string {
  const greet = args.toName ? `Hi ${args.toName.split(' ')[0]},` : 'Hi,';
  const sign = args.fromUserName ?? '';
  return [
    `<p>${greet}</p>`,
    `<p>Quick one — when can you have this back? Just need a target date so I can plan around it.</p>`,
    `<p style="color:#666;font-size:13px">Re: ${escapeHtml(args.itemTitle)}</p>`,
    `<p>Reply with a date or a phrase like "next Friday" / "in 5 days" — anything that gives me a target.</p>`,
    `<p>Thanks${sign ? `,<br/>${escapeHtml(sign)}` : '!'}</p>`,
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
