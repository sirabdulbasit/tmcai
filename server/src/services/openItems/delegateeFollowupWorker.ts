/**
 * Delegatee follow-up worker — Brain → DELEGATEE on/around due date.
 *
 * Per Basit 2026-05-23 delegation lifecycle spec:
 *   3. send email to whom it has delegated  ← handled inline at delegation time
 *   4. brain will monitor and do follow up on whatsapp (from brain) when
 *      due date comes if not done get the reason and update it then get
 *      the new due date (keep asking until you get new due date and then
 *      ask on new due date and so on)
 *   5. If done, status updated and whatsapp to whom you actually delegated
 *      that task has completed now (also update all the updates which was
 *      provided by delegatee during follow up)
 *
 * This worker handles step 4: on the due_date OR every 24h after, send
 * a WhatsApp ping FROM Brain (tenant Nexeo number) to the delegatee
 * asking "did you finish X?".
 *
 * Defaults (from Basit's Q-defaults 2026-05-23):
 *   Q3 (no WhatsApp number) → email-only throughout. If delegatee has
 *      no phone, the ping goes via email instead.
 *   Q4 (delegatee silent) → second reminder at 3 days, then escalate to
 *      user at 5 days.
 *
 * Step 5 (completion + closure notification) is a separate concern in
 * delegationClosureService.ts; this worker only handles the chasing.
 *
 * Schedule: hourly cron (different timezones get appropriate hours;
 * brainContactsUser handles quiet hours for user-facing pings).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('delegatee-followup');

interface DelegationFollowupEntry {
  at: string;
  channel: 'whatsapp' | 'email' | 'user-escalation';
  direction: 'out' | 'in';
  content: string;
  reason?: string;
  newDueDate?: string;
}

/** Hours between successive delegatee pings. After the first one (on
 *  due_date), subsequent pings space out at 24h, 24h (= 3 days total
 *  silence), then escalate to user. */
const FIRST_PING_HOURS_AFTER_DUE = 0;       // fire on the due date itself
const SUBSEQUENT_PING_INTERVAL_HOURS = 24;
const ESCALATE_TO_USER_AFTER_HOURS = 24 * 5; // 5 days silent → escalate to user (Q4 default)
const MAX_DELEGATEE_PINGS = 5;

/** Run a sweep. Returns counts for observability. */
export async function runDelegateeFollowupSweep(opts: { dryRun?: boolean } = {}): Promise<{
  scanned: number;
  pinged: number;
  escalated: number;
  skipped: number;
  errors: number;
}> {
  const out = { scanned: 0, pinged: 0, escalated: 0, skipped: 0, errors: 0 };

  // Pull DELEGATED items where:
  //  - Brain has emailed the delegatee at delegation time (so they
  //    KNOW about the task)
  //  - due_date is set
  //  - we haven't hit max follow-ups
  const items = await prisma.openItem.findMany({
    where: {
      status: 'DELEGATED' as any,
      delegationEmailedAt: { not: null } as any,
      dueDate: { not: null } as any,
      delegationFollowupCount: { lt: MAX_DELEGATEE_PINGS } as any,
    } as any,
    select: {
      id: true, clientNumber: true, userId: true, title: true,
      delegateeName: true, delegateeEmail: true, dueDate: true,
      delegationFollowupCount: true,
      delegationLastFollowupAt: true,
      delegationFollowupTrail: true,
    },
    take: 200,
  }).catch(() => [] as any[]);
  out.scanned = items.length;

  const now = Date.now();

  for (const it of items) {
    const due = new Date((it as any).dueDate).getTime();
    const lastPing = (it as any).delegationLastFollowupAt
      ? new Date((it as any).delegationLastFollowupAt).getTime()
      : null;
    const count = (it as any).delegationFollowupCount ?? 0;

    // Decide whether to fire now.
    let shouldFire = false;
    if (count === 0) {
      // First ping: on or after the due date.
      if (now >= due + FIRST_PING_HOURS_AFTER_DUE * 60 * 60 * 1000) shouldFire = true;
    } else if (lastPing) {
      const sinceLast = (now - lastPing) / (60 * 60 * 1000);
      if (sinceLast >= SUBSEQUENT_PING_INTERVAL_HOURS) shouldFire = true;
    }
    if (!shouldFire) { out.skipped += 1; continue; }

    // Escalate-to-user check (Q4 default: 5 days silent total).
    const sinceFirstPingHours = lastPing
      ? (now - new Date((it as any).delegationFollowupTrail?.[0]?.at ?? lastPing).getTime()) / (60 * 60 * 1000)
      : 0;
    if (count > 0 && sinceFirstPingHours >= ESCALATE_TO_USER_AFTER_HOURS) {
      if (opts.dryRun) {
        log.info('would escalate to user', { itemId: it.id, sinceFirstPingHours });
        out.escalated += 1;
        continue;
      }
      try {
        const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
        await enqueueBrainPrompt({
          userId: (it as any).userId,
          clientNumber: (it as any).clientNumber,
          question: `🔴 ${(it as any).delegateeName ?? 'the delegatee'} has been silent for ${Math.floor(sinceFirstPingHours / 24)} days on "${(it as any).title}". I've pinged them ${count} times. Want to take it back or chase them yourself?`,
          openItemId: (it as any).id,
          sideEffect: { kind: 'free_form_note', openItemId: (it as any).id },
          criticality: 'high',
          dedupKey: `delegatee_escalation:${(it as any).id}`,
          metadata: { source: 'delegatee_followup_worker', tier: 'escalation' },
        });
        await appendTrail(it, {
          at: new Date().toISOString(),
          channel: 'user-escalation',
          direction: 'out',
          content: 'Escalated to user after delegatee silent past threshold.',
        });
        out.escalated += 1;
      } catch (e: any) {
        log.warn('escalation enqueue failed', { itemId: it.id, error: e?.message });
        out.errors += 1;
      }
      continue;
    }

    // Otherwise: ping the delegatee directly.
    if (opts.dryRun) {
      log.info('would ping delegatee', { itemId: it.id, count, channel: (it as any).delegateeEmail ? 'email' : 'unknown' });
      out.pinged += 1;
      continue;
    }

    try {
      // Q3 default: prefer WhatsApp if the delegatee has a phone in
      // entities. Fall back to email if not.
      const delegateePhone = await prisma.entity.findFirst({
        where: {
          clientNumber: (it as any).clientNumber,
          entityType: 'contact',
          email: (it as any).delegateeEmail,
          phone: { not: null } as any,
        } as any,
        select: { phone: true, name: true },
      }).catch(() => null);

      const userName = await prisma.user.findUnique({
        where: { id: (it as any).userId },
        select: { name: true },
      }).then((u) => (u?.name ?? 'the user').split(/\s+/)[0]).catch(() => 'the user');

      const dueDateStr = new Date((it as any).dueDate).toISOString().slice(0, 10);
      const firstNameDel = ((it as any).delegateeName ?? '').split(/\s+/)[0] || 'there';
      const body = count === 0
        ? `Hi ${firstNameDel}, this is Nexeo — ${userName}'s AI assistant. Quick check on "${(it as any).title}" — it was due ${dueDateStr}. Is it done? If not, when can you complete it?`
        : `Hi ${firstNameDel}, Nexeo again. Following up on "${(it as any).title}" — still waiting on a status update. Could you let me know where it stands?`;

      let sentVia: 'whatsapp' | 'email' = 'email';
      let sentOk = false;
      if (delegateePhone?.phone) {
        const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
        const r = await sendTenantWhatsAppText(
          (it as any).clientNumber,
          delegateePhone.phone,
          body,
          (it as any).userId,
        );
        if (r.ok) {
          sentVia = 'whatsapp';
          sentOk = true;
        }
      }
      if (!sentOk) {
        // Fall back to email
        const { sendUserEmail } = await import('../gmailService');
        const subject = count === 0
          ? `Quick status check: ${(it as any).title}`
          : `Follow-up: ${(it as any).title}`;
        const r = await sendUserEmail(
          (it as any).userId,
          (it as any).delegateeEmail,
          subject,
          body,
        );
        if (r.success) {
          sentVia = 'email';
          sentOk = true;
        }
      }

      if (sentOk) {
        await prisma.openItem.update({
          where: { id: (it as any).id },
          data: {
            delegationFollowupCount: count + 1,
            delegationLastFollowupAt: new Date(),
          } as any,
        });
        await appendTrail(it, {
          at: new Date().toISOString(),
          channel: sentVia,
          direction: 'out',
          content: body,
        });
        out.pinged += 1;
      } else {
        out.errors += 1;
      }
    } catch (e: any) {
      log.warn('delegatee ping failed', { itemId: it.id, error: e?.message });
      out.errors += 1;
    }
  }

  if (out.scanned > 0) {
    log.info('delegatee followup sweep', out);
  }
  return out;
}

async function appendTrail(item: any, entry: DelegationFollowupEntry): Promise<void> {
  const current = Array.isArray(item.delegationFollowupTrail) ? item.delegationFollowupTrail : [];
  const trail = [...current, entry].slice(-20);
  await prisma.openItem.update({
    where: { id: item.id },
    data: { delegationFollowupTrail: trail as any } as any,
  }).catch((e) => log.warn('trail update failed', { itemId: item.id, error: e?.message }));
}

/** Schedule hourly. Pattern matches followupWorker.ts. */
export function scheduleDelegateeFollowupWorker(): void {
  const INTERVAL_MS = 60 * 60 * 1000; // hourly
  const FIRST_TICK_MS = 5 * 60 * 1000; // 5 min after boot
  setTimeout(() => {
    runDelegateeFollowupSweep().catch(() => undefined);
    setInterval(() => runDelegateeFollowupSweep().catch(() => undefined), INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('delegatee-followup worker scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
