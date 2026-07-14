import { describe, it, expect } from 'vitest';
import {
  classifyCapability,
  CONNECTOR_FOR_ACTION,
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
  ...over,
});

describe('classifyCapability — fail-closed state machine', () => {
  it('registered + approved + healthy connector → available', () => {
    expect(classifyCapability({
      def: def({}), healthyConnectors: new Set(['gmail']), tenantWaActive: true,
    })).toBe('available');
  });

  it('email without a healthy gmail connector → connector_unavailable (never claimed available)', () => {
    expect(classifyCapability({
      def: def({}), healthyConnectors: new Set(), tenantWaActive: true,
    })).toBe('connector_unavailable');
  });

  it('meeting actions demand google_calendar', () => {
    expect(classifyCapability({
      def: def({ type: 'schedule_meeting', handlerModule: 'calendarService', handlerFunction: 'createEvent' }),
      healthyConnectors: new Set(['gmail']), tenantWaActive: true,
    })).toBe('connector_unavailable');
  });

  it('notify_via_whatsapp requires the tenant notifier to be active', () => {
    const base = def({ type: 'notify_via_whatsapp', handlerModule: 'tenantWhatsappSender', handlerFunction: 'sendTenantWhatsAppText' });
    expect(classifyCapability({ def: base, healthyConnectors: new Set(), tenantWaActive: false })).toBe('connector_unavailable');
    expect(classifyCapability({ def: base, healthyConnectors: new Set(), tenantWaActive: true })).toBe('available');
  });

  it('unapproved definition → approval_required, not available', () => {
    expect(classifyCapability({
      def: def({ approvedAt: null }), healthyConnectors: new Set(['gmail']), tenantWaActive: true,
    })).toBe('approval_required');
  });

  it('deactivated definition → unsupported (disabled action disappears)', () => {
    expect(classifyCapability({
      def: def({ isActive: false }), healthyConnectors: new Set(['gmail']), tenantWaActive: true,
    })).toBe('unsupported');
  });

  it('a row whose handler is NOT in any dispatch path → unsupported, even if active+approved (fail closed)', () => {
    expect(classifyCapability({
      def: def({ type: 'totally_new_thing', handlerModule: 'evilModule', handlerFunction: 'pwn' }),
      healthyConnectors: new Set(['gmail']), tenantWaActive: true,
    })).toBe('unsupported');
  });

  it('composer-dispatched types count as supported without a generic-dispatcher handler', () => {
    expect(classifyCapability({
      def: def({ type: 'update_contact', handlerModule: 'entityService', handlerFunction: 'updateContactGuarded' }),
      healthyConnectors: new Set(), tenantWaActive: false,
    })).toBe('available'); // internal action — no connector needed
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

  it('connector requirements only reference seeded types', () => {
    const seeded = new Set(ACTIONS.map((a: any) => a.type));
    expect(Object.keys(CONNECTOR_FOR_ACTION).filter((t) => !seeded.has(t))).toEqual([]);
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
