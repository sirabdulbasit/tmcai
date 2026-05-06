/**
 * MyOS — Day Brief attention + decide endpoints.
 *
 *   GET  /brief/attention          → items where Brain is asking MD for a call
 *   POST /brief/decide             → MD records a decision (reply / delegate / open item / ignore)
 *   POST /brief/hide               → MD hides a pattern from future attention
 *   GET  /brief/brain-actions      → past 24h of autonomous Brain actions (the "Brief" section)
 */
import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';
import crypto from 'crypto';
import { buildAttentionList, buildHandledList, suggestForFeedEvent, computeDedupHash, type SuggestedAction, type ItemType, type Archetype } from '../services/triage/triageSuggester';

const router = Router();

// Every route requires authenticated user
router.use((req: Request, res: Response, next) => {
  if (!(req as any).user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  next();
});

/** Section 2 — My Attention */
router.get('/attention', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '30'), 10) || 30, 100);
  try {
    const items = await buildAttentionList(user.clientNumber, user.id, limit);
    // NOTE: WhatsApp push for critical items is NOT fired here anymore.
    // It used to be fire-and-forget on every /brief/attention call,
    // which meant opening the Day Brief in two tabs (or React's
    // strict-mode double-fetch) sent the user the same bundle twice.
    // The push now runs from a per-tenant cron tick (criticalityBundleSweep)
    // so it fires once per minute regardless of how often the page polls.
    res.json({ items, count: items.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /brief/inbox — drill-down list of every feed_event Brain has
 * ingested for this user, paginated.
 *
 * Query params:
 *   source — 'gmail' | 'whatsapp' | 'gcal' | 'gtasks' | 'all' (default 'all')
 *   limit  — page size (default 50, max 200)
 *   offset — for pagination
 *   q      — substring filter against sender + subject (optional)
 *
 * Returns: { items, total, hasMore }
 *
 * User-scoped via req.user; no cross-tenant leakage. Same shape the
 * volume tile drills into when clicked.
 */
router.get('/inbox', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const source = String(req.query.source ?? 'all');
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const offset = Math.max(parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
  const q = String(req.query.q ?? '').trim();

  const VALID_SOURCES = new Set(['gmail', 'whatsapp', 'gcal', 'gtasks']);
  const sourceFilter = source !== 'all' && VALID_SOURCES.has(source) ? source : null;

  try {
    const where: any = {
      clientNumber: user.clientNumber,
      userId: user.id,
    };
    if (sourceFilter) where.sourceType = sourceFilter;
    if (q) {
      where.OR = [
        { senderName: { contains: q, mode: 'insensitive' } },
        { senderEmail: { contains: q, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.feedEvent.findMany({
        where,
        select: {
          id: true,
          sourceType: true,
          senderEmail: true,
          senderName: true,
          rawPayload: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.feedEvent.count({ where }),
    ]);

    const items = rows.map((r) => {
      const p: any = r.rawPayload ?? {};
      return {
        id: r.id,
        sourceType: r.sourceType,
        senderName: r.senderName,
        senderEmail: r.senderEmail,
        subject: String(p.subject ?? p.summary ?? p.title ?? p.eventName ?? '').slice(0, 240),
        snippet: String(p.snippet ?? p.body ?? p.description ?? '').slice(0, 200),
        receivedAt: r.createdAt.toISOString(),
      };
    });

    res.json({ items, total, hasMore: offset + items.length < total });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /brief/handled — items Brain handled WITHOUT bothering the user.
 *
 * Sister endpoint to /attention. Together they implement the "100%
 * accountability" rule — every inbox item in the Day Brief window must
 * appear in exactly one of {attention, handled}.
 *
 * Returns HandledItem[]; each has a `bucket` enum so the client can
 * group: auto_rule | auto_noise | auto_self | auto_high_confidence |
 * auto_decided. Newest first. User-scoped via req.user (no tenant or
 * per-user data leaks).
 */
router.get('/handled', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  try {
    const items = await buildHandledList(user.clientNumber, user.id, limit);
    // Pre-compute per-bucket counts so the client doesn't have to filter
    // for the header tally.
    const byBucket: Record<string, number> = {};
    for (const it of items) byBucket[it.bucket] = (byBucket[it.bucket] ?? 0) + 1;
    res.json({ items, count: items.length, byBucket });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Drafts — LLM-composed replies Brain wrote but held for MD review. */
router.get('/drafts', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const drafts = await prisma.agentAction.findMany({
    where: {
      clientNumber: user.clientNumber,
      userId: user.id,
      actionType: 'draft_reply',
      status: 'done',
      requiresApproval: false,
      // Drafts we haven't acted on yet — no 'approved_at' or similar marker
    } as any,
    select: { id: true, input: true, output: true, riskTier: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  res.json({
    drafts: drafts.map((d) => {
      const out: any = d.output ?? {};
      const inp: any = d.input ?? {};
      const isWhatsApp = out.channel === 'whatsapp' || !!out.chatId;
      return {
        id: d.id,
        channel: isWhatsApp ? 'whatsapp' : 'email',
        to: isWhatsApp
          ? (out.phoneNumber ?? out.chatId ?? '')
          : (out.to ?? inp.to ?? ''),
        // WhatsApp drafts have no subject line — emails carry "Re: <subj>"
        subject: isWhatsApp ? null : (out.subject ?? (inp.subject ? `Re: ${inp.subject}` : '')),
        body: out.body ?? '',
        provider: out.provider,
        feedEventId: inp.feedEventId,
        ruleId: inp.ruleId,
        createdAt: d.createdAt.toISOString(),
      };
    }),
  });
});

/** Approve a draft → actually send via Gmail + archive the draft row. */
router.post('/drafts/:id/send', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const draft = await prisma.agentAction.findFirst({
    where: { id, clientNumber: user.clientNumber, userId: user.id, actionType: 'draft_reply' } as any,
  });
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  const out: any = draft.output ?? {};
  const body = req.body?.body ?? out.body;
  const isWhatsApp = out.channel === 'whatsapp' || !!out.chatId;
  try {
    let r: { success: boolean; messageId?: string; error?: string };

    if (isWhatsApp) {
      const chatId = out.chatId;
      if (!chatId) return res.status(400).json({ error: 'draft is missing chatId' });
      const { sendReply } = await import('../services/whatsapp/UserWebjsProvider');
      r = await sendReply(user.id, chatId, body);
    } else {
      const to = req.body?.to ?? out.to;
      const subject = req.body?.subject ?? out.subject;
      const { sendUserEmail } = await import('../services/gmailService');
      r = await sendUserEmail(user.id, to, subject, body);
    }

    if (!r.success) return res.status(500).json({ error: r.error ?? 'send failed' });
    await prisma.agentAction.update({
      where: { id },
      data: { status: 'approved', output: { ...out, sentAt: new Date().toISOString(), messageId: r.messageId } as any },
    });
    // Write the TERMINAL decision_log now — MD actually sent the reply.
    // The earlier 'drafted' decision kept the card visible while the
    // draft was pending; 'approved' drops it from Attention permanently
    // and feeds the rule miner the real signal (MD actually replied).
    try {
      const inp: any = draft.input ?? {};
      if (inp.feedEventId) {
        const { computeDedupHash } = await import('../services/triage/triageSuggester');
        const { classifyArchetypeFromPayload } = await import('../services/triage/executorHelpers');
        const fe = await prisma.feedEvent.findUnique({
          where: { id: String(inp.feedEventId) },
          select: { senderEmail: true, sourceType: true, rawPayload: true },
        }).catch(() => null);
        const payload = (fe?.rawPayload as any) ?? {};
        const senderDomain = fe?.senderEmail ? fe.senderEmail.split('@')[1]?.toLowerCase().replace(/[>]/g, '') : undefined;
        const itemType =
          fe?.sourceType === 'gmail' ? 'email' :
          fe?.sourceType === 'whatsapp' ? 'whatsapp' :
          fe?.sourceType === 'gcal' ? 'meeting' : 'email';
        const archetype = classifyArchetypeFromPayload(
          String(payload.subject ?? ''),
          String(payload.snippet ?? payload.body ?? ''),
          String(payload.from ?? fe?.senderEmail ?? ''),
        );
        const dedupHash = computeDedupHash({ userId: user.id, itemType: itemType as any, archetype: archetype as any, senderDomain });
        await prisma.decisionLog.create({
          data: {
            id: `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            clientNumber: user.clientNumber,
            userId: user.id,
            sessionType: 'decide',
            itemType: itemType as string,
            entityId: String(inp.feedEventId),
            connectorSlug: fe?.sourceType ?? null,
            userDecision: 'approved',
            actionTaken: 'reply_sent',
            dedupHash,
          } as any,
        }).catch(() => {});
      }
    } catch { /* decision_log best-effort */ }
    // Now that the reply has been sent, mark the ORIGINAL incoming email
    // as read (the one Brain drafted a reply to). The feed_event linked via
    // draft.input.feedEventId carries the Gmail message id as sourceId.
    try {
      const inp: any = draft.input ?? {};
      if (inp.feedEventId) {
        const fe = await prisma.feedEvent.findFirst({
          where: { id: String(inp.feedEventId), clientNumber: user.clientNumber },
          select: { sourceId: true, sourceType: true, rawPayload: true },
        });
        if (fe?.sourceType === 'gmail' && fe.sourceId) {
          const { markAsRead } = await import('../services/gmailService');
          await markAsRead(user.id, fe.sourceId);
        } else if (fe?.sourceType === 'whatsapp') {
          const rp: any = fe.rawPayload ?? {};
          const target = rp.chatId || rp.waMessageId;
          if (target) {
            const { markAsRead } = await import('../services/whatsapp/UserWebjsProvider');
            await markAsRead(user.id, target);
          }
        }
        // Also flip feed_event status so it disappears from Attention if still there
        await prisma.feedEvent.updateMany({
          where: { id: String(inp.feedEventId), clientNumber: user.clientNumber },
          data: { status: 'processed', processedAt: new Date() },
        });
      }
    } catch { /* best effort */ }
    res.json({ ok: true, messageId: r.messageId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Reject a draft → mark so it disappears from the queue but stays in audit. */
router.post('/drafts/:id/reject', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  const reason = String(req.body?.reason ?? '');
  const draft = await prisma.agentAction.findFirst({
    where: { id, clientNumber: user.clientNumber, userId: user.id, actionType: 'draft_reply' } as any,
  });
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  await prisma.agentAction.update({
    where: { id },
    data: { status: 'rejected', output: { ...(draft.output as any), rejectedAt: new Date().toISOString(), rejectReason: reason } as any },
  });
  res.json({ ok: true });
});

/**
 * GET /brief/cognitive — what the cognitive engine has noticed recently.
 * Returns: { mindState: { body, updatedAt }, observations: [...] }
 * Read-only. The worker publishes observations on its 30-min tick.
 */
router.get('/cognitive', async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const { getLatestObservations, getMindState } = await import('../services/knowledge/brainCognitiveEngine');
    const [obs, mind] = await Promise.all([
      getLatestObservations(user.clientNumber, user.id, 8),
      getMindState(user.clientNumber, user.id),
    ]);
    res.json({
      mindState: mind,
      observations: obs.map((o: any) => ({
        id: o.id,
        title: o.title,
        kind: o.kind,
        urgency: o.urgency ?? 0,
        summary: (o.metadata as any)?.summary ?? '',
        anchors: (o.metadata as any)?.anchors ?? [],
        updatedAt: o.lastUpdatedAt,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /brief/cognitive/run — force a cognitive tick for the current
 * user. Lets the UI trigger an immediate re-think without waiting for
 * the next 30-min cycle.
 */
router.post('/cognitive/run', async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const { runCognitiveTick } = await import('../services/knowledge/brainCognitiveEngine');
    const r = await runCognitiveTick(user.clientNumber, user.id);
    res.json(r);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /brief/attention/:feedEventId/apply-rule
 * Body: { ruleId }
 *
 * The user clicked the "Apply rule X" button on a SUGGEST-mode rule
 * surfaced on an Attention card. We:
 *  1. Verify the rule still exists, is active, and belongs to this user.
 *  2. Fire it through `executeViaRegistry` with the rule's payload
 *     enriched with the inbound event's context (threadId/from/etc.).
 *  3. Stamp the agent_action with `executedByAgent='user_action_rule_manual:<id>'`
 *     so audit knows it was a user-confirmed rule application, not auto.
 *  4. Bump the rule's `triggered_count` (not `auto_executed_count`).
 */
router.post('/attention/:feedEventId/apply-rule', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const feedEventId = String(req.params.feedEventId);
  const ruleId = String(req.body?.ruleId ?? '');
  if (!ruleId) return res.status(400).json({ error: 'ruleId required' });

  try {
    const event = await prisma.feedEvent.findFirst({
      where: { id: feedEventId, clientNumber: user.clientNumber, userId: user.id },
      select: { senderEmail: true, senderName: true, rawPayload: true, sourceType: true },
    });
    if (!event) return res.status(404).json({ error: 'feed event not found' });

    const { getRule, noteFire } = await import('../services/userActionRuleService');
    const rule = await getRule(user.clientNumber, ruleId);
    if (!rule) return res.status(404).json({ error: 'rule not found' });
    if (rule.scope === 'user' && rule.userId !== user.id) {
      return res.status(403).json({ error: 'not your rule' });
    }
    if (!rule.isActive) return res.status(400).json({ error: 'rule is archived' });

    const payload = (event.rawPayload as any) ?? {};
    const enrichedPayload = {
      ...(rule.actionPayload ?? {}),
      feedEventId,
      threadId: payload.threadId,
      from: payload.from ?? event.senderName ?? event.senderEmail,
      senderEmail: event.senderEmail,
      subject: payload.subject ?? '',
      preview: payload.snippet ?? payload.body ?? '',
    };

    const { executeViaRegistry } = await import('../services/actions/executeViaRegistry');
    const r = await executeViaRegistry({
      actionType: rule.actionType,
      clientNumber: user.clientNumber,
      userId: user.id,
      payload: enrichedPayload,
      confidence: rule.confidenceThreshold,
      executedByAgent: `user_action_rule_manual:${rule.id}`,
    });

    await noteFire(user.clientNumber, rule.id, { autoExecuted: false });

    // Audit. Manual rule application is a different flavour than AUTO —
    // the user explicitly approved this single firing, not promoted to AUTO.
    try {
      const { audit } = await import('../services/auditLogService');
      await audit({
        clientNumber: user.clientNumber,
        actorId: user.id,
        actorKind: 'user',
        action: 'brain.action.executed',
        subjectType: 'user_action_rule_manual',
        subjectId: rule.id,
        result: r.ok ? 'success' : 'failure',
        details: { ruleName: rule.name, actionType: rule.actionType, feedEventId, error: r.error ?? null },
      });
    } catch { /* audit best-effort */ }

    res.json({ ok: r.ok, error: r.error, actionId: r.actionId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /brief/brain-actions/:id/override
 * Body: { reason, replacementAction, delegatee? }
 *
 * The MD is correcting an autonomous action AND teaching Brain the right
 * answer. "Not just stop — do this instead next time."
 *
 *   1. Reverse the action where technically possible.
 *   2. Mark the agent_action as 'overridden'.
 *   3. Write a decision_log row with action_taken = replacementAction so the
 *      rule miner sees a new vote for that action on this dedup_hash.
 *   4. If the replacement now dominates the hash's history, flip the
 *      governing shadow_rule's action (same hash, new action) so Brain
 *      starts doing the correct thing immediately.
 *   5. Record overrides on the old rule; auto-freeze if ignored too often.
 */
router.post('/brain-actions/:id/override', async (req: Request, res: Response) => {
  try {
  const user = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  const reason = String(req.body?.reason ?? 'Brain got this wrong');
  const replacementAction = String(req.body?.replacementAction ?? '');
  const replacementDelegatee = req.body?.delegatee ?? null;
  // applyToSimilar: when true, after overriding this action, find every
  // OTHER open agent_action with the same dedup_hash and apply the same
  // override. Saves the MD from Fix-clicking 6 identical Plaud transcripts.
  const applyToSimilar = req.body?.applyToSimilar === true;
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  if (!replacementAction) return res.status(400).json({ error: 'replacementAction required — tell Brain what to do instead' });

  const action = await prisma.agentAction.findFirst({
    where: { id, clientNumber: user.clientNumber, userId: user.id } as any,
  });
  if (!action) return res.status(404).json({ error: 'action not found' });

  const input = (action.input as any) ?? {};
  const output = (action.output as any) ?? {};
  const ruleId = input.ruleId as string | undefined;
  const feedEventId = input.feedEventId as string | undefined;
  const reversals: string[] = [];

  // ── 1. Technical reversal per action type ─────────────────
  switch (action.actionType) {
    case 'ignore_email':
    case 'acknowledge':
      if (feedEventId) {
        await prisma.feedEvent.updateMany({
          where: { id: feedEventId, clientNumber: user.clientNumber },
          data: { status: 'new', processedAt: null } as any,
        }).catch(() => {});
        reversals.push('feed_event returned to Attention');
      }
      break;
    case 'add_open_item':
      if (output.openItemId) {
        await prisma.openItem.updateMany({
          where: { id: String(output.openItemId), clientNumber: user.clientNumber, userId: user.id },
          data: { status: 'CLOSED' } as any,
        }).catch(() => {});
        reversals.push('open_item closed');
      }
      break;
    case 'delegate_forward':
      reversals.push('email already sent (cannot unsend); delegation flagged as reversed');
      break;
    case 'draft_reply':
      reversals.push('draft was held — no message ever sent');
      break;
    default:
      reversals.push('no technical reversal for ' + action.actionType);
  }

  await prisma.agentAction.update({
    where: { id },
    data: { status: 'overridden', error: reason, undoStatus: 'undone' } as any,
  });

  // ── 2. Load feed_event context + compute canonical hash ──
  const { computeDedupHash } = await import('../services/triage/triageSuggester');
  const { classifyArchetypeFromPayload } = await import('../services/triage/executorHelpers');
  let dedupHash: string | undefined;
  let itemType: any = 'email';
  if (feedEventId) {
    const fe = await prisma.feedEvent.findUnique({
      where: { id: feedEventId },
      select: { senderEmail: true, sourceType: true, rawPayload: true },
    }).catch(() => null);
    const payload = (fe?.rawPayload as any) ?? {};
    const senderDomain = fe?.senderEmail ? fe.senderEmail.split('@')[1]?.toLowerCase().replace(/[>]/g, '') : undefined;
    itemType =
      fe?.sourceType === 'gmail' ? 'email' :
      fe?.sourceType === 'whatsapp' ? 'whatsapp' :
      fe?.sourceType === 'gcal' ? 'meeting' : 'email';
    const archetype = classifyArchetypeFromPayload(
      String(payload.subject ?? ''),
      String(payload.snippet ?? payload.body ?? ''),
      String(payload.from ?? fe?.senderEmail ?? ''),
    );
    dedupHash = computeDedupHash({ userId: user.id, itemType, archetype, senderDomain });
  }

  // ── 3. Write decision_log carrying the REPLACEMENT action ──
  //     This is the positive teaching signal: MD said "do X instead".
  //     The rule miner will aggregate these on the next tick.
  if (dedupHash && feedEventId) {
    await prisma.decisionLog.create({
      data: {
        id: `dl_override_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        clientNumber: user.clientNumber,
        userId: user.id,
        sessionType: 'override',
        itemType,
        entityId: feedEventId,
        userDecision: mapActionToDecision(replacementAction as any),
        actionTaken: replacementAction,
        isMatch: false,
        overrideReason: reason,
        dedupHash,
      } as any,
    }).catch(() => {});

    // If replacementAction is 'delegate' and delegatee info provided, also
    // write a delegation_log row so the new mapping is counted.
    if (replacementAction === 'delegate' && replacementDelegatee) {
      await prisma.delegationLog.create({
        data: {
          id: `dg_override_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          clientNumber: user.clientNumber,
          userId: user.id,
          delegateeUserId: replacementDelegatee.userId ?? null,
          delegateeEmail: replacementDelegatee.email ?? null,
          delegateeName: replacementDelegatee.name ?? null,
          itemType, taskArchetype: null,
          entityId: feedEventId, sourceRef: feedEventId,
          delegatedBy: 'user',
          dedupHash,
        } as any,
      }).catch(() => {});
    }
  }

  // ── 4. Immediately flip the rule to the new action if it's now dominant ──
  let ruleUpdated = false;
  let ruleFrozen = false;
  if (ruleId && dedupHash) {
    const rule = await prisma.shadowRule.findUnique({ where: { id: ruleId } }).catch(() => null);
    if (rule) {
      const newOverrides = (rule.overrides ?? 0) + 1;

      // Recompute dominant action from all decision_logs for this hash
      const tally = await prisma.$queryRawUnsafe<Array<{ user_decision: string; n: number }>>(
        `SELECT user_decision, COUNT(*)::int AS n
           FROM decision_logs
          WHERE client_number = $1 AND user_id = $2 AND dedup_hash = $3
          GROUP BY user_decision ORDER BY n DESC`,
        user.clientNumber, user.id, dedupHash,
      ).catch(() => []);
      const total = tally.reduce((s, r) => s + r.n, 0);
      const dominant = tally[0];
      const agreement = total > 0 ? dominant.n / total : 0;

      // Map user_decision back to the rule's canonical action
      const newAction = dominant?.user_decision ?? rule.action;

      // Too many overrides on the old behaviour → freeze immediately
      const shouldFreeze = newOverrides >= 3 && newAction === rule.action;

      await prisma.shadowRule.update({
        where: { id: ruleId },
        data: {
          overrides: newOverrides,
          action: newAction,
          agreement,
          mode: shouldFreeze ? 'FROZEN' : rule.mode,
          frozenReason: shouldFreeze ? `Auto-frozen: ${newOverrides} MD overrides` : rule.frozenReason,
          description: `Updated after MD correction — dominant action is now "${newAction}" (${Math.round(agreement * 100)}% consistent)`,
        } as any,
      }).catch((e: any) => {
        // Rule may have been deleted between findUnique and update.
        // Log and continue — MD's override already got its teaching signal
        // written to decision_logs above.
        console.warn(`[override] shadowRule.update failed for ruleId=${ruleId}: ${e.message}`);
      });
      ruleUpdated = newAction !== rule.action;
      ruleFrozen = shouldFreeze;
    }
  }

  // ── 5. Apply same override to all open siblings with same dedup_hash ──
  //     So the MD doesn't have to Fix-click six identical Plaud transcripts
  //     one by one. Only touches OPEN actions that haven't been overridden
  //     or approved already.
  let siblingsFixed = 0;
  if (applyToSimilar && dedupHash) {
    const siblings = await prisma.$queryRawUnsafe<any[]>(
      `SELECT aa.id, aa.action_type AS "actionType", aa.output, aa.input
         FROM agent_actions aa
        WHERE aa.client_number = $1 AND aa.user_id = $2
          AND aa.id <> $3
          AND aa.status NOT IN ('overridden','rejected')
          AND aa.input ? 'feedEventId'
          AND EXISTS (
            SELECT 1 FROM feed_events fe
             WHERE fe.id = aa.input->>'feedEventId'
               AND fe.client_number = $1
          )`,
      user.clientNumber, user.id, id,
    ).catch(() => []);

    for (const s of siblings) {
      const sInput: any = s.input ?? {};
      const sFeedId = sInput.feedEventId;
      if (!sFeedId) continue;
      const sFe = await prisma.feedEvent.findUnique({
        where: { id: sFeedId },
        select: { senderEmail: true, sourceType: true, rawPayload: true },
      }).catch(() => null);
      if (!sFe) continue;
      const sPayload: any = sFe.rawPayload ?? {};
      const sSenderDomain = sFe.senderEmail ? sFe.senderEmail.split('@')[1]?.toLowerCase().replace(/[>]/g, '') : undefined;
      const sItemType: any =
        sFe.sourceType === 'gmail' ? 'email' :
        sFe.sourceType === 'whatsapp' ? 'whatsapp' :
        sFe.sourceType === 'gcal' ? 'meeting' : 'email';
      const sArchetype = classifyArchetypeFromPayload(
        String(sPayload.subject ?? ''),
        String(sPayload.snippet ?? sPayload.body ?? ''),
        String(sPayload.from ?? sFe.senderEmail ?? ''),
      );
      const sHash = computeDedupHash({
        userId: user.id, itemType: sItemType,
        archetype: sArchetype as any, senderDomain: sSenderDomain,
      });
      if (sHash !== dedupHash) continue;  // not actually similar

      // Technical reversal per action type
      const sOut: any = s.output ?? {};
      if (s.actionType === 'add_open_item' && sOut.openItemId) {
        await prisma.openItem.updateMany({
          where: { id: String(sOut.openItemId), clientNumber: user.clientNumber, userId: user.id },
          data: { status: 'CLOSED' } as any,
        }).catch(() => {});
      }
      if ((s.actionType === 'ignore_email' || s.actionType === 'acknowledge') && sFeedId) {
        await prisma.feedEvent.updateMany({
          where: { id: sFeedId, clientNumber: user.clientNumber },
          data: { status: 'new', processedAt: null } as any,
        }).catch(() => {});
      }
      await prisma.agentAction.update({
        where: { id: s.id },
        data: { status: 'overridden', error: `${reason} (bulk-applied)`, undoStatus: 'undone' } as any,
      }).catch(() => {});
      siblingsFixed++;
    }
  }

  const msg = siblingsFixed > 0
    ? `Got it. Applied to this + ${siblingsFixed} similar item${siblingsFixed === 1 ? '' : 's'}. Brain will ${humanLabel(replacementAction)} for this pattern going forward.`
    : ruleUpdated
      ? `Got it. Next time I'll ${humanLabel(replacementAction)} for this pattern.`
      : ruleFrozen
        ? 'Noted. I\'ve stopped this rule — too many overrides.'
        : 'Noted — Brain will weigh this the next time it sees the pattern.';

  res.json({ ok: true, reversals, ruleUpdated, ruleFrozen, siblingsFixed, message: msg });
  } catch (err: any) {
    console.warn(`[override] failed for id=${req.params.id}: ${err.message}`, err.stack);
    res.status(500).json({ error: err.message || 'Override failed — check server logs' });
  }
});

function humanLabel(action: string): string {
  return ({
    draft_reply: 'draft a reply for you',
    delegate: 'delegate it',
    add_open_item: 'add it to Open Items',
    ignore: 'archive it quietly',
    schedule_meeting: 'queue it for the calendar handler',
    acknowledge: 'acknowledge and move on',
  } as Record<string, string>)[action] ?? action;
}

/**
 * GET /brief/connector-gaps — which standard feeds is this user missing?
 *
 * A MyOS user needs at minimum Email + Calendar + Messaging for Brain to
 * have useful signal. Each slug below is part of the "standard feed set";
 * if the user has no `connected` UserConnector matching the group, it
 * shows up as a gap with a reason the UI can render. Brain proactively
 * surfaces this so a new MD doesn't stare at an empty Day Brief
 * wondering why nothing is flowing.
 *
 * Groups (at least ONE connector in each group satisfies the gap):
 *   email      → gmail | outlook
 *   calendar   → google_calendar | outlook_calendar
 *   messaging  → whatsapp_personal | whatsapp | telegram
 *   tasks      → (optional) google_tasks | ms_todo | todoist
 */
router.get('/connector-gaps', async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const rows = await prisma.userConnector.findMany({
      where: { userId: user.id, clientNumber: user.clientNumber },
      include: { connectorType: { select: { slug: true, name: true } } },
    });
    // A connector counts as "working" if either:
    //   - user_connectors.status = 'connected', OR
    //   - metadata.connectedNumber / metadata.status='connected' is set
    //     (whatsapp_personal: socket state lives in metadata).
    const slugs = new Set(
      rows
        .filter((c) => {
          if (c.status === 'connected') return true;
          const m: any = c.metadata ?? {};
          return m?.status === 'connected' || !!m?.connectedNumber;
        })
        .map((c) => c.connectorType.slug),
    );
    const connected = rows.filter((c) => slugs.has(c.connectorType.slug));

    const groups: Array<{ id: string; label: string; why: string; options: Array<{ slug: string; name: string }>; required: boolean }> = [
      {
        id: 'email',
        label: 'Email',
        why: 'I need email to see who is writing to you and learn which senders you always reply to, archive, or delegate.',
        required: true,
        options: [ { slug: 'gmail', name: 'Gmail' }, { slug: 'outlook', name: 'Outlook' } ],
      },
      {
        id: 'calendar',
        label: 'Calendar',
        why: 'I use your calendar to see free/busy for scheduling and to avoid pulling you into work during meetings.',
        required: true,
        options: [ { slug: 'google_calendar', name: 'Google Calendar' }, { slug: 'outlook_calendar', name: 'Outlook Calendar' } ],
      },
      {
        id: 'messaging',
        label: 'Messaging',
        why: 'WhatsApp is where a lot of real work lands. Without it, I only see email patterns.',
        required: true,
        options: [ { slug: 'whatsapp_personal', name: 'WhatsApp (Personal)' }, { slug: 'whatsapp', name: 'WhatsApp (Business)' }, { slug: 'telegram', name: 'Telegram' } ],
      },
      {
        id: 'tasks',
        label: 'Tasks',
        why: 'Optional — if you track tasks elsewhere, I can bring them into Open Items so one queue holds everything.',
        required: false,
        options: [ { slug: 'google_tasks', name: 'Google Tasks' }, { slug: 'ms_todo', name: 'Microsoft To Do' }, { slug: 'todoist', name: 'Todoist' } ],
      },
    ];

    const gaps = groups
      .map((g) => ({ ...g, satisfied: g.options.some((o) => slugs.has(o.slug)) }))
      .filter((g) => !g.satisfied);

    res.json({
      connectedCount: connected.length,
      totalConnected: slugs.size,
      gaps,
      hasAnyFeed: slugs.size > 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /brief/rebuild-memory — backfill sender_history + sender_topic
 * Wiki pages from existing feed_events.
 *
 * Body: { wipeFirst?: boolean (default true), maxResummarize?: number (default 100) }
 */
router.post('/rebuild-memory', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const body = req.body ?? {};
  try {
    const { backfillSenderWiki } = await import('../services/knowledge/senderWikiBackfill');
    const summary = await backfillSenderWiki(user.clientNumber, user.id, {
      wipeFirst: body.wipeFirst !== false,
      maxResummarize: Number.isFinite(body.maxResummarize) ? Number(body.maxResummarize) : undefined,
    });
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /brief/warm-up-brain — full reset: pull historical feed from every
 * connected source (Gmail + Calendar), then rebuild sender_history Wiki
 * pages from the fresh + existing feed_events. Use when onboarding a new
 * user who just connected their first connector.
 *
 * Body: { gmailDays?: 30, gmailCap?: 500, calendarDaysBack?: 30, calendarDaysAhead?: 60 }
 */
router.post('/warm-up-brain', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const body = req.body ?? {};
  try {
    const { warmUpBrainFromSources } = await import('../services/knowledge/historicalFeedPull');
    const result = await warmUpBrainFromSources(user.clientNumber, user.id, {
      gmailDays: Number.isFinite(body.gmailDays) ? Number(body.gmailDays) : undefined,
      gmailCap: Number.isFinite(body.gmailCap) ? Number(body.gmailCap) : undefined,
      calendarDaysBack: Number.isFinite(body.calendarDaysBack) ? Number(body.calendarDaysBack) : undefined,
      calendarDaysAhead: Number.isFinite(body.calendarDaysAhead) ? Number(body.calendarDaysAhead) : undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /brief/sync-now — manual pull for impatient users.
 * Triggers the same generic poller the 5-min cron uses (so behaviour is
 * identical — the difference is timing). Also calls the calendar poller.
 * Returns counts so UI can toast.
 */
router.post('/sync-now', async (req: Request, res: Response) => {
  const user = (req as any).user;
  try {
    const [genericResult, gcalResult] = await Promise.all([
      (async () => {
        const { pollAllTenants } = await import('../jobs/genericFeedPoller');
        const all = await pollAllTenants();
        // Filter to this tenant, summing gmail adapter's work
        const mine = all.filter((r) => r.tenantId === user.clientNumber);
        const gmail = mine.find((r) => r.source === 'gmail') ?? { fetched: 0, ingested: 0, duplicates: 0, errors: 0 };
        return gmail;
      })(),
      (async () => {
        const { pollAllActiveCalendarUsers } = await import('../jobs/gcalFeedPoller');
        const all = await pollAllActiveCalendarUsers();
        return all.find((r) => r.userId === user.id) ?? { fetched: 0, ingested: 0, duplicates: 0, errors: 0 };
      })(),
    ]);
    res.json({
      ok: true,
      gmail: genericResult,
      gcal: gcalResult,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Section 1 — Brief: autonomous actions Brain took in last 24h */
router.get('/brain-actions', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  try {
    // Exclude internal telemetry rows that the preference learner writes
    // to agent_actions (actionType='user_signal'). Those record YOUR
    // clicks, not actions Brain took for you — surfacing them in the
    // Brief mislabels them and pollutes the "20 actions I took" count.
    // Also exclude diagnostic / scoring rows that aren't user-facing.
    const INTERNAL_ACTION_TYPES = ['user_signal', 'feedback_diagnosis', 'criticality_calibration'];
    const actions = await prisma.agentAction.findMany({
      where: {
        clientNumber: user.clientNumber, userId: user.id,
        status: 'done', requiresApproval: false,
        createdAt: { gte: since },
        actionType: { notIn: INTERNAL_ACTION_TYPES },
      } as any,
      select: { id: true, actionType: true, input: true, output: true, riskTier: true, createdAt: true, executedByAgent: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json({
      actions: actions.map((a) => ({
        id: a.id,
        actionType: a.actionType,
        input: a.input,
        output: a.output,
        riskTier: a.riskTier,
        agent: a.executedByAgent,
        at: a.createdAt.toISOString(),
      })),
      count: actions.length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /brief/decide
 * Body:
 *   { feedEventId, itemType, archetype, senderDomain,
 *     action: 'draft_reply' | 'delegate' | 'add_open_item' | 'ignore' | 'schedule_meeting' | 'acknowledge',
 *     delegatee?: { userId?, email?, name? },
 *     note?: string,
 *     replyBody?: string (for draft_reply) }
 *
 * Writes append-only decision_log; if action=delegate, also writes delegation_log.
 * Both rows share the same dedup_hash so the scoring aggregation lines up.
 */
router.post('/decide', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const body = req.body ?? {};
  const { feedEventId, itemType, archetype, action } = body;

  if (!feedEventId || !itemType || !action) {
    return res.status(400).json({ error: 'feedEventId, itemType, action required' });
  }

  // Load the feed_event so we can enrich the audit row + re-run the
  // classifier to derive the canonical dedup_hash. This MUST match what the
  // autonomous executor computes — otherwise the MD's decisions and Brain's
  // auto-action hit different buckets.
  const event = await prisma.feedEvent.findFirst({
    where: { id: feedEventId, clientNumber: user.clientNumber },
    select: { id: true, clientNumber: true, userId: true, sourceType: true, sourceId: true, senderEmail: true, senderName: true, rawPayload: true, createdAt: true },
  });
  if (!event) return res.status(404).json({ error: 'feed event not found' });

  // Re-run the same classifier triageSuggester uses. Body-provided
  // archetype / senderDomain are only used as fallbacks if the feed_event
  // row lacks enough data.
  const suggestion = await suggestForFeedEvent({
    id: event.id,
    clientNumber: event.clientNumber,
    userId: event.userId ?? user.id,
    sourceType: event.sourceType,
    senderEmail: event.senderEmail,
    senderName: event.senderName,
    rawPayload: event.rawPayload as Record<string, unknown> | null,
    createdAt: event.createdAt,
  });

  const senderEmail = event.senderEmail ?? body.senderEmail ?? null;
  const subject = suggestion.subject || String(body.subject ?? '');
  const senderDomain = suggestion.senderDomain ?? (senderEmail ? senderEmail.split('@')[1]?.toLowerCase() : body.senderDomain);
  const dedupHash = suggestion.dedupHash;  // canonical — same one the executor will compute

  const traceId = crypto.randomUUID();

  // Always write a decision_log row (learning signal)
  const decisionId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await prisma.decisionLog.create({
    data: {
      id: decisionId,
      clientNumber: user.clientNumber,
      userId: user.id,
      sessionType: 'intraday',
      itemType: itemType as string,
      entityId: feedEventId,
      connectorSlug: event.sourceType ?? null,
      suggestedAction: body.suggestedAction ?? null,
      userDecision: mapActionToDecision(action),
      actionTaken: action as string,
      isMatch: body.wasBrainSuggestion === true,
      overrideReason: body.overrideReason ?? null,
      dedupHash,
      traceId,
    } as any,
  });

  // LIVING BRAIN: any new decision on this pattern changes what Brain
  // should reason about it. Bust the reasoner cache so next triage call
  // re-asks the LLM with fresh decision history.
  try {
    const { invalidateReasonerCache } = await import('../services/triage/triageReasoner');
    invalidateReasonerCache(dedupHash);
  } catch { /* cache module optional */ }

  // When MD clicks "Draft reply", compose a draft body now and park it in
  // agent_actions as a `draft_reply` with status='done' so it surfaces in
  // the Drafts section of Day Brief. Email uses general-tone; WhatsApp uses
  // per-chat tone (mirrors the MD's texting style with that exact contact).
  let draftReplyId: number | undefined;
  if (action === 'draft_reply') {
    try {
      const rp: any = event.rawPayload ?? {};
      const isWhatsApp = event.sourceType === 'whatsapp';
      let draftBody = '';
      let provider: string | undefined;

      if (isWhatsApp) {
        const { composeWhatsAppReply } = await import('../services/knowledge/toneService');
        draftBody = await composeWhatsAppReply({
          userId: user.id,
          chatId: String(rp.chatId || ''),
          incomingText: String(rp.body ?? (event.rawPayload as any)?.snippet ?? ''),
          senderName: event.senderName || rp.senderName || undefined,
          threadContext: Array.isArray(rp.threadContext) ? rp.threadContext : undefined,
          mdNote: body.note,
        });
        provider = 'tone:whatsapp';
      } else {
        const { callLLM } = await import('../services/llmRouter');
        const { withUserPrompts } = await import('../services/knowledge/userPromptService');
        const baseSys = `You are drafting a concise, professional reply on behalf of the user. 2-4 sentences. Match the MD's tone — polite, direct, no filler. Do NOT fabricate facts; if more info is needed, ask one clear question. NEVER mention MyOS, Brain, AI, or automation.`;
        const sys = await withUserPrompts(baseSys, user.id, 'draft_reply');
        const userMsg = `Incoming email:\nFrom: ${(event.rawPayload as any)?.from ?? event.senderEmail ?? ''}\nSubject: ${(event.rawPayload as any)?.subject ?? ''}\nPreview: ${String((event.rawPayload as any)?.snippet ?? '').slice(0, 600)}\n${body.note ? `\nWhat the user wants to say: ${body.note}` : ''}\n\nWrite only the reply body. No salutation or signature.`;
        const r = await callLLM(sys, userMsg, { maxTokens: 280, userId: user.id, clientNumber: user.clientNumber, purpose: 'manual_draft_reply' });
        draftBody = r.text;
        provider = r.provider;
      }

      const subjectLine = String((event.rawPayload as any)?.subject ?? '');
      const draft = await prisma.agentAction.create({
        data: {
          clientNumber: user.clientNumber,
          userId: user.id,
          actionType: 'draft_reply',
          status: 'done',
          requiresApproval: false,
          input: { feedEventId, itemType } as any,
          output: isWhatsApp ? {
            channel: 'whatsapp',
            chatId: rp.chatId,
            phoneNumber: rp.phoneNumber,
            body: draftBody,
            provider,
          } as any : {
            channel: 'email',
            to: event.senderEmail,
            subject: subjectLine ? `Re: ${subjectLine}` : '(no subject)',
            body: draftBody,
            provider,
          } as any,
        } as any,
        select: { id: true },
      });
      draftReplyId = draft.id;
    } catch (err: any) {
      console.warn(`[decide] draft_reply compose failed for ${feedEventId}: ${err.message}`);
    }
  }

  // If delegation, take three actions in addition to decision_log:
  //   1. Write delegation_log (scoring signal; ties to decision_log via hash)
  //   2. Forward the email via Gmail so the delegatee actually receives it
  //   3. If delegatee is an internal MyOS user, also create an OpenItem for
  //      them so it surfaces in their Action Center
  let forwarded: boolean | undefined;
  let forwardMessageId: string | undefined;
  let delegateeOpenItemId: string | undefined;

  if (action === 'delegate' && body.delegatee) {
    const delegateeEmail: string | undefined = body.delegatee.email;
    const delegateeName: string | undefined = body.delegatee.name;
    const delegateeUserId: number | undefined = body.delegatee.userId;

    // 1. Audit
    await prisma.delegationLog.create({
      data: {
        id: `dg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        clientNumber: user.clientNumber,
        userId: user.id,
        delegateeUserId: delegateeUserId ?? null,
        delegateeEmail: delegateeEmail ?? null,
        delegateeName: delegateeName ?? null,
        itemType: itemType as string,
        taskArchetype: archetype ?? null,
        entityId: feedEventId,
        sourceRef: String((event.rawPayload as any)?.threadId ?? feedEventId),
        senderEmail,
        senderDomain: senderDomain ?? null,
        subject: subject || null,
        briefNote: body.note ?? null,
        delegatedBy: 'user',
        traceId,
        dedupHash,
      } as any,
    });

    // 2. Forward via Gmail with a tone-matched cover note (no "MyOS" mention)
    //    and the MD CC'd so replies naturally loop back to them.
    if (delegateeEmail && event.sourceType === 'gmail') {
      try {
        const { sendUserEmail } = await import('../services/gmailService');
        const { composeForwardNote } = await import('../services/knowledge/toneService');
        const payload = (event.rawPayload ?? {}) as any;
        const originalFrom = payload.from ?? senderEmail ?? '(unknown)';
        const snippet = (payload.snippet ?? '').slice(0, 800);

        const coverNote = await composeForwardNote({
          userId: user.id,
          userName: user.name,
          delegateeName: delegateeName,
          originalSender: originalFrom,
          originalSubject: subject,
          originalSnippet: snippet,
          mdNote: body.note,
        });

        // Compose final body: cover-note + a clean separator + quoted
        // original. No system branding, no rule IDs, no "via MyOS".
        const dateLine = payload.date ? `On ${payload.date}, ${originalFrom} wrote:` : `${originalFrom} wrote:`;
        const fwdBody = [
          coverNote,
          '',
          '',
          '────────────────────────',
          dateLine,
          '',
          snippet,
        ].join('\n');

        const myEmail = user.integrationEmail ?? user.email;
        const r = await sendUserEmail(
          user.id,
          delegateeEmail,
          `Fwd: ${subject}`,
          fwdBody,
          myEmail && myEmail !== delegateeEmail ? myEmail : undefined,  // CC self so replies come back
        );
        forwarded = r.success;
        forwardMessageId = r.messageId;
      } catch (err: any) {
        forwarded = false;
        console.warn(`[decide] gmail forward failed for ${feedEventId}: ${err.message}`);
      }
    }

    // 3. If delegatee is an internal MyOS user, create an OpenItem on their
    //    Action Center so it gets the same triage loop treatment as their
    //    own incoming work.
    if (delegateeUserId) {
      const op = await prisma.openItem.create({
        data: {
          title: subject || `Delegated ${itemType} from ${user.name ?? 'MD'}`,
          description: [
            `Delegated by ${user.name ?? 'MD'} (${user.email ?? ''})`,
            `Original from: ${(event.rawPayload as any)?.from ?? senderEmail ?? '(unknown)'}`,
            body.note ? `\nNote: ${body.note}` : '',
            `\nOpen the source email in Gmail to see the full thread.`,
          ].filter(Boolean).join('\n'),
          type: itemType as string,
          status: 'NEW',
          priority: body.priority ?? 'medium',
          ownerId: delegateeUserId,
          delegateeId: delegateeUserId,
          delegateeName: delegateeName ?? null,
          delegateeEmail: delegateeEmail ?? null,
          sourceFeed: event.sourceType ?? null,
          sourceRef: feedEventId,
          clientNumber: user.clientNumber,
          userId: delegateeUserId, // scope to the delegatee's Day Brief
          sourceFeedEventId: feedEventId,
          archetype: archetype ?? null,
          delegationTrail: [{
            from: user.name ?? user.email ?? 'MD',
            at: new Date().toISOString(),
            note: body.note ?? null,
            traceId,
          }],
        } as any,
        select: { id: true },
      });
      delegateeOpenItemId = op.id;
    }

    // MD-owned DELEGATED tracker OpenItem — low priority, followUp due in
    // 7 days. The delegation tracker service watches inbound emails from
    // this delegatee and auto-closes/updates this item; the follow-up job
    // auto-pings the delegatee if no response by dueAt. Independent of the
    // delegatee's own OpenItem above (which lives on their Action Center).
    try {
      const followUpDueAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await prisma.openItem.create({
        data: {
          title: subject || `Delegated: ${itemType}`,
          description: [
            `Delegated to: ${delegateeName ?? delegateeEmail ?? 'someone'}`,
            `Original from: ${(event.rawPayload as any)?.from ?? senderEmail ?? '(unknown)'}`,
            body.note ? `Your note: ${body.note}` : '',
            `\nI'll watch for their reply and update you. If nothing comes back by ${followUpDueAt.toDateString()}, I'll send a follow-up on your behalf.`,
          ].filter(Boolean).join('\n'),
          type: 'delegation',
          status: 'DELEGATED',
          priority: 'low',
          ownerId: user.id,
          delegateeId: delegateeUserId ?? null,
          delegateeName: delegateeName ?? null,
          delegateeEmail: delegateeEmail ?? null,
          sourceFeed: event.sourceType ?? null,
          sourceRef: feedEventId,
          clientNumber: user.clientNumber,
          userId: user.id,
          sourceFeedEventId: feedEventId,
          archetype: archetype ?? null,
          delegationTrail: [{
            from: user.name ?? user.email ?? 'MD',
            to: delegateeName ?? delegateeEmail,
            at: new Date().toISOString(),
            note: body.note ?? null,
            traceId,
          }],
          metadata: {
            followUp: {
              dueAt: followUpDueAt.toISOString(),
              count: 0,
              lastSentAt: null,
              lastResponseAt: null,
              maxFollowUps: 3,
            },
          } as any,
        } as any,
      });
    } catch (err: any) {
      console.warn(`[decide] tracker OpenItem create failed for ${feedEventId}: ${err.message}`);
    }
  }

  // If add_open_item, create an OpenItem linked back to the feed_event.
  // Forwarded-email aware: when the source is gmail and the message is a
  // forward, lift the title from the forwarder's note (the actual ask) and
  // record original sender + forwarder in metadata so Brain knows who asked
  // who.
  let openItemId: string | undefined;
  if (action === 'add_open_item') {
    const rawPayload: any = event.rawPayload ?? {};
    const bodyText: string = String(rawPayload.body ?? rawPayload.snippet ?? '');
    let title = subject || `Follow up on ${itemType}`;
    let description = String(rawPayload.snippet ?? '');
    let forwardedMeta: any = undefined;
    if (event.sourceType === 'gmail') {
      try {
        const { parseForwardedEmail, buildOpenItemFromForward } = await import('../services/openItems/forwardedEmailParser');
        const parsed = parseForwardedEmail(subject ?? null, bodyText);
        if (parsed.isForwarded) {
          const built = buildOpenItemFromForward(
            parsed,
            senderEmail ?? null,
            (event as any).senderName ?? null,
            subject || `Follow up on ${itemType}`,
          );
          title = built.title;
          description = built.description;
          forwardedMeta = {
            forwarderEmail: senderEmail ?? null,
            forwarderName: (event as any).senderName ?? null,
            originalSenderEmail: parsed.originalSenderEmail,
            originalSenderName: parsed.originalSenderName,
            forwarderNote: parsed.forwarderNote,
          };
        }
      } catch { /* best-effort: fall back to raw subject/snippet */ }
    }
    const created = await prisma.openItem.create({
      data: {
        title,
        description,
        type: itemType as string,
        status: 'NEW',
        priority: body.priority ?? 'medium',
        ownerId: user.id,
        sourceFeed: event.sourceType ?? null,
        sourceRef: feedEventId,
        clientNumber: user.clientNumber,
        userId: user.id,
        sourceFeedEventId: feedEventId,
        archetype: archetype ?? null,
        metadata: forwardedMeta ? { forwarded: forwardedMeta } as any : undefined,
      } as any,
    });
    openItemId = created.id;
  }

  // Mark feed_event as processed
  try {
    await prisma.feedEvent.updateMany({
      where: { id: feedEventId, clientNumber: user.clientNumber },
      data: { status: 'processed', processedAt: new Date() },
    });
  } catch { /* best effort */ }

  // Mark the original message as read so MD's inbox counter reflects
  // that this event has been handled. For draft_reply we DON'T mark read
  // yet — the draft is just held for review; actual "read" happens when MD
  // clicks Send. Applies to both Gmail and WhatsApp.
  if (action !== 'draft_reply') {
    try {
      if (event.sourceType === 'gmail' && event.sourceId) {
        const { markAsRead } = await import('../services/gmailService');
        await markAsRead(user.id, event.sourceId);
      } else if (event.sourceType === 'whatsapp') {
        const rp: any = (event as any).rawPayload ?? {};
        const target = rp.chatId || rp.waMessageId;
        if (target) {
          const { markAsRead } = await import('../services/whatsapp/UserWebjsProvider');
          await markAsRead(user.id, target);
        }
      }
    } catch { /* best effort */ }
  }

  // Compute current score for this dedup_hash so the UI can show progress
  const [decisionScore, delegationScore] = await Promise.all([
    prisma.decisionLog.count({ where: { clientNumber: user.clientNumber, userId: user.id, dedupHash } }),
    prisma.delegationLog.count({ where: { clientNumber: user.clientNumber, userId: user.id, dedupHash } }),
  ]);

  res.json({
    ok: true,
    decisionId,
    openItemId,
    dedupHash,
    score: decisionScore + delegationScore,
    traceId,
    // Delegation-specific:
    forwarded,            // true if Gmail forward succeeded, false if failed, undefined if not email
    forwardMessageId,     // Gmail message id so MD can click through to Sent
    delegateeOpenItemId,  // if delegatee is an internal user, their new OpenItem id
    // Draft reply-specific:
    draftReplyId,         // id of the composed draft agent_action (surfaces in Drafts)
  });
});

function mapActionToDecision(action: SuggestedAction | string): string {
  switch (action) {
    // 'drafted' is a PENDING decision — MD wants a reply but hasn't sent
    // it yet. Attention keeps showing this card (with the draft inline)
    // until MD clicks Send (→ 'approved') or Reject.
    case 'draft_reply': return 'drafted';
    case 'delegate': return 'delegated';
    case 'add_open_item': return 'snoozed';
    case 'ignore': return 'dismissed';
    case 'schedule_meeting': return 'approved';
    case 'acknowledge': return 'approved';
    default: return 'overrode';
  }
}

/** List pattern_insights (Reflection agent output) for Day Brief's
 *  "Noticed overnight" section. Plus a flag whether each insight can be
 *  converted into a shadow rule (those phrased "ignored X emails from Y"). */
router.get('/insights', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const rows = await prisma.patternInsight.findMany({
    where: { clientNumber: user.clientNumber, userId: user.id, status: 'new' } as any,
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, description: true, evidenceCount: true, createdAt: true },
  });
  res.json({
    insights: rows.map((r) => {
      // Detect "ignored N emails from domain" phrasing → rule-creation opportunity
      const m = r.description.match(/ignored (\d+) emails from (\S+)/i);
      return {
        id: r.id,
        description: r.description,
        evidence: r.evidenceCount,
        createdAt: r.createdAt.toISOString(),
        canCreateRule: !!m,
        ruleHint: m ? { senderDomain: m[2], action: 'ignore', archetype: 'inform_only', evidence: parseInt(m[1], 10) } : null,
      };
    }),
  });
});

/** One-click rule creation from a pattern insight nudge. */
router.post('/insights/:id/create-rule', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  const insight = await prisma.patternInsight.findFirst({
    where: { id, clientNumber: user.clientNumber, userId: user.id } as any,
  });
  if (!insight) return res.status(404).json({ error: 'not found' });
  const m = insight.description.match(/ignored (\d+) emails from (\S+)/i);
  if (!m) return res.status(400).json({ error: 'insight not rule-convertible' });
  const [, nStr, senderDomain] = m;
  const evidence = parseInt(nStr, 10);
  const { computeDedupHash } = await import('../services/triage/triageSuggester');
  const hash = computeDedupHash({ userId: user.id, itemType: 'email', archetype: 'inform_only', senderDomain: senderDomain.replace(/\.?$/, '').toLowerCase() });
  const ruleId = `manual_${user.clientNumber}_${user.id}_${hash.slice(0, 12)}`;
  const existing = await prisma.shadowRule.findUnique({ where: { id: ruleId } }).catch(() => null);
  if (existing) {
    await prisma.shadowRule.update({
      where: { id: ruleId },
      data: { mode: 'ACTIVE', action: 'dismissed', evidence, agreement: 1, updatedAt: new Date() },
    });
  } else {
    await prisma.shadowRule.create({
      data: {
        id: ruleId,
        clientNumber: user.clientNumber,
        userId: user.id,
        name: `auto: archive emails from ${senderDomain}`,
        description: `Created from pattern insight — you chose to auto-archive after ${evidence} manual ignores.`,
        archetype: 'inform_only',
        triggerCondition: { kind: 'dedup_hash', hash, itemType: 'email', archetype: 'inform_only', senderDomain: senderDomain.replace(/\.?$/, '').toLowerCase() } as any,
        action: 'dismissed',
        mode: 'ACTIVE',
        evidence, confirms: evidence, overrides: 0,
        agreement: 1,
      } as any,
    });
  }
  await prisma.patternInsight.update({
    where: { id },
    data: { status: 'acknowledged' } as any,
  });
  res.json({ ok: true, ruleId, mode: 'ACTIVE' });
});

/** Dismiss a pattern insight (not interesting — hide from future briefs). */
router.post('/insights/:id/dismiss', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  await prisma.patternInsight.updateMany({
    where: { id, clientNumber: user.clientNumber, userId: user.id },
    data: { status: 'dismissed' },
  });
  res.json({ ok: true });
});

/** Hide a pattern from My Attention going forward (soft — audit intact). */
router.post('/hide', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { dedupHash, reason } = req.body ?? {};
  if (!dedupHash) return res.status(400).json({ error: 'dedupHash required' });
  await prisma.patternHidden.upsert({
    where: { userId_source_dedupHash: { userId: user.id, source: 'decision', dedupHash } } as any,
    update: { reason: reason ?? null } as any,
    create: { userId: user.id, clientNumber: user.clientNumber, source: 'decision', dedupHash, reason: reason ?? null } as any,
  });
  res.json({ ok: true });
});

router.post('/unhide', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { dedupHash } = req.body ?? {};
  if (!dedupHash) return res.status(400).json({ error: 'dedupHash required' });
  await prisma.patternHidden.deleteMany({
    where: { userId: user.id, source: 'decision', dedupHash },
  });
  res.json({ ok: true });
});

/** Pattern scoreboard — list user's most-frequent decision + delegation patterns */
router.get('/patterns', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const [decisions, delegations, hidden] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(`
      SELECT dedup_hash AS "dedupHash",
             item_type  AS "itemType",
             user_decision AS "userDecision",
             COUNT(*)::int AS score
      FROM decision_logs
      WHERE client_number = $1 AND user_id = $2 AND dedup_hash IS NOT NULL
      GROUP BY dedup_hash, item_type, user_decision
      ORDER BY score DESC
      LIMIT $3
    `, user.clientNumber, user.id, limit).catch(() => []),
    prisma.$queryRawUnsafe<any[]>(`
      SELECT dedup_hash AS "dedupHash",
             item_type  AS "itemType",
             task_archetype AS "taskArchetype",
             COALESCE(delegatee_name, delegatee_email, '(unknown)') AS delegatee,
             COUNT(*)::int AS score
      FROM delegation_logs
      WHERE client_number = $1 AND user_id = $2
      GROUP BY dedup_hash, item_type, task_archetype, delegatee
      ORDER BY score DESC
      LIMIT $3
    `, user.clientNumber, user.id, limit).catch(() => []),
    prisma.patternHidden.findMany({
      where: { clientNumber: user.clientNumber, userId: user.id },
      select: { dedupHash: true, source: true },
    }),
  ]);
  const hiddenSet = new Set(hidden.map((h) => `${h.source}:${h.dedupHash}`));
  res.json({
    decisions: (decisions as any[]).map((d) => ({
      dedupHash: d.dedupHash,
      itemType: d.itemType,
      action: d.userDecision,
      score: d.score,
      hidden: hiddenSet.has(`decision:${d.dedupHash}`),
    })),
    delegations: (delegations as any[]).map((d) => ({
      dedupHash: d.dedupHash,
      itemType: d.itemType,
      archetype: d.taskArchetype,
      delegatee: d.delegatee,
      score: d.score,
      hidden: hiddenSet.has(`delegation:${d.dedupHash}`),
    })),
  });
});

// ── Decisions + Delegations browsers (audit views) ──────────────

/** List recent decision_logs for this user with filters. */
router.get('/decisions', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const sinceStr = req.query.since ? String(req.query.since) : null;
  const itemType = req.query.itemType ? String(req.query.itemType) : null;
  const action = req.query.action ? String(req.query.action) : null;
  const q = req.query.q ? String(req.query.q) : null;
  // source = 'mine' | 'brain' | 'all'  (default 'mine')
  // decision_logs are only written by user paths today (brain's autonomous
  // actions go to agent_actions instead). Kept for symmetry + future-proofing.
  const source = String(req.query.source ?? 'mine');

  const where: any = { clientNumber: user.clientNumber, userId: user.id };
  if (sinceStr) where.createdAt = { gte: new Date(sinceStr) };
  if (itemType) where.itemType = itemType;
  if (action) where.actionTaken = action;
  if (source === 'brain') where.agentId = { not: null };
  if (q) {
    where.OR = [
      { inputSummary: { contains: q, mode: 'insensitive' } },
      { outputSummary: { contains: q, mode: 'insensitive' } },
      { actionTaken: { contains: q, mode: 'insensitive' } },
    ];
  }
  const rows = await prisma.decisionLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, itemType: true, userDecision: true, actionTaken: true,
      inputSummary: true, outputSummary: true,
      createdAt: true, dedupHash: true, connectorSlug: true,
      entityId: true, overrideReason: true,
    },
  });
  res.json({ decisions: rows });
});

/** List recent delegation_logs for this user with filters. */
router.get('/delegations', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);
  const sinceStr = req.query.since ? String(req.query.since) : null;
  const itemType = req.query.itemType ? String(req.query.itemType) : null;
  const delegateeQ = req.query.delegatee ? String(req.query.delegatee) : null;
  const q = req.query.q ? String(req.query.q) : null;
  // source = 'mine' | 'brain' | 'all'  (default 'mine')
  const source = String(req.query.source ?? 'mine');

  const where: any = { clientNumber: user.clientNumber, userId: user.id };
  if (sinceStr) where.createdAt = { gte: new Date(sinceStr) };
  if (itemType) where.itemType = itemType;
  if (source === 'mine') where.delegatedBy = 'user';
  else if (source === 'brain') where.delegatedBy = 'brain';
  if (delegateeQ) {
    where.OR = [
      { delegateeName:  { contains: delegateeQ, mode: 'insensitive' } },
      { delegateeEmail: { contains: delegateeQ, mode: 'insensitive' } },
    ];
  }
  if (q) {
    where.AND = [
      {
        OR: [
          { subject:     { contains: q, mode: 'insensitive' } },
          { senderEmail: { contains: q, mode: 'insensitive' } },
          { briefNote:   { contains: q, mode: 'insensitive' } },
        ],
      },
    ];
  }
  const rows = await prisma.delegationLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, itemType: true, taskArchetype: true,
      delegateeName: true, delegateeEmail: true, delegateeUserId: true,
      senderEmail: true, senderDomain: true, subject: true, briefNote: true,
      delegatedBy: true, createdAt: true, dedupHash: true,
    },
  });
  res.json({ delegations: rows });
});

// ── Destructive deletes on audit logs ─────────────────────────
// These are the only ways decision_logs / delegation_logs can be deleted.
// Require explicit per-request opt-in. Also scope strictly to the caller's
// own user_id so an admin can't quietly nuke another user's audit trail
// by hitting this endpoint with a different id.

/**
 * Audit-log deletes use raw SQL inside an interactive transaction so that
 * `SET LOCAL myos.allow_log_delete = 'true'` reliably applies to the
 * subsequent DELETE on the same connection. Going through Prisma's client
 * (`tx.delegationLog.deleteMany`) routes through the $extends tenant
 * middleware which broke the SET LOCAL coupling on prod — the trigger
 * fired and the user saw the raw Postgres error.
 */
function sanitizeDeleteError(err: any): string {
  const msg = String(err?.message ?? '');
  if (/append-only/i.test(msg) && /cannot be deleted/i.test(msg)) {
    return 'This audit row is append-only and cannot be deleted by the platform. Contact support if removal is required for compliance.';
  }
  if (/permission denied/i.test(msg)) {
    return 'Permission denied — your account cannot delete this row.';
  }
  if (/not found/i.test(msg) || /no rows/i.test(msg)) {
    return 'Row not found or already deleted.';
  }
  // Generic fallback — never leak Postgres / Prisma internals to the UI.
  return 'Could not delete the row. Please try again or refresh the page.';
}

/** DELETE a single decision_log row. Body: { confirm: true } */
router.delete('/decisions/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'confirm flag required' });
  }
  try {
    const count = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL myos.allow_log_delete = 'true'`);
      // Raw SQL — going through tx.decisionLog.deleteMany hits the
      // $extends middleware which on prod broke the SET LOCAL coupling
      // and the trigger fired anyway. Raw SQL stays on the same conn.
      const r = await tx.$executeRawUnsafe(
        `DELETE FROM decision_logs WHERE id = $1 AND client_number = $2 AND user_id = $3`,
        id, user.clientNumber, user.id,
      );
      return Number(r);
    });
    if (count === 0) return res.status(404).json({ error: 'Row not found or not yours.' });
    res.json({ ok: true, deleted: count });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeDeleteError(err) });
  }
});

/** DELETE all decision_logs for this user. Body: { confirmPhrase: 'DELETE ALL MY DECISIONS' } */
router.post('/decisions/delete-all', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const phrase = String(req.body?.confirmPhrase ?? '');
  if (phrase !== 'DELETE ALL MY DECISIONS') {
    return res.status(400).json({
      error: "Type DELETE ALL MY DECISIONS exactly to confirm.",
    });
  }
  const source = String(req.body?.source ?? 'mine');
  const sinceStr = req.body?.since ? String(req.body.since) : null;
  const conds: string[] = ['client_number = $1', 'user_id = $2'];
  const params: any[] = [user.clientNumber, user.id];
  if (sinceStr) {
    params.push(new Date(sinceStr));
    conds.push(`created_at >= $${params.length}`);
  }
  if (source === 'brain') conds.push(`agent_id IS NOT NULL`);
  try {
    const count = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL myos.allow_log_delete = 'true'`);
      const r = await tx.$executeRawUnsafe(
        `DELETE FROM decision_logs WHERE ${conds.join(' AND ')}`,
        ...params,
      );
      return Number(r);
    });
    res.json({ ok: true, deleted: count });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeDeleteError(err) });
  }
});

/** DELETE a single delegation_log row. Body: { confirm: true } */
router.delete('/delegations/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'confirm flag required' });
  }
  try {
    const count = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL myos.allow_log_delete = 'true'`);
      const r = await tx.$executeRawUnsafe(
        `DELETE FROM delegation_logs WHERE id = $1 AND client_number = $2 AND user_id = $3`,
        id, user.clientNumber, user.id,
      );
      return Number(r);
    });
    if (count === 0) return res.status(404).json({ error: 'Row not found or not yours.' });
    res.json({ ok: true, deleted: count });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeDeleteError(err) });
  }
});

/** DELETE all delegation_logs. Body: { confirmPhrase: 'DELETE ALL MY DELEGATIONS' } */
router.post('/delegations/delete-all', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const phrase = String(req.body?.confirmPhrase ?? '');
  if (phrase !== 'DELETE ALL MY DELEGATIONS') {
    return res.status(400).json({
      error: "confirmPhrase must exactly match 'DELETE ALL MY DELEGATIONS'",
    });
  }
  const source = String(req.body?.source ?? 'mine'); // mine | brain | all
  const sinceStr = req.body?.since ? String(req.body.since) : null;
  const conds: string[] = ['client_number = $1', 'user_id = $2'];
  const params: any[] = [user.clientNumber, user.id];
  if (sinceStr) {
    params.push(new Date(sinceStr));
    conds.push(`created_at >= $${params.length}`);
  }
  if (source === 'mine') conds.push(`delegated_by = 'user'`);
  else if (source === 'brain') conds.push(`delegated_by = 'brain'`);
  try {
    const count = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL myos.allow_log_delete = 'true'`);
      const r = await tx.$executeRawUnsafe(
        `DELETE FROM delegation_logs WHERE ${conds.join(' AND ')}`,
        ...params,
      );
      return Number(r);
    });
    res.json({ ok: true, deleted: count });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeDeleteError(err) });
  }
});

// ── User prompts (natural-language steerings) ────────────────────

/** List prompts for the current user. */
router.get('/prompts', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const rows = await prisma.userPrompt.findMany({
    where: { clientNumber: user.clientNumber, userId: user.id },
    orderBy: [{ isActive: 'desc' }, { priority: 'desc' }, { createdAt: 'desc' }],
  });
  res.json({ prompts: rows });
});

/** Create a prompt. */
router.post('/prompts', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const { text, scope, priority } = req.body ?? {};
  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return res.status(400).json({ error: 'text required (min 3 chars)' });
  }
  const row = await prisma.userPrompt.create({
    data: {
      clientNumber: user.clientNumber,
      userId: user.id,
      text: text.trim(),
      scope: ['triage', 'draft_reply', 'delegation', 'whatsapp_reply', 'global'].includes(scope) ? scope : 'global',
      priority: typeof priority === 'number' ? priority : 0,
      isActive: true,
    } as any,
  });
  res.json({ ok: true, prompt: row });
});

/** Update (text / scope / isActive / priority). */
router.put('/prompts/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const { text, scope, isActive, priority } = req.body ?? {};
  const data: any = {};
  if (text !== undefined) data.text = String(text);
  if (scope !== undefined && ['triage', 'draft_reply', 'delegation', 'whatsapp_reply', 'global'].includes(scope)) data.scope = scope;
  if (typeof isActive === 'boolean') data.isActive = isActive;
  if (typeof priority === 'number') data.priority = priority;
  const row = await prisma.userPrompt.updateMany({
    where: { id, clientNumber: user.clientNumber, userId: user.id },
    data,
  });
  if (row.count === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

/** Delete. */
router.delete('/prompts/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = parseInt(String(req.params.id), 10);
  const row = await prisma.userPrompt.deleteMany({
    where: { id, clientNumber: user.clientNumber, userId: user.id },
  });
  if (row.count === 0) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ── Shadow rule management ────────────────────────────────────

/** List all shadow rules Brain has learned for this user. */
router.get('/rules', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const rules = await prisma.shadowRule.findMany({
    where: { clientNumber: user.clientNumber, userId: user.id },
    orderBy: [{ mode: 'asc' }, { evidence: 'desc' }],
    select: {
      id: true, name: true, description: true, archetype: true, action: true,
      mode: true, evidence: true, confirms: true, overrides: true, agreement: true,
      frozenReason: true, updatedAt: true, triggerCondition: true,
    },
  });
  res.json({ rules });
});

/** Build a human-readable rule name from action + trigger context. */
function buildRuleName(action: string, tc: any, delegateeLabel?: string | null): string {
  const itemType = tc?.itemType ?? 'email';
  const senderDomain = tc?.senderDomain ?? '';
  const fromPart = senderDomain ? `from ${senderDomain}` : `(${tc?.archetype ?? 'untagged'})`;
  switch (action) {
    case 'dismissed': return `auto: archive ${itemType}s ${fromPart}`;
    case 'approved':  return `auto: reply to ${itemType}s ${fromPart}`;
    case 'delegated': return `auto: delegate ${itemType}s ${fromPart}${delegateeLabel ? ` to ${delegateeLabel}` : ''}`;
    case 'snoozed':   return `auto: add ${itemType}s ${fromPart} to Open Items`;
    case 'overrode':  return `auto: review ${itemType}s ${fromPart}`;
    default:          return `auto: ${action} ${itemType}s ${fromPart}`;
  }
}

/** Manually edit a rule's action (and delegatee, if applicable).
 *  Setting action here locks the rule so subsequent miner runs respect
 *  the MD's choice — they'll still update evidence/agreement counters
 *  but won't revert the action. Body:
 *    { action, delegateeUserId?, delegateeEmail?, delegateeName? }
 */
router.put('/rules/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const { action, delegateeUserId, delegateeEmail, delegateeName } = req.body ?? {};
  const allowed = ['dismissed', 'approved', 'delegated', 'snoozed', 'overrode'];
  if (!allowed.includes(String(action))) {
    return res.status(400).json({ error: `action must be one of: ${allowed.join(', ')}` });
  }
  const rule = await prisma.shadowRule.findFirst({
    where: { id, clientNumber: user.clientNumber, userId: user.id },
  });
  if (!rule) return res.status(404).json({ error: 'rule not found' });

  const tc = (rule.triggerCondition as any) ?? {};
  const meta = (rule.metadata as any) ?? {};
  meta.userOverride = true;
  meta.userOverrideAt = new Date().toISOString();
  if (action === 'delegated' && (delegateeUserId || delegateeEmail)) {
    meta.delegatee = {
      userId: delegateeUserId ?? null,
      email: delegateeEmail ?? null,
      name: delegateeName ?? null,
    };
  } else if (action !== 'delegated') {
    delete meta.delegatee;
  }

  const newName = buildRuleName(action, tc, delegateeName ?? delegateeEmail);

  await prisma.shadowRule.update({
    where: { id },
    data: {
      action,
      name: newName,
      description: `MD set action to "${action}"${action === 'delegated' && (delegateeName || delegateeEmail) ? ` (delegatee: ${delegateeName ?? delegateeEmail})` : ''}. Evidence + agreement keep updating.`,
      metadata: meta as any,
    } as any,
  });

  res.json({ ok: true, name: newName });
});

router.post('/rules/:id/freeze', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const reason = String(req.body?.reason ?? 'User froze via UI');
  const r = await prisma.shadowRule.updateMany({
    where: { id, clientNumber: user.clientNumber, userId: user.id },
    data: { mode: 'FROZEN', frozenReason: reason } as any,
  });
  if (r.count === 0) return res.status(404).json({ error: 'rule not found' });
  res.json({ ok: true });
});

router.post('/rules/:id/unfreeze', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const r = await prisma.shadowRule.updateMany({
    where: { id, clientNumber: user.clientNumber, userId: user.id },
    data: { mode: 'ACTIVE', frozenReason: null } as any,
  });
  if (r.count === 0) return res.status(404).json({ error: 'rule not found' });
  res.json({ ok: true });
});

router.delete('/rules/:id', async (req: Request, res: Response) => {
  const user = (req as any).user;
  const id = String(req.params.id);
  const r = await prisma.shadowRule.deleteMany({
    where: { id, clientNumber: user.clientNumber, userId: user.id },
  });
  if (r.count === 0) return res.status(404).json({ error: 'rule not found' });
  res.json({ ok: true });
});

export default router;
