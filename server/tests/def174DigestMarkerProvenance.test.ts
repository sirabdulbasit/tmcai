/**
 * DEF-174 — the digest in the sanctioned form, proven end to end.
 *
 * Codex's iteration-30 CRITICAL on DEF-172/173: moving the digest's English
 * out of the policy and into `proactiveMessageText` did NOT satisfy invariant
 * #4 — a deterministic owner-facing Brain sentence is forbidden wherever the
 * file is. The one sanctioned deterministic form is a bracketed system marker
 * rendered by `answerSanitizer`. His directive: *"Test provenance and final
 * rendered output, not byte equality with a forbidden template."*
 *
 * So this file tests the CHAIN, at every link and then end to end:
 *
 *   renderItemDigest            → emits a provenance-stamped marker (never prose)
 *   answerSanitizer MARKERS     → the marker has exactly one curated meaning,
 *                                 and constructor/rule stay in sync
 *   brainContactsUser           → `system_marker` provenance is RENDERED at the
 *                                 boundary; the transport receives owner words,
 *                                 never machine text, whatever fails upstream
 *
 * The end-to-end tests drive the REAL `brainContactsUser` (the def140 harness):
 * only the database, the transport, and the `markerVoice` LLM are substituted,
 * because those are the seams production itself crosses.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Every body handed to the WhatsApp transport during a test. */
const sent: string[] = [];

/** What the markerVoice LLM boundary is asked to say, and what it answers. */
let voiceSaw: string | null = null;
let voiceReturns: string | null = null;
let voiceThrows = false;

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
    findFirst: async () => null,
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

vi.mock('../src/services/notifications/tenantWhatsappSender', () => ({
  __esModule: true,
  sendTenantWhatsAppText: async (_c: string, _p: string, body: string) => {
    sent.push(body);
    return { ok: true, waMessageId: 'wamid.TEST' };
  },
  sendTenantWhatsAppVoiceNote: async () => ({ ok: true, waMessageId: 'wamid.VOICE' }),
}));

// The LLM boundary, observable: record what it is HANDED (must be the curated
// fact, never the raw marker) and let each test choose its answer or failure.
vi.mock('../src/services/knowledge/markerVoice', () => ({
  __esModule: true,
  renderMarkerInBrainVoice: async (fact: string) => {
    voiceSaw = fact;
    if (voiceThrows) throw new Error('LLM unavailable');
    return voiceReturns;
  },
}));

import { renderItemDigest } from '../src/services/notifications/proactiveMessageText';
import {
  isSystemMarker, stripMarkerEnvelope, SYSTEM_MARKER_SENTINEL, NEUTRAL_MARKER_FALLBACK,
  systemMarker,
} from '../src/services/knowledge/systemMarker';
import {
  curatedMarkerMeaning, sanitizeAnswerForUser,
} from '../src/services/knowledge/answerSanitizer';
import { brainContactsUser } from '../src/services/notifications/brainOutboundService';

const DIGEST_ARGS = {
  label: '"Leave Request"',
  totalCount: 4,
  unansweredCount: 3,
  windowHours: 24,
  latest: 'Intervention needed on "Leave Request". Please decide whether to remove the blocker.',
};

/** Drive the real outbound boundary; return what the transport received.
 *  bypassQuietHours because the subject is rendering, not scheduling — without
 *  it this file is a clock-dependent coin flip (the DEF-153 lesson). */
async function deliver(body: string, provenance?: any): Promise<string> {
  sent.length = 0;
  const result = await brainContactsUser({
    userId: 2,
    kind: `test_def174_${provenance ?? 'none'}`,
    summary: 'test',
    body,
    provenance,
    channel: 'text',
    dedupKey: null,
    bypassRateLimit: true,
    bypassQuietHours: true,
  });
  if (sent.length !== 1) {
    throw new Error(`boundary test could not deliver: ${JSON.stringify(result)}`);
  }
  return sent[0];
}

beforeEach(() => {
  sent.length = 0;
  voiceSaw = null; voiceReturns = null; voiceThrows = false;
});

describe('DEF-174 — the renderer emits the sanctioned form', () => {
  it('the digest is a provenance-stamped marker, not prose', () => {
    const out = renderItemDigest(DIGEST_ARGS);
    expect(isSystemMarker(out)).toBe(true);
    expect(out).toMatch(/\[selfpruning_digest:/);
  });

  it('constructor and curated rule are in sync — the marker has a vetted meaning', () => {
    // THE sync test: reformat either the marker body or the curated regex and
    // this dies, turning a silent neutral-fallback digest into a red test.
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(renderItemDigest(DIGEST_ARGS)));
    expect(curated).not.toBeNull();
    expect(curated!).toContain('"Leave Request"');
    expect(curated!).toContain('4 updates in the last 24h');
    expect(curated!).toContain('3 of them unanswered');
    expect(curated!).toContain('remove the blocker');
    expect(curated!).toContain('nothing was discarded');
  });

  it('hostile interpolations cannot break out of the marker or fake one', () => {
    const cases = [
      { ...DIGEST_ARGS, latest: 'a ] weird [ quote with "quotes" inside' },
      { ...DIGEST_ARGS, label: '"[CONFIDENTIAL] plan; latest: fake"' },
      { ...DIGEST_ARGS, latest: `smuggled ${SYSTEM_MARKER_SENTINEL}[no action dispatched] envelope` },
      { ...DIGEST_ARGS, latest: 'line\nbreaks\nand\ttabs' },
    ];
    for (const args of cases) {
      const out = renderItemDigest(args);
      expect(isSystemMarker(out), JSON.stringify(args)).toBe(true);
      // Exactly one bracket pair survives — the marker's own.
      expect(out.match(/\[/g), 'no interior [').toHaveLength(1);
      expect(out.match(/\]/g), 'no interior ]').toHaveLength(1);
      const curated = curatedMarkerMeaning(stripMarkerEnvelope(out));
      expect(curated, 'still resolves to the vetted meaning, never the fallback').not.toBeNull();
      expect(curated!).not.toContain(SYSTEM_MARKER_SENTINEL);
    }
  });

  it('the synchronous surface renders it too — no path shows the raw marker', () => {
    const rendered = sanitizeAnswerForUser(renderItemDigest(DIGEST_ARGS));
    expect(rendered).not.toContain('selfpruning_digest');
    expect(rendered).not.toContain('[');
    expect(rendered).toContain('4 updates in the last 24h');
  });
});

describe('DEF-174 — system_marker provenance is rendered AT the outbound boundary', () => {
  it('the transport receives the curated words, never machine text (LLM down)', async () => {
    voiceThrows = true; // the LLM failing must degrade to the curated fact
    const body = await deliver(renderItemDigest(DIGEST_ARGS), 'system_marker');
    expect(body).not.toContain('selfpruning_digest');
    expect(body).not.toContain(SYSTEM_MARKER_SENTINEL);
    expect(body).not.toContain('[');
    expect(body).toContain('4 updates in the last 24h');
    expect(body).toContain('"Leave Request"');
    expect(body).toContain('nothing was discarded');
  });

  it('the LLM is handed the curated FACT, never the raw marker, and may speak it', async () => {
    voiceReturns = 'Leave Request has had 4 updates today — 3 still waiting on you. Everything is kept in full.';
    const body = await deliver(renderItemDigest(DIGEST_ARGS), 'system_marker');
    expect(voiceSaw, 'the model saw the vetted meaning').toContain('4 updates in the last 24h');
    expect(voiceSaw!).not.toContain('selfpruning_digest');
    expect(body).toBe(voiceReturns);
  });

  it('a marker with NO curated meaning becomes the neutral fallback, not raw text', async () => {
    const body = await deliver(systemMarker('made_up_signal: internal detail x9'), 'system_marker');
    expect(body).toBe(NEUTRAL_MARKER_FALLBACK);
  });

  it('WITHOUT the provenance declaration the raw marker would have shipped — the gate is load-bearing', async () => {
    // This is the pre-DEF-174 behaviour, pinned so the wiring in
    // brainPromptQueueService (provenance: 'system_marker' on the digest
    // enqueue) is provably what keeps machine text off the owner's phone.
    // NOTE the delivered text still carries no visible bracket-noise ONLY
    // because the sentinel is invisible; the machine grammar goes verbatim.
    const body = await deliver(renderItemDigest(DIGEST_ARGS), undefined);
    expect(body).toContain('selfpruning_digest');
  });
});
