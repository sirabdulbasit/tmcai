/**
 * Section 33a — reviewer-required test matrix (REQ-003 approval).
 * Pure-logic-first with mocked prisma/LLM, plus source-level proofs
 * for the scope fences (33a sends NOTHING to counterparts; grants have
 * zero consumers; retired workers stay retired).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const { prismaMock, tx } = vi.hoisted(() => {
  const tx = {
    delegationThreadEvent: { create: vi.fn() },
    delegationThread: { updateMany: vi.fn() },
    correlationIncident: { upsert: vi.fn(), update: vi.fn() },
    correlationIncidentCandidate: { count: vi.fn(), upsert: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  };
  const prismaMock = {
    delegationThread: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    delegationThreadEvent: { findFirst: vi.fn(), count: vi.fn() },
    openItem: { findFirst: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(tx)),
  };
  return { prismaMock, tx };
});
vi.mock('../src/db/prisma', () => ({ default: prismaMock }));

import {
  ACTIVE_THREAD_STATES, THREAD_TRANSITIONS, canonicalWhatsAppNumber,
  counterpartKeyFor, isDelegationCaptureEnabled, isAutonomousOutboundEnabled,
  appendEventWithTransition, registerOutboundReceipt, upsertActiveThread,
} from '../src/services/delegation/delegationThreadService';

const SRC = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: any) => fn(tx));
  tx.delegationThreadEvent.create.mockResolvedValue({ id: 'evt_1' });
  tx.delegationThread.updateMany.mockResolvedValue({ count: 1 });
});

// ── canonical keys / LID normalization ───────────────────────────────
describe('counterpart canonicalization', () => {
  it('normalizes phone variants to one E.164 key', () => {
    for (const v of ['+92 302 8000553', '923028000553', '0092-3028000553'.replace('00', '+'), '+923028000553']) {
      expect(canonicalWhatsAppNumber(v)).toBe('+923028000553');
    }
    expect(counterpartKeyFor('whatsapp', '92 302 8000553')).toBe('wa:+923028000553');
  });
  it('rejects garbage destinations (fail closed, no guessing)', () => {
    expect(canonicalWhatsAppNumber('not-a-number')).toBeNull();
    expect(counterpartKeyFor('whatsapp', '12')).toBeNull();
    expect(counterpartKeyFor('email', 'nope')).toBeNull();
  });
  it('emails lowercase into em: keys', () => {
    expect(counterpartKeyFor('email', ' Yousaf@TMC.com ')).toBe('em:yousaf@tmc.com');
  });
});

// ── transition table integrity + migration lockstep ─────────────────
describe('state machine integrity', () => {
  it('terminal states have no outgoing transitions', () => {
    for (const s of ['closed', 'expired', 'cancelled']) expect(THREAD_TRANSITIONS[s]).toEqual([]);
  });
  it('every transition target is a declared state', () => {
    const all = new Set(Object.keys(THREAD_TRANSITIONS));
    for (const targets of Object.values(THREAD_TRANSITIONS)) {
      for (const t of targets) expect(all.has(t), `undeclared state ${t}`).toBe(true);
    }
  });
  it('ACTIVE_THREAD_STATES matches the migration partial-index WHERE clauses exactly', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', '20260722_delegation_threads', 'migration.sql'), 'utf8');
    const clauses = [...sql.matchAll(/WHERE state IN \(([^)]+)\)/g)].map((m) =>
      m[1].split(',').map((s) => s.trim().replace(/'/g, '')).sort());
    expect(clauses.length).toBeGreaterThanOrEqual(2);
    for (const clause of clauses) {
      expect(clause).toEqual([...ACTIVE_THREAD_STATES].sort());
    }
  });
  it('migration is additive-only and idempotent by construction', () => {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'migrations', '20260722_delegation_threads', 'migration.sql'), 'utf8');
    expect(sql).not.toMatch(/ALTER TABLE (?!.*delegation|.*correlation)/i);
    expect(sql).not.toMatch(/DROP /i);
    expect((sql.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length).toBe(5);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS dte_inbound_dedup_uq/);
  });
});

// ── kill switches / defaults ─────────────────────────────────────────
describe('feature flags fail closed', () => {
  it('env kill switch beats everything', async () => {
    process.env.DELEGATION_CAPTURE_ENABLED = '0';
    expect(await isDelegationCaptureEnabled('TMC-0001')).toBe(false);
    delete process.env.DELEGATION_CAPTURE_ENABLED;
    process.env.DELEGATION_AUTONOMOUS_OUTBOUND_ENABLED = '0';
    expect(await isAutonomousOutboundEnabled('TMC-0001')).toBe(false);
    delete process.env.DELEGATION_AUTONOMOUS_OUTBOUND_ENABLED;
  });
  it('defaults are OFF (behaviorConfig def=0 for both flags)', async () => {
    const { BEHAVIOR_SPECS } = await import('../src/services/behaviorConfig');
    expect(BEHAVIOR_SPECS['delegation.capture_enabled'].def).toBe(0);
    expect(BEHAVIOR_SPECS['delegation.autonomous_outbound_enabled'].def).toBe(0);
  });
});

// ── CAS + dedup semantics ────────────────────────────────────────────
describe('appendEventWithTransition', () => {
  it('rejects illegal transitions before touching the DB', async () => {
    const r = await appendEventWithTransition({
      clientNumber: 'TMC-0001', threadId: 't1',
      event: { eventType: 'inbound_received', channel: 'whatsapp', provenance: 'external_delegatee_reply' },
      transition: { expectedState: 'closed', toState: 'evaluating' },
    });
    expect(r).toEqual({ ok: false, reason: 'illegal_transition' });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
  it('concurrent consumption: CAS mismatch → cas_conflict, event rolled back with the tx', async () => {
    tx.delegationThread.updateMany.mockResolvedValue({ count: 0 });
    const r = await appendEventWithTransition({
      clientNumber: 'TMC-0001', threadId: 't1',
      event: { eventType: 'inbound_received', channel: 'whatsapp', provenance: 'external_delegatee_reply' },
      transition: { expectedState: 'awaiting_reply', toState: 'evaluating' },
    });
    expect(r).toEqual({ ok: false, reason: 'cas_conflict' });
  });
  it('duplicate provider delivery: unique violation → duplicate_event, no mutation', async () => {
    tx.delegationThreadEvent.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const r = await appendEventWithTransition({
      clientNumber: 'TMC-0001', threadId: 't1',
      event: { eventType: 'inbound_received', channel: 'whatsapp', inboundSourceId: 'wa_1', provenance: 'external_delegatee_reply' },
      transition: { expectedState: 'awaiting_reply', toState: 'evaluating' },
    });
    expect(r).toEqual({ ok: false, reason: 'duplicate_event' });
  });
});

describe('receipt/intent binding (stale receipts cannot mutate later dispatches)', () => {
  it('receipt for a superseded intent is audit-only — no transition', async () => {
    prismaMock.delegationThread.findFirst.mockResolvedValue({
      state: 'dispatch_pending', activeIntentEventId: 'intent_NEW', priorState: 'awaiting_reply', origin: 'worker_send',
    });
    const r = await registerOutboundReceipt({
      clientNumber: 'TMC-0001', threadId: 't1', channel: 'whatsapp',
      senderIdentity: 'tenant_wa:TMC-0001', intentEventId: 'intent_OLD', status: 'accepted',
    });
    expect(r.ok).toBe(true);
    expect(r.transitioned).toBe(false);
    expect(tx.delegationThread.updateMany).not.toHaveBeenCalled();
  });
  it('late receipt after inbound evidence (state=evaluating) is audit-only', async () => {
    prismaMock.delegationThread.findFirst.mockResolvedValue({
      state: 'evaluating', activeIntentEventId: 'intent_1', priorState: 'awaiting_reply', origin: 'worker_send',
    });
    const r = await registerOutboundReceipt({
      clientNumber: 'TMC-0001', threadId: 't1', channel: 'whatsapp',
      senderIdentity: 'tenant_wa:TMC-0001', intentEventId: 'intent_1', status: 'failed',
    });
    expect(r.transitioned).toBe(false);
  });
  it('failed receipt on a thread newly created for this dispatch → cancelled', async () => {
    prismaMock.delegationThread.findFirst.mockResolvedValue({
      state: 'dispatch_pending', activeIntentEventId: 'intent_1', priorState: null, origin: 'worker_send',
    });
    prismaMock.delegationThreadEvent.findFirst.mockResolvedValue({ priorState: 'awaiting_reply' });
    prismaMock.delegationThreadEvent.count.mockResolvedValue(0); // ledger: only the intent exists
    const r = await registerOutboundReceipt({
      clientNumber: 'TMC-0001', threadId: 't1', channel: 'whatsapp',
      senderIdentity: 'tenant_wa:TMC-0001', intentEventId: 'intent_1', status: 'failed',
    });
    expect(r.transitioned).toBe(true);
    const casArg = tx.delegationThread.updateMany.mock.calls[0][0];
    expect(casArg.data.state).toBe('cancelled');
    expect(casArg.where.state).toBe('dispatch_pending');
  });
  it('failed receipt on a pre-existing thread restores the recorded prior state', async () => {
    prismaMock.delegationThread.findFirst.mockResolvedValue({
      state: 'dispatch_pending', activeIntentEventId: 'intent_1', priorState: 'awaiting_reply', origin: 'worker_send',
    });
    prismaMock.delegationThreadEvent.findFirst.mockResolvedValue({ priorState: 'awaiting_reply' });
    prismaMock.delegationThreadEvent.count.mockResolvedValue(3);
    const r = await registerOutboundReceipt({
      clientNumber: 'TMC-0001', threadId: 't1', channel: 'whatsapp',
      senderIdentity: 'tenant_wa:TMC-0001', intentEventId: 'intent_1', status: 'failed',
    });
    expect(r.transitioned).toBe(true);
    expect(tx.delegationThread.updateMany.mock.calls[0][0].data.state).toBe('awaiting_reply');
  });
});

describe('thread upsert', () => {
  it('cross-tenant race: unique violation re-selects the winner instead of guessing', async () => {
    prismaMock.delegationThread.findFirst
      .mockResolvedValueOnce(null)                                  // pre-check
      .mockResolvedValueOnce({ id: 'winner', state: 'awaiting_reply' }); // post-conflict
    prismaMock.delegationThread.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));
    const r = await upsertActiveThread({
      clientNumber: 'TMC-0001', ownerUserId: 2, openItemId: 'item1',
      channel: 'whatsapp', destination: '+923028000553', origin: 'worker_send',
    });
    expect(r).toEqual({ id: 'winner', state: 'awaiting_reply' });
  });
  it('uncanonicalizable destination → null (send proceeds unregistered, nothing invented)', async () => {
    expect(await upsertActiveThread({
      clientNumber: 'TMC-0001', ownerUserId: 2, openItemId: 'item1',
      channel: 'whatsapp', destination: 'landline?', origin: 'worker_send',
    })).toBeNull();
  });
});

// ── classifier fencing ───────────────────────────────────────────────
describe('thread_capture classification fences', () => {
  it('interpretActionReplyStrict returns null on LLM failure — never the regex fallback', async () => {
    vi.doMock('../src/services/llmRouter', () => ({
      callLLM: vi.fn(async () => { throw new Error('down'); }),
    }));
    vi.resetModules();
    const { interpretActionReplyStrict } = await import('../src/services/openItems/actionLifecycleService');
    expect(await interpretActionReplyStrict('done, all deployed', { title: 'EXIM' })).toBeNull();
    vi.doUnmock('../src/services/llmRouter');
    vi.resetModules();
  });
  it('recordActionLifecycleReply in thread_capture without interpretation refuses (no guessing)', async () => {
    const { recordActionLifecycleReply } = await import('../src/services/openItems/actionLifecycleService');
    const r = await recordActionLifecycleReply({
      openItemId: 'i1', clientNumber: 'TMC-0001', body: 'done', source: 'whatsapp', mode: 'thread_capture',
    });
    expect(r.handled).toBe(false);
  });
  it('thread_capture never closes the item nor mutates dueDate on confident completion', async () => {
    prismaMock.openItem.findFirst.mockResolvedValue({
      id: 'i1', clientNumber: 'TMC-0001', userId: 2, title: 'EXIM',
      status: 'DELEGATED', dueDate: null, notes: [], metadata: {},
    });
    prismaMock.openItem.update.mockResolvedValue({});
    const { recordActionLifecycleReply } = await import('../src/services/openItems/actionLifecycleService');
    const r = await recordActionLifecycleReply({
      openItemId: 'i1', clientNumber: 'TMC-0001', body: 'deployed to UAT yesterday',
      source: 'whatsapp', mode: 'thread_capture',
      interpretation: {
        outcome: 'completed', summary: 'deployed to UAT', newDeadline: new Date('2026-08-01'),
        delayReason: null, completionEvidence: 'deployed to UAT yesterday',
        needsUserIntervention: false, confidence: 0.95,
      } as any,
    });
    expect(r.closed).toBe(false);
    const updateData = prismaMock.openItem.update.mock.calls[0][0].data;
    expect(updateData.dueDate).toBeUndefined();
  });
});

// ── source-level scope proofs ────────────────────────────────────────
describe('33a scope fences (source-level)', () => {
  it('delegation services send NOTHING to counterparts, except the DEF-123 disambiguation ask', () => {
    // AMENDED 2026-08-11 by owner ruling, not by convenience: "brain knows that
    // against which that Hamna's message belongs to, if not then brain should
    // get clarification from Hamna and then update me".
    //
    // The 33a fence exists to stop Brain CONVERSING with counterparts —
    // answering them, reacting, being drawn into a thread it cannot govern.
    // That still holds absolutely. What it never really meant was "no contact
    // at all": smartChaseService has always been allowed to chase a delegatee,
    // so the true boundary was unsolicited conversation, not outbound bytes.
    //
    // The single permitted exception is ONE question to a KNOWN delegatee,
    // mid-thread, when their reply matched several of their own open items —
    // asking the person who knows instead of waking the owner to guess.
    // Everything else stays forbidden, and the OTHER two files stay absolute.
    for (const rel of ['services/delegation/delegationThreadService.ts', 'jobs/delegationRecoveryJob.ts']) {
      const src = SRC(rel);
      for (const forbidden of ['sendTenantWhatsAppText', 'sendUserEmail', 'sendInboundTextReply', 'message.reply', '.react(']) {
        expect(src, `${rel} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }

    const capture = SRC('services/delegation/delegationCaptureService.ts');
    // Still never answers, reacts, or replies inline.
    for (const forbidden of ['sendUserEmail', 'sendInboundTextReply', 'message.reply', '.react(']) {
      expect(capture, `capture must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // The one send it may do is the disambiguation ask, and nothing else.
    const sends = capture.split('sendTenantWhatsAppText').length - 1;
    expect(sends, 'exactly one counterpart send path is permitted').toBeLessThanOrEqual(2); // import + call
    expect(capture, 'the only send must be the disambiguation ask')
      .toContain('askCounterpartWhichItem');
    // It must remain guarded: known counterpart, real number, once per day.
    const fn = capture.slice(capture.indexOf('async function askCounterpartWhichItem'));
    expect(fn.slice(0, 3000), 'must refuse an unresolved LID').toMatch(/\^\\\+\\d\{8,15\}\$/);
    expect(fn.slice(0, 3000), 'must ask at most once a day').toContain('sent_at::date');
  });
  it('grants have ZERO consumers in src (schema-only in 33a)', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes('delegationAuthorizationGrant')) hits.push(p);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    expect(hits).toEqual([]);
  });
  it('worker counterpart email branch is fail-closed (no sendUserEmail in contactConcernedParty)', () => {
    const src = SRC('jobs/actionLifecycleWorker.ts');
    const fn = src.slice(src.indexOf('async function contactConcernedParty'), src.indexOf('async function claimAndRecord'));
    expect(fn).not.toContain('await sendUserEmail(');
    expect(fn).not.toContain("import('../services/gmailService')");
    expect(fn).toContain('counterpart email suppressed');
    expect(fn).toContain('sendTenantWhatsAppText'); // tenant identity only
  });
  it('unregistered voice senders get no transcription echo (gate present)', () => {
    const src = SRC('services/whatsapp/WebjsProvider.ts');
    const echoIdx = src.indexOf('🎙️ Heard:');
    const guardIdx = src.lastIndexOf('if (resolvedIdentity) {', echoIdx);
    expect(echoIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    expect(echoIdx - guardIdx).toBeLessThan(400); // the echo sits inside the identity gate
  });
  it('retired services stay retired: no callers outside their own files', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) { walk(p); continue; }
        if (!f.name.endsWith('.ts')) continue;
        const body = fs.readFileSync(p, 'utf8');
        if (p.includes('expectedExternalReplyService.ts') || p.includes('delegateeFollowupWorker.ts')) continue;
        if (body.includes('captureExpectedExternalReply') || body.includes('scheduleDelegateeFollowupWorker') || body.includes('runDelegateeFollowupSweep')) {
          offenders.push(p);
        }
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    expect(offenders).toEqual([]);
  });
  it('counterpart text reaches the classifier as fenced data (no regex injection gate)', () => {
    const src = SRC('services/delegation/delegationCaptureService.ts');
    expect(src).toContain('untrusted data');
    expect(src).not.toMatch(/injection.*test\(|\.test\(.*injection/i);
  });
});
