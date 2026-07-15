import { describe, it, expect } from 'vitest';
import { registerAllHandlers } from '../src/services/actions/handlers';
import { listAll, reset } from '../src/services/actions/handlerRegistry';
import {
  listRegisteredHandlerPairs,
  confirmationForHandler,
} from '../src/services/knowledge/genericActionDispatcher';

// Hardening audit 2026-07-14, item #6 — every external-action path
// declares what its success actually PROVES. An 'unverifiable'
// declaration means the executor records 'unconfirmed', never 'done'.

describe('Stack B handlers — confirmationCapability declarations', () => {
  reset();
  registerAllHandlers();
  const handlers = listAll();

  it('every registered handler declares a valid confirmation capability', () => {
    expect(handlers.length).toBeGreaterThan(30);
    for (const h of handlers) {
      const cap = (h as any).confirmationCapability();
      expect(['provider_confirmed', 'locally_confirmed', 'unverifiable']).toContain(cap);
    }
  });

  it('provider read-back handlers are declared provider_confirmed', () => {
    const byName = new Map(handlers.map((h) => [h.metadata().name, h]));
    for (const name of ['send_email', 'send_email_reply', 'forward_email', 'create_event', 'reschedule_event', 'cancel_event', 'add_attendee', 'send_chat_reply', 'send_whatsapp_message']) {
      const h = byName.get(name);
      expect(h, `handler ${name} missing`).toBeTruthy();
      expect((h as any).confirmationCapability()).toBe('provider_confirmed');
    }
  });

  it('send_slack_message (output-only confirm) is declared unverifiable — can never record done', () => {
    const h = handlers.find((x) => x.metadata().name === 'send_slack_message');
    expect((h as any).confirmationCapability()).toBe('unverifiable');
  });

  it('#8: EVERY external-category handler DECLARES its capability — the permissive default is not allowed to reach external actions', () => {
    const externalCategories = new Set(['communication', 'calendar', 'crm', 'task']);
    const undeclared = handlers
      .filter((h) => externalCategories.has(h.metadata().category))
      .filter((h) => !Object.prototype.hasOwnProperty.call(Object.getPrototypeOf(h), 'confirmationCapability'))
      .map((h) => h.metadata().name);
    // If this fails: a new external handler shipped relying on the
    // inherited 'locally_confirmed' default. Declare what its confirm()
    // actually proves (provider_confirmed needs a real provider
    // read-back; re-reading your own output is unverifiable).
    expect(undeclared).toEqual([]);
  });

  it('odoo + google-tasks read-back handlers are provider_confirmed; reassign_task (never succeeds) is unverifiable', () => {
    const byName = new Map(handlers.map((h) => [h.metadata().name, h]));
    for (const name of ['update_odoo_crm', 'create_odoo_lead', 'create_odoo_opportunity', 'update_odoo_opportunity', 'create_task', 'complete_task', 'add_subtask']) {
      expect((byName.get(name) as any).confirmationCapability(), name).toBe('provider_confirmed');
    }
    expect((byName.get('reassign_task') as any).confirmationCapability()).toBe('unverifiable');
  });
});

describe('Stack A generic dispatcher — confirmation map parity', () => {
  it('every allow-listed handler pair has an explicit confirmation declaration', () => {
    // Unmapped pairs fail closed to 'unverifiable' at dispatch, but a
    // deliberate declaration is required here so new registry entries
    // can't silently ship without deciding what their success proves.
    const undeclared = listRegisteredHandlerPairs().filter((pair) => {
      const [m, f] = pair.split('.');
      return confirmationForHandler(m, f) === 'unverifiable';
    });
    expect(undeclared).toEqual([]);
  });

  it('external sends are provider_confirmed; internal DB writes locally_confirmed', () => {
    expect(confirmationForHandler('gmailService', 'sendUserEmail')).toBe('provider_confirmed');
    expect(confirmationForHandler('tenantWhatsappSender', 'sendTenantWhatsAppText')).toBe('provider_confirmed');
    expect(confirmationForHandler('openItemsService', 'createItem')).toBe('locally_confirmed');
  });

  it('an unknown pair fails closed to unverifiable', () => {
    expect(confirmationForHandler('evilModule', 'pwn')).toBe('unverifiable');
  });
});
