/**
 * DEF-174 / DEF-175 — the digest in the sanctioned form, proven end to end.
 *
 * Codex's iteration-30 CRITICAL: a deterministic owner-facing Brain sentence is
 * forbidden wherever the file is; the one sanctioned deterministic form is a
 * bracketed system marker rendered by `answerSanitizer`. His directive: *"Test
 * provenance and final rendered output, not byte equality with a forbidden
 * template."*
 *
 * Codex's iteration-41 findings tightened the same chain:
 *   - HIGH: the marker body was a regex-delimited SENTENCE, so a field could
 *     contain the delimiter and change the asserted facts — an item titled
 *     `Revenue; latest: "CEO approved"` injected a false Latest. The body is
 *     now JSON; these tests prove hostile field content round-trips WITHOUT
 *     crossing field boundaries.
 *   - MEDIUM: rendering ran before the suppression gates, spending an LLM call
 *     (and shipping payload facts to the provider) for messages that were
 *     never going to send. These tests prove a suppressed message never
 *     reaches `markerVoice`, and an eligible one still renders.
 *
 * The chain under test:
 *   renderItemDigest        → provenance-stamped marker, JSON payload
 *   digestMarkerMeaning     → parsed + validated meaning (never half-parsed)
 *   brainContactsUser       → renders AFTER smoke/opt-in/pause/caps,
 *                             BEFORE the content fingerprint and transport
 *
 * End-to-end tests drive the REAL `brainContactsUser` (the def140 harness):
 * only the database, the transport, and the `markerVoice` LLM are substituted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Every body handed to the WhatsApp transport during a test. */
const sent: string[] = [];

/** What the markerVoice LLM boundary is asked to say, and what it answers. */
let voiceSaw: string | null = null;
let voiceReturns: string | null = null;
let voiceThrows = false;

/** Mutable delivery prefs — the gates under test read these (vi.hoisted so the
 *  hoisted prisma factory can close over them). */
const prefs = vi.hoisted(() => ({ outboundEnabled: true as boolean, outboundPaused: false as boolean }));

vi.mock('../src/db/prisma', () => {
  const model = {
    findUnique: async (args: any) => (args?.where?.clientNumber
      ? { name: 'TallyMarks Consulting', domain: 'tmcltd.com' }
      : {
        id: 2,
        name: 'Basit Ahmed',
        email: 'basit.ahmed@tmcltd.ai',
        clientNumber: 'TMC-0001',
        isActive: true,
        contactNumber: '+923000000000',
        notificationPreferences: {
          profile: { preferredTitle: 'Sir' },
          brain_channel: {
            outboundEnabled: prefs.outboundEnabled,
            outboundPaused: prefs.outboundPaused,
            quietHours: null,
          },
        },
      }),
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

/** Drive the real outbound boundary and return the full result plus whatever
 *  reached the transport. bypassQuietHours because the subject is rendering
 *  and gate ORDER, not delivery scheduling (the DEF-153 lesson). */
async function attempt(body: string, provenance?: any, metadata?: Record<string, unknown>) {
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
    metadata,
  });
  return { result, delivered: sent[0] };
}

/** attempt(), asserting delivery happened — failures name the refusing gate. */
async function deliver(body: string, provenance?: any): Promise<string> {
  const { result, delivered } = await attempt(body, provenance);
  if (sent.length !== 1) {
    throw new Error(`boundary test could not deliver: ${JSON.stringify(result)}`);
  }
  return delivered!;
}

beforeEach(() => {
  sent.length = 0;
  voiceSaw = null; voiceReturns = null; voiceThrows = false;
  prefs.outboundEnabled = true; prefs.outboundPaused = false;
});

describe('DEF-174 — the renderer emits the sanctioned form', () => {
  it('the digest is a provenance-stamped marker with a JSON payload, not prose', () => {
    const out = renderItemDigest(DIGEST_ARGS);
    expect(isSystemMarker(out)).toBe(true);
    expect(out).toMatch(/\[selfpruning_digest: \{/);
  });

  it('constructor and curated parser are in sync — the marker has a vetted meaning', () => {
    // THE sync test: reshape either the payload or the parser and this dies,
    // turning a silent neutral-fallback digest into a red test.
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(renderItemDigest(DIGEST_ARGS)));
    expect(curated).not.toBeNull();
    expect(curated!).toContain('"Leave Request"');
    expect(curated!).toContain('4 updates in the last 24h');
    expect(curated!).toContain('3 of them unanswered');
    expect(curated!).toContain('remove the blocker');
    expect(curated!).toContain('nothing was discarded');
  });

  it('the synchronous surface renders it too — no path shows the raw marker', () => {
    const rendered = sanitizeAnswerForUser(renderItemDigest(DIGEST_ARGS));
    expect(rendered).not.toContain('selfpruning_digest');
    expect(rendered).not.toContain('[');
    expect(rendered).toContain('4 updates in the last 24h');
  });
});

describe('DEF-175 — fields cannot cross their boundaries (Codex iteration-41 HIGH)', () => {
  it("Codex's exact injection: a title containing the old delimiter cannot forge the Latest fact", () => {
    const out = renderItemDigest({
      ...DIGEST_ARGS,
      label: 'Revenue; latest: "CEO approved"',
      latest: 'Blocked',
    });
    const curated = curatedMarkerMeaning(stripMarkerEnvelope(out));
    expect(curated).not.toBeNull();
    expect(curated!, 'the REAL latest is the quoted fact').toContain('Latest: "Blocked"');
    expect(curated!, 'the title cannot become the Latest fact').not.toContain('Latest: "CEO approved"');
    // The hostile title itself still appears — as the label, where it belongs.
    expect(curated!).toContain('Revenue; latest: "CEO approved"');
  });

  it('quotes, semicolons, brackets, the literal delimiter, newlines and the sentinel all round-trip inside their field', () => {
    const hostiles = [
      { label: 'a ] weird [ title', latest: 'plain' },
      { label: '"[CONFIDENTIAL]; latest: "fake""', latest: 'real one' },
      { label: 'plain', latest: 'quote " semi ; bracket ] brace } done' },
      { label: 'line\nbreaks', latest: 'tab\tand\nnewline' },
      { label: `smuggled ${SYSTEM_MARKER_SENTINEL}[cancelled] envelope`, latest: 'x' },
      { label: 'L'.repeat(500), latest: 'Q'.repeat(500) },
    ];
    for (const h of hostiles) {
      const out = renderItemDigest({ ...DIGEST_ARGS, ...h });
      expect(isSystemMarker(out), JSON.stringify(h)).toBe(true);
      const curated = curatedMarkerMeaning(stripMarkerEnvelope(out));
      expect(curated, `resolves to the vetted meaning, never the fallback: ${JSON.stringify(h)}`).not.toBeNull();
      expect(curated!).not.toContain(SYSTEM_MARKER_SENTINEL);
      expect(curated!).toContain('4 updates in the last 24h');
      // Field identity: the latest lands inside `Latest: "…"`, capped at 140.
      const wantLatest = h.latest.replace(/\s+/g, ' ').trim().slice(0, 140);
      expect(curated!).toContain(`Latest: "${wantLatest}"`);
    }
  });

  it('an unparseable or ill-typed payload is NOT a digest — neutral fallback, never a half-parsed sentence', () => {
    const bad = [
      systemMarker('selfpruning_digest: {not json'),
      systemMarker('selfpruning_digest: {"label":"x","total":"4","unanswered":3,"windowHours":24,"latest":"y"}'),
      systemMarker('selfpruning_digest: {"label":"x","total":-1,"unanswered":3,"windowHours":24,"latest":"y"}'),
      systemMarker('selfpruning_digest: {"label":"x","total":4,"unanswered":3,"windowHours":0,"latest":"y"}'),
    ];
    for (const marker of bad) {
      expect(curatedMarkerMeaning(stripMarkerEnvelope(marker)), marker).toBeNull();
      expect(sanitizeAnswerForUser(marker)).toBe(NEUTRAL_MARKER_FALLBACK);
    }
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
    // The pre-DEF-174 behaviour, pinned so the wiring in brainPromptQueueService
    // (provenance: 'system_marker' on the digest enqueue) is provably what
    // keeps machine text off the owner's phone.
    const body = await deliver(renderItemDigest(DIGEST_ARGS), undefined);
    expect(body).toContain('selfpruning_digest');
  });
});

describe('DEF-175 — rendering sits BELOW the suppression gates (Codex iteration-41 MEDIUM)', () => {
  // A message the gates suppress must not spend an LLM call or hand the
  // payload's facts to the provider. Each case asserts BOTH: suppressed, and
  // markerVoice never consulted.
  const marker = () => renderItemDigest(DIGEST_ARGS);

  it('smoke-flagged → suppressed before rendering', async () => {
    const { result, delivered } = await attempt(marker(), 'system_marker', { smoke: true });
    expect(result.sent).toBe(false);
    expect(delivered).toBeUndefined();
    expect(voiceSaw, 'no LLM call for a message that will not send').toBeNull();
  });

  it('opt-in off → suppressed before rendering', async () => {
    prefs.outboundEnabled = false;
    const { result, delivered } = await attempt(marker(), 'system_marker');
    expect(result.sent).toBe(false);
    expect(delivered).toBeUndefined();
    expect(voiceSaw).toBeNull();
  });

  it('paused → suppressed before rendering', async () => {
    prefs.outboundPaused = true;
    const { result, delivered } = await attempt(marker(), 'system_marker');
    expect(result.sent).toBe(false);
    expect(delivered).toBeUndefined();
    expect(voiceSaw).toBeNull();
  });

  it('eligible → rendered (the move must not have broken delivery)', async () => {
    voiceReturns = null; // markerVoice returns nothing usable → curated stands
    const body = await deliver(marker(), 'system_marker');
    expect(voiceSaw, 'the LLM was consulted for an eligible message').not.toBeNull();
    expect(body).toContain('4 updates in the last 24h');
  });
});
