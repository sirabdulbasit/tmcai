/**
 * DEF-140 — the address rules existed for compose only, and the owner reads
 * mostly something else.
 *
 * CL-033 (owner-supplied thread, 2026-08-12): the daily draft ask reached him
 * as *"Basit, haven't pinned this down yet — a priority and a deadline?"*. His
 * configured form of address is "Sir". Four loop iterations had been spent
 * refining address handling and none of them could reach this message, because
 * `compose` is not on its path.
 *
 * Codex verified the architecture independently: `openItemDraftAskJob` gets a
 * name from `addressUser`, renders `phraseDraftAsk`, and calls
 * `brainContactsUser` — never `compose`, never `finaliseUserVisibleProse`.
 *
 * ROOT CAUSE, and it is smaller than the architecture: **two disagreeing
 * implementations of "how do we address this person".** `brainPersonaService`
 * honours Settings → Profile; `addressUser` read `user.name` and took the first
 * token. `protection-with-two-implementations`, seventh occurrence, and the
 * 2026-05-20 fix for this exact complaint landed in the one the owner's phone
 * does not use.
 *
 * TWO LAYERS, and the order matters:
 *   1. Composition time — `addressUser` delegates to the persona. Supplying
 *      the right token when the message is BUILT cannot corrupt anything.
 *   2. Send time — one provenance-gated boundary in `brainContactsUser`,
 *      applied to Brain's own prose and nothing else.
 *
 * Layer 2 is why the provenance type exists. `senderTriage` and
 * `delegationCaptureService` forward a third party's words verbatim inside
 * `"${body.slice(0, 300)}"`. A universal finaliser at the transport would
 * rewrite a counterpart whose message opens "Hi Basit Ahmed" or "Sir, …" —
 * misquoting a real human to satisfy a cosmetic rule. That is DEF-137 with a
 * wider blast radius, and the assertions below are what stop it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const LEGAL_NAME = 'Basit Ahmed';
const PREFERRED = 'Sir';

// DEF-174 — what the boundary substitutes for a marker with no curated meaning.
import { NEUTRAL_MARKER_FALLBACK } from '../src/services/knowledge/systemMarker';

/** Every body handed to the WhatsApp transport during a test. */
const sent: string[] = [];

vi.mock('../src/db/prisma', () => {
  const user = {
    id: 2,
    name: 'Basit Ahmed',
    email: 'basit.ahmed@tmcltd.ai',
    clientNumber: 'TMC-0001',
    isActive: true,
    contactNumber: '+923000000000',
    notificationPreferences: {
      profile: { preferredTitle: 'Sir' },
      brain_channel: { outboundEnabled: true, quietHours: null },
    },
  };
  const model = {
    findUnique: async (args: any) => (args?.where?.clientNumber
      ? { name: 'TallyMarks Consulting', domain: 'tmcltd.com' }
      : user),
    // DEF-179: the outbound service resolves the user with a tenant-
    // constrained findFirst (id + clientNumber) — serve it, honouring both.
    findFirst: async (args: any) => (
      args?.where?.id === user.id && args?.where?.clientNumber === user.clientNumber
        ? user : null),
    findMany: async () => [],
    create: async () => ({ id: 'rec-1' }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
    count: async () => 0,
    aggregate: async () => ({}),
    groupBy: async () => [],
  };
  const p: any = new Proxy(
    { $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRaw: async () => 0 },
    { get: (t: any, k: string) => (k in t ? t[k] : model) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/knowledge/promptBlockService', () => ({
  __esModule: true,
  getApplicableBlocks: async () => [{ name: 'communication_contract', content: '# contract (stub)' }],
}));

vi.mock('../src/services/notifications/tenantWhatsappSender', () => ({
  __esModule: true,
  sendTenantWhatsAppText: async (_c: string, _p: string, body: string) => {
    sent.push(body);
    return { ok: true, waMessageId: 'wamid.TEST' };
  },
  sendTenantWhatsAppVoiceNote: async () => ({ ok: true, waMessageId: 'wamid.VOICE' }),
}));

import { addressUser, phraseDraftAsk, phraseOwnerChase } from '../src/services/notifications/brainHumanComm';
import { brainContactsUser } from '../src/services/notifications/brainOutboundService';

/**
 * Drive the real boundary and return the text the transport received.
 *
 * HERMETIC, and it was not before (DEF-153). `brainContactsUser` gates delivery
 * on OFFICE HOURS (`brainOutboundService.ts:450`, DEF-120), so these eight
 * assertions passed when the suite ran inside the working day and failed
 * deterministically outside it. The published iteration-10 numbers were true at
 * 12:46 and worthless as a release claim, because they were a function of the
 * clock. Codex reproduced 8 failures and attributed them to Redis idempotency;
 * the real gate is `outside_office_hours`, confirmed by printing the refusal.
 *
 * `bypassQuietHours` is the flag that clears both quiet and office hours. The
 * subject here is the address/provenance boundary, not delivery scheduling, so
 * suppressing an unrelated gate is the correct isolation — and doing it
 * explicitly beats mocking the clock.
 */
async function deliver(body: string, provenance?: any): Promise<string | undefined> {
  sent.length = 0;
  const result = await brainContactsUser({
    userId: 2,
    // DEF-178: the caller declares the tenant it acts for, verified against
    // the resolved user — the mock user above belongs to TMC-0001.
    clientNumber: 'TMC-0001',
    kind: `test_${Math.abs(body.length)}_${provenance ?? 'none'}`,
    summary: 'test',
    body,
    provenance,
    channel: 'text',
    dedupKey: null,
    bypassRateLimit: true,
    // Without this the whole file is a clock-dependent coin flip.
    bypassQuietHours: true,
  });
  // Assert the send HAPPENED before asserting what it contained. Not having
  // this is why the original failure read as "expected undefined to be …"
  // instead of naming the gate that refused — eight misleading messages that
  // cost a review cycle to diagnose.
  if (sent.length !== 1) {
    throw new Error(
      `boundary test could not deliver: brainContactsUser returned `
      + `${JSON.stringify(result)} — a delivery gate refused, so nothing about `
      + `address policy was actually exercised`,
    );
  }
  return sent[0];
}

describe('DEF-140 — one owner-address boundary, and it knows what it is looking at', () => {
  beforeEach(() => { sent.length = 0; });

  // ── Layer 1: composition time. The root cause. ─────────────────────────
  describe('addressUser resolves the CONFIGURED form, not the legal name', () => {
    it('returns the preferred title when one is set', async () => {
      // The whole defect in one assertion: this returned "Basit" in production.
      await expect(addressUser(2)).resolves.toBe(PREFERRED);
    });

    it('the draft ask therefore never opens with the legal first name', async () => {
      const greet = await addressUser(2);
      const msg = phraseDraftAsk({
        userFirstName: greet,
        itemTitle: "Define rules for Brain's responsiveness to new vs. existing contacts",
        missingSlots: ['priority', 'dueDate'],
        dayIndex: 0,
        itemId: 'item-def140',
      });
      // The exact string the owner received, verbatim from CL-033.
      expect(msg).not.toContain('Basit,');
      expect(msg.startsWith('Basit')).toBe(false);
      expect(msg).toContain(`${PREFERRED},`);
    });

    it('the owner-chase prompt is fixed by the same resolver', async () => {
      const greet = await addressUser(2);
      const msg = phraseOwnerChase({
        userFirstName: greet,
        delegateeName: 'Hamna Latif Bhutta',
        itemTitle: 'ShireMe Recruiting Portal Application Testing',
        ageDays: 3,
        itemId: 'item-chase',
      });
      expect(msg).not.toContain('Basit,');
      expect(msg).toContain(`${PREFERRED},`);
    });
  });

  // ── Layer 2: the send boundary, gated on provenance. ───────────────────
  describe('quoted third-party text is never touched', () => {
    // HONEST NOTE about how much these two prove, because mutation says less
    // than the assertion looks like it says. Both bodies lead with
    // `${who} replied:`, so the third party's words sit mid-string — and
    // DEF-137 already anchored both address rules at position 0. Removing the
    // provenance gate does NOT break these two; they stay green either way.
    //
    // So today the ANCHOR is what protects the current producers, and
    // provenance is defence in depth behind it. They are kept because they
    // pin the real production shapes verbatim, and because the anchor is one
    // edit away from being relaxed by someone who does not know what it is
    // for. The test that actually proves the gate earns its place is
    // "the two provenances disagree on the SAME input" below — that one dies
    // when the gate is removed.
    it('leaves a counterpart message quoting "Hi Basit Ahmed" byte-for-byte unchanged', async () => {
      // delegationCaptureService / senderTriage shape, verbatim.
      const body = `Hamna Latif Bhutta replied: "Hi ${LEGAL_NAME}, the repository is ready"\n\n`
        + '(Not attached to an open request — everything I had with them is already closed or waiting on you.)';
      expect(await deliver(body, 'quoted_third_party')).toBe(body);
    });

    it('leaves a counterpart message quoting "Sir," byte-for-byte unchanged', async () => {
      const body = `+923001234567 replied: "${PREFERRED}, I will send it tomorrow"\n\n`
        + '(Not attached to an open request.)';
      expect(await deliver(body, 'quoted_third_party')).toBe(body);
    });
  });

  describe('deterministic artifacts and markers keep their shape', () => {
    it('leaves the lifecycle intervention form unchanged', async () => {
      const body = 'Intervention needed on "Vision Metric Integration". Owner: Hamna Latif Bhutta. '
        + 'Follow-up attempts without a usable response: 3. Commitments recorded: 0.';
      expect(await deliver(body, 'deterministic')).toBe(body);
    });

    it('a system marker is RENDERED, never delivered as machine text (DEF-174)', async () => {
      // This test used to assert the marker passed through UNCHANGED — which
      // pinned the defect: `system_marker` provenance claimed "rendered
      // downstream by answerSanitizer" while nothing downstream rendered it,
      // so raw machine text was one producer away from the owner's phone
      // (Codex iteration-30 CRITICAL). The boundary now renders: this marker
      // has no curated meaning, so the owner gets the neutral fallback — a
      // plain sentence — never the internal bracket.
      const body = '[remove_open_item: could not find an open item matching "that"]';
      const delivered = await deliver(body, 'system_marker');
      expect(delivered).toBe(NEUTRAL_MARKER_FALLBACK);
      expect(delivered).not.toContain('[');
    });

    it('leaves an UNCLASSIFIED payload unchanged — fail closed', async () => {
      // ~60 producers are not yet classified. They must be inert here, not
      // guessed at: an unclassified body is somebody else's text until proven
      // otherwise (invariant #6).
      const body = `${PREFERRED}, this producer never declared what it is.`;
      expect(await deliver(body)).toBe(body);
    });
  });

  describe('Brain prose does get the policy', () => {
    it('normalises a legal-name greeting in Brain-authored prose', async () => {
      expect(await deliver(`Hi ${LEGAL_NAME}, your 3pm moved to 4.`, 'brain_prose'))
        .toBe(`Hi ${PREFERRED}, your 3pm moved to 4.`);
    });

    it('drops a reflexive vocative opener in Brain-authored prose', async () => {
      // Same rule the compose surface has had since DEF-134 — now reaching
      // the surface the owner actually reads most of.
      expect(await deliver(`${PREFERRED}, the invoice cleared this morning.`, 'brain_prose'))
        .toBe('The invoice cleared this morning.');
    });

    it('and the two provenances disagree on the SAME input', async () => {
      // The single clearest statement of why provenance exists rather than a
      // universal finaliser: identical bytes, opposite correct outcomes.
      const body = `${PREFERRED}, the invoice cleared this morning.`;
      expect(await deliver(body, 'quoted_third_party')).toBe(body);
      expect(await deliver(body, 'brain_prose')).not.toBe(body);
    });
  });

  // ── Containment: the producers that must stay classified. ──────────────
  describe('the classified producers do not silently lose their declaration', () => {
    // Source-level, and labelled as such: a supplement to the behaviour tests
    // above, not a substitute (working rule #6). Its job is narrow — catch a
    // future edit that drops a provenance line from a producer the inventory
    // classified, which no behaviour test in this file would notice.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const classified: Array<[string, string]> = [
      ['src/jobs/openItemDraftAskJob.ts', 'brain_prose'],
      ['src/jobs/openItemFollowUpJob.ts', 'brain_prose'],
      ['src/services/selfheal/repairService.ts', 'brain_prose'],
      ['src/services/selfheal/findingNotifier.ts', 'brain_prose'],
      ['src/services/whatsapp/senderTriage.ts', 'quoted_third_party'],
      ['src/services/delegation/delegationCaptureService.ts', 'quoted_third_party'],
      ['src/jobs/actionLifecycleWorker.ts', 'deterministic'],
    ];
    for (const [rel, expected] of classified) {
      it(`${rel.split('/').pop()} still declares ${expected}`, () => {
        const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
        expect(src).toContain(`provenance: '${expected}'`);
      });
    }

    it('the prompt queue still carries provenance across the tick', () => {
      // delegationCaptureService reaches the owner via the queue, so a drop
      // here would silently unclassify the quoted-third-party case.
      const src = fs.readFileSync(
        path.join(__dirname, '..', 'src/services/brainPrompts/brainPromptQueueService.ts'), 'utf8',
      );
      expect(src).toContain('provenance: input.provenance');
      expect(src).toContain('queueMeta.provenance');
    });
  });
});
