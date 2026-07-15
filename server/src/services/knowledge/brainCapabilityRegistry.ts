/**
 * brainCapabilityRegistry — single source of truth for what Brain
 * can and cannot do. Injected into every composer prompt so the LLM
 * never invents a limitation ("I can't add contacts yet") or promises
 * a capability that doesn't exist ("I'll SMS them").
 *
 * Motivated by Basit chat 2026-07-07: Brain told the user "I can't add
 * contacts yet — this is a feature I'm still learning" when adding a
 * contact IS a supported operation (POST /entities). That kind of
 * fabricated limitation is a crime in building AI (memory rule
 * feedback_no_hardcoded_brain_replies) — the LLM was working around
 * a hole in its own prompt knowledge.
 *
 * Two lists:
 *   CAN — actions with a real dispatch path in the server. When the
 *     user asks for one of these, Brain must attempt it (via the
 *     matching action type in ComposedAction) instead of demurring.
 *   CANNOT — actions that genuinely have no path. Brain must say
 *     so plainly ("I can't send SMS from here") and, where useful,
 *     suggest the closest supported alternative.
 *
 * When editing this file: keep it aligned with (a) the ComposedAction
 * union in brainComposer.ts and (b) the dispatcher branches in
 * dispatchInstruction / dispatchPendingDirect. Adding a capability
 * without also wiring the action type is worse than not adding it —
 * Brain will promise and then fail.
 */

export interface Capability {
  /** Short human label the LLM can reason about. */
  label: string;
  /** ComposedAction "type" that fulfils this capability, or a REST
   *  route hint for capabilities Brain triggers without an action
   *  emission (e.g. adding a contact via /entities POST). */
  handle: string;
  /** One-line description of what it actually does end-to-end. */
  what: string;
}

export interface Limitation {
  /** Short label the LLM can reason about. */
  label: string;
  /** Honest reason it isn't supported. */
  why: string;
  /** Suggested closest alternative Brain should offer instead. */
  offerInstead?: string;
}

const CAPABILITIES: Capability[] = [
  { label: 'Add or update an open item (task/todo)', handle: 'add_open_item / update_open_item', what: 'Creates or edits a row in the user\'s open items list.' },
  { label: 'Mark an open item done', handle: 'mark_open_item_done', what: 'Closes an open item with an optional completion note.' },
  { label: 'Delegate an open item', handle: 'delegate_open_item', what: 'Assigns an open item to a contact (or ad-hoc email) and sends them a delegation email.' },
  { label: 'Schedule a meeting', handle: 'schedule_meeting', what: 'Creates a Google Calendar event with attendees (contact or ad-hoc email) and sends invites.' },
  { label: 'Reschedule a meeting', handle: 'reschedule_meeting', what: 'Updates an existing Calendar event\'s time or duration.' },
  { label: 'Cancel a meeting', handle: 'cancel_meeting', what: 'Cancels a Calendar event and notifies attendees.' },
  { label: 'Send an email', handle: 'send_email', what: 'Sends via user\'s Gmail (or SMTP fallback). Post-send fetches the message from Gmail to verify it landed in Sent and to report which From address was used — surface that "from" line to the user when you claim "sent".' },
  { label: 'Check what emails were actually sent', handle: 'gmailService.getRecentSentSummary(userId)', what: 'Reads the user\'s Gmail Sent folder — use this whenever the user asks "did it go?", "check sent items", "which account did that go from?", or when you need proof a message actually left. Do NOT claim knowledge of sent items from memory; fetch and cite messageId + timestamp.' },
  { label: 'Notify a contact via WhatsApp', handle: 'notify_via_whatsapp', what: 'Sends a message from the Nexeo tenant WhatsApp number, with an "AI assistant on behalf of {user}" prefix.' },
  { label: 'Add a new contact', handle: 'POST /entities', what: 'Creates a person/entity row with name/email/phone; Brain can trigger this itself when the user provides a name and identifier.' },
  { label: 'Edit a contact\'s details (name, email, phone)', handle: 'update_contact', what: 'Updates a field on an existing contact — email correction, name fix, phone add/change. Emit update_contact with contactCandidateId + the new value. Do NOT tell the user "I can\'t edit contacts", and do NOT create a duplicate contact to work around it — this action edits in place.' },
  { label: 'Change contact visibility (private/normal/tenant)', handle: 'set_contact_scope', what: 'Adjusts whether a contact is user-scoped, shared, or tenant-wide.' },
  { label: 'Mark a contact inactive', handle: 'mark_contact_inactive', what: 'Hides a contact so Brain skips them in future flows.' },
  { label: 'Archive or delete a wiki page', handle: 'archive_wiki_page / delete_wiki_page', what: 'Removes a page from Brain\'s retrieval (archive) or from the DB (delete).' },
  { label: 'Rename yourself (Brain\'s name)', handle: 'set_brain_name', what: 'Sets the custom name the user prefers for the assistant.' },
  { label: 'Remember a user preference', handle: 'record_preference', what: 'Stores a key/value the user asked to be remembered (signoff, tone, working hours, etc.).' },
];

const LIMITATIONS: Limitation[] = [
  { label: 'Send SMS', why: 'No SMS provider is wired in.', offerInstead: 'notify_via_whatsapp or send_email' },
  { label: 'Make voice phone calls', why: 'No PSTN calling provider is wired in.', offerInstead: 'a WhatsApp voice-note ping, or a "tap to call" nudge back to the user' },
  { label: 'Post to Slack / Teams / social media', why: 'Those channels aren\'t connected.', offerInstead: 'email or WhatsApp' },
  { label: 'Send WhatsApp from the user\'s personal WhatsApp identity', why: 'Trust boundary — Brain never speaks as the user without an explicit user-initiated chain.', offerInstead: 'notify_via_whatsapp (which sends from the Nexeo tenant number with an "AI assistant" prefix)' },
  { label: 'Send bulk messages / marketing blasts', why: 'Only 1:1 outbound is supported by design.', offerInstead: 'sending individually, or asking the user to script the batch themselves' },
  { label: 'Access files outside connected sources', why: 'Brain only reads Gmail / Calendar / Drive folders / WhatsApp messages that the user has connected.', offerInstead: 'connect the source in Settings → Connectors' },
];

/** Human-friendly descriptions keyed by ACTION TYPE — metadata for the
 *  live discovery module (brainCapabilityLive), which generates the CAN
 *  list from the action registry. These strings are display copy only;
 *  presence in this map does NOT make a capability exist (fail-closed:
 *  the live module drops anything without a real dispatch path, and a
 *  type missing here still renders with a de-snaked fallback label). */
export const CAPABILITY_HINTS: Record<string, { label: string; what: string }> = Object.fromEntries(
  CAPABILITIES
    .filter((c) => /^[a-z_]+$/.test(c.handle.split(' / ')[0]))
    .flatMap((c) => c.handle.split(' / ').map((h) => [h.trim(), { label: c.label, what: c.what }])),
);

/** Capabilities NOT backed by an actionDefinition row (tool/REST
 *  paths the composer triggers directly). The live module appends
 *  these to the CAN list verbatim — they have no registry row to
 *  discover. Keep this list tiny and only for paths that exist. */
export const NON_ACTION_CAPABILITIES: Capability[] = CAPABILITIES.filter(
  (c) => !/^[a-z_]+$/.test(c.handle.split(' / ')[0]),
);

/** DEPRECATED for prompt injection — brainComposer now uses
 *  brainCapabilityLive.renderCapabilityBlockLive() (generated from the
 *  action registry + connector health). Kept as the display fallback
 *  and for the static hint metadata above. */
export function renderCapabilityBlock(): string {
  const canLines = CAPABILITIES.map((c) => `- ${c.label} → ${c.handle}`).join('\n');
  const cannotLines = LIMITATIONS.map((l) => {
    const alt = l.offerInstead ? ` — offer instead: ${l.offerInstead}` : '';
    return `- ${l.label} (${l.why})${alt}`;
  }).join('\n');
  return `# Capability truth-table (never fabricate limitations or capabilities)

WHAT YOU CAN DO — if the user asks for one of these, DO IT. Never say "I can't do that yet" for anything on this list. If a required detail is missing (name, email, phone, time), ask for JUST that detail.

${canLines}

WHAT YOU CANNOT DO — say so plainly, and offer the closest supported alternative from the list above:

${cannotLines}

For any user request that isn't clearly on either list, reason from first principles about which capability it maps to. Do NOT invent a new limitation. If genuinely unsure, ask a clarifying question rather than declining.`;
}

/** Programmatic access — used by capability-health check endpoints. */
export function listCapabilities(): Capability[] {
  return CAPABILITIES.slice();
}

export function listLimitations(): Limitation[] {
  return LIMITATIONS.slice();
}
