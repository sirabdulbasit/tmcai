/**
 * DEF-246 — the capability the owner actually asked for, twice, verbatim:
 * "Derive actionable or open items from each email arrive and add them"
 * (S20/S23). Until this job, NOTHING consumed gmail feed_events into items:
 * 2,621 received, 0 processed — while whatsapp/gcal/gtasks all had consumers
 * at 95–98%. DEF-243 stopped Brain CLAIMING this capability; this job builds
 * it, and by moving rows off `status:new` it flips DEF-243's licensed claim
 * truthful with no further edit — the claim and the feed state are one data
 * source by construction.
 *
 * Governance (BRAIN_VISION §governed): the MODEL judges actionability — is
 * this email a concrete ask of the owner, and what are its slots? Code holds
 * the guardrails only: tenant/user scope on every read and write, target
 * grounding through `gateOpenItemCreate` (the canonical creation gate, with
 * its dedup and DRAFT routing), and no silent loss — a row leaves `new` only
 * as `processed` (item created) or `skipped` (judged not actionable /
 * gate-blocked duplicate), each a durable receipt.
 *
 * Bounded on purpose:
 *  - WINDOW: only events from the last 48h. The 2,621-row backlog stays
 *    `new` — flooding weeks of dead email into his list would be the CL-033
 *    noise failure in a new costume. A deliberate backlog sweep is the
 *    owner's call, not this job's default.
 *  - BATCH: at most `comm.email_item_derivation_batch` LLM judgements per
 *    tick (def 5), so cost is capped and a bad model day cannot spam.
 *  - A failed judgement leaves the row `new` for the next tick — never DLQ,
 *    never a guessed item.
 *  - Owner's own outbound mail is excluded (an email FROM him is not an ask
 *    OF him on this path).
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('email-item-derivation');

const WINDOW_HOURS = 48;

export interface DerivationSummary {
  scanned: number;
  created: number;
  drafted: number;
  skippedNotActionable: number;
  skippedDuplicate: number;
  errors: number;
}

interface Judgement {
  actionable: boolean;
  title?: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low' | null;
  dueDateISO?: string | null;
  reason?: string;
}

/** The MODEL's call — actionability is a judgement, and judgements are the
 *  model's (owner ruling 2026-08-19). Flash, JSON, bounded. Exported for the
 *  mutation test. */
export async function judgeEmailActionability(email: {
  subject: string; from: string; snippet: string;
}): Promise<Judgement | null> {
  try {
    const { callGemini } = await import('../services/geminiService');
    const system = [
      'You judge ONE inbound email for a busy owner. Decide whether it asks HIM to do',
      'something concrete (reply, decide, pay, review, attend, provide something).',
      'Newsletters, receipts, notifications, FYI threads and marketing are NOT actionable.',
      'Answer STRICT JSON only:',
      '{"actionable": boolean, "title": string (imperative, <=80 chars, only when actionable),',
      ' "description": string (<=200 chars, names the sender and the ask),',
      ' "priority": "critical"|"high"|"medium"|"low",',
      ' "dueDateISO": "YYYY-MM-DD" or null (only if the email itself names a date),',
      ' "reason": string (<=100 chars, why actionable or not)}',
    ].join('\n');
    const user = `From: ${email.from}\nSubject: ${email.subject}\n\n${email.snippet}`;
    const r = await callGemini(system, user, { flash: true, maxTokens: 512, responseMimeType: 'application/json' });
    const parsed = JSON.parse((r as any).text ?? (r as any)) as Judgement;
    if (typeof parsed?.actionable !== 'boolean') return null;
    return parsed;
  } catch (e: any) {
    log.warn('judgement failed — row stays new for the next tick', { error: e?.message?.slice(0, 150) });
    return null;
  }
}

export async function runEmailItemDerivation(): Promise<DerivationSummary> {
  const out: DerivationSummary = {
    scanned: 0, created: 0, drafted: 0, skippedNotActionable: 0, skippedDuplicate: 0, errors: 0,
  };
  try {
    const { getBehaviorValue } = await import('../services/behaviorConfig');

    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
    const candidates = await prisma.feedEvent.findMany({
      where: {
        sourceType: 'gmail',
        status: 'new',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      take: 50, // page bound; per-tenant batch cap applied below
      select: {
        id: true, clientNumber: true, userId: true, sourceId: true,
        rawPayload: true, senderEmail: true, createdAt: true,
      } as any,
    });

    const perTenantSeen = new Map<string, number>();
    for (const row of candidates as any[]) {
      if (row.userId == null) continue; // no owner to derive FOR — leave for a future owner-mapping pass
      const tenantKey = `${row.clientNumber}:${row.userId}`;
      try {
        const enabled = await getBehaviorValue('comm.email_item_derivation_enabled', { clientNumber: row.clientNumber });
        if (enabled !== 1) continue;
        const batchCap = await getBehaviorValue('comm.email_item_derivation_batch', { clientNumber: row.clientNumber });
        const seen = perTenantSeen.get(tenantKey) ?? 0;
        if (seen >= batchCap) continue;

        // An email FROM the owner is not an ask OF the owner on this path.
        const owner = await prisma.user.findFirst({
          where: { id: row.userId, clientNumber: row.clientNumber },
          select: { email: true, integrationEmail: true } as any,
        });
        const senderEmail = String(row.senderEmail ?? '').toLowerCase();
        const ownEmails = [
          (owner as any)?.email, (owner as any)?.integrationEmail,
        ].filter(Boolean).map((s: string) => s.toLowerCase());
        if (senderEmail && ownEmails.includes(senderEmail)) {
          await prisma.feedEvent.update({
            where: { id: row.id },
            data: { status: 'skipped', processedAt: new Date() } as any,
          });
          out.skippedNotActionable += 1;
          continue;
        }

        // DEF-247 — the SAME shared sender-quality predicate the gate
        // enforces, called early so a newsletter never costs an LLM
        // judgement. The GATE remains the enforcement point: a creator that
        // skips this line is still blocked there (that asymmetry — guard on
        // one path, minting on another — is exactly how the Anthropic
        // no-reply email became an item on 08-26).
        {
          const { isLikelyAutomated } = await import('../services/knowledge/senderQualityFilter');
          if (senderEmail && isLikelyAutomated(senderEmail)) {
            await prisma.feedEvent.update({
              where: { id: row.id },
              data: { status: 'skipped', processedAt: new Date() } as any,
            });
            out.skippedNotActionable += 1;
            continue;
          }
        }

        const p = (row.rawPayload ?? {}) as Record<string, unknown>;
        const email = {
          subject: String(p.subject ?? '(no subject)').slice(0, 300),
          from: String(p.from ?? row.senderEmail ?? '(unknown sender)').slice(0, 200),
          snippet: String(p.snippet ?? '').slice(0, 1500),
        };

        perTenantSeen.set(tenantKey, seen + 1);
        out.scanned += 1;

        const judged = await judgeEmailActionability(email);
        if (!judged) continue; // stays `new`; retried next tick

        if (!judged.actionable) {
          await prisma.feedEvent.update({
            where: { id: row.id },
            data: { status: 'skipped', processedAt: new Date() } as any,
          });
          out.skippedNotActionable += 1;
          continue;
        }

        const title = String(judged.title ?? email.subject).slice(0, 120);
        const description = String(judged.description ?? `From ${email.from}: ${email.subject}`).slice(0, 500);
        const dueDate = judged.dueDateISO && /^\d{4}-\d{2}-\d{2}$/.test(judged.dueDateISO)
          ? new Date(`${judged.dueDateISO}T12:00:00Z`)
          : null;
        const priority = (['critical', 'high', 'medium', 'low'] as const).includes(judged.priority as any)
          ? judged.priority as 'critical' | 'high' | 'medium' | 'low'
          : 'medium';

        const { gateOpenItemCreate } = await import('../services/openItems/openItemGate');
        const gate = await gateOpenItemCreate({
          clientNumber: row.clientNumber,
          userId: row.userId,
          sourceFeedEventId: row.id,
          title,
          description,
          priority,
          dueDate,
          sourceFeed: 'gmail',
          sourceRef: String(row.sourceId ?? ''),
        });
        if (gate.block) {
          // Duplicate (or gate refusal): the ask already exists as an item —
          // the receipt is `skipped`, never a second row.
          await prisma.feedEvent.update({
            where: { id: row.id },
            data: { status: 'skipped', processedAt: new Date() } as any,
          });
          out.skippedDuplicate += 1;
          continue;
        }

        await prisma.openItem.create({
          data: {
            title, description,
            type: 'manual',
            status: gate.status,
            priority,
            ownerId: row.userId,
            ...(gate.delegateeId != null ? { delegateeId: gate.delegateeId } : {}),
            ...(gate.delegateeName ? { delegateeName: gate.delegateeName } : {}),
            ...(gate.delegateeEmail ? { delegateeEmail: gate.delegateeEmail } : {}),
            clientNumber: row.clientNumber,
            userId: row.userId,
            sourceFeed: 'gmail',
            sourceRef: String(row.sourceId ?? ''),
            sourceFeedEventId: row.id,
            idempotencyKey: `email_derive:${row.id}`,
            ...(dueDate ? { dueDate } : {}),
            ...(gate.status === 'DRAFT' ? {
              metadata: {
                draft: {
                  missingSlots: gate.missingSlots,
                  asksSentCount: 0, firstAskScheduledAt: null, lastAskAt: null,
                },
                derivedFrom: { feedEventId: row.id, judgedReason: judged.reason ?? null },
              } as any,
            } : {
              metadata: { derivedFrom: { feedEventId: row.id, judgedReason: judged.reason ?? null } } as any,
            }),
          } as any,
          select: { id: true },
        });

        // The receipt that makes DEF-243's licensed claim TRUE: the row leaves
        // `new` only after the item exists.
        await prisma.feedEvent.update({
          where: { id: row.id },
          data: { status: 'processed', processedAt: new Date() } as any,
        });
        if (gate.status === 'DRAFT') out.drafted += 1; else out.created += 1;
      } catch (e: any) {
        out.errors += 1;
        log.warn('derivation failed for one event — row stays new', {
          feedEventId: row.id, clientNumber: row.clientNumber, error: e?.message?.slice(0, 200),
        });
      }
    }
  } catch (e: any) {
    out.errors += 1;
    log.warn('derivation sweep failed', { error: e?.message?.slice(0, 200) });
  }
  if (out.scanned > 0 || out.errors > 0) log.info('sweep', out as any);
  return out;
}

export function scheduleEmailItemDerivation(): void {
  const INTERVAL_MS = 15 * 60 * 1000; // every 15 min
  const FIRST_TICK_MS = 5 * 60 * 1000; // 5 min after boot
  setTimeout(() => {
    runEmailItemDerivation().catch(() => undefined);
    setInterval(() => runEmailItemDerivation().catch(() => undefined), INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('email item derivation scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
