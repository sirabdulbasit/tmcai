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

// ── DEF-329 — `email-derivation-consumer-dark`: the liveness latch ─────────
//
// "A failed judgement leaves the row `new` for the next tick" (the DEF-246
// contract above) has no floor: when the judgement dependency dies outright
// (measured: provider 403 "requires billing", 2026-09-29 08:36 → 10-02, all
// three channels at once because they share one credential), every row stays
// `new` forever, the sweep log prints a healthy summary, and 481 inbound
// events accumulate silently. A never-acted failure produces no bad reply,
// so no chat log ever reports it — the outage is invisible by construction.
// Guardrail enforced: no-claim-without-a-receipt, applied to the consumer's
// OWN health — it may not keep claiming quiet sweeps while 100% of its
// judgements fail. The latch is deterministic ops mechanics (counts in vs
// out); the ALERT body carries provider facts, and its wording goes through
// the same outbound path as every Brain contact (model-rendered, curated
// fallback only when the model is unreachable — which, in this failure mode,
// it is: the sanctioned case for a string that carries the fact).
const OUTAGE_SWEEP_THRESHOLD = 4; // ≈1h of 15-min ticks — one flaky call never alarms
const OUTAGE_REALERT_MS = 24 * 60 * 60 * 1000; // mirror connector-stale: once/24h, never spam
let consecutiveFullFailureSweeps = 0;
let lastOutageAlertAt = 0;
let lastJudgementErrorHead: string | null = null;

/** Test seam — liveness state is module-scoped by design (one process, one consumer). */
export function resetDerivationLiveness(): void {
  consecutiveFullFailureSweeps = 0;
  lastOutageAlertAt = 0;
  lastJudgementErrorHead = null;
}

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
  /** DEF-329 — judgements that returned null (threw, or malformed JSON).
   *  Rows legitimately stay `new` for retry, but the SWEEP RECEIPT must say
   *  so: on 2026-09-29→10-02 every judgement failed for 9 days (provider 403,
   *  billing) and this summary printed `errors: 0` throughout — a healthy
   *  claim with no receipt behind it, during a total outage. */
  judgementFailures: number;
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
      'You judge ONE inbound message (an email, a chat message from a Google Chat space, or a',
      'calendar event/invitation) for a busy owner. Decide whether it asks HIM to do something',
      'concrete (reply, decide, pay, review, provide something).',
      'Newsletters, receipts, notifications, FYI threads, marketing, and chat smalltalk are NOT actionable.',
      'A CALENDAR EVENT is actionable ONLY if it asks him to do something BEYOND attending —',
      'prepare material, make a decision, answer a question, bring or provide something. An',
      'invitation he can simply attend or decline from his calendar is NOT actionable: the owner',
      'has said plainly that items minted from bare invitations are noise to him.',
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
    lastJudgementErrorHead = e?.message?.slice(0, 160) ?? null;
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
    lastJudgementErrorHead = e?.message?.slice(0, 160) ?? null;
    log.warn('thread reconciliation judgement failed — event stays new for retry', { error: e?.message?.slice(0, 150) });
    return null;
  }
}

const ACTIVE_STATUSES = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED', 'DRAFT'];

export async function runEmailItemDerivation(): Promise<DerivationSummary> {
  const out: DerivationSummary = {
    scanned: 0, created: 0, drafted: 0, skippedNotActionable: 0, skippedDuplicate: 0, reconciled: 0, errors: 0,
    judgementFailures: 0,
  };
  // DEF-329 — sweep-local liveness inputs: did ANY judgement succeed, and
  // which owners are affected when none do (they receive the alarm).
  let judgementSuccesses = 0;
  const failedFor = new Map<number, string>();
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
        // DEF-307 — gcal joins the SAME consumer, the last dead channel: 55 of
        // 55 in-window events at status:new, 0 EVER processed, while Brain's
        // standing claim implied it reads every channel (`fabricated-status`
        // by DEF-243's co-existence test). Same argument as DEF-253 one
        // comment up: a third per-channel job would be
        // `protection-with-two-implementations`; joining here inherits the
        // noise gate, the shared batch cap, the 48h window (the 800+-row
        // backlog stays untouched), the creation gate and the receipts.
        sourceType: { in: ['gmail', 'gchat', 'gcal'] },
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
          : row.sourceType === 'gcal'
            ? 'comm.gcal_item_derivation_enabled'
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
            if (!rel) { // judgement failed — event stays `new`, retried
              out.judgementFailures += 1;
              failedFor.set(row.userId, row.clientNumber);
              continue;
            }
            judgementSuccesses += 1;
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
        // DEF-307 — a calendar event's meaning lives in different fields (the
        // same defensive shapes buildCalendarSnapshot reads: title|summary,
        // start.dateTime|start.date, organizer as string or object, attendees
        // as objects or strings). The judge is told WHAT it is judging.
        const gcalOrganizer = (o: unknown): string => (typeof o === 'string'
          ? o
          : String((o as any)?.email ?? (o as any)?.displayName ?? ''));
        const email = row.sourceType === 'gcal'
          ? {
            subject: String(p.title ?? p.summary ?? '(untitled event)').slice(0, 300),
            from: (gcalOrganizer(p.organizer) || String(row.senderEmail ?? '') || '(unknown organizer)').slice(0, 200),
            snippet: [
              `Calendar event, starts ${String((p.start as any)?.dateTime ?? (p.start as any)?.date ?? p.start ?? '(no start)').slice(0, 60)}.`,
              String(p.description ?? '').slice(0, 800),
              Array.isArray(p.attendees)
                ? `Attendees: ${(p.attendees as any[]).slice(0, 6)
                  .map((a) => String(a?.displayName ?? a?.email ?? (typeof a === 'string' ? a : ''))).filter(Boolean).join(', ')}`
                : '',
            ].filter(Boolean).join('\n').slice(0, 1500),
          }
          : {
            subject: String(p.subject ?? '(no subject)').slice(0, 300),
            // gchat has no sender email — the display name carries who spoke.
            from: String(p.from ?? p.senderDisplayName ?? row.senderEmail ?? '(unknown sender)').slice(0, 200),
            // gchat's full text beats its 200-char snippet; gmail has snippet only.
            snippet: String((row.sourceType === 'gchat' ? p.text : p.snippet) ?? p.snippet ?? '').slice(0, 1500),
          };

        perTenantSeen.set(tenantKey, seen + 1);
        out.scanned += 1;

        const judged = await judgeEmailActionability(email);
        if (!judged) { // stays `new`; retried next tick
          out.judgementFailures += 1;
          failedFor.set(row.userId, row.clientNumber);
          continue;
        }
        judgementSuccesses += 1;

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
  await assessJudgementLiveness(out, judgementSuccesses, failedFor);
  if (out.scanned > 0 || out.errors > 0 || out.judgementFailures > 0) log.info('sweep', out as any);
  return out;
}

/**
 * DEF-329 — the latch itself. A sweep with at least one failed judgement and
 * ZERO successful ones advances the counter; any success resets it (and arms
 * the alarm afresh for a future outage). At the threshold, each affected
 * owner is told ONCE per 24h window, through the canonical outbound
 * chokepoint — same mechanics as the connector-stale alert, which is the
 * certified precedent for exactly this shape of failure. The alarm must
 * never break the sweep: it is fully fenced.
 */
async function assessJudgementLiveness(
  out: DerivationSummary,
  judgementSuccesses: number,
  failedFor: Map<number, string>,
): Promise<void> {
  try {
    if (judgementSuccesses > 0) {
      consecutiveFullFailureSweeps = 0;
      lastOutageAlertAt = 0;
      return;
    }
    if (out.judgementFailures === 0) return; // nothing attempted — no evidence either way
    consecutiveFullFailureSweeps += 1;
    if (consecutiveFullFailureSweeps < OUTAGE_SWEEP_THRESHOLD) return;
    if (Date.now() - lastOutageAlertAt < OUTAGE_REALERT_MS) return;
    lastOutageAlertAt = Date.now();
    const { brainContactsUser } = await import('../services/notifications/brainOutboundService');
    for (const [userId, clientNumber] of failedFor) {
      const since = new Date(Date.now() - WINDOW_HOURS * 60 * 60 * 1000);
      const waiting = await prisma.feedEvent.count({
        where: {
          clientNumber, userId,
          sourceType: { in: ['gmail', 'gchat', 'gcal'] },
          status: 'new',
          createdAt: { gte: since },
        },
      }).catch(() => out.judgementFailures);
      const lines = [
        `⚠️ Inbound triage is stalled: the AI judgement call has failed on every attempt for ${consecutiveFullFailureSweeps} consecutive sweeps (~${consecutiveFullFailureSweeps * 15} min).`,
        `${waiting} inbound email/chat/calendar events are waiting, and none can become open items until this recovers.`,
        ...(lastJudgementErrorHead ? [`Provider error: ${lastJudgementErrorHead}`] : []),
      ];
      await brainContactsUser({
        userId,
        clientNumber,
        kind: 'derivation_judgement_outage',
        summary: 'Inbound triage stalled — AI judgement calls failing',
        body: lines.join('\n'),
        urgency: 'high',
        dedupKey: 'derivation_judgement_outage',
        dedupWindowMs: OUTAGE_REALERT_MS,
        metadata: { consecutiveFullFailureSweeps, waiting, errorHead: lastJudgementErrorHead } as any,
      }).catch((e: any) => log.warn('outage alert send failed', { userId, error: e?.message?.slice(0, 120) }));

      // DEF-329 remediation (Codex iteration-76 §3 MEDIUM, measured live:
      // the alarm above never reached the owner's inbox in the 23.5h after
      // D-107 deployed it — suppressed one layer up by the user-facing
      // opt-in gate). The SECOND route, like DEF-321's: a direct SA/AD email
      // through the shared ops helper, independent of `outboundEnabled`.
      // Facts only — this path exists precisely because the model is dead.
      try {
        const { sendAdminOpsEmail, escapeOpsHtml } = await import('../services/notifications/adminOpsAlert');
        const subject = `[Nexeo] Inbound triage stalled — AI judgement calls failing (${clientNumber})`;
        const html = `
          <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px;">
            <p style="margin: 0 0 16px;"><strong>Every AI judgement call on tenant <code>${escapeOpsHtml(clientNumber)}</code> has failed for ${consecutiveFullFailureSweeps} consecutive sweeps (~${consecutiveFullFailureSweeps * 15} min).</strong></p>
            <table style="border-collapse: collapse; width: 100%; font-size: 13px;">
              <tr><td style="padding: 6px 10px; color: #666;">Waiting inbound events (48h window)</td><td style="padding: 6px 10px;">${waiting}</td></tr>
              ${lastJudgementErrorHead ? `<tr><td style="padding: 6px 10px; color: #666;">Provider error</td><td style="padding: 6px 10px;"><code>${escapeOpsHtml(lastJudgementErrorHead)}</code></td></tr>` : ''}
              <tr><td style="padding: 6px 10px; color: #666;">Detected</td><td style="padding: 6px 10px;">${new Date().toISOString()}</td></tr>
            </table>
            <div style="margin-top: 16px; padding: 12px 14px; background: #fff8e6; border: 1px solid #f5d97f; border-radius: 6px; font-size: 13px;">
              <strong>Action required:</strong><br />
              Resolve the provider error above (credential, quota, or billing on the project it names).
              Until it recovers, no inbound email, chat or calendar event becomes an open item — rows wait at
              <code>status:new</code> and are retried, never dropped.
            </div>
          </div>
        `;
        const { total, results } = await sendAdminOpsEmail({ clientNumber, subject, html });
        const sentOk = results.filter((r) => r.ok).length;
        if (total === 0 || sentOk === 0) {
          // An undeliverable "the model is dead" alert is an incident of its
          // own (DEF-321's lesson, verbatim shape).
          log.error('judgement outage alert reached NO ONE over email', {
            clientNumber, total,
            failures: results.filter((r) => !r.ok).map((f) => ({ email: f.email, error: f.error })),
          });
        } else {
          log.info('judgement outage admin email sent', { clientNumber, sent: sentOk, total });
        }
      } catch (e: any) {
        log.warn('judgement outage admin email threw', { clientNumber, error: e?.message?.slice(0, 120) });
      }
    }
    log.warn('judgement outage alarm raised', {
      sweeps: consecutiveFullFailureSweeps, users: failedFor.size, errorHead: lastJudgementErrorHead,
    });
  } catch (e: any) {
    log.warn('liveness assessment failed', { error: e?.message?.slice(0, 120) });
  }
}

export function scheduleEmailItemDerivation(): void {
  const INTERVAL_MS = 15 * 60 * 1000; // every 15 min
  const FIRST_TICK_MS = 5 * 60 * 1000; // 5 min after boot
  // DEF-344 `comm-ingestion-stalled` / `email-derivation-consumer-dark` — this
  // sweep was the LAST raw-setInterval consumer on the ingestion path: no
  // overlap guard (two sweeps could run concurrently), no timeout, errors
  // swallowed by `.catch(() => undefined)`, and — the 10-08 incident's exact
  // shape — no wedge breaker, so one hung tick could halt derivation FOREVER
  // in silence. DEF-335 built the breaker but only for protectedTick jobs;
  // this job was not one, which is why it never fired here across eight
  // deploys. Each tick now runs the BODY through the one reliability runner
  // (pg-advisory lease, persisted run state in job_runs — the durable
  // run-completion receipt whose ABSENCE was previously invisible — bounded
  // attempt timeout, visible overlap skip, the DEF-335 wedge breaker, and
  // escalation to system_logs after 3 consecutive failures). Timer wiring is
  // unchanged, matching the server.ts protectedJob pattern.
  const tick = (): void => {
    void import('./jobRunner')
      .then(({ protectedTick }) =>
        protectedTick('email_item_derivation', 'important', () => runEmailItemDerivation()))
      .catch((e: any) => log.warn('email derivation tick could not run protected', { error: e?.message?.slice(0, 160) }));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('email item derivation scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
