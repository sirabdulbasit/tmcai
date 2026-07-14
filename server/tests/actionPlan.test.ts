import { describe, it, expect, vi, beforeEach } from 'vitest';

// Phase 1A (2026-07-14) — compound actions. reasoningCompose could emit
// multi-step action_plan since 2026-05-23 but NOTHING executed it —
// compound requests ("update his email AND send followup on email and
// whatsapp", Basit chat 5) silently reduced to one action. Now:
// one combined preview → one "send" → every step dispatches through
// the same guard + provider verification, stop on first failure.

const resolveCandidateMock = vi.fn();
const verifyTargetsMock = vi.fn(async () => ({ ok: true } as any));
const sendWaMock = vi.fn();
const sendEmailMock = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    entity: { findFirst: vi.fn(async () => null) },
    openItem: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    feedEvent: { findUnique: vi.fn(async () => null) },
  },
}));
vi.mock('../src/services/knowledge/candidateResolver', () => ({
  resolveCandidate: (...a: any[]) => resolveCandidateMock(...a),
  resolveCandidates: async (ids: string[], u: number, cn: string) =>
    Promise.all(ids.map((id) => resolveCandidateMock(id, u, cn))),
}));
vi.mock('../src/services/knowledge/actionTargetGuard', () => ({
  verifyActionTargets: (...a: any[]) => verifyTargetsMock(...a),
}));
vi.mock('../src/services/notifications/tenantWhatsappSender', () => ({
  sendTenantWhatsAppText: (...a: any[]) => sendWaMock(...a),
}));
vi.mock('../src/services/gmailService', () => ({
  sendUserEmail: (...a: any[]) => sendEmailMock(...a),
}));
vi.mock('../src/services/knowledge/brainPersonaService', () => ({
  getBrainPersona: vi.fn(async () => ({ userFirstName: 'Basit' })),
}));
vi.mock('../src/services/instructions/instructionDispatcher', () => ({
  dispatchInstruction: vi.fn(async () => ({ ok: true, artifactId: 'oi_1', message: 'Added.' })),
}));

import { dispatchPendingDirect, renderPlanPreview } from '../src/services/knowledge/brainComposer';

const YOUSAF = { id: 'ent_yousaf', name: 'Muhammad Yousaf', email: null, phone: '+923028000553' };
const ASAD = { id: 'ent_asad', name: 'Asad Ahmed Taj', email: 'asad.ahmed@tmcltd.com', phone: null };

const planPending = (steps: Array<{ kind: string; slots: any }>) => ({
  id: 'pend_1', clientNumber: 'TMC-0001', userId: 2, channel: 'whatsapp' as const,
  actionKind: 'action_plan' as const, status: 'confirmed' as const,
  slots: { steps }, missingSlots: [], previewHash: null, previewedAt: null,
  artifactId: null, createdAt: new Date(), updatedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000),
});

beforeEach(() => {
  vi.clearAllMocks();
  verifyTargetsMock.mockResolvedValue({ ok: true });
  resolveCandidateMock.mockImplementation(async (id: string) =>
    id === 'ent_yousaf' ? YOUSAF : id === 'ent_asad' ? ASAD : null);
  sendWaMock.mockResolvedValue({ ok: true, waMessageId: 'wa_1' });
  sendEmailMock.mockResolvedValue({ success: true, messageId: 'm_1', verified: true });
});

describe('action_plan dispatch — fan-out with per-step guarantees', () => {
  it('dispatches every step and aggregates a numbered result', async () => {
    const r = await dispatchPendingDirect('TMC-0001', 2, planPending([
      { kind: 'send_email', slots: { toCandidateIds: ['ent_asad'], toAdHoc: [], subject: 'Followup', body: 'Hi' } },
      { kind: 'notify_via_whatsapp', slots: { recipientCandidateId: 'ent_yousaf', message: 'status?' } },
    ]) as any);
    expect(r.ok).toBe(true);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendWaMock).toHaveBeenCalledTimes(1);
    expect(r.message).toMatch(/1\. ✓/);
    expect(r.message).toMatch(/2\. ✓/);
  });

  it('stops on first failure and reports the remaining steps as NOT attempted', async () => {
    sendEmailMock.mockResolvedValue({ success: false, error: 'quota exceeded' });
    const r = await dispatchPendingDirect('TMC-0001', 2, planPending([
      { kind: 'send_email', slots: { toCandidateIds: ['ent_asad'], toAdHoc: [], subject: 'F', body: 'B' } },
      { kind: 'notify_via_whatsapp', slots: { recipientCandidateId: 'ent_yousaf', message: 'x' } },
    ]) as any);
    expect(r.ok).toBe(false);
    expect(sendWaMock).not.toHaveBeenCalled(); // later step never fired
    expect(r.message).toMatch(/1\. ✗/);
    expect(r.message).toMatch(/1 remaining step not attempted/);
  });

  it('each step re-runs the ground-or-ask guard for ITS kind (per-step grounding)', async () => {
    await dispatchPendingDirect('TMC-0001', 2, planPending([
      { kind: 'send_email', slots: { toCandidateIds: ['ent_asad'], toAdHoc: [], subject: 'F', body: 'B' } },
      { kind: 'notify_via_whatsapp', slots: { recipientCandidateId: 'ent_yousaf', message: 'x' } },
    ]) as any);
    const guardedKinds = verifyTargetsMock.mock.calls.map((c) => c[0]);
    expect(guardedKinds).toContain('send_email');
    expect(guardedKinds).toContain('notify_via_whatsapp');
  });

  it('a step blocked by the guard halts the plan with the ask marker', async () => {
    verifyTargetsMock.mockImplementation(async (kind: string) =>
      kind === 'notify_via_whatsapp'
        ? { ok: false, marker: '[target unresolved: the WhatsApp recipient — name the exact contact or give a valid number]' }
        : { ok: true });
    const r = await dispatchPendingDirect('TMC-0001', 2, planPending([
      { kind: 'send_email', slots: { toCandidateIds: ['ent_asad'], toAdHoc: [], subject: 'F', body: 'B' } },
      { kind: 'notify_via_whatsapp', slots: { recipientCandidateId: 'ghost', message: 'x' } },
    ]) as any);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/target unresolved/);
    expect(sendWaMock).not.toHaveBeenCalled();
  });

  it('refuses nested plans (no recursion bombs)', async () => {
    const r = await dispatchPendingDirect('TMC-0001', 2, planPending([
      { kind: 'action_plan', slots: { steps: [] } },
    ]) as any);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/nested plan/);
  });

  it('empty plan fails closed', async () => {
    const r = await dispatchPendingDirect('TMC-0001', 2, planPending([]) as any);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no steps/);
  });
});

describe('renderPlanPreview — one combined confirmation', () => {
  it('numbers every step, resolves names, and asks ONE confirm for all', async () => {
    const preview = await renderPlanPreview([
      { kind: 'update_contact', slots: { contactCandidateId: 'ent_asad', newEmail: 'asad.ahmed@tmcltd.com' } },
      { kind: 'send_email', slots: { toCandidateIds: ['ent_asad'], subject: 'Followup: Leave Request' } },
      { kind: 'notify_via_whatsapp', slots: { recipientCandidateId: 'ent_yousaf', message: 'Status update please' } },
    ], 2, 'TMC-0001');
    expect(preview).toMatch(/1\. Update contact Asad Ahmed Taj: email → asad\.ahmed@tmcltd\.com/);
    expect(preview).toMatch(/2\. Email to Asad Ahmed Taj — "Followup: Leave Request"/);
    expect(preview).toMatch(/3\. WhatsApp to Muhammad Yousaf/);
    // Exactly one confirm instruction, covering everything.
    expect(preview).toMatch(/Reply "send" to confirm everything/);
    expect((preview.match(/Reply "send"/g) ?? []).length).toBe(1);
  });
});
