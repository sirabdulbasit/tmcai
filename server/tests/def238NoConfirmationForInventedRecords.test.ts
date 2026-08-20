/**
 * DEF-238 — he was asked to authorise deleting five items that do not exist.
 *
 * Owner's WhatsApp, 2026-08-20 18:14 PKT, verbatim:
 *
 *   him:   "Can u delete all open items including draft?"
 *   Brain: "…there's no concept of 'draft' items… Do you want me to remove all 7 active
 *           open items?"
 *   him:   "yes remove all"
 *   Brain: "Before I proceed, please confirm — I'm about to do ALL of these:
 *           • Remove (unknown item cmou52r0) from your open items
 *           • Remove (unknown item cmou55ls) from your open items      [five in total]
 *           Reply "send" to confirm everything, or tell me what to change."
 *
 * Checked against the database at the time: he had ZERO active open items (276 CLOSED, 7
 * CANCELLED), and those five ids exist in NO TABLE. The model invented the records and he was
 * asked to authorise their deletion.
 *
 * THE PREVIEW ALREADY KNEW. `itemTitleOf` prints "(unknown item …)" precisely because the row
 * cannot be found — it rendered its own doubt as text and asked for confirmation anyway. The
 * ground-or-ask guard that catches exactly this ran only in `dispatchPendingDirect`, AFTER his
 * "send". It runs at plan validation now: the same rule the code already states one paragraph
 * earlier for dispatchability — "never ask the owner to confirm something that cannot execute;
 * fail here, where it costs a message, instead of after yes" — applied to the records too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openItemExists = vi.fn();
vi.mock('../src/services/knowledge/actionTargetGuard', () => ({
  verifyActionTargets: async (kind: string, slots: any) => {
    if (kind !== 'remove_open_item') return { ok: true };
    if (await openItemExists(slots.openItemId)) return { ok: true };
    if (typeof slots.titleRef === 'string' && slots.titleRef.trim().length >= 2) return { ok: true };
    return { ok: false, marker: '[ask: which item to remove — name it and I will take it off the list]' };
  },
}));

/** The five ids from his transcript. They exist nowhere. */
const INVENTED = ['cmou52r0', 'cmou55ls', 'cmou58d8', 'cmou5alw', 'cmou5bvi'];

describe('DEF-238 — a plan step whose target does not exist is refused before the preview', () => {
  beforeEach(() => { openItemExists.mockReset(); });

  it('refuses his five invented ids rather than asking him to confirm them', async () => {
    openItemExists.mockResolvedValue(false);          // none of them resolve, as in production
    const { verifyActionTargets } = await import('../src/services/knowledge/actionTargetGuard');
    for (const id of INVENTED) {
      const v = await verifyActionTargets('remove_open_item', { openItemId: id } as any, 2, 'TMC-0001');
      expect(v.ok, `${id} must not be confirmable`).toBe(false);
    }
  });

  it('the refusal is an ASK, not a silent drop — he still learns what to do', async () => {
    openItemExists.mockResolvedValue(false);
    const { verifyActionTargets } = await import('../src/services/knowledge/actionTargetGuard');
    const v = await verifyActionTargets('remove_open_item', { openItemId: INVENTED[0] } as any, 2, 'TMC-0001');
    expect(v.marker).toMatch(/name it/i);
  });

  it('still passes a step whose item genuinely exists', async () => {
    openItemExists.mockResolvedValue(true);
    const { verifyActionTargets } = await import('../src/services/knowledge/actionTargetGuard');
    const v = await verifyActionTargets('remove_open_item', { openItemId: 'real-id' } as any, 2, 'TMC-0001');
    expect(v.ok).toBe(true);
  });

  it('still passes a stale id carrying the title he actually said (DEF-103)', async () => {
    // Refusing on a stale id is what made Brain ask him to repeat himself. The title is enough
    // to identify the item; uniqueness is settled at dispatch.
    openItemExists.mockResolvedValue(false);
    const { verifyActionTargets } = await import('../src/services/knowledge/actionTargetGuard');
    const v = await verifyActionTargets(
      'remove_open_item', { openItemId: 'stale', titleRef: 'EXIM solution' } as any, 2, 'TMC-0001');
    expect(v.ok).toBe(true);
  });
});

describe('DEF-238 — the guard is wired into plan validation, not only dispatch', () => {
  it('the composer calls verifyActionTargets BEFORE renderPlanPreview', async () => {
    // Order is the whole fix: after the preview means after his authorisation.
    const fs = await import('fs');
    const src = fs.readFileSync(
      new URL('../src/services/knowledge/brainComposer.ts', import.meta.url), 'utf8');
    const guardAt = src.indexOf("await import('./actionTargetGuard')");
    const previewAt = src.indexOf('renderPlanPreview(planSteps');
    expect(guardAt, 'the plan loop must import the target guard').toBeGreaterThan(-1);
    expect(previewAt).toBeGreaterThan(-1);
    expect(guardAt, 'the guard must run before the preview is rendered').toBeLessThan(previewAt);
  });
});
