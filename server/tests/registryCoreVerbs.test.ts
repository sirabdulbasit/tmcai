import { describe, it, expect } from 'vitest';
import { registerAllHandlers } from '../src/services/actions/handlers/index';
import { has } from '../src/services/actions/handlerRegistry';

// F1/F2 — the action registry IS the brain's capability ceiling: anything
// not registered here is something the brain silently "can't do". This
// locks the core executive-assistant verb set so a refactor can't drop one.

const CORE_VERBS = [
  // communication
  'send_email', 'send_email_reply', 'forward_email', 'send_chat_reply',
  'send_whatsapp_message', 'send_slack_message',
  // calendar
  'create_event', 'reschedule_event', 'cancel_event', 'propose_times', 'add_attendee',
  // lifecycle
  'snooze', 'close', 'archive', 'escalate',
  // crm
  'update_odoo_crm', 'create_odoo_lead',
  // proactivity (D3)
  'notify_user_risk',
];

describe('registry exposes the core executive-assistant verbs', () => {
  // Registering once at describe-time is enough — vitest isolates
  // modules per file, so this file starts with an empty registry and
  // the single call populates it. Fix 6 (2026-07-09): if a future
  // case ever needs a clean intermediate state, use resetAllHandlers()
  // from handlers/index.ts — it flips the module-level once-guard so
  // re-registering actually works. The raw handlerRegistry.reset() is
  // half a reset and will leave the registry empty on the next register
  // call.
  registerAllHandlers();

  it.each(CORE_VERBS)('%s is registered', (verb) => {
    expect(has(verb)).toBe(true);
  });
});
