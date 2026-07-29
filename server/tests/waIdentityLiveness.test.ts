/**
 * REQ-009 — @lid identity unification + liveness deadlock break.
 *
 * Covers the production outage of 2026-07-24 → 07-28: the §34 liveness
 * probe compared its self-chat echo against a single Wid spelling, so
 * every probe failed, the tenant channel sat `degraded` with outbound
 * sends withheld, and no code path could recover it — while Brain kept
 * answering the owner over the very transport being declared dead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  normalizeWid, sameWid, isLidId, resolveIdentityIds, resolveSelfIds,
  resolvePhoneChat, resolveMessageViaPhoneChat, __resetWaIdentityCacheForTests,
} from '../src/services/whatsapp/waIdentity';
import {
  newProbeSession, matchProbeEcho, buildProbeMarker, recordOutboundProof,
  recordProbeFailure, mayReprobe, noteProbeAttempt, getConsecutiveLivenessFailures,
  isSendCapableStatus, EPISODE_PROBE_CAP, __resetTenantLivenessForTests,
} from '../src/services/whatsapp/webjsLiveness';

const WA_DIR = path.join(__dirname, '..', 'src', 'services', 'whatsapp');
const SRC = (rel: string) => fs.readFileSync(path.join(WA_DIR, rel), 'utf8');

const TENANT = 'TMC-0001';
const PHONE = '923274572102@c.us';
const LID = '173555350261799@lid';

beforeEach(() => {
  __resetTenantLivenessForTests();
  __resetWaIdentityCacheForTests();
});

describe('Wid normalization', () => {
  it('ignores multi-device suffix and case, keeps the domain', () => {
    expect(normalizeWid('923274572102:12@c.us')).toBe(PHONE);
    expect(normalizeWid('923274572102@C.US')).toBe(PHONE);
    expect(sameWid('923274572102:3@c.us', PHONE)).toBe(true);
  });
  it('never treats a LID as equal to a phone Wid by string alone', () => {
    // LID digits live in a different namespace — collapsing domains would
    // let one account's LID compare equal to another account's phone.
    expect(sameWid(LID, '173555350261799@c.us')).toBe(false);
    expect(isLidId(LID)).toBe(true);
    expect(isLidId(PHONE)).toBe(false);
  });
  it('empty/garbage ids never compare equal', () => {
    expect(sameWid('', '')).toBe(false);
    expect(sameWid(null, undefined)).toBe(false);
    expect(normalizeWid(undefined)).toBe('');
  });
});

describe('identity resolution via the library', () => {
  const client = (over: any = {}) => ({
    info: { wid: { _serialized: PHONE } },
    getContactLidAndPhone: async () => [{ lid: LID, pn: PHONE }],
    ...over,
  });

  it('returns both spellings of the same account', async () => {
    expect(await resolveSelfIds(client())).toEqual([PHONE, LID]);
  });
  it('caches a resolved pair (page evaluation is expensive, binding is stable)', async () => {
    let calls = 0;
    const c = client({ getContactLidAndPhone: async () => { calls += 1; return [{ lid: LID, pn: PHONE }]; } });
    await resolveSelfIds(c);
    await resolveSelfIds(c);
    expect(calls).toBe(1);
  });
  it('a library failure degrades to the known id and is NOT cached', async () => {
    let calls = 0;
    const c = client({
      getContactLidAndPhone: async () => { calls += 1; throw new Error('page detached'); },
    });
    expect(await resolveSelfIds(c)).toEqual([PHONE]);
    await resolveSelfIds(c);
    expect(calls).toBe(2); // retried, so a transient fault cannot become permanent
  });
  it('tolerates a client with no mapping API at all', async () => {
    expect(await resolveIdentityIds({ }, LID)).toEqual([LID]);
    expect(await resolveSelfIds({})).toEqual([]);
  });
});

describe('probe echo matching is @lid-aware (lock 2 preserved)', () => {
  const session = () => {
    const s = newProbeSession(TENANT, 'TMC-0001#gen7', 'nonceA');
    s.expectedProviderId = 'prov_1';
    return s;
  };
  const echo = (s: any, over: any = {}) => matchProbeEcho(s, {
    fromMe: true, chatId: PHONE, selfId: PHONE, selfIds: [PHONE, LID],
    body: buildProbeMarker(s.nonce), providerId: 'prov_1',
    generation: s.generation, clientNumber: TENANT, ...over,
  });

  it('THE OUTAGE: echo stamped with the account LID now matches', () => {
    // Before REQ-009 this returned 'rejected' — every probe failed here.
    expect(echo(session(), { chatId: LID })).toBe('matched');
  });
  it('echo stamped with the phone Wid still matches', () => {
    expect(echo(session())).toBe('matched');
  });
  it('device-suffixed echo matches', () => {
    expect(echo(session(), { chatId: '923274572102:9@c.us' })).toBe('matched');
  });
  it('a FOREIGN chat is still rejected — the gate keeps its purpose', () => {
    expect(echo(session(), { chatId: '92300111222@c.us' })).toBe('rejected');
    expect(echo(session(), { chatId: '999999999@lid' })).toBe('rejected');
  });
  it('fromMe and nonce remain mandatory regardless of identity breadth', () => {
    expect(echo(session(), { fromMe: false })).toBe('rejected');
    expect(echo(session(), { body: buildProbeMarker('other') })).toBe('rejected');
  });
  it('falls back to selfId when no set is supplied (old callers unchanged)', () => {
    expect(echo(session(), { selfIds: undefined })).toBe('matched');
    expect(echo(session(), { selfIds: [], chatId: LID })).toBe('rejected');
  });
  it('an empty identity set can never match anything', () => {
    expect(echo(session(), { selfId: null, selfIds: [] })).toBe('rejected');
  });
});

describe('outbound proof breaks the liveness deadlock', () => {
  it('re-arms an exhausted probe budget', () => {
    for (let i = 0; i < EPISODE_PROBE_CAP; i++) noteProbeAttempt(TENANT);
    expect(mayReprobe(TENANT)).toEqual({ allowed: false, reason: 'episode_cap_exhausted' });
    expect(recordOutboundProof(TENANT)).toBe(true);
    expect(mayReprobe(TENANT).allowed).toBe(true);
  });
  it('clears the degraded spacing window so recovery is immediate', () => {
    recordProbeFailure(TENANT); recordProbeFailure(TENANT); // degraded + lastProbeAt=now
    expect(mayReprobe(TENANT)).toEqual({ allowed: false, reason: 'too_soon' });
    recordOutboundProof(TENANT);
    expect(mayReprobe(TENANT).allowed).toBe(true);
  });
  it('does NOT erase probe-failure history — only a pass may do that', () => {
    recordProbeFailure(TENANT); recordProbeFailure(TENANT); recordProbeFailure(TENANT);
    recordOutboundProof(TENANT);
    expect(getConsecutiveLivenessFailures(TENANT)).toBe(3);
  });
  it('does NOT make the channel send-capable (lock 6 intact)', () => {
    recordOutboundProof(TENANT);
    for (const s of ['degraded', 'connected_unverified', 'liveness_failed']) {
      expect(isSendCapableStatus(s), s).toBe(false);
    }
  });
  it('reports false when nothing needed re-arming', () => {
    expect(recordOutboundProof(TENANT)).toBe(false);
  });
});

describe('phone-chat resolution helpers', () => {
  it('resolvePhoneChat is a no-op for non-LID ids', async () => {
    const client = { getChatById: async () => ({ id: PHONE }), getContactLidAndPhone: async () => [{ pn: PHONE }] };
    expect(await resolvePhoneChat(client, PHONE)).toBeNull();
  });
  it('resolvePhoneChat returns the phone-Wid chat for a LID id', async () => {
    const client = {
      getContactLidAndPhone: async () => [{ lid: LID, pn: PHONE }],
      getChatById: async (id: string) => ({ id }),
    };
    expect(await resolvePhoneChat(client, LID)).toEqual({ id: PHONE });
  });
  it('resolvePhoneChat swallows library faults', async () => {
    const client = {
      getContactLidAndPhone: async () => { throw new Error('detached'); },
      getChatById: async () => ({}),
    };
    expect(await resolvePhoneChat(client, LID)).toBeNull();
  });
  it('resolveMessageViaPhoneChat finds the same message in the phone chat', async () => {
    const target = { id: { _serialized: 'MSG_1' }, downloadMedia: async () => ({ data: 'x' }) };
    const message = {
      from: LID,
      id: { _serialized: 'MSG_1' },
      client: {
        getContactLidAndPhone: async () => [{ lid: LID, pn: PHONE }],
        getChatById: async () => ({ fetchMessages: async () => [{ id: { _serialized: 'OTHER' } }, target] }),
      },
    };
    expect(await resolveMessageViaPhoneChat(message)).toBe(target);
  });
  it('resolveMessageViaPhoneChat returns null for a non-LID message', async () => {
    expect(await resolveMessageViaPhoneChat({ from: PHONE, id: { _serialized: 'M' } })).toBeNull();
  });
});

describe('recurrence guards (source-level)', () => {
  it('waIdentity.ts is the ONLY home of the @lid mapping call', () => {
    // The root cause of three repeats: the resolver lived privately in one
    // consumer, so each new module reopened the hole. Any new direct caller
    // must instead route through waIdentity.
    const offenders = fs.readdirSync(WA_DIR)
      .filter((f) => f.endsWith('.ts') && f !== 'waIdentity.ts')
      .filter((f) => SRC(f).includes('getContactLidAndPhone'));
    expect(offenders).toEqual([]);
  });
  it('the activity, media and probe layers all consume the shared module', () => {
    expect(SRC('inboundActivity.ts')).toContain("from './waIdentity'");
    expect(SRC('inboundMedia.ts')).toContain("'./waIdentity'");
    expect(SRC('WebjsProvider.ts')).toContain("'./waIdentity'");
  });
  it('the probe passes a self-identity SET, not one spelling', () => {
    const src = SRC('WebjsProvider.ts');
    expect(src).toContain('resolveSelfIds');
    const probe = src.slice(src.indexOf('async function runLivenessProbe'));
    expect(probe).toContain('selfIds');
  });
  it('generation tokens are monotonic strings, never Symbols', () => {
    const src = SRC('WebjsProvider.ts');
    expect(src).not.toMatch(/=\s*Symbol\(/); // the assignment, not prose about it
    expect(src).toContain('nextGenerationToken');
    expect(src).toContain('token: string');
  });
  it('the generation is stamped at client registration, not first probe', () => {
    // Otherwise requestLivenessProbe early-returns and every watchdog
    // capped_reprobe is a silent no-op until `ready` fires in-process.
    const src = SRC('WebjsProvider.ts');
    const stamp = src.indexOf('__livenessGeneration = token');
    expect(stamp).toBeGreaterThan(-1);
    expect(stamp).toBeLessThan(src.indexOf('clients.set(clientNumber, client)') + 200);
  });
  it('a liveness-degraded client may re-initialize; a pairing fault may not', () => {
    const src = SRC('WebjsProvider.ts');
    expect(src).toContain("previousHealth.repairReason !== 'liveness'");
    expect(src).toContain("repairReason: 'auth_failure'");
    expect(src).toContain("repairReason: requiresRepair ? 'init_timeout' : undefined");
    // The old text asserted a pairing fault nothing had checked.
    expect(src).not.toContain('initialize withheld — session requires re-pair');
  });
  it('probe failures record which limb broke', () => {
    const src = SRC('WebjsProvider.ts');
    for (const mode of ['send_threw', 'echo_unmatched', 'no_echo']) expect(src).toContain(mode);
    expect(src).toContain('failureMode');
  });
  it('a confirmed webjs reply feeds proof back into the liveness budget', () => {
    const inbound = SRC('WhatsAppInbound.ts');
    expect(inbound).toContain('recordOutboundProof');
    const replyIdx = inbound.indexOf('if (params.replyFn)');
    expect(inbound.slice(replyIdx, replyIdx + 1200)).toContain('recordOutboundProof');
  });
});
