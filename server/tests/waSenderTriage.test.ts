/**
 * Section 35 Phase 1 — sender triage at the tenant WhatsApp door.
 * Owner ruling 2026-08-04: unknown senders get ONE ask; "ignore" persists
 * until countermanded; concern is derived from evidence, never a manual
 * whitelist; the Brain never recommends ignoring anyone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const q = vi.fn();
const x = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: (...a: any[]) => q(...a), $executeRawUnsafe: (...a: any[]) => x(...a) },
}));
const enqueue = vi.fn(async () => ({ enqueued: true }));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueue(...a),
}));
const contact = vi.fn(async () => ({ sent: true }));
vi.mock('../src/services/notifications/brainOutboundService', () => ({
  brainContactsUser: (...a: any[]) => contact(...a),
}));

import {
  triageUnregisteredInbound, gatherConcernEvidence, interpretSenderDecision,
} from '../src/services/whatsapp/senderTriage';

const OWNER = [{ id: 2 }];
const PARAMS = { clientNumber: 'TMC-0001', fromNumber: '+923001234567', body: 'AoA, need approval' };

beforeEach(() => { q.mockReset(); x.mockReset(); enqueue.mockReset(); contact.mockReset(); x.mockResolvedValue(1); });

describe('door policy honors standing decisions', () => {
  it('standing ignore → silent drop, no relay, no re-ask', async () => {
    q.mockResolvedValueOnce(OWNER).mockResolvedValueOnce([{ policy: 'ignored' }]);
    const r = await triageUnregisteredInbound(PARAMS);
    expect(r.action).toBe('dropped_ignored');
    expect(enqueue).not.toHaveBeenCalled();
    expect(contact).not.toHaveBeenCalled();
  });

  it('pending → held quietly; ask-once means repeat inbound never re-prompts', async () => {
    q.mockResolvedValueOnce(OWNER).mockResolvedValueOnce([{ policy: 'pending' }]);
    const r = await triageUnregisteredInbound(PARAMS);
    expect(r.action).toBe('held_pending');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('allowed → message relayed to the owner', async () => {
    q.mockResolvedValueOnce(OWNER).mockResolvedValueOnce([{ policy: 'allowed' }]);
    const r = await triageUnregisteredInbound(PARAMS);
    expect(r.action).toBe('relayed_allowed');
    expect(contact).toHaveBeenCalledTimes(1);
    expect(String(contact.mock.calls[0][0].body)).toContain('AoA, need approval');
  });
});

describe('unknown sender — evidence, then ask-once', () => {
  it('concern evidence auto-allows and relays (no ask)', async () => {
    q.mockResolvedValueOnce(OWNER)          // owner
      .mockResolvedValueOnce([])            // no policy row
      .mockResolvedValueOnce([{ id: 't1' }]) // delegation thread
      .mockResolvedValueOnce([])            // no prior outbound
      .mockResolvedValueOnce([]);           // no facet
    const r = await triageUnregisteredInbound(PARAMS);
    expect(r.action).toBe('relayed_allowed');
    expect(r.evidence).toEqual(['delegation_thread']);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('no evidence → pending row + ONE neutral owner ask', async () => {
    q.mockResolvedValueOnce(OWNER).mockResolvedValueOnce([])
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const r = await triageUnregisteredInbound(PARAMS);
    expect(r.action).toBe('asked_owner');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const ask = enqueue.mock.calls[0][0];
    expect(ask.dedupKey).toBe('wa_sender_triage:+923001234567');
    expect(ask.sideEffect.kind).toBe('wa_sender_policy_decision');
    // The ask is neutral — the Brain must never recommend ignoring.
    expect(ask.question).not.toMatch(/recommend|should ignore|suggest ignoring/i);
  });

  it('fail-closed: lookup explosion holds the message, never allows it in', async () => {
    q.mockRejectedValue(new Error('db down'));
    const r = await triageUnregisteredInbound(PARAMS);
    expect(['held_pending', 'no_owner']).toContain(r.action);
    expect(contact).not.toHaveBeenCalled();
  });
});

describe('evidence gathering is deterministic joins', () => {
  it('collects each evidence kind independently', async () => {
    q.mockResolvedValueOnce([{ id: 't' }]).mockResolvedValueOnce([{ id: 'm' }]).mockResolvedValueOnce([{ id: 'f' }]);
    const ev = await gatherConcernEvidence('TMC-0001', '+923001234567');
    expect(ev).toEqual(['delegation_thread', 'prior_brain_outbound', 'contact_phone_match']);
  });
  it('empty phone → no evidence, no queries', async () => {
    expect(await gatherConcernEvidence('TMC-0001', '')).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });
});

describe('owner decision interpretation', () => {
  it('strict forms fast-path without the LLM', async () => {
    const llm = vi.fn();
    expect(await interpretSenderDecision('ignore', llm)).toBe('ignore');
    expect(await interpretSenderDecision('Reply', llm)).toBe('allow');
    expect(await interpretSenderDecision('yes', llm)).toBe('allow');
    expect(llm).not.toHaveBeenCalled();
  });
  it('free-form answers go to the LLM (regex is never the final boundary)', async () => {
    expect(await interpretSenderDecision('ye mera cousin hai, baat kar lo', async () => 'ALLOW')).toBe('allow');
    expect(await interpretSenderDecision('spam lagta hai', async () => 'IGNORE')).toBe('ignore');
    expect(await interpretSenderDecision('hmm', async () => 'UNCLEAR')).toBe('unclear');
  });
  it('classifier failure → unclear (pending stays; nothing mutates on a guess)', async () => {
    expect(await interpretSenderDecision('kuch samajh nahi aya', async () => { throw new Error('llm down'); })).toBe('unclear');
  });
});

describe('wiring proofs', () => {
  const SRC = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
  it('the inbound silent drop is gone — triage is consulted', () => {
    const inbound = SRC('services/whatsapp/WhatsAppInbound.ts');
    expect(inbound).toContain('triageUnregisteredInbound');
    expect(inbound).not.toContain('dropped (no save, no reply)');
  });
  it('the prompt side-effect is registered end to end', () => {
    expect(SRC('services/brainPrompts/brainPromptQueueService.ts')).toContain("'wa_sender_policy_decision'");
    expect(SRC('services/brainPrompts/promptReplyHandler.ts')).toContain("case 'wa_sender_policy_decision'");
  });
  it('migration exists and is idempotent', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', '20260804_wa_sender_policy', 'migration.sql'), 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS wa_sender_policy');
    expect(sql).toMatch(/DO \$\$/);
  });
});
