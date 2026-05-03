/**
 * MyOS — Autonomous Executor.
 *
 * When a new feed_event lands, check whether its dedup_hash matches any
 * ACTIVE shadow_rule for that user. If it does, Brain executes the rule's
 * action without surfacing the item to the MD. An agent_action row is
 * written with status='done', requiresApproval=false so the action shows
 * up in Day Brief Section 1 ("What I handled without you").
 *
 * First-cut action set (no LLM required):
 *   - ignore / dismissed → mark feed_event processed, log "archived"
 *   - add_open_item      → create an OpenItem row, log the creation
 *   - acknowledge        → mark feed_event acknowledged, log
 *   - draft_reply / delegate / schedule_meeting → defer (need LLM or
 *     explicit delegatee resolution). Fall back: don't auto-execute, leave
 *     the event in feed so triageSuggester's handledByRule still renders a
 *     suggestion if the MD opens Attention.
 *
 * Idempotency: we check for an existing agent_action with
 *   input.feedEventId = this event AND executedByAgent = 'rule_miner_auto'
 * so a retry or re-poll doesn't double-execute.
 */
import prisma from '../../db/prisma';
import { computeDedupHash, type ItemType, type Archetype, type SuggestedAction } from './triageSuggester';

export interface FeedEventForExec {
  id: string;
  clientNumber: string;
  userId: number | null;
  sourceType: string;
  senderEmail: string | null;
  senderName: string | null;
  rawPayload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface ExecResult {
  executed: boolean;
  action?: SuggestedAction | string;
  ruleId?: string;
  agentActionId?: number;
  reason?: string;
}

function domainOf(email?: string): string | undefined {
  if (!email) return undefined;
  const m = email.match(/@([^>\s]+)/);
  return m?.[1]?.toLowerCase();
}

function classifyArchetype(subject: string, preview: string, from: string): Archetype {
  const all = `${from} ${subject} ${preview}`.toLowerCase();
  if (/(newsletter|digest|unsubscribe|no[-_.]?reply|noreply)/.test(from) || /(webinar|save \d+%|\bsale\b)/.test(all)) return 'inform_only';
  if (/\b(meeting|call|invite|calendar|reschedule|schedule)\b/.test(all)) return 'schedule_meeting';
  if (/\b(approve|approval|sign.?off|review|authoris)/.test(all)) return 'review_risk';
  if (/\b(announcement|all.hands|company update)\b/.test(all)) return 'acknowledge';
  return 'reply_needed';
}

function decisionToAction(userDecision: string): SuggestedAction {
  switch (userDecision) {
    case 'dismissed': return 'ignore';
    case 'delegated': return 'delegate';
    case 'snoozed': return 'add_open_item';
    case 'approved': return 'draft_reply';
    default: return 'acknowledge';
  }
}

/**
 * Unified markAsRead across Gmail + WhatsApp. Called on terminal actions
 * (ignore_email, add_open_item, acknowledge, delegate) so the MD's inbox
 * counters drop in sync with Brain's action. Best-effort; failures are
 * swallowed because the source action has already succeeded.
 */
async function markSourceAsRead(event: FeedEventForExec): Promise<void> {
  if (!event.userId) return;
  try {
    if (event.sourceType === 'gmail') {
      const fe = await prisma.feedEvent.findUnique({ where: { id: event.id }, select: { sourceId: true } });
      if (!fe?.sourceId) return;
      const { markAsRead } = await import('../gmailService');
      await markAsRead(event.userId, fe.sourceId);
    } else if (event.sourceType === 'whatsapp') {
      const payload = (event.rawPayload ?? {}) as any;
      const target = payload.chatId || payload.waMessageId;
      if (!target) return;
      const { markAsRead } = await import('../whatsapp/UserWebjsProvider');
      await markAsRead(event.userId, target);
    }
  } catch { /* best effort */ }
}

export async function executeIfMatched(event: FeedEventForExec): Promise<ExecResult | null> {
  if (!event.userId) return null;

  const itemType: ItemType =
    event.sourceType === 'gmail' ? 'email' :
    event.sourceType === 'whatsapp' ? 'whatsapp' :
    event.sourceType === 'gcal' ? 'meeting' :
    event.sourceType === 'gtasks' ? 'task' : 'email';

  const payload = event.rawPayload ?? {};
  const subject = String((payload as any).subject ?? '');
  const preview = String((payload as any).snippet ?? (payload as any).body ?? '');
  const fromFull = String((payload as any).from ?? event.senderName ?? event.senderEmail ?? '');
  const senderDomain = domainOf(event.senderEmail ?? fromFull);
  const archetype = classifyArchetype(subject, preview, fromFull);

  const dedupHash = computeDedupHash({ userId: event.userId, itemType, archetype, senderDomain });

  // Standing instructions can VETO autonomous execution — the user's
  // 6th-layer rules override any learned shadow rule. Examples:
  //   - "Never auto-send without my approval"    → global_rule veto
  //   - "Alert me if anyone mentions EXIM"       → watchpoint_match veto
  //   - "Ask me first before delegating Raazia"  → subject_match veto
  // When a veto fires, we do NOT auto-execute whatever Brain had
  // learned; the event stays in Attention with a note for the user.
  try {
    const { findVetoForEvent } = await import('../knowledge/instructionMatcher');
    const veto = await findVetoForEvent(event.clientNumber, event.userId!, {
      senderEmail: event.senderEmail,
      senderName: event.senderName,
      subject,
      snippet: preview,
    });
    if (veto) {
      // Log so cognitive engine can surface it as an observation on
      // Day Brief — "held per your rule 'X'". The event itself flows
      // through the normal triage path and appears on Attention.
      const { appendTenantLog } = await import('../knowledge/tenantLogService');
      await appendTenantLog(event.clientNumber, event.userId!, {
        kind: 'instruction_veto',
        title: `auto-action held for ${event.sourceType} from ${fromFull.slice(0, 60)}`,
        detail: `instructionId=${veto.instruction.id} kind=${veto.instruction.kind} reason=${veto.reason} subject=${veto.instruction.subject ?? ''} action=${veto.instruction.action ?? ''} feedEventId=${event.id}`,
      }).catch(() => {});
      return {
        executed: false,
        reason: `vetoed_by_instruction:${veto.reason}`,
        action: undefined,
      };
    }
  } catch { /* best effort — never crash the executor on a matcher failure */ }

  // User-defined action rules — the editor lets the user write rules
  // like "forward Raazia emails to Asad". Each rule has a mode:
  //   DRAFT   : log only, no surface, no execute
  //   SUGGEST : record a suggestion (next-turn UI surfaces it as a
  //             pre-filled action on the Attention card)
  //   AUTO    : fire through the handler registry now
  // We evaluate BEFORE the legacy shadow-rule path because user-
  // authored rules are explicit intent and should win over learned
  // patterns when both match.
  try {
    const triggerKind: import('../userActionRuleService').TriggerKind =
      event.sourceType === 'gmail' ? 'inbound_email'
      : event.sourceType === 'whatsapp' ? 'inbound_whatsapp'
      : event.sourceType === 'gchat' ? 'inbound_chat'
      : 'inbound_any';

    const { evaluateRulesForEvent, noteFire } = await import('../userActionRuleService');
    const matches = await evaluateRulesForEvent({
      clientNumber: event.clientNumber, userId: event.userId!,
      triggerKind,
      senderEmail: event.senderEmail,
      senderName: event.senderName,
      senderDomain: senderDomain ?? null,
      subject, body: preview,
      archetype,
    });

    if (matches.length > 0) {
      const { appendTenantLog } = await import('../knowledge/tenantLogService');
      // Take the first match — UI lets user resolve conflicts manually.
      const m = matches[0];
      await noteFire(event.clientNumber, m.rule.id, { autoExecuted: m.rule.mode === 'AUTO' });

      if (m.rule.mode === 'AUTO') {
        // Fire through the registry. Pass the rule's action payload +
        // event context so handlers like forward_email can resolve
        // threadId/recipient. Conservative: confidence-gated so a
        // mis-fire still falls back to a draft if it looks risky.
        try {
          const { executeViaRegistry } = await import('../actions/executeViaRegistry');
          const enrichedPayload = {
            ...(m.rule.actionPayload ?? {}),
            feedEventId: event.id,
            threadId: (event.rawPayload as any)?.threadId,
            from: fromFull,
            senderEmail: event.senderEmail,
            subject, preview,
          };
          const r = await executeViaRegistry({
            actionType: m.rule.actionType,
            clientNumber: event.clientNumber,
            userId: event.userId!,
            payload: enrichedPayload,
            confidence: m.rule.confidenceThreshold,
            executedByAgent: `user_action_rule:${m.rule.id}`,
          });
          await appendTenantLog(event.clientNumber, event.userId!, {
            kind: 'decision',
            title: `user-rule fired: ${m.rule.name}`,
            detail: `ruleId=${m.rule.id} action=${m.rule.actionType} ok=${r.ok} feedEventId=${event.id}`,
          }).catch(() => {});
          return {
            executed: r.ok,
            reason: r.ok ? `user_rule_auto:${m.rule.id}` : `user_rule_failed:${r.error}`,
            action: m.rule.actionType,
            agentActionId: r.actionId,
          };
        } catch (err: any) {
          await appendTenantLog(event.clientNumber, event.userId!, {
            kind: 'decision',
            title: `user-rule failed: ${m.rule.name}`,
            detail: `ruleId=${m.rule.id} error=${err.message?.slice(0, 200)} feedEventId=${event.id}`,
          }).catch(() => {});
          // Fall through to existing shadow-rule path so Brain still triages.
        }
      } else {
        // SUGGEST or DRAFT — both surface to tenant_log so the user
        // can see the rule fired. UI reads recent matches and renders
        // a "Apply rule X" button on the matching Attention card.
        await appendTenantLog(event.clientNumber, event.userId!, {
          kind: m.rule.mode === 'SUGGEST' ? 'instruction_match' : 'decision',
          title: `user-rule [${m.rule.mode}] ${m.rule.name}`,
          detail: `ruleId=${m.rule.id} matched=${m.matchedOn.join(';')} feedEventId=${event.id} action=${m.rule.actionType}`,
        }).catch(() => {});
        // Keep going — let normal triage produce the Attention card.
      }
    }
  } catch { /* best effort */ }

  // Look up ACTIVE rule
  const rule = await prisma.shadowRule.findFirst({
    where: {
      clientNumber: event.clientNumber,
      userId: event.userId,
      mode: 'ACTIVE',
      triggerCondition: { path: ['hash'], equals: dedupHash } as any,
    },
    select: { id: true, action: true, agreement: true, name: true },
  }).catch(() => null);

  // No shadow rule — before bailing, see if a standing user instruction
  // fires on this event. Instructions are the 6th layer of MyOS: explicit
  // human orders ("always delegate Raazia's emails to Asad", "alert me on
  // EXIM"). A match here doesn't auto-execute the implied action (fuzzy
  // substring matching is not safe enough for real delegation), but we
  // log it into the tenant log so Brain sees the match on the next turn
  // and surfaces it on Day Brief via the cognitive engine.
  if (!rule) {
    void (async () => {
      try {
        const { matchInstructionsForEvent } = await import('../knowledge/instructionMatcher');
        const matches = await matchInstructionsForEvent(event.clientNumber, event.userId!, {
          senderEmail: event.senderEmail,
          senderName: event.senderName,
          subject,
          snippet: preview,
        });
        if (matches.length === 0) return;
        const { appendTenantLog } = await import('../knowledge/tenantLogService');
        for (const m of matches) {
          await appendTenantLog(event.clientNumber, event.userId!, {
            kind: 'instruction_match',
            title: `instruction "${m.instruction.title}" matched ${event.sourceType} from ${fromFull.slice(0, 60)}`,
            detail: `kind=${m.instruction.kind} matchedOn=${m.matchedOn} subject=${m.instruction.subject ?? ''} action=${m.instruction.action ?? ''} feedEventId=${event.id}`,
          });
        }
      } catch { /* best effort */ }
    })();
    return null;
  }

  // Translate rule.action (which stores the MD's user_decision verb like
  // 'dismissed' / 'delegated') into a concrete SuggestedAction
  const action = decisionToAction(rule.action);

  // Idempotency check
  const existing = await prisma.agentAction.findFirst({
    where: {
      clientNumber: event.clientNumber,
      userId: event.userId,
      executedByAgent: 'rule_miner_auto',
      input: { path: ['feedEventId'], equals: event.id } as any,
    },
    select: { id: true },
  }).catch(() => null);
  if (existing) {
    return { executed: false, ruleId: rule.id, action, reason: 'already executed' };
  }

  // Execute the action (first-cut: ignore + add_open_item + acknowledge)
  let actionType: string;
  let output: Record<string, unknown>;

  switch (action) {
    case 'ignore': {
      actionType = 'ignore_email';
      output = { archived: true, subject, from: fromFull, reason: `rule ${rule.id}` };
      await prisma.feedEvent.updateMany({
        where: { id: event.id, clientNumber: event.clientNumber },
        data: { status: 'processed', processedAt: new Date() },
      }).catch(() => {});
      await markSourceAsRead(event);
      break;
    }

    case 'add_open_item': {
      await markSourceAsRead(event);
      const item = await prisma.openItem.create({
        data: {
          title: subject || `Follow up on ${itemType}`,
          description: preview.slice(0, 500),
          type: itemType,
          status: 'NEW',
          priority: 'medium',
          ownerId: event.userId,
          sourceFeed: event.sourceType,
          sourceRef: event.id,
          clientNumber: event.clientNumber,
          userId: event.userId,
          sourceFeedEventId: event.id,
          archetype,
        } as any,
      });
      actionType = 'add_open_item';
      output = { openItemId: item.id, subject, from: fromFull, reason: `rule ${rule.id}` };
      await prisma.feedEvent.updateMany({
        where: { id: event.id, clientNumber: event.clientNumber },
        data: { status: 'processed', processedAt: new Date() },
      }).catch(() => {});
      break;
    }

    case 'acknowledge': {
      actionType = 'acknowledge';
      output = { subject, from: fromFull, reason: `rule ${rule.id}` };
      await prisma.feedEvent.updateMany({
        where: { id: event.id, clientNumber: event.clientNumber },
        data: { status: 'processed', processedAt: new Date() },
      }).catch(() => {});
      await markSourceAsRead(event);
      break;
    }

    case 'delegate': {
      // Forward the original thread to the recommended delegatee. Pick the
      // most frequent prior delegatee for this dedup_hash. If none, look up
      // best candidate via People Intelligence.
      const { suggestOwner } = await import('../knowledge/peopleIntelligenceService');
      const { classifyArchetypeFromPayload } = await import('./executorHelpers');
      const archetype = classifyArchetypeFromPayload(subject, preview, fromFull);

      // Top historical delegatee for the exact pattern
      const topDeleg = await prisma.delegationLog.groupBy({
        by: ['delegateeEmail', 'delegateeName', 'delegateeUserId'],
        where: { clientNumber: event.clientNumber, userId: event.userId },
        _count: true,
        take: 1,
      } as any).catch(() => [] as any[]);
      const histTop = topDeleg[0];

      // Fallback: people intelligence
      let delegateeEmail = histTop?.delegateeEmail as string | undefined;
      let delegateeName = histTop?.delegateeName as string | undefined;
      let delegateeUserId = histTop?.delegateeUserId as number | undefined;

      if (!delegateeEmail) {
        const ranked = await suggestOwner({
          clientNumber: event.clientNumber,
          itemType: itemType as any,
          archetype: archetype as any,
          senderDomain,
          senderEmail: event.senderEmail ?? undefined,
          subject, preview,
          excludeUserId: event.userId,
          limit: 1,
        });
        if (ranked[0]) {
          delegateeEmail = ranked[0].email;
          delegateeName = ranked[0].name;
          delegateeUserId = ranked[0].userId;
        }
      }

      if (!delegateeEmail) {
        return { executed: false, ruleId: rule.id, action, reason: 'no delegatee resolvable for this pattern' };
      }

      // Forward via Gmail with a tone-matched cover note (no MyOS branding)
      // and CC the MD so replies naturally come back to them.
      let forwardOk = false;
      try {
        const { sendUserEmail } = await import('../gmailService');
        const { composeForwardNote } = await import('../knowledge/toneService');
        const u = await prisma.user.findUnique({
          where: { id: event.userId },
          select: { name: true, email: true, integrationEmail: true },
        });
        const coverNote = await composeForwardNote({
          userId: event.userId,
          userName: u?.name ?? undefined,
          delegateeName: delegateeName ?? undefined,
          originalSender: fromFull,
          originalSubject: subject,
          originalSnippet: preview,
        });
        const fwdBody = [
          coverNote,
          '',
          '',
          '────────────────────────',
          `${fromFull} wrote:`,
          '',
          preview,
        ].join('\n');
        const myEmail = u?.integrationEmail ?? u?.email;
        const r = await sendUserEmail(
          event.userId,
          delegateeEmail,
          `Fwd: ${subject}`,
          fwdBody,
          myEmail && myEmail !== delegateeEmail ? myEmail : undefined,
        );
        forwardOk = r.success;
      } catch (err: any) {
        console.warn(`[autoExec] forward failed: ${err.message}`);
      }

      const crypto = await import('crypto');
      const { computeDedupHash } = await import('./triageSuggester');
      const dh = computeDedupHash({ userId: event.userId, itemType: itemType as any, archetype: archetype as any, senderDomain });
      await prisma.delegationLog.create({
        data: {
          id: `dg_auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          clientNumber: event.clientNumber,
          userId: event.userId,
          delegateeUserId: delegateeUserId ?? null,
          delegateeEmail, delegateeName: delegateeName ?? null,
          itemType, taskArchetype: archetype,
          entityId: event.id,
          sourceRef: String((event.rawPayload as any)?.threadId ?? event.id),
          senderEmail: event.senderEmail,
          senderDomain: senderDomain ?? null,
          subject, delegatedBy: 'brain',
          confidenceScore: rule.agreement ?? null,
          agentId: 'rule_miner_auto',
          dedupHash: dh,
          traceId: crypto.randomUUID(),
        } as any,
      }).catch(() => {});

      actionType = 'delegate_forward';
      output = {
        delegateeEmail, delegateeName,
        forwarded: forwardOk,
        subject, from: fromFull,
        reason: `rule ${rule.id}`,
      };
      await prisma.feedEvent.updateMany({
        where: { id: event.id, clientNumber: event.clientNumber },
        data: { status: 'processed', processedAt: new Date() },
      }).catch(() => {});
      await markSourceAsRead(event);
      break;
    }

    case 'draft_reply': {
      // LLM-compose a short reply and save it as a DRAFT agent_action for MD review.
      let body = '';
      let providerUsed: string | undefined;
      const isWhatsApp = event.sourceType === 'whatsapp';

      try {
        if (isWhatsApp) {
          // WhatsApp reply: per-chat tone, short, no greeting/signature.
          const rp: any = event.rawPayload ?? {};
          const chatId = rp.chatId || '';
          const { composeWhatsAppReply } = await import('../knowledge/toneService');
          body = await composeWhatsAppReply({
            userId: event.userId,
            chatId,
            incomingText: String(rp.body ?? preview ?? ''),
            senderName: event.senderName || rp.senderName || undefined,
            threadContext: Array.isArray(rp.threadContext) ? rp.threadContext : undefined,
          });
          providerUsed = 'tone:whatsapp';
        } else {
          // Email reply: general professional tone.
          const { callLLM } = await import('../llmRouter');
          const baseSys = `You are drafting a concise, professional reply on behalf of the user. Write 2-4 sentences. Match the MD's tone: polite, direct, no filler. Do NOT fabricate facts — if more info is needed, ask one clear question. NEVER mention MyOS, Brain, AI, or any automation — the reply must read as if the user wrote it.`;
          const { withUserPrompts } = await import('../knowledge/userPromptService');
          const sys = await withUserPrompts(baseSys, event.userId, 'draft_reply');
          const userMsg = `Incoming email:\nFrom: ${fromFull}\nSubject: ${subject}\nPreview: ${preview}\n\nWrite only the reply body. No salutation or signature — MyOS will add them.`;
          const r = await callLLM(sys, userMsg, { maxTokens: 280, userId: event.userId, clientNumber: event.clientNumber, purpose: 'auto_draft_reply' });
          body = r.text;
          providerUsed = r.provider;
        }
      } catch (err: any) {
        return { executed: false, ruleId: rule.id, action, reason: `LLM draft failed: ${err.message}` };
      }

      // Never auto-send — always save as draft for MD review.
      actionType = 'draft_reply';
      const rp: any = event.rawPayload ?? {};
      output = isWhatsApp ? {
        channel: 'whatsapp',
        chatId: rp.chatId,
        phoneNumber: rp.phoneNumber,
        body,
        provider: providerUsed,
        reason: `rule ${rule.id}`,
      } : {
        subject: `Re: ${subject}`,
        to: event.senderEmail,
        body,
        provider: providerUsed,
        reason: `rule ${rule.id}`,
      };
      // Don't mark feed_event processed yet — MD still decides on the draft.
      break;
    }

    case 'schedule_meeting': {
      // Calendar handling is orchestrated separately via the handler
      // registry (propose_times / create_event). For v1 we surface a
      // marker action that Day Brief can link to the calendar workflow.
      actionType = 'schedule_meeting_queued';
      output = { subject, from: fromFull, reason: `rule ${rule.id} — queued for calendar handler` };
      break;
    }

    default:
      return { executed: false, ruleId: rule.id, action, reason: `unknown action ${action}` };
  }

  // Write the agent_action row — this is what Day Brief Section 1 reads from.
  const row = await prisma.agentAction.create({
    data: {
      clientNumber: event.clientNumber,
      userId: event.userId,
      actionType,
      status: 'done',
      requiresApproval: false,
      executedByAgent: 'rule_miner_auto',
      riskTier: 'LOW',
      input: {
        feedEventId: event.id,
        ruleId: rule.id,
        subject, from: fromFull,
      } as any,
      output: output as any,
      undoStatus: action === 'add_open_item' ? 'undoable' : 'none',
    } as any,
    select: { id: true },
  });

  return { executed: true, action, ruleId: rule.id, agentActionId: row.id };
}
