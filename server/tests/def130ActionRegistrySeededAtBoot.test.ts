import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * DEF-130 — "I don't have the capability to delete open items directly."
 *
 * `remove_open_item` had a parser, a dispatch branch, a seed entry and a
 * verified `→ CANCELLED` transition. What it did not have was a row in
 * `action_definitions` on production, because the seeder was a hand-run CLI
 * script that nothing invoked. `brainCapabilityLive` builds the CAN side of
 * the capability truth-table from those rows, so the action was invisible to
 * every prompt and Brain denied it truthfully. `create_contact` (DEF-058) was
 * missing for the same reason — 16 of 18 declared types were live.
 *
 * These tests pin the two halves of the fix: the seeder is callable as a
 * function (so boot can run it), and the rows it writes are shapes the live
 * classifier will actually advertise. A row that gets seeded but classifies
 * as `unsupported` would leave the defect exactly where it was.
 */

const registerAction = vi.fn(async (args: any) => args);

vi.mock('../src/services/knowledge/actionRegistryService', () => ({
  registerAction: (args: any) => registerAction(args),
}));

import { ACTIONS, seedActionDefinitions } from '../src/scripts/seedActionDefinitions';
import { classifyCapability } from '../src/services/knowledge/brainCapabilityLive';

beforeEach(() => registerAction.mockClear());

describe('the seeder reconciles every declared action', () => {
  it('upserts one row per ACTIONS entry and reports the count', async () => {
    const n = await seedActionDefinitions();
    expect(n).toBe(ACTIONS.length);
    expect(registerAction).toHaveBeenCalledTimes(ACTIONS.length);
  });

  it('seeds the two types production was missing', async () => {
    await seedActionDefinitions();
    const seeded = registerAction.mock.calls.map(([a]: any[]) => a.type);
    expect(seeded).toContain('remove_open_item');
    expect(seeded).toContain('create_contact');
  });

  it('every row is system-scoped and pre-approved — an unapproved row is still invisible', async () => {
    await seedActionDefinitions();
    for (const [a] of registerAction.mock.calls as any[][]) {
      expect(a.scope).toBe('system');
      expect(a.preApproved).toBe(true);
      // classifyCapability fails closed on missing metadata, so a row seeded
      // without it is seeded and still unusable.
      expect(a.operationalMetadata).toBeTruthy();
    }
  });

  it('carries the handler pointer through — the classifier checks it for a dispatch path', async () => {
    await seedActionDefinitions();
    const remove = (registerAction.mock.calls as any[][])
      .map(([a]) => a).find((a) => a.type === 'remove_open_item');
    expect(remove.handlerModule).toBe('openItemsService');
    expect(remove.handlerFunction).toBe('removeItem');
  });
});

describe('what the seeded rows classify as — the actual defect', () => {
  /** The row shape `registerAction` persists, as the live module reads it. */
  const asStoredRow = (a: any) => ({
    type: a.type,
    isActive: true,
    approvedAt: a.preApproved ? new Date('2026-08-11') : null,
    handlerModule: a.handlerModule,
    handlerFunction: a.handlerFunction,
    operationalMetadata: a.operationalMetadata,
  });

  it('no seeded action classifies as unsupported — seeding a row Brain still denies is not a fix', async () => {
    await seedActionDefinitions();
    const providers = new Set(['gmail', 'smtp', 'google_calendar', 'tenant_whatsapp']);
    const unsupported = (registerAction.mock.calls as any[][])
      .map(([a]) => asStoredRow(a))
      .filter((def) => classifyCapability({ def, availableProviders: providers }) === 'unsupported')
      .map((d) => d.type);
    expect(unsupported).toEqual([]);
  });

  it('remove_open_item is AVAILABLE with no connectors at all — it never needed one', async () => {
    await seedActionDefinitions();
    const row = (registerAction.mock.calls as any[][])
      .map(([a]) => a).find((a) => a.type === 'remove_open_item');
    expect(classifyCapability({ def: asStoredRow(row), availableProviders: new Set() })).toBe('available');
  });

  it('create_contact is AVAILABLE too — the other type production was missing', async () => {
    await seedActionDefinitions();
    const row = (registerAction.mock.calls as any[][])
      .map(([a]) => a).find((a) => a.type === 'create_contact');
    expect(classifyCapability({ def: asStoredRow(row), availableProviders: new Set() })).toBe('available');
  });

  /**
   * SUPPLEMENT, not proof. `server.ts` calls `app.listen`, so the boot path
   * cannot be exercised in a unit test, and every behaviour test above passes
   * whether or not anything actually calls the seeder — which is precisely the
   * shape of the original defect: a correct function nobody invoked. This
   * reads the file instead. It is weak evidence, and it is the only evidence
   * that the wiring exists at all.
   */
  it('boot wires the seeder (source assertion — the behaviour tests cannot see this)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/scripts\/seedActionDefinitions/);
    expect(src).toMatch(/seedActionDefinitions\(\)/);
  });

  it('the removal description tells Brain not to substitute "done" for "removed"', () => {
    const remove: any = ACTIONS.find((a: any) => a.type === 'remove_open_item');
    // The observed failure was Brain OFFERING mark-done instead, which records
    // work that never happened — the fabricated-completion class.
    expect(remove.description).toMatch(/CANCELLED/);
    expect(remove.description).toMatch(/NOT done/i);
  });
});
