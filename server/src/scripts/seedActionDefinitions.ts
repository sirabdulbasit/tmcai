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
  /** #7 (2026-07-14): operational requirements — REQUIRED on every
   *  seed (parity test enforces it). external=true means the action
   *  leaves the system; connectors.anyOf lists providers of which ONE
   *  healthy instance satisfies the requirement ('smtp' = platform
   *  SMTP fallback, 'tenant_whatsapp' = the tenant Meta notifier). */
  operationalMetadata: { external: boolean; connectors?: { anyOf: string[] } };
}

// Exported for the registry-parity test (capabilityDiscovery.test.ts):
// every seeded type must have a live dispatch path, or the suite goes
// red before Brain can ever claim a capability it can't perform.
export const ACTIONS: Seed[] = [
  {
    type: 'add_open_item',
    displayName: 'Add open item',
    description: "Create a new open item (follow-up / task) on the user's list. For dueDate, emit the user's RAW DATE PHRASE in `dueDateRaw` (e.g. 'monday', 'tomorrow', 'next friday', 'in 3 days', '2026-05-25'). The server resolves it to an absolute date using the user's timezone — DO NOT compute the date yourself. Leave dueDateRaw empty/omitted if the user didn't specify a date.",
    schema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        dueDateRaw: { type: 'string' /* user's raw date phrase — server resolves */ },
        note: { type: 'string' },
      },
    },
    handlerModule: 'openItemsService',
    handlerFunction: 'createItem',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_open_items',
    isHumanFacing: false, // internal — no preview gate
  },
  {
    type: 'update_open_item',
    displayName: 'Update open item',
    description: "Update fields on an existing open item — typically used to complete DRAFT items by filling priority/dueDate, or to amend any field on an active item. Reference the item by openItemId from the open-items context block (use the exact id shown there). priority must be one of: critical | high | medium | low (normalise 'normal' → 'medium'). For dueDate, emit the user's RAW DATE PHRASE in `dueDateRaw` (e.g. 'monday', 'tomorrow', 'next friday', '2026-05-25'); the server resolves it. DO NOT compute or invent ISO dates yourself. CRITICAL — TITLE RULE: ONLY emit a `title` field if the user EXPLICITLY asked to rename the item ('rename it to X', 'change the title to Y', 'call it Z'). Do NOT auto-translate the title from Roman-Urdu/Urdu to English. Do NOT 'clean up' the title for grammar. Do NOT 'standardise' it. The user's original phrasing is the canonical title; preserve it unless they explicitly say otherwise.",
    schema: {
      type: 'object',
      required: ['openItemId'],
      properties: {
        openItemId: { type: 'string' },
        title: { type: 'string' },
        priority: { type: 'string' /* critical | high | medium | low */ },
        dueDateRaw: { type: 'string' /* user's raw date phrase — server resolves */ },
        note: { type: 'string' },
      },
    },
    handlerModule: 'openItemsService',
    handlerFunction: 'updateItem',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_open_items',
    isHumanFacing: false,
  },
  {
    type: 'mark_open_item_done',
    displayName: 'Mark open item done',
    description: "Mark an existing open item as DONE/CLOSED. Reference by openItemId from the open-items context block. If the item was DELEGATED, the system also sends a closure summary to the user via WhatsApp/web (with the trail of delegatee follow-up updates).",
    schema: {
      type: 'object',
      required: ['openItemId'],
      properties: {
        openItemId: { type: 'string' },
        completionNote: { type: 'string', description: 'Optional note about how it was completed' },
      },
    },
    handlerModule: 'openItemsService',
    handlerFunction: 'markDone',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_open_items',
    isHumanFacing: false,
  },
  {
    type: 'delegate_open_item',
    displayName: 'Delegate open item',
    description: "Transition an existing open item to DELEGATED with a delegatee. Emit `delegateeCandidateId` = the EXACT candidateId from the contacts block. NEVER emit raw emails or names — the server resolves candidateId → email + name. If you can't find a matching contact, emit decision='ask' with a clarifying question listing the real candidates. If multiple candidates match the user's named recipient, emit ask too.",
    schema: {
      type: 'object',
      required: ['openItemId', 'delegateeCandidateId'],
      properties: {
        openItemId: { type: 'string' },
        delegateeCandidateId: { type: 'string' /* MUST match a candidateId from the contacts block */ },
        note: { type: 'string' },
      },
    },
    handlerModule: 'openItemsService',
    handlerFunction: 'delegateItem',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_open_items',
    isHumanFacing: true,
    previewTemplate: 'Delegate "{titleHint}" to {delegateeName} <{delegateeEmail}>?',
  },
  {
    type: 'schedule_meeting',
    displayName: 'Schedule meeting',
    description: "Create a Google Calendar event and invite attendees. Emit `whenRaw` = the user's raw date+time phrase ('today 6pm', 'tomorrow 10am', 'next monday 9am'); the server resolves to ISO. Emit `attendeeCandidateIds` = exact candidateIds from the contacts block — NEVER raw emails. DO NOT compute the ISO time yourself. If a named attendee isn't in contacts, emit decision='ask'.",
    schema: {
      type: 'object',
      required: ['title', 'whenRaw', 'attendeeCandidateIds'],
      properties: {
        title: { type: 'string' },
        whenRaw: { type: 'string' /* user's raw date+time phrase — server resolves */ },
        durationMin: { type: 'integer' },
        attendeeCandidateIds: { type: 'array', items: { type: 'string' /* candidateIds from contacts block */ } },
        note: { type: 'string' },
      },
    },
    handlerModule: 'calendarService',
    handlerFunction: 'createEvent',
    operationalMetadata: { external: true, connectors: { anyOf: ['google_calendar'] } },
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
    operationalMetadata: { external: true, connectors: { anyOf: ['google_calendar'] } },
    requiresCapability: 'google_calendar',
    isHumanFacing: true,
    previewTemplate: 'Cancel meeting "{titleHint}" (event {eventId})?',
  },
  {
    type: 'reschedule_meeting',
    displayName: 'Reschedule meeting',
    description: "Update an existing event's time/duration and re-notify attendees. Emit `newWhenRaw` = the user's raw date+time phrase; server resolves. DO NOT compute ISO yourself.",
    schema: {
      type: 'object',
      required: ['eventId'],
      properties: {
        eventId: { type: 'string' },
        titleHint: { type: 'string' },
        newWhenRaw: { type: 'string' /* user's raw date+time phrase — server resolves */ },
        newDurationMin: { type: 'integer' },
        reason: { type: 'string' },
      },
    },
    handlerModule: 'calendarService',
    handlerFunction: 'updateEvent',
    operationalMetadata: { external: true, connectors: { anyOf: ['google_calendar'] } },
    requiresCapability: 'google_calendar',
    isHumanFacing: true,
    previewTemplate: 'Move "{titleHint}" to {newWhenIso}?',
  },
  {
    type: 'send_email',
    displayName: 'Send email',
    description: "Send an email from the user's connected Gmail. Footer \"Sent by Nexeo, <user>'s AI assistant\" appended automatically. Emit `toCandidateIds` and `ccCandidateIds` = exact candidateIds from the contacts block. NEVER emit raw emails. If the user explicitly typed an email NOT in contacts, emit it in `toAdHoc`. If a named recipient isn't in contacts and the user didn't type a full email, emit decision='ask'. TONE MATCHING: when the context includes a `# Your writing voice` block with the user's recent emails to this recipient, MIRROR the user's actual opening / closing / formality / language mix shown in those samples. Do NOT use generic openings ('Hope this finds you well') unless the samples show the user uses them. Match the user's voice precisely — that's a hard requirement.",
    schema: {
      type: 'object',
      required: ['toCandidateIds', 'subject', 'body'],
      properties: {
        toCandidateIds: { type: 'array', items: { type: 'string' /* candidateIds from contacts block */ } },
        ccCandidateIds: { type: 'array', items: { type: 'string' } },
        toAdHoc: { type: 'array', items: { type: 'string' /* email the user typed explicitly */ } },
        subject: { type: 'string' },
        body: { type: 'string' },
        replyToFeedEventId: { type: 'string' },
      },
    },
    handlerModule: 'gmailService',
    handlerFunction: 'sendUserEmail',
    operationalMetadata: { external: true, connectors: { anyOf: ['gmail', 'smtp'] } },
    requiresCapability: 'send_email',
    isHumanFacing: true,
    previewTemplate: 'To: {to}\nSubject: {subject}\nBody:\n{body}',
  },
  {
    type: 'notify_via_whatsapp',
    displayName: 'Notify via WhatsApp',
    description: "Send a WhatsApp message FROM the tenant Nexeo notifier number with auto-prepended introduction. NOT the user's personal WhatsApp. Emit `recipientCandidateId` = candidateId from contacts block; server resolves to phone. NEVER emit raw phone numbers. If the named recipient isn't in contacts (or has no phone), emit decision='ask'.",
    schema: {
      type: 'object',
      required: ['recipientCandidateId', 'message'],
      properties: {
        recipientCandidateId: { type: 'string' /* candidateId from contacts block */ },
        message: { type: 'string' },
      },
    },
    handlerModule: 'tenantWhatsappSender',
    handlerFunction: 'sendTenantWhatsAppText',
    operationalMetadata: { external: true, connectors: { anyOf: ['tenant_whatsapp'] } },
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
    operationalMetadata: { external: false },
    requiresCapability: null,
    isHumanFacing: false,
  },
  {
    type: 'set_contact_scope',
    displayName: 'Set contact scope (public/normal/private)',
    description: "Change a contact's visibility scope. Emit `contactCandidateId` (entity row id from the contacts context block) and `scope` (one of: 'tenant', 'normal', 'private'). 'tenant' = Public (visible to all users in the tenant), 'normal' = default (Brain on, owner-only), 'private' = Brain-muted (Brain ignores this contact entirely). Per Basit 2026-05-23 rule: contacts default to 'normal' on auto-discovery; this action is the ONLY way Brain can change a contact's scope, and it ALWAYS previews before applying.",
    schema: {
      type: 'object',
      required: ['contactCandidateId', 'scope'],
      properties: {
        contactCandidateId: { type: 'string' },
        scope: { type: 'string' /* tenant | normal | private */ },
        nameHint: { type: 'string' },
      },
    },
    handlerModule: 'entityCatalogService',
    handlerFunction: 'setContactScope',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_contacts',
    isHumanFacing: true,
    previewTemplate: 'Set "{nameHint}" scope to {scope}?',
  },
  {
    type: 'mark_contact_inactive',
    displayName: 'Mark contact inactive',
    description: "Mark a contact as inactive — Brain stops processing them entirely and they're hidden from the default Contacts view. Emit `contactCandidateId` from the contacts block. Preview-by-default. Soft-delete; row remains in DB.",
    schema: {
      type: 'object',
      required: ['contactCandidateId'],
      properties: {
        contactCandidateId: { type: 'string' },
        nameHint: { type: 'string' },
      },
    },
    handlerModule: 'entityCatalogService',
    handlerFunction: 'markContactInactive',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_contacts',
    isHumanFacing: true,
    previewTemplate: 'Mark "{nameHint}" inactive?',
  },
  {
    // DEF-058 (2026-08-05): Brain could UPDATE a contact but not CREATE one,
    // and rather than saying so it narrated the creation anyway — "I've
    // created a contact for your friend Arjamand Bano" when nothing was
    // written. A capability the model believes it has is more dangerous than
    // one it lacks, because the refusal never comes.
    type: 'create_contact',
    displayName: 'Save a new contact',
    description: "Create a NEW contact when the user gives you someone's details and that person is not already in the contacts block — e.g. \"note Arjamand Bano is my friend, her number is +92…\". Requires `name` plus at least one of `email` / `phone`; a contact with neither is unreachable and must not be created. `note` records context the user gave about them (\"special respected friend\"). If the email or phone already belongs to an existing contact the action REFUSES and names them — use `update_contact` on that person instead, never create a second row for someone you already have.",
    schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        note: { type: 'string' },
      },
    },
    handlerModule: 'entityService',
    handlerFunction: 'createEntity',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_contacts',
    isHumanFacing: false,
    previewTemplate: 'Save contact {name}?',
  },
  {
    type: 'update_contact',
    displayName: 'Update a contact\'s details',
    description: "Edit an existing contact's email, phone, or name IN PLACE. Emit `contactCandidateId` (entity row id from the contacts block) plus at least one of `newEmail`, `newPhone`, `newName`. Use this for corrections like \"his email is actually X\" or \"update her number\". NEVER create a new/duplicate contact to work around a wrong field — edit the existing one. Do NOT claim you can't edit contacts; this action does exactly that.",
    schema: {
      type: 'object',
      required: ['contactCandidateId'],
      properties: {
        contactCandidateId: { type: 'string' },
        newEmail: { type: 'string' },
        newPhone: { type: 'string' },
        newName: { type: 'string' },
        nameHint: { type: 'string' },
      },
    },
    handlerModule: 'entityService',
    handlerFunction: 'updateEntity',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_contacts',
    isHumanFacing: true,
    previewTemplate: 'Update {nameHint}?',
  },
  {
    type: 'archive_wiki_page',
    displayName: 'Archive wiki page',
    description: "Archive (soft-hide) a wiki page so Brain stops surfacing it in answers / retrieval. Reversible — the page stays in the DB and can be restored. Reference by `wikiPageId` (use lookups via the wiki search if you don't have one in context). Always preview-by-default; the user MUST confirm before the page is hidden from Brain.",
    schema: {
      type: 'object',
      required: ['wikiPageId'],
      properties: {
        wikiPageId: { type: 'string' },
        titleHint: { type: 'string', description: 'Page title for the preview' },
        reason: { type: 'string' },
      },
    },
    handlerModule: 'wikiService',
    handlerFunction: 'archivePage',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_wiki',
    isHumanFacing: true,
    previewTemplate: 'Archive wiki page "{titleHint}"?',
  },
  {
    type: 'delete_wiki_page',
    displayName: 'Delete wiki page',
    description: "Hard-delete a wiki page. IRREVERSIBLE — the page row is removed and Brain forgets it entirely. ALWAYS preview-by-default; the user MUST confirm with explicit \"delete\" or \"yes delete\" before dispatch. Prefer archive_wiki_page when the user just wants Brain to ignore it — only use delete when they want it gone forever.",
    schema: {
      type: 'object',
      required: ['wikiPageId'],
      properties: {
        wikiPageId: { type: 'string' },
        titleHint: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    handlerModule: 'wikiService',
    handlerFunction: 'deletePage',
    operationalMetadata: { external: false },
    requiresCapability: 'manage_wiki',
    isHumanFacing: true,
    previewTemplate: 'PERMANENTLY DELETE wiki page "{titleHint}"? (Irreversible.)',
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
    operationalMetadata: { external: false },
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
      operationalMetadata: a.operationalMetadata,
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

// This file is also imported by registry-parity tests for ACTIONS.
// Importing an inventory must never seed the database or terminate the
// host test process. Run the CLI only when this module is the direct
// entry point (ts-node/node); imports remain side-effect free.
if (require.main === module) {
  main().catch((e) => {
    console.error('[seedActionDefinitions] fatal:', e);
    process.exitCode = 1;
  });
}
