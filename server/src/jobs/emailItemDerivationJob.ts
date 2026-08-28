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
 *
 * DEF-253 — gchat joined this SAME consumer (one job, both channels): the
 * chat channel sat at 294 received / 0 EVER processed — the owner's own
 * leadership space unread — while Brain claimed to review incoming messages
 * across channels. The noise gate, batch cap, thread reconciliation and
 * receipts are inherited, not re-implemented; each channel keeps its own
 * kill switch. (The file name is historical — this is the inbound-message
 * item-derivation consumer.)
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
  /** DEF-250 — events that reconciled an existing same-thread item
   *  (fulfilled → closed/annotated, or advanced → annotated). */
  reconciled: number;
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
      'You judge ONE inbound message (an email, or a chat message from a Google Chat space)',
      'for a busy owner. Decide whether it asks HIM to do something concrete (reply, decide,',
      'pay, review, attend, provide something).',
      'Newsletters, receipts, notifications, FYI threads, marketing, and chat smalltalk are NOT actionable.',
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

// ─── DEF-250 — `thread-answered-but-item-open`: the thread that continued ────
//
// Owner, verbatim (CL-039 era): "if email said to provide API, but in later
// email that API was provided and brain didnt get it." Measured: Safi Ullah
// delivered the DAL API on 08-24 05:56; Brain minted "Share DAL Open API to
// Basit" on 08-26 — two days AFTER delivery — and chased him for a deadline
// on it. An item is minted from ONE message and never reconciled against the
// thread that continued; worse, the continuation may be judged not-actionable
// on its own and `skipped`, so the fulfilment is never even looked at (the
// GCP/Imperial reply, 08-27 05:32).
//
// So reconciliation runs FIRST, before the noise skip and before the
// actionability judgement: when an inbound email belongs to a thread that
// already carries an ACTIVE item, the MODEL judges the relation (fulfils /
// advances / unrelated — a judgement, therefore the model's). Code executes
// the verdict through guardrails only: `fulfils` attempts the CANONICAL
// lifecycle close (`transitionStatus` → CLOSED with the model's note as the
// resolution reason — ledgered, reversible, refused-able); a REFUSED close
// (approval guard, lifecycle rule) falls back to annotating the item, never
// forcing it. `advances` annotates. Every outcome leaves a receipt on the
// item (`metadata.threadUpdates`) and the event exits `new` as `processed`.
// Guardrail: no-claim-without-a-receipt — the item's state change carries the
// feed event that caused it.

interface ThreadJudgement {
  relation: 'fulfils' | 'advances' | 'unrelated';
  note?: string;
}

/** The MODEL's reconciliation call. Exported for the mutation test. */
export async function judgeThreadReconciliation(args: {
  item: { title: string; description?: string | null; status: string };
  email: { subject: string; from: string; snippet: string };
}): Promise<ThreadJudgement | null> {
  try {
    const { callGemini } = await import('../services/geminiService');
    const system = [
      'An open to-do item was created from an earlier email in this thread. A NEW email has',
      'arrived on the SAME thread. Judge the relation:',
      '- "fulfils": the new email itself DELIVERS or confirms completion of what the item asks for',
      '  (the thing was provided, done, sent, or answered).',
      '- "advances": it provides part of it, or materially updates the item (new date, new owner).',
      '- "unrelated": neither.',
      'Answer STRICT JSON: {"relation":"fulfils"|"advances"|"unrelated",',
      ' "note": string (<=200 chars, names WHO did WHAT — used as the closure/update note)}',
    ].join('\n');
    const user = `ITEM (${args.item.status}): ${args.item.title}\n${args.item.description ?? ''}\n\nNEW EMAIL\nFrom: ${args.email.from}\nSubject: ${args.email.subject}\n\n${args.email.snippet}`;
    const r = await callGemini(system, user, { flash: true, maxTokens: 384, responseMimeType: 'application/json' });
    const parsed = JSON.parse((r as any).text ?? (r as any)) as ThreadJudgement;
    if (!['fulfils', 'advances', 'unrelated'].includes(parsed?.relation as string)) return null;
    return parsed;
  } catch (e: any) {
    log.warn('thread reconciliation judgement failed — event stays new for retry', { error: e?.message?.slice(0, 150) });
    return null;
  }
}

const ACTIVE_STATUSES = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED', 'DRAFT'];

export async function runEmailItemDerivation(): Promise<DerivationSummary> {
  const out: DerivationSummary = {
    scanned: 0, created: 0, drafted: 0, skippedNotActionable: 0, skippedDuplicate: 0, reconciled: 0, errors: 0,
  };
  try {
    const { getBehaviorValue } = await import('../services/behaviorConfig');

    const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
    // DEF-253 — gchat joins the SAME consumer. The channel sat at 294
    // received / 0 EVER processed — the owner's own leadership space unread —
    // while gmail's consumer ran beside it. A second per-channel job would be
    // `protection-with-two-implementations` (the 10-deep class); one consumer
    // means the noise gate, the batch cap, the thread reconciliation and the
    // receipts are inherited, not re-earned.
    const candidates = await prisma.feedEvent.findMany({
      where: {
        sourceType: { in: ['gmail', 'gchat'] },
        status: 'new',
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'asc' },
      take: 50, // page bound; per-tenant batch cap applied below
      select: {
        id: true, clientNumber: true, userId: true, sourceId: true, sourceType: true,
        rawPayload: true, senderEmail: true, createdAt: true,
      } as any,
    });

    const perTenantSeen = new Map<string, number>();
    for (const row of candidates as any[]) {
      if (row.userId == null) continue; // no owner to derive FOR — leave for a future owner-mapping pass
      const tenantKey = `${row.clientNumber}:${row.userId}`;
      try {
        // DEF-253 — each channel keeps its own kill switch; the batch cap is
        // shared, because it bounds LLM spend per tenant, not per channel.
        const enabledKey = row.sourceType === 'gchat'
          ? 'comm.chat_item_derivation_enabled'
          : 'comm.email_item_derivation_enabled';
        const enabled = await getBehaviorValue(enabledKey, { clientNumber: row.clientNumber });
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

        // DEF-250 — THREAD RECONCILIATION RUNS FIRST, before the noise skip
        // and before the actionability judgement: a continuation that would
        // be judged not-actionable on its own may be the FULFILMENT of an
        // item this thread already carries (the DAL API delivery; the
        // skipped GCP reply). Cheap DB check first; the model is consulted
        // only when an active same-thread item exists, and the call counts
        // against the same batch cap.
        const p0 = (row.rawPayload ?? {}) as Record<string, unknown>;
        // gmail carries `threadId`; gchat carries `threadName` (or the space
        // itself for unthreaded rooms). One key, both channels.
        const threadId = String(p0.threadId ?? p0.threadName ?? '').trim();
        if (threadId) {
          const activeItems = await prisma.openItem.findMany({
            where: {
              clientNumber: row.clientNumber, userId: row.userId,
              sourceFeed: row.sourceType, status: { in: ACTIVE_STATUSES as any },
              sourceFeedEventId: { not: null },
            },
            select: { id: true, title: true, description: true, status: true, sourceFeedEventId: true, metadata: true },
            take: 25,
          } as any);
          let matched: any = null;
          if (activeItems.length > 0) {
            const srcEvents = await prisma.feedEvent.findMany({
              where: { id: { in: activeItems.map((i: any) => i.sourceFeedEventId).filter(Boolean) } },
              select: { id: true, rawPayload: true } as any,
            });
            const threadOf = new Map(srcEvents.map((e: any) => {
              const rp = (e.rawPayload ?? {}) as Record<string, unknown>;
              return [e.id, String(rp.threadId ?? rp.threadName ?? '')];
            }));
            matched = activeItems.find((i: any) => threadOf.get(i.sourceFeedEventId) === threadId) ?? null;
          }
          if (matched) {
            perTenantSeen.set(tenantKey, (perTenantSeen.get(tenantKey) ?? 0) + 1);
            const pEmail = {
              subject: String(p0.subject ?? '(no subject)').slice(0, 300),
              from: String(p0.from ?? p0.senderDisplayName ?? row.senderEmail ?? '(unknown sender)').slice(0, 200),
              snippet: String((row.sourceType === 'gchat' ? p0.text : p0.snippet) ?? p0.snippet ?? '').slice(0, 1500),
            };
            const rel = await judgeThreadReconciliation({
              item: { title: matched.title, description: matched.description, status: matched.status },
              email: pEmail,
            });
            if (!rel) continue; // judgement failed — event stays `new`, retried
            if (rel.relation !== 'unrelated') {
              const note = String(rel.note ?? '').slice(0, 200) || 'answered by a later email on the same thread';
              let closed = false;
              if (rel.relation === 'fulfils') {
                try {
                  const { transitionStatus } = await import('../services/itemLifecycle/lifecycleService');
                  const res = await transitionStatus(matched.id, 'CLOSED', {
                    clientNumber: row.clientNumber,
                    actor: 'brain:thread_reconciliation',
                    reason: note,
                  });
                  closed = !!res.ok;
                  if (!res.ok) {
                    log.info('reconciliation close refused by the lifecycle — annotating instead', {
                      itemId: matched.id, error: (res as any).error?.slice?.(0, 120),
                    });
                  }
                } catch (e: any) {
                  log.warn('reconciliation close failed — annotating instead', { itemId: matched.id, error: e?.message?.slice(0, 120) });
                }
              }
              // The receipt rides the ITEM either way: what arrived, what the
              // model judged, what was done about it.
              const meta = (matched.metadata as Record<string, unknown> | null) ?? {};
              const updates = Array.isArray((meta as any).threadUpdates) ? (meta as any).threadUpdates : [];
              await prisma.openItem.update({
                where: { id: matched.id },
                data: {
                  metadata: {
                    ...meta,
                    threadUpdates: [...updates, {
                      feedEventId: row.id, relation: rel.relation, note,
                      closed, at: new Date().toISOString(),
                    }].slice(-10),
                  } as any,
                },
              }).catch((e: any) => log.warn('thread receipt write failed', { itemId: matched.id, error: e?.message?.slice(0, 120) }));
              await prisma.feedEvent.update({
                where: { id: row.id },
                data: { status: 'processed', processedAt: new Date() } as any,
              });
              out.reconciled += 1;
              continue;
            }
            // unrelated → fall through to the normal noise/actionability flow.
          }
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
          // gchat has no sender email — the display name carries who spoke.
          from: String(p.from ?? p.senderDisplayName ?? row.senderEmail ?? '(unknown sender)').slice(0, 200),
          // gchat's full text beats its 200-char snippet; gmail has snippet only.
          snippet: String((row.sourceType === 'gchat' ? p.text : p.snippet) ?? p.snippet ?? '').slice(0, 1500),
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
          sourceFeed: row.sourceType,
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
            sourceFeed: row.sourceType,
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
                derivedFrom: { feedEventId: row.id, threadId: threadId || null, judgedReason: judged.reason ?? null },
              } as any,
            } : {
              metadata: { derivedFrom: { feedEventId: row.id, threadId: threadId || null, judgedReason: judged.reason ?? null } } as any,
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
