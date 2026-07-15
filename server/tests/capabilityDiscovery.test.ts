import { describe, it, expect } from 'vitest';
import {
  classifyCapability,
  type ClassifyInput,
} from '../src/services/knowledge/brainCapabilityLive';
import { isHandlerRegistered } from '../src/services/knowledge/genericActionDispatcher';
import { COMPOSER_DISPATCHED_TYPES } from '../src/services/knowledge/brainComposer';
import { ACTIONS } from '../src/scripts/seedActionDefinitions';
import { CAPABILITY_HINTS, NON_ACTION_CAPABILITIES, listLimitations } from '../src/services/knowledge/brainCapabilityRegistry';

// Hardening audit 2026-07-14, item #2 — the capability truth-table is
// GENERATED from the action registry + connector health instead of a
// hand-maintained list that drifted twice (2026-07-07 "can't add
// contacts", 2026-07-13 "can't update contact email" — RECURRED).

const def = (over: Partial<ClassifyInput['def']>): ClassifyInput['def'] => ({
  type: 'send_email', isActive: true, approvedAt: new Date('2026-07-01'),
  handlerModule: 'gmailService', handlerFunction: 'sendUserEmail',
  operationalMetadata: { external: true, connectors: { anyOf: ['gmail', 'smtp'] } },
  ...over,
});

describe('classifyCapability — fail-closed, metadata-driven (#7)', () => {
  it('registered + approved + healthy provider → available', () => {
    expect(classifyCapability({ def: def({}), availableProviders: new Set(['gmail']) })).toBe('available');
  });

  it('a healthy SMTP ALTERNATIVE satisfies send_email without Gmail (anyOf)', () => {
    expect(classifyCapability({ def: def({}), availableProviders: new Set(['smtp']) })).toBe('available');
  });

  it('email with NO healthy provider in anyOf → connector_unavailable', () => {
    expect(classifyCapability({ def: def({}), availableProviders: new Set(['google_calendar']) })).toBe('connector_unavailable');
  });

  it('meeting actions demand a healthy calendar provider', () => {
    expect(classifyCapability({
      def: def({ type: 'schedule_meeting', handlerModule: 'calendarService', handlerFunction: 'createEvent',
        operationalMetadata: { external: true, connectors: { anyOf: ['google_calendar'] } } }),
      availableProviders: new Set(['gmail', 'smtp']),
    })).toBe('connector_unavailable');
  });

  it('tenant WhatsApp is distinct from a personal whatsapp connector', () => {
    const wa = def({ type: 'notify_via_whatsapp', handlerModule: 'tenantWhatsappSender', handlerFunction: 'sendTenantWhatsAppText',
      operationalMetadata: { external: true, connectors: { anyOf: ['tenant_whatsapp'] } } });
    // A user's PERSONAL whatsapp connector must not satisfy the tenant notifier requirement.
    expect(classifyCapability({ def: wa, availableProviders: new Set(['whatsapp_personal']) })).toBe('connector_unavailable');
    expect(classifyCapability({ def: wa, availableProviders: new Set(['tenant_whatsapp']) })).toBe('available');
  });

  it('unapproved definition → approval_required, not available', () => {
    expect(classifyCapability({ def: def({ approvedAt: null }), availableProviders: new Set(['gmail']) })).toBe('approval_required');
  });

  it('deactivated definition → unsupported (disabled action disappears)', () => {
    expect(classifyCapability({ def: def({ isActive: false }), availableProviders: new Set(['gmail']) })).toBe('unsupported');
  });

  it('a row whose handler is NOT in any dispatch path → unsupported, even if active+approved', () => {
    expect(classifyCapability({
      def: def({ type: 'totally_new_thing', handlerModule: 'evilModule', handlerFunction: 'pwn' }),
      availableProviders: new Set(['gmail']),
    })).toBe('unsupported');
  });

  it('an UNKNOWN type with no operational metadata fails closed to unsupported', () => {
    expect(classifyCapability({
      def: { type: 'mystery_external_action', isActive: true, approvedAt: new Date(),
        handlerModule: 'gmailService', handlerFunction: 'sendUserEmail', operationalMetadata: null },
      availableProviders: new Set(['gmail', 'smtp', 'tenant_whatsapp']),
    })).toBe('unsupported');
  });

  it('a KNOWN legacy type with NULL metadata uses the transition fallback (pre-reseed grace)', () => {
    expect(classifyCapability({
      def: def({ operationalMetadata: null }), // send_email, pre-reseed row
      availableProviders: new Set(['smtp']),
    })).toBe('available');
  });

  it('composer-dispatched internal types need no connector', () => {
    expect(classifyCapability({
      def: def({ type: 'update_contact', handlerModule: 'entityService', handlerFunction: 'updateContactGuarded',
        operationalMetadata: { external: false } }),
      availableProviders: new Set(),
    })).toBe('available');
  });
});

describe('registry parity — the anti-drift lock', () => {
  it('EVERY seeded action type has a live dispatch path (generic dispatcher or composer)', () => {
    const orphans = ACTIONS.filter((a: any) =>
      !isHandlerRegistered(a.handlerModule, a.handlerFunction) &&
      !COMPOSER_DISPATCHED_TYPES.has(a.type),
    ).map((a: any) => a.type);
    // If this fails: a capability was seeded that nothing can dispatch.
    // Brain would promise it and then fail — wire the dispatch branch
    // (or remove the seed) before shipping.
    expect(orphans).toEqual([]);
  });

  it('every composer-dispatched type is seeded in the registry (no hidden capabilities)', () => {
    const seeded = new Set(ACTIONS.map((a: any) => a.type));
    const hidden = [...COMPOSER_DISPATCHED_TYPES].filter((t) => !seeded.has(t));
    expect(hidden).toEqual([]);
  });

  it('every action-type capability hint refers to a seeded type (descriptions are metadata, not truth)', () => {
    const seeded = new Set(ACTIONS.map((a: any) => a.type));
    const stale = Object.keys(CAPABILITY_HINTS).filter((t) => !seeded.has(t));
    expect(stale).toEqual([]);
  });

  it('EVERY seed declares operationalMetadata — new actions cannot ship without it (#7)', () => {
    const missing = ACTIONS.filter((a: any) => !a.operationalMetadata || typeof a.operationalMetadata.external !== 'boolean').map((a: any) => a.type);
    expect(missing).toEqual([]);
  });

  it('every EXTERNAL seed lists at least one provider in connectors.anyOf', () => {
    const bad = ACTIONS.filter((a: any) => a.operationalMetadata?.external === true &&
      !(a.operationalMetadata.connectors?.anyOf?.length > 0)).map((a: any) => a.type);
    expect(bad).toEqual([]);
  });
});

describe('deterministic safety limitations stay hand-written', () => {
  it('the CANNOT list still contains the trust-boundary entries', () => {
    const labels = listLimitations().map((l) => l.label.toLowerCase());
    expect(labels.some((l) => l.includes('sms'))).toBe(true);
    expect(labels.some((l) => l.includes("user's personal whatsapp"))).toBe(true);
    expect(labels.some((l) => l.includes('bulk'))).toBe(true);
  });

  it('non-action capabilities are the curated tool/REST paths only', () => {
    const handles = NON_ACTION_CAPABILITIES.map((c) => c.handle);
    expect(handles).toContain('POST /entities');
    expect(handles.some((h) => h.includes('getRecentSentSummary'))).toBe(true);
    // Everything snake_case-only must have gone through the registry.
    expect(handles.every((h) => !/^[a-z_]+$/.test(h.split(' / ')[0]))).toBe(true);
  });
});
