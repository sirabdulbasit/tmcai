/**
 * genericActionDispatcher — data-driven action routing.
 *
 * Phase 4-5 of refactor (2026-05-22). Replaces the per-type switch
 * cases in instructionDispatcher.ts + the inline branches in
 * brainComposer's compose() with one entry point:
 *
 *   dispatch(action, ctx) →
 *     1. Load action_definitions row for action.type.
 *     2. Validate payload against the row's schema.
 *     3. Check capability_registry for requiresCapability.
 *     4. Dynamically import handlerModule, invoke handlerFunction.
 *     5. Return uniform DispatchResult.
 *
 * Handlers are referenced BY NAME (module + function). The actual
 * handler code lives in the existing services (calendarService,
 * gmailService, etc.) — only the routing layer is data-driven.
 * Brain can register a new action type by inserting a row with an
 * EXISTING handler reference; it cannot invoke arbitrary code.
 *
 * SAFETY: the handler registry below is a closed allow-list of
 * (module, function) pairs Brain is permitted to call. Even if a
 * malicious / buggy action_definitions row points at a different
 * module, the registry returns null and dispatch fails closed.
 */
import { getActionDefinition, validateActionPayload } from './actionRegistryService';
import { hasCapability } from './capabilityRegistryService';

export interface DispatchContext {
  userId: number;
  clientNumber: string;
}

export interface DispatchResult {
  ok: boolean;
  artifactId?: string;
  message: string;
  errorCode?: string;
  /** What an ok result actually PROVES (audit 2026-07-14 #6). Stamped
   *  by dispatchAction from CONFIRMATION_BY_HANDLER; callers rendering
   *  user-facing success text must not claim "sent/done" when this is
   *  'unverifiable' — say "dispatched, not yet confirmed" instead. */
  confirmation?: 'provider_confirmed' | 'locally_confirmed' | 'unverifiable';
}

/** Confirmation strength per allow-listed (module, function) pair.
 *  provider_confirmed = the provider returned a durable receipt (Gmail
 *  message id, Calendar event id, Meta wamid). locally_confirmed = the
 *  side effect is our own DB row. Unlisted pairs fail closed to
 *  'unverifiable'. */
const CONFIRMATION_BY_HANDLER: Record<string, DispatchResult['confirmation']> = {
  'calendarService.createEvent': 'provider_confirmed',
  'calendarService.deleteEvent': 'provider_confirmed',
  'calendarService.updateEvent': 'provider_confirmed',
  'gmailService.sendUserEmail': 'provider_confirmed',
  'tenantWhatsappSender.sendTenantWhatsAppText': 'provider_confirmed',
  'openItemsService.createItem': 'locally_confirmed',
  'openItemsService.delegateItem': 'locally_confirmed',
  'brainPersonaService.setBrainName': 'locally_confirmed',
  'userMemoryService.recordExplicitMemory': 'locally_confirmed',
};

/** Closed registry of permitted (handlerModule, handlerFunction)
 *  pairs. Even if action_definitions has a row pointing elsewhere,
 *  dispatch fails closed. New handlers must be added here by a
 *  human deploy — Brain cannot extend the registry at runtime. */
const HANDLER_REGISTRY: Record<string, Record<string, (userId: number, payload: any, ctx: DispatchContext) => Promise<DispatchResult>>> = {
  calendarService: {
    createEvent: async (userId, payload) => {
      const { createEvent } = await import('../calendarService');
      const { normalizeWhenIsoToLocalTz } = await getNormalizer();
      const { getUserTimezoneOffset } = await import('../userTimezoneService');
      const offset = await getUserTimezoneOffset(userId).catch(() => '+05:00');
      const normalized = normalizeWhenIsoToLocalTz(payload.whenIso, offset);
      const startDate = new Date(normalized);
      if (Number.isNaN(startDate.getTime())) {
        return { ok: false, message: `Schedule failed: couldn't parse "${payload.whenIso}".`, errorCode: 'parse_time' };
      }
      const duration = Math.max(1, payload.durationMin ?? 30);
      const endDate = new Date(startDate.getTime() + duration * 60_000);
      const attendees = [
        ...(Array.isArray(payload.attendeeEmails) ? payload.attendeeEmails : []),
        ...(Array.isArray(payload.attendeeNames) ? payload.attendeeNames : []),
      ].filter((a) => typeof a === 'string' && a.includes('@'));
      const r = await createEvent(userId, {
        title: payload.title,
        startTime: startDate.toISOString(),
        endTime: endDate.toISOString(),
        attendees,
      });
      if (r.error || !r.event) return { ok: false, message: `Schedule failed: ${r.error ?? 'unknown'}`, errorCode: 'calendar_api' };
      return {
        ok: true,
        artifactId: r.event.id,
        message: `Meeting "${payload.title}" scheduled for ${r.event.start}${attendees.length ? ` with ${attendees.join(', ')}` : ''}. Invites sent.`,
      };
    },
    deleteEvent: async (userId, payload) => {
      const { deleteEvent } = await import('../calendarService');
      const r = await deleteEvent(userId, payload.eventId);
      if (!r.success) return { ok: false, message: `Cancel failed: ${r.error ?? 'unknown'}`, errorCode: 'calendar_api' };
      return {
        ok: true,
        artifactId: payload.eventId,
        message: `Cancelled meeting${payload.titleHint ? ` "${payload.titleHint}"` : ''}.${payload.reason ? ` (${payload.reason})` : ''} Attendees notified.`,
      };
    },
    updateEvent: async (userId, payload) => {
      const { updateEvent } = await import('../calendarService');
      const { normalizeWhenIsoToLocalTz } = await getNormalizer();
      const { getUserTimezoneOffset } = await import('../userTimezoneService');
      const patch: any = {};
      if (payload.newWhenIso) {
        const offset = await getUserTimezoneOffset(userId).catch(() => '+05:00');
        const norm = normalizeWhenIsoToLocalTz(payload.newWhenIso, offset);
        const start = new Date(norm);
        if (Number.isNaN(start.getTime())) {
          return { ok: false, message: `Reschedule failed: couldn't parse "${payload.newWhenIso}".`, errorCode: 'parse_time' };
        }
        patch.startTime = start.toISOString();
        const dur = payload.newDurationMin > 0 ? payload.newDurationMin : 30;
        patch.endTime = new Date(start.getTime() + dur * 60_000).toISOString();
      }
      const r = await updateEvent(userId, payload.eventId, patch);
      if (r.error || !r.event) return { ok: false, message: `Reschedule failed: ${r.error ?? 'unknown'}`, errorCode: 'calendar_api' };
      return {
        ok: true,
        artifactId: r.event.id,
        message: `Rescheduled${payload.titleHint ? ` "${payload.titleHint}"` : ''} to ${r.event.start}. Attendees notified.`,
      };
    },
  },
  gmailService: {
    sendUserEmail: async (userId, payload, ctx) => {
      const { sendUserEmail } = await import('../gmailService');
      const { getBrainPersona } = await import('./brainPersonaService');
      const persona = await getBrainPersona(userId, ctx.clientNumber).catch(() => null);
      const userName = persona?.userFirstName || 'the user';
      const footer = `\n\n— Sent by Nexeo, ${userName}'s AI assistant`;
      const fullBody = `${payload.body ?? ''}${footer}`;
      const toArr = Array.isArray(payload.to) ? payload.to : [];
      const ccArr = Array.isArray(payload.cc) ? payload.cc : undefined;
      try {
        const r = await sendUserEmail(
          userId,
          toArr.join(', '),
          String(payload.subject ?? ''),
          fullBody,
          ccArr && ccArr.length ? ccArr.join(', ') : undefined,
        );
        if (!r.success) return { ok: false, message: `Email send failed: ${r.error ?? 'unknown'}`, errorCode: 'gmail_api' };
        return {
          ok: true,
          artifactId: r.messageId,
          message: `Sent email to ${toArr.join(', ')} — subject: "${payload.subject}".`,
        };
      } catch (e: any) {
        return { ok: false, message: `Email send failed: ${e?.message ?? 'unknown'}`, errorCode: 'exception' };
      }
    },
  },
  tenantWhatsappSender: {
    sendTenantWhatsAppText: async (userId, payload, ctx) => {
      const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
      const { getBrainPersona } = await import('./brainPersonaService');
      const persona = await getBrainPersona(userId, ctx.clientNumber).catch(() => null);
      const userName = persona?.userFirstName || 'the user';
      // Custom brain name when set ("Suzi"), Nexeo otherwise.
      const { getBrainDisplayName } = await import('./outboundIdentity');
      const brainName = await getBrainDisplayName(userId).catch(() => 'Nexeo');
      const intro = `Hi ${payload.recipientName}, this is ${brainName} — ${userName}'s AI assistant. ${userName} asked me to let you know:\n\n`;
      try {
        const { normalizeWhatsAppSubstantiveMessage, whatsappAcceptedMessage } = await import('./whatsappOutboundPolicy');
        const substantive = normalizeWhatsAppSubstantiveMessage(String(payload.message), String(payload.recipientName));
        const r = await sendTenantWhatsAppText(ctx.clientNumber, String(payload.recipientPhone), `${intro}${substantive}`, userId);
        if (!r.ok) return { ok: false, message: `WhatsApp send failed: ${r.error ?? 'unknown'}`, errorCode: 'wa_api' };
        return {
          ok: true,
          artifactId: r.waMessageId,
          message: r.waMessageId
            ? `Sent WhatsApp to ${payload.recipientName} (${payload.recipientPhone}) from the Nexeo number.`
            : whatsappAcceptedMessage(String(payload.recipientName), String(payload.recipientPhone)),
        };
      } catch (e: any) {
        return { ok: false, message: `WhatsApp send failed: ${e?.message ?? 'unknown'}`, errorCode: 'exception' };
      }
    },
  },
  openItemsService: {
    createItem: async (userId, payload, ctx) => {
      const { dispatchInstruction } = await import('../instructions/instructionDispatcher');
      const res = await dispatchInstruction({
        clientNumber: ctx.clientNumber,
        userId,
        instruction: {
          intent: 'add_open_item',
          confidence: 1,
          summary: String(payload.title),
          params: {
            itemTitle: payload.title,
            itemDueDate: payload.dueDate,
            itemNote: payload.note,
          },
        } as any,
      });
      return {
        ok: res.ok,
        artifactId: (res as any).artifactId,
        message: res.message,
      };
    },
    delegateItem: async (userId, payload, ctx) => {
      const { delegateItem } = await import('../openItemsService');
      try {
        await delegateItem(
          String(payload.openItemId),
          ctx.clientNumber,
          null,
          String(payload.delegateeName),
          payload.delegateeEmail ? String(payload.delegateeEmail) : undefined,
          payload.note ? String(payload.note) : undefined,
        );
        return {
          ok: true,
          artifactId: String(payload.openItemId),
          message: `Delegated "${payload.titleHint ?? payload.openItemId}" to ${payload.delegateeName} <${payload.delegateeEmail}>.`,
        };
      } catch (e: any) {
        return { ok: false, message: `Delegate failed: ${e?.message ?? 'unknown'}`, errorCode: 'exception' };
      }
    },
  },
  brainPersonaService: {
    setBrainName: async (userId, payload) => {
      const { setBrainName } = await import('./brainPersonaService');
      try {
        const saved = await setBrainName(userId, payload.name || null);
        return {
          ok: true,
          message: saved
            ? `Got it — from now on you can call me ${saved}.`
            : `Cleared my custom name — I'll go by "your AI assistant" from here on.`,
        };
      } catch (e: any) {
        return { ok: false, message: `Couldn't save the name: ${e?.message ?? 'unknown'}`, errorCode: 'exception' };
      }
    },
  },
  userMemoryService: {
    recordExplicitMemory: async (userId, payload, ctx) => {
      const { recordExplicitMemory } = await import('./userMemoryService');
      try {
        await recordExplicitMemory({
          clientNumber: ctx.clientNumber,
          userId,
          key: payload.key,
          value: payload.value,
        });
        const valStr = typeof payload.value === 'string' ? payload.value : JSON.stringify(payload.value);
        return {
          ok: true,
          artifactId: `pref:${payload.key}`,
          message: `Got it — I'll remember "${payload.key}" as ${valStr} going forward.`,
        };
      } catch (e: any) {
        return { ok: false, message: `Couldn't save preference: ${e?.message ?? 'unknown'}`, errorCode: 'exception' };
      }
    },
  },
};

/** Helper — reach into instructionDispatcher to grab normalizeWhenIsoToLocalTz
 *  without exporting it (it's not exported). For now we inline the same logic. */
async function getNormalizer() {
  return {
    normalizeWhenIsoToLocalTz(whenIso: string, fixedOffset: string): string {
      if (!whenIso || typeof whenIso !== 'string') return whenIso;
      if (/[Zz]|[+-]\d{2}:?\d{2}$/.test(whenIso)) return whenIso;
      let s = whenIso;
      if (/T\d{2}:\d{2}$/.test(s)) s = s + ':00';
      return s + fixedOffset;
    },
  };
}

/** Resolve a handler reference (module, function) from the registry.
 *  Returns null if not in the allow-list. */
function resolveHandler(module: string, fn: string): ((userId: number, payload: any, ctx: DispatchContext) => Promise<DispatchResult>) | null {
  return HANDLER_REGISTRY[module]?.[fn] ?? null;
}

/** All allow-listed (module, function) pairs — for the confirmation
 *  parity test: every dispatchable pair must declare what its success
 *  proves, or it fails closed to 'unverifiable'. */
export function listRegisteredHandlerPairs(): string[] {
  return Object.entries(HANDLER_REGISTRY).flatMap(([m, fns]) => Object.keys(fns).map((f) => `${m}.${f}`));
}

/** Declared confirmation strength for a pair ('unverifiable' when unmapped). */
export function confirmationForHandler(module: string, fn: string): NonNullable<DispatchResult['confirmation']> {
  return CONFIRMATION_BY_HANDLER[`${module}.${fn}`] ?? 'unverifiable';
}

/** True when a (module, function) pair is in the closed allow-list —
 *  i.e. an action definition pointing at it can actually dispatch.
 *  Read-only probe for live capability discovery; never exposes the
 *  handler itself. */
export function isHandlerRegistered(module: string | null | undefined, fn: string | null | undefined): boolean {
  if (!module || !fn) return false;
  return Boolean(HANDLER_REGISTRY[module]?.[fn]);
}

/** Main entry point. Validates + capability-checks + invokes handler. */
export async function dispatchAction(
  actionType: string,
  payload: Record<string, unknown>,
  ctx: DispatchContext,
): Promise<DispatchResult> {
  // E3/E5: tenant-scoped lookup — dispatch fails closed ("unknown
  // action") when the type is pinned to a DIFFERENT tenant; system
  // actions (clientNumber=NULL) resolve for everyone as before.
  const def = await getActionDefinition(actionType, ctx.clientNumber);
  if (!def) {
    return { ok: false, message: `Unknown action type "${actionType}" — not registered in action_definitions.`, errorCode: 'unknown_action' };
  }
  if (def.approvedAt === null) {
    return { ok: false, message: `Action "${actionType}" is not yet approved for use.`, errorCode: 'unapproved' };
  }
  const errs = validateActionPayload(def, payload);
  if (errs && errs.length > 0) {
    return { ok: false, message: `Invalid payload: ${errs.join('; ')}`, errorCode: 'schema_violation' };
  }
  if (def.requiresCapability) {
    const cap = await hasCapability(ctx.userId, def.requiresCapability);
    if (!cap) {
      return {
        ok: false,
        message: `Capability "${def.requiresCapability}" not enabled for this user. Grant in Settings → Brain → Capabilities to use this action.`,
        errorCode: 'capability_missing',
      };
    }
  }
  const handler = resolveHandler(def.handlerModule, def.handlerFunction);
  if (!handler) {
    return {
      ok: false,
      message: `Handler ${def.handlerModule}.${def.handlerFunction} not in registry — refusing to dispatch.`,
      errorCode: 'handler_not_in_registry',
    };
  }
  try {
    const result = await handler(ctx.userId, payload, ctx);
    return {
      ...result,
      confirmation: result.confirmation
        ?? CONFIRMATION_BY_HANDLER[`${def.handlerModule}.${def.handlerFunction}`]
        ?? 'unverifiable', // fail closed: unmapped pair proves nothing
    };
  } catch (e: any) {
    return { ok: false, message: `Handler threw: ${e?.message ?? 'unknown'}`, errorCode: 'handler_exception' };
  }
}
