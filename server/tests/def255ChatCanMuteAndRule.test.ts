/**
 * DEF-255 — `trigger-instruction-as-task`, 2nd recorded occurrence (DEF-237 was the 1st).
 *
 * S22 (2026-08-29): "Ignore all emails from Anthropic and HR announcement" had NOWHERE to
 * land on the chat path. The voice/WhatsApp dispatcher has muted a sender and persisted a
 * standing rule since A8 (2026-07-08); chat could not, so the model — whose capability
 * truth-table is GENERATED from the action registry (DEF-130) and therefore listed only
 * `set_contact_scope` / `mark_contact_inactive` — offered two mechanisms that do something
 * else, and asked which one, twice.
 *
 * Same capability, two channels, one implementation missing: the 12th
 * `protection-with-two-implementations`. So the fix is a BRIDGE, never a second
 * implementation — the chat path calls the SAME `dispatchInstruction` WhatsApp calls, and
 * the compile-time `satisfies readonly InstructionIntent[]` on `DISPATCHER_BRIDGED_TYPES`
 * makes a dispatcher rename break the build instead of stranding a chat action.
 *
 * What this suite pins, in the order the failure happened:
 *   1. the capability is DECLARED (registry + both dispatch gates) — the half DEF-130 taught
 *   2. the planner's JSON becomes a real action, and an empty one becomes nothing
 *   3. the bridge reaches the REAL dispatcher and the row is actually written
 *   4. a CONFIRMED plan executes it too — the DEF-232 invariant, for the new kinds
 *   5. the bridge is NOT a catch-all — drift still dies loudly rather than being "Noted"
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

const muteUpserts: any[] = [];
const muteDeletes: any[] = [];

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    deleteMany: async () => ({ count: 0 }), upsert: async () => ({}), count: async () => 0,
  };
  const p: any = new Proxy(
    {
      mutedSender: {
        upsert: async (args: any) => { muteUpserts.push(args); return {}; },
        deleteMany: async (args: any) => { muteDeletes.push(args); return { count: 1 }; },
      },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

import {
  COMPOSER_DISPATCHED_TYPES,
  DISPATCHABLE_PLAN_STEP_KINDS,
  DISPATCHER_BRIDGED_TYPES,
  IMMEDIATE_INTERNAL_ACTION_TYPES,
  actionAsInstruction,
  dispatchPendingDirect,
  normaliseAction,
} from '../src/services/knowledge/brainComposer';
import { ACTIONS } from '../src/scripts/seedActionDefinitions';

const COMPOSER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8',
);
/** Comments stripped — a source guard must read code, not prose about it. */
const CODE = COMPOSER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const pending = (actionKind: string, slots: any) => ({
  id: 'pend_255', clientNumber: 'TMC-0001', userId: 2, channel: 'whatsapp' as const,
  actionKind: actionKind as any, status: 'confirmed' as const,
  slots, missingSlots: [], previewHash: null, previewedAt: null,
  artifactId: null, createdAt: new Date(), updatedAt: new Date(),
  expiresAt: new Date(Date.now() + 3600_000),
}) as any;

beforeEach(() => {
  muteUpserts.length = 0;
  muteDeletes.length = 0;
});

describe('DEF-255 — the capability is DECLARED, which is what S22 actually lacked', () => {
  it('all three intents are seeded in the action registry (the model is TOLD it can)', () => {
    // DEF-130's lesson exactly: `brainCapabilityLive` generates the CAN side of the truth
    // table from these rows, so an unseeded capability is one Brain truthfully denies —
    // however well it works. This is the half that makes S22's ask answerable at all.
    const seeded = new Set(ACTIONS.map((a) => a.type));
    for (const t of DISPATCHER_BRIDGED_TYPES) expect(seeded.has(t), `${t} not seeded`).toBe(true);
  });

  it('every seeded bridged intent declares operationalMetadata as internal (no connector)', () => {
    // Muting writes one local row and a standing rule writes a wiki page: neither leaves the
    // system, so neither may be gated on a connector's health.
    for (const t of DISPATCHER_BRIDGED_TYPES) {
      const seed = ACTIONS.find((a) => a.type === t)!;
      expect(seed.operationalMetadata).toEqual({ external: false });
    }
  });

  it('they dispatch immediately AND from a confirmed plan (DEF-232 invariant holds)', () => {
    for (const t of DISPATCHER_BRIDGED_TYPES) {
      expect(COMPOSER_DISPATCHED_TYPES.has(t), `${t} not composer-dispatched`).toBe(true);
      expect(DISPATCHABLE_PLAN_STEP_KINDS.has(t), `${t} refused in a confirmed plan`).toBe(true);
      expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has(t as any), `${t} would demand a preview`).toBe(true);
    }
  });

  it('the near-duplicate intents stay OUT — offering two mechanisms is the S22 failure', () => {
    // `draft_reply` / `delegate` / `set_window` all duplicate composer actions that already
    // exist. Advertising both is precisely how the model came to ask which one to use.
    for (const t of ['draft_reply', 'delegate', 'set_window', 'none']) {
      expect(COMPOSER_DISPATCHED_TYPES.has(t), `${t} must not be bridged`).toBe(false);
    }
  });
});

describe('DEF-255 — the planner\'s JSON becomes a real action, or nothing', () => {
  it('"ignore all emails from Anthropic" parses into a mute with its reason', () => {
    expect(normaliseAction({
      type: 'mute_sender', senderIdentifier: ' Anthropic@x.com ',
      senderChannel: 'email', reason: 'Owner asked to ignore these',
    })).toEqual({
      type: 'mute_sender', senderIdentifier: 'Anthropic@x.com',
      senderChannel: 'email', reason: 'Owner asked to ignore these',
    });
  });

  it('a standing rule keeps the owner\'s words verbatim', () => {
    expect(normaliseAction({
      type: 'standing_instruction', instructionText: '  Never chase Hamna after 6pm  ',
    })).toEqual({ type: 'standing_instruction', instructionText: 'Never chase Hamna after 6pm', summary: undefined });
  });

  it('an empty identifier or empty rule is REJECTED, not muted-with-nothing', () => {
    // A mute with no identifier would upsert a blank row and answer "Muted ." — a claim
    // with no referent, which is the `fabricated-status` shape.
    expect(normaliseAction({ type: 'mute_sender', senderIdentifier: '   ' })).toBeNull();
    expect(normaliseAction({ type: 'unmute_sender' })).toBeNull();
    expect(normaliseAction({ type: 'standing_instruction', instructionText: '' })).toBeNull();
  });

  it('the channel defaults to email and only whatsapp overrides it', () => {
    expect((normaliseAction({ type: 'mute_sender', senderIdentifier: 'a@b.com' }) as any).senderChannel).toBe('email');
    expect((normaliseAction({ type: 'mute_sender', senderIdentifier: '+92300', senderChannel: 'whatsapp' }) as any).senderChannel).toBe('whatsapp');
    expect((normaliseAction({ type: 'mute_sender', senderIdentifier: 'a@b.com', senderChannel: 'telex' }) as any).senderChannel).toBe('email');
  });

  it('actionAsInstruction reshapes without knowing any type — the mapping lives in ONE switch', () => {
    const ix = actionAsInstruction({
      type: 'mute_sender', senderIdentifier: 'hr@x.com', senderChannel: 'email', reason: 'noise',
    } as any);
    expect(ix.intent).toBe('mute_sender');
    expect(ix.params.senderIdentifier).toBe('hr@x.com');
    expect(ix.params.reason).toBe('noise');
    // Summary falls back through the fields a bridged type actually carries, so the
    // dispatcher's ack names the thing rather than saying "Noted: ".
    expect(actionAsInstruction({ type: 'standing_instruction', instructionText: 'No chasing on Sundays' } as any).summary)
      .toBe('No chasing on Sundays');
  });
});

describe('DEF-255 — the bridge reaches the REAL dispatcher and the row is written', () => {
  it('a confirmed mute upserts muted_senders — no "[Unknown pending action kind]"', async () => {
    const r = await dispatchPendingDirect('TMC-0001', 2, pending('mute_sender', {
      senderIdentifier: 'Announcements@Anthropic.COM', senderChannel: 'email', reason: 'S22: ignore these',
    }));
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain('Unknown pending action kind');
    expect(muteUpserts).toHaveLength(1);
    // The dispatcher's own normalisation applies — one implementation, so chat inherits it.
    expect(muteUpserts[0].create.identifier).toBe('announcements@anthropic.com');
    expect(muteUpserts[0].create.userId).toBe(2);
  });

  it('the stored reason is the CALLER\'s, not the literal "Voice instruction"', async () => {
    // The mute row is what the owner reads when he asks why a sender is silent. Recording a
    // chat instruction as a voice one is a small lie in the one place that explains itself.
    await dispatchPendingDirect('TMC-0001', 2, pending('mute_sender', {
      senderIdentifier: 'hr@tmcltd.com', senderChannel: 'email', reason: 'HR announcements — owner asked',
    }));
    expect(muteUpserts[0].create.reason).toBe('HR announcements — owner asked');
    expect(muteUpserts[0].update.reason).toBe('HR announcements — owner asked');
  });

  it('a mute with no reason still records the old default rather than an empty one', async () => {
    await dispatchPendingDirect('TMC-0001', 2, pending('mute_sender', { senderIdentifier: 'x@y.com' }));
    expect(muteUpserts[0].create.reason).toBe('Voice instruction');
  });

  it('unmute is the reversal, through the same bridge', async () => {
    const r = await dispatchPendingDirect('TMC-0001', 2, pending('unmute_sender', {
      senderIdentifier: 'HR@tmcltd.com', senderChannel: 'email',
    }));
    expect(r.ok).toBe(true);
    expect(muteDeletes[0].where.identifier).toBe('hr@tmcltd.com');
  });
});

describe('DEF-255 — the bridge is not a catch-all, so drift still dies loudly', () => {
  it('an unknown kind still returns "[Unknown pending action kind]"', async () => {
    // The first draft of this fix routed EVERY unmatched kind to the dispatcher, whose
    // default persists any textful intent as a standing instruction and answers "Noted".
    // A capability that silently degrades into a note is `fabricated-status` with extra
    // steps, and it would have hidden exactly the drift chat17's lock exists to catch.
    const r = await dispatchPendingDirect('TMC-0001', 2, pending('teleport_item', { title: 'x' }));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Unknown pending action kind');
    expect(muteUpserts).toHaveLength(0);
  });

  it('the immediate chain gates the bridge on the bridged set, not on "everything else"', () => {
    expect(CODE).toContain('DISPATCHER_BRIDGED_TYPES as readonly string[]).includes(act.type)');
  });

  it('the bridged set is exactly the three, and each is a real dispatcher intent', () => {
    // The `satisfies readonly InstructionIntent[]` in the source is the compile-time half;
    // this pins the membership so a fourth intent cannot be added without a row and a test.
    expect([...DISPATCHER_BRIDGED_TYPES]).toEqual(['mute_sender', 'unmute_sender', 'standing_instruction']);
    expect(CODE).toContain('satisfies readonly InstructionIntent[]');
  });
});
