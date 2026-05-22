/**
 * Phase 1 seed (2026-05-22): codify Brain's current action types
 * (from the ComposedAction union in brainComposer.ts +
 * instructionDispatcher.ts switch cases) into action_definitions rows.
 *
 * Each row contains:
 *   - schema:   JSON-schema-subset describing the slots
 *   - handlerModule + handlerFunction:  where the implementation lives
 *   - requiresCapability:  the capability key the user must have
 *   - isHumanFacing:  triggers preview gate
 *   - previewTemplate:  text Brain renders when previewing
 *
 * After Phase 4-5 wires the generic dispatcher, these rows ARE the
 * action types — the switch/case in instructionDispatcher gets deleted.
 *
 * Idempotent — re-running upserts by `type`. Safe to run after any
 * schema tweak below.
 *
 * Usage:
 *   npx ts-node src/scripts/seedActionDefinitions.ts
 */
import { registerAction } from '../services/knowledge/actionRegistryService';

interface Seed {
  type: string;
  displayName: string;
  description: string;
  schema: any;
  handlerModule: string;
  handlerFunction: string;
  previewTemplate?: string | null;
  requiresCapability?: string | null;
  isHumanFacing?: boolean;
}

const ACTIONS: Seed[] = [
  {
    type: 'add_open_item',
    displayName: 'Add open item',
    description: 'Create a new open item (follow-up / task) on the user\'s list.',
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        dueDate: { type: 'string' },
        note: { type: 'string' },
      },
    },
    handlerModule: 'openItemsService',
    handlerFunction: 'createItem',
    requiresCapability: 'manage_open_items',
    isHumanFacing: false, // internal — no preview gate
  },
  {
    type: 'update_open_item',
    displayName: 'Update open item',
    description: 'Update fields on an existing open item — typically used to complete DRAFT items by filling priority/dueDate, or to amend title/note/dueDate on any active item. Reasoning must reference the item by openItemId from the open-items context block.',
    schema: {
      type: 'object',
      required: ['openItemId'],
      properties: {
        openItemId: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string' }, // 'critical' | 'high' | 'medium' | 'low' — reasoning normalises "normal" → "medium"
        dueDate: { type: 'string' },
        note: { type: 'string' },
      },
    },
    handlerModule: 'openItemsService',
    handlerFunction: 'updateItem',
    requiresCapability: 'manage_open_items',
    isHumanFacing: false,
  },
  {
    type: 'delegate_open_item',
    displayName: 'Delegate open item',
    description: 'Transition an existing open item to DELEGATED status with a delegatee.',
    schema: {
      type: 'object',
      required: ['openItemId', 'delegateeEmail', 'delegateeName'],
      properties: {
        openItemId: { type: 'string' },
        delegateeEmail: { type: 'string' },
        delegateeName: { type: 'string' },
        note: { type: 'string' },
      },
    },
    handlerModule: 'openItemsService',
    handlerFunction: 'delegateItem',
    requiresCapability: 'manage_open_items',
    isHumanFacing: true,
    previewTemplate: 'Delegate "{titleHint}" to {delegateeName} <{delegateeEmail}>?',
  },
  {
    type: 'schedule_meeting',
    displayName: 'Schedule meeting',
    description: 'Create a Google Calendar event and send invites to attendees.',
    schema: {
      type: 'object',
      required: ['title', 'whenIso', 'attendeeEmails', 'attendeeNames'],
      properties: {
        title: { type: 'string' },
        whenIso: { type: 'string' },
        durationMin: { type: 'integer' },
        attendeeEmails: { type: 'array', items: { type: 'string' } },
        attendeeNames: { type: 'array', items: { type: 'string' } },
        note: { type: 'string' },
      },
    },
    handlerModule: 'calendarService',
    handlerFunction: 'createEvent',
    requiresCapability: 'google_calendar',
    isHumanFacing: true,
    previewTemplate: 'Schedule "{title}" {whenIso} ({durationMin} min) with {attendeeNames}.',
  },
  {
    type: 'cancel_meeting',
    displayName: 'Cancel meeting',
    description: 'Delete an existing calendar event and notify attendees.',
    schema: {
      type: 'object',
      required: ['eventId'],
      properties: {
        eventId: { type: 'string' },
        titleHint: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    handlerModule: 'calendarService',
    handlerFunction: 'deleteEvent',
    requiresCapability: 'google_calendar',
    isHumanFacing: true,
    previewTemplate: 'Cancel meeting "{titleHint}" (event {eventId})?',
  },
  {
    type: 'reschedule_meeting',
    displayName: 'Reschedule meeting',
    description: 'Update an existing event\'s time/duration and re-notify attendees.',
    schema: {
      type: 'object',
      required: ['eventId'],
      properties: {
        eventId: { type: 'string' },
        titleHint: { type: 'string' },
        newWhenIso: { type: 'string' },
        newDurationMin: { type: 'integer' },
        reason: { type: 'string' },
      },
    },
    handlerModule: 'calendarService',
    handlerFunction: 'updateEvent',
    requiresCapability: 'google_calendar',
    isHumanFacing: true,
    previewTemplate: 'Move "{titleHint}" to {newWhenIso}?',
  },
  {
    type: 'send_email',
    displayName: 'Send email',
    description: 'Send an email from the user\'s connected Gmail. Footer "Sent by Nexeo, <user>\'s AI assistant" appended automatically.',
    schema: {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'array', items: { type: 'string' } },
        cc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        replyToFeedEventId: { type: 'string' },
      },
    },
    handlerModule: 'gmailService',
    handlerFunction: 'sendUserEmail',
    requiresCapability: 'send_email',
    isHumanFacing: true,
    previewTemplate: 'To: {to}\nSubject: {subject}\nBody:\n{body}',
  },
  {
    type: 'notify_via_whatsapp',
    displayName: 'Notify via WhatsApp',
    description: 'Send a WhatsApp message FROM the tenant Nexeo notifier number with an auto-prepended introduction. NOT from the user\'s personal WhatsApp identity.',
    schema: {
      type: 'object',
      required: ['recipientName', 'recipientPhone', 'message'],
      properties: {
        recipientName: { type: 'string' },
        recipientPhone: { type: 'string' },
        message: { type: 'string' },
      },
    },
    handlerModule: 'tenantWhatsappSender',
    handlerFunction: 'sendTenantWhatsAppText',
    requiresCapability: 'notify_via_whatsapp',
    isHumanFacing: true,
    previewTemplate: 'Hi {recipientName}, this is Nexeo — {userName}\'s AI assistant. {userName} asked me to let you know:\n\n{message}',
  },
  {
    type: 'set_brain_name',
    displayName: 'Set Brain name',
    description: 'Update Brain\'s custom name as the user prefers. Empty string clears.',
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
      },
    },
    handlerModule: 'brainPersonaService',
    handlerFunction: 'setBrainName',
    requiresCapability: null,
    isHumanFacing: false,
  },
  {
    type: 'record_preference',
    displayName: 'Record preference',
    description: 'Store a durable user preference (sign-off, working hours, default duration, etc).',
    schema: {
      type: 'object',
      required: ['key', 'value'],
      properties: {
        key: { type: 'string' },
        value: {}, // any
        description: { type: 'string' },
      },
    },
    handlerModule: 'userMemoryService',
    handlerFunction: 'recordExplicitMemory',
    requiresCapability: null,
    isHumanFacing: false,
  },
];

async function main() {
  console.log('[seedActionDefinitions] starting');
  let createdCount = 0;
  for (const a of ACTIONS) {
    await registerAction({
      type: a.type,
      displayName: a.displayName,
      description: a.description,
      schema: a.schema,
      handlerModule: a.handlerModule,
      handlerFunction: a.handlerFunction,
      previewTemplate: a.previewTemplate ?? null,
      requiresCapability: a.requiresCapability ?? null,
      isHumanFacing: !!a.isHumanFacing,
      scope: 'system',
      source: 'seeded',
      preApproved: true,
    });
    console.log(`  upserted: ${a.type}`);
    createdCount++;
  }
  console.log(`[seedActionDefinitions] done. upserted=${createdCount}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[seedActionDefinitions] fatal:', e);
  process.exit(1);
});
