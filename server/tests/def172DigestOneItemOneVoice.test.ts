/**
 * DEF-172 / C-3 increment 2 — one item, one voice.
 *
 * Increment 1 measured the real noise shape from production: not floods from
 * strangers (the CL-033 sender was answered 13/13), but a CROSS-PRODUCER DRIP —
 * `item:cmqauv4xx…` took 13 pushes from three subsystems at 69% unanswered,
 * each push reasonable in isolation.
 *
 * So increment 2 digests per ITEM across producers, at the one chokepoint every
 * producer already calls (`enqueueBrainPrompt`). These tests drive the REAL
 * enqueue function and the REAL behaviorConfig resolver — iteration 26's lesson
 * is that mocking the resolver proves a path production cannot take.
 *
 * ── THE PROPERTIES UNDER TEST, IN ORDER OF WHAT THEY PROTECT ────────────────
 *
 * 1. OWNER CONTROL: default OFF. Deploying this changes nothing until the owner
 *    flips `selfpruning.digest_enabled` — Codex's required gate before any
 *    automatic suppression.
 * 2. NOTHING IS LOST: a digested push is a FULL queue row with an audit block,
 *    never dispatched, never deleted. DEF-156 dropped nine of ten messages by
 *    suppressing before persisting; every rule here fails toward sending.
 * 3. NO BYPASS: the decision lives inside `enqueueBrainPrompt`, so a producer
 *    cannot route around it without abandoning the queue entirely.
 * 4. EXACT SUBJECTS ONLY: increment 1's `unresolvedSubjects` and `floods` are
 *    non-actionable; a push without an item identity is always sent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Rows already in the queue (the history the policy counts). */
let existing: any[] = [];
/** Every row created THIS test, in order. */
let created: any[] = [];
let countWhere: any = null;
let countFails = false;
/** DEF-173 failure injection: which create dies, and how. */
let digestCreateFails = false;
let filingCreateFails = false;
/** DEF-174/175 P2002 shapes: 'racer' = the real race (the racer's committed row
 *  is visible for survivor verification); 'ghost' = P2002 with NO survivor to
 *  verify; 'wrong-constraint' = a different unique surface named in
 *  e.meta.target, with a live same-key row present so that ONLY the constraint
 *  check can refuse it; 'cross-tenant' = the only matching live row belongs to
 *  ANOTHER tenant, so only a tenant-scoped survivor read can refuse it
 *  (Codex iteration-41 CRITICAL — each mode kills the mutant that drops its
 *  check). */
let digestCreateP2002: false | 'racer' | 'ghost' | 'wrong-constraint' | 'cross-tenant' = false;
/** Tenant config for the REAL behaviorConfig resolver + owner decisions. */
let tenantConfig: Record<string, unknown> = {};

let nextId = 1;

vi.mock('../src/db/prisma', () => {
  const brainPromptQueue = {
    create: async ({ data }: any) => {
      const isDigestMsg = data?.metadata?.source === 'selfpruning_digest';
      const isFiled = !!data?.metadata?.digest;
      if (isDigestMsg && digestCreateFails) throw new Error('digest insert failed');
      if (isDigestMsg && digestCreateP2002) {
        if (digestCreateP2002 !== 'ghost') {
          // The racer COMMITTED between the probe and this insert — its row is
          // what DEF-174's survivor verification reads back. In 'cross-tenant'
          // mode the row lives under ANOTHER tenant: visible to an unscoped
          // read, invisible to a correct one.
          existing.push({
            ...data, id: nextId++, state: 'queued',
            ...(digestCreateP2002 === 'cross-tenant' ? { clientNumber: 'OTHER-9' } : {}),
          });
        }
        const e: any = new Error('unique constraint');
        e.code = 'P2002';
        e.meta = {
          target: digestCreateP2002 === 'wrong-constraint'
            ? 'brain_prompt_queue_pkey' : 'uq_bpq_dedup_live_tenant',
        };
        throw e;
      }
      if (isFiled && filingCreateFails) throw new Error('filing insert failed');
      const row = { id: nextId++, ...data };
      created.push(row);
      return { id: row.id };
    },
    findFirst: async ({ where }: any) => {
      // The dedup probe / survivor verification: any non-terminal row with
      // this dedupKey. The mock HONOURS every filter the query states —
      // including clientNumber — so a query that omits tenant scoping will
      // happily match a cross-tenant row here, which is exactly what the
      // DEF-175 adversarial tests below exploit to kill that mutant.
      if (where?.dedupKey) {
        return [...existing, ...created].find((r) =>
          r.dedupKey === where.dedupKey
          && (where.clientNumber === undefined || r.clientNumber === where.clientNumber)
          && (where.userId === undefined || r.userId === where.userId)
          && ['queued', 'awaiting_reply'].includes(r.state)) ?? null;
      }
      // sendNextPrompt's "next queued row" probe — nothing dispatches in tests.
      return null;
    },
    count: async ({ where }: any) => {
      if (countFails) throw new Error('count unavailable');
      countWhere = where;
      return existing.filter((r) => {
        if (r.clientNumber !== where.clientNumber || r.userId !== where.userId) return false;
        if (!r.sentAt || r.sentAt < where.sentAt.gte || r.sentAt > where.sentAt.lte) return false;
        if (r.answeredAt) return false;
        const itemId = where.OR[0].openItemId;
        return r.openItemId === itemId || r.metadata?.openItemId === itemId;
      }).length;
    },
    findMany: async () => [],
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
  };
  const openItem = {
    findFirst: async ({ where }: any) =>
      where?.id === 'item-X' ? { title: 'Leave Request' } : null,
  };
  const empty: any = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), count: async () => 0,
  };
  const p: any = new Proxy(
    { brainPromptQueue, openItem, $queryRawUnsafe: async () => [] },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

// Nothing may actually reach a channel from a unit test.
vi.mock('../src/services/notifications/brainOutboundService', () => ({
  __esModule: true,
  brainContactsUser: async () => ({ sent: false, reason: 'test' }),
}));

// The REAL behaviorConfig runs; only the tenant config STORE is substituted
// (the seam production goes through). Owner per-item decisions ride the same
// store.
vi.mock('../src/services/configService', () => ({
  __esModule: true,
  getConfig: async (_c: string, key: string) => tenantConfig[key] ?? null,
}));

import { enqueueBrainPrompt } from '../src/services/brainPrompts/brainPromptQueueService';
import { decideDigest } from '../src/services/selfpruning/digestPolicy';
import { clearBehaviorCache } from '../src/services/behaviorConfig';
import { isSystemMarker } from '../src/services/knowledge/systemMarker';
import { sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';

const NOW = new Date('2026-08-13T12:00:00Z');

/** A push already DELIVERED and unanswered — what the drip looks like.
 *
 *  `sentAt` is RELATIVE to the wall clock, deliberately (DEF-174 while fixing
 *  iteration-30's findings): the enqueue chokepoint calls `decideDigest`
 *  without a `now`, so the policy windows on the REAL clock. The first version
 *  of this fixture pinned `2026-08-13T10:00:00Z` — green for exactly 24 hours
 *  after it was written, then eight tests failed on an unchanged HEAD. That is
 *  the DEF-153 clock-dependence shape inside the very tests written to close a
 *  review finding. */
const delivered = (over: Record<string, any> = {}) => ({
  id: nextId++,
  clientNumber: 'TMC-0001', userId: 2,
  question: 'Intervention needed on "Leave Request".',
  openItemId: 'item-X', metadata: { source: 'action_lifecycle_governor' },
  state: 'answered_window', dedupKey: null,
  sentAt: new Date(Date.now() - 60 * 60 * 1000), answeredAt: null,
  ...over,
});

/** Three producers' worth of unanswered drip about one item. */
const drip = () => [
  delivered({ metadata: { source: 'action_lifecycle_governor' } }),
  delivered({ metadata: { source: 'preactive_due_nudge' }, openItemId: null,
    // DEF-120: this producer records the subject in metadata, not the column.
    ...( { metadata: { source: 'preactive_due_nudge', openItemId: 'item-X' } } ) }),
  delivered({ metadata: { source: 'action_status_update' } }),
];

const enqueue = (over: Record<string, any> = {}) => enqueueBrainPrompt({
  clientNumber: 'TMC-0001', userId: 2,
  question: 'Intervention needed on "Leave Request". Please decide whether to remove the blocker.',
  openItemId: 'item-X',
  provenance: 'brain_self' as any,
  metadata: { source: 'action_lifecycle_reply' },
  ...over,
} as any);

beforeEach(() => {
  existing = []; created = []; countWhere = null; countFails = false;
  digestCreateFails = false; filingCreateFails = false; digestCreateP2002 = false;
  tenantConfig = {}; nextId = 1;
  clearBehaviorCache();
});

describe('DEF-172 — owner control comes first', () => {
  it('DEFAULT OFF: with the switch unset, a heavy drip still sends normally', async () => {
    // Deploying the mechanism must change nothing. This is the whole safety
    // story of shipping increment 2 in the same release as the flag.
    existing = drip();
    const r = await enqueue();
    expect(r.status).toBe('queued');
    expect(created.filter((c) => c.metadata?.digest)).toHaveLength(0);
  });

  it('an owner per-item KEEP wins over the threshold', async () => {
    tenantConfig['behavior.selfpruning.digest_enabled'] = 1;
    tenantConfig['selfpruning.decision.item:item-X'] = 'keep';
    existing = drip();
    const r = await enqueue();
    expect(r.status).toBe('queued');
  });

  it('an UNRECOGNISED owner decision is keep, not consent', async () => {
    tenantConfig['behavior.selfpruning.digest_enabled'] = 1;
    tenantConfig['selfpruning.decision.item:item-X'] = 'obliterate';
    existing = drip();
    const r = await enqueue();
    expect(r.status, 'a value nobody defined must not authorise suppression').toBe('queued');
  });
});

describe('DEF-172 — the digest, when the owner has opted in', () => {
  beforeEach(() => { tenantConfig['behavior.selfpruning.digest_enabled'] = 1; });

  it('the 4th push about one item folds into ONE digest naming the count', async () => {
    existing = drip();
    const r = await enqueue();

    expect(r.status).toBe('digested');

    const filed = created.filter((c) => c.metadata?.digest);
    expect(filed, 'the push itself is filed, not dropped').toHaveLength(1);
    // 'skipped', an EXISTING schema state: the 20260505 CHECK constraint rejects
    // novel values with Postgres 23514 (DEF-060 — five days of silent insert
    // failures). The DEF-063 guard caught my first version using 'digested';
    // mocked prisma has no CHECK constraints, so only that guard could.
    expect(filed[0].state).toBe('skipped');
    expect(filed[0].question, 'the original text survives verbatim')
      .toContain('remove the blocker');
    expect(filed[0].metadata.digest.subjectKey).toBe('item:item-X');
    expect(filed[0].metadata.digest.reason).toMatch(/3 delivered unanswered/);

    const digests = created.filter((c) => c.metadata?.source === 'selfpruning_digest');
    expect(digests, 'exactly one digest message').toHaveLength(1);
    expect(digests[0].state).toBe('queued');
    expect(digests[0].dedupKey).toMatch(/^selfpruning_digest:item:item-X:\d+$/);
    // DEF-174 — the digest is the sanctioned deterministic form: a
    // provenance-stamped marker, declared as such so the outbound boundary
    // renders it instead of delivering it.
    expect(isSystemMarker(digests[0].question),
      'the queued digest is a marker, not owner prose').toBe(true);
    expect(digests[0].metadata.provenance).toBe('system_marker');
    // The FACTS are asserted on what the owner would read (DEF-175: the marker
    // body is JSON, so prose assertions belong on the rendered text).
    const rendered = sanitizeAnswerForUser(digests[0].question);
    expect(rendered).toContain('"Leave Request"');
    expect(rendered).toContain('4 updates');
    expect(rendered, 'the latest push is quoted').toContain('remove the blocker');
  });

  it('the count spans PRODUCERS and both subject encodings — no producer bypasses', async () => {
    // The drip fixture holds three different producers, one of which records the
    // item in metadata rather than the column (DEF-120). A fourth producer's
    // push still digests, because the decision is per ITEM at the chokepoint.
    existing = drip();
    const r = await enqueue({ metadata: { source: 'a_brand_new_producer' } });
    expect(r.status).toBe('digested');
    expect(countWhere.OR, 'the count reads column AND metadata subjects').toHaveLength(2);
  });

  it('a second digested push in the same window adds NO second digest message', async () => {
    existing = drip();
    await enqueue();
    const before = created.filter((c) => c.metadata?.source === 'selfpruning_digest').length;
    await enqueue({ question: 'Another nudge about the same item.' });
    const after = created.filter((c) => c.metadata?.source === 'selfpruning_digest').length;

    expect(before).toBe(1);
    expect(after, 'one item, one voice, one window').toBe(1);
    expect(created.filter((c) => c.metadata?.digest)).toHaveLength(2);
  });

  it('below the threshold it sends normally', async () => {
    existing = drip().slice(0, 2);
    const r = await enqueue();
    expect(r.status).toBe('queued');
  });

  it('pushes outside the window do not count', async () => {
    existing = drip().map((r) => ({ ...r, sentAt: new Date('2026-08-10T10:00:00Z') }));
    const r = await enqueue();
    expect(r.status, 'a three-day-old drip is not a live one').toBe('queued');
  });
});

describe('DEF-172 — what is NEVER digested, enabled or not', () => {
  beforeEach(() => {
    tenantConfig['behavior.selfpruning.digest_enabled'] = 1;
    existing = drip();
  });

  it('a push with no exact item identity', async () => {
    // Increment 1's floods and unresolved subjects are non-actionable; this is
    // the constructive half of that promise.
    const r = await enqueue({ openItemId: null, metadata: { source: 'delegation_capture', threadId: 'thr-9' } });
    expect(r.status).toBe('queued');
  });

  it('a HIGH-criticality push — escalations are never muffled', async () => {
    const r = await enqueue({ criticality: 'high' });
    expect(r.status).toBe('queued');
  });

  it('a digest itself — no recursion', async () => {
    const r = await enqueue({ metadata: { source: 'selfpruning_digest' } });
    expect(r.status).toBe('queued');
  });

  it('anything, when the count is unreadable — fail open to sending', async () => {
    // Losing a push to a broken query is the DEF-156 shape.
    countFails = true;
    const r = await enqueue();
    expect(r.status).toBe('queued');
  });
});

describe('DEF-172 — the policy is honest about its own reasons', () => {
  it('every send carries a reason a human can audit', async () => {
    const cases: Array<[Record<string, any>, RegExp]> = [
      [{ metadata: { source: 'selfpruning_digest' } }, /is itself a digest/],
      [{ criticality: 'high' }, /never digested/],
      [{}, /owner has not opted in/],
    ];
    for (const [over, want] of cases) {
      const d = await decideDigest({
        clientNumber: 'TMC-0001', userId: 2, question: 'q',
        criticality: 'routine', openItemId: 'item-X', now: NOW,
        ...over,
      } as any);
      expect(d.action).toBe('send');
      expect(d.reason, JSON.stringify(over)).toMatch(want);
    }
  });
});

describe('DEF-173 — never zero owner messages (Codex iteration-29 HIGH #2)', () => {
  beforeEach(() => {
    tenantConfig['behavior.selfpruning.digest_enabled'] = 1;
    existing = drip();
  });

  it('digest insert fails → the ORIGINAL sends normally, nothing is parked', async () => {
    // The first version filed the original as terminal FIRST, then enqueued the
    // digest — a failure between the writes left the owner with NOTHING. The
    // order is now inverted, so this failure mode degrades to "no digesting
    // this time", which is the behaviour the owner had before the feature.
    digestCreateFails = true;
    const r = await enqueue();
    expect(r.status).toBe('queued');
    expect(created.filter((c) => c.metadata?.digest), 'nothing may be parked without a durable digest')
      .toHaveLength(0);
    const normal = created.filter((c) =>
      c.state === 'queued' && c.metadata?.source !== 'selfpruning_digest' && !c.metadata?.digest);
    expect(normal, 'the original went out as itself').toHaveLength(1);
    expect(normal[0].question).toContain('remove the blocker');
  });

  it('filing fails AFTER the digest is durable → the original still sends (one too many, never zero)', async () => {
    filingCreateFails = true;
    const r = await enqueue();
    expect(r.status).toBe('queued');
    expect(created.filter((c) => c.metadata?.source === 'selfpruning_digest'),
      'the digest survived').toHaveLength(1);
    expect(created.filter((c) =>
      c.state === 'queued' && c.metadata?.source !== 'selfpruning_digest' && !c.metadata?.digest),
      'and the original was not lost to the failed filing').toHaveLength(1);
  });

  it('a concurrent digest insert losing the DB race (P2002) still yields ONE voice', async () => {
    // Codex HIGH #3: the dedup probe is SELECT-then-INSERT and can race. The
    // 20260813 migration adds a partial unique index on live (user, dedup_key)
    // rows; the losing insert gets P2002 and is treated as the duplicate it is —
    // durable — so the covered push is still filed rather than sent as a second
    // voice.
    digestCreateP2002 = 'racer';
    const r = await enqueue();
    expect(r.status, 'a VERIFIED P2002 race means the digest exists — filing proceeds').toBe('digested');
    expect(created.filter((c) => c.metadata?.source === 'selfpruning_digest'),
      'no second digest row was created').toHaveLength(0);
    expect(created.filter((c) => c.metadata?.digest)).toHaveLength(1);
  });
});

describe('DEF-174 — P2002 is a claim to verify, not proof (Codex iteration-30)', () => {
  // The catch wraps a create with several unique surfaces. "Any P2002 while a
  // dedupKey happens to be set" would let a conflict on an UNRELATED constraint
  // file the push as covered by a survivor that does not exist — a silently
  // swallowed owner message. Both proofs are exercised here; failing either
  // one must degrade to SENDING the original, never to filing it.
  beforeEach(() => {
    tenantConfig['behavior.selfpruning.digest_enabled'] = 1;
    existing = drip();
  });

  it('P2002 with NO surviving live row → the original SENDS, nothing is filed', async () => {
    digestCreateP2002 = 'ghost';
    const r = await enqueue();
    expect(r.status, 'an unproven duplicate claim never parks the push').toBe('queued');
    expect(created.filter((c) => c.metadata?.digest),
      'no filing without a read-back survivor').toHaveLength(0);
    const normal = created.filter((c) =>
      c.state === 'queued' && c.metadata?.source !== 'selfpruning_digest' && !c.metadata?.digest);
    expect(normal, 'the original went out as itself').toHaveLength(1);
  });

  it('P2002 naming a DIFFERENT constraint → never treated as dedup coverage, even with a live same-key row', async () => {
    // The live same-key row is present, so survivor verification ALONE would
    // pass — only the e.meta.target check can refuse this one. Removing that
    // check is the exact mutant this test kills.
    digestCreateP2002 = 'wrong-constraint';
    const r = await enqueue();
    expect(r.status).toBe('queued');
    expect(created.filter((c) => c.metadata?.digest)).toHaveLength(0);
  });

  it("a CROSS-TENANT live row is never this tenant's survivor (Codex iteration-41 CRITICAL)", async () => {
    // The only matching (userId, dedupKey) live row belongs to OTHER-9. An
    // unscoped survivor read finds it and files the owner's push as covered
    // by a row it was not authorized to read — invariant #1. The tenant-scoped
    // read finds nothing, rethrows, and the original SENDS.
    digestCreateP2002 = 'cross-tenant';
    const r = await enqueue();
    expect(r.status, 'no cross-tenant row may authorize filing').toBe('queued');
    expect(created.filter((c) => c.metadata?.digest)).toHaveLength(0);
    const normal = created.filter((c) =>
      c.state === 'queued' && c.metadata?.source !== 'selfpruning_digest' && !c.metadata?.digest);
    expect(normal, 'the original went out as itself').toHaveLength(1);
  });
});

describe('DEF-175 — the soft-dedup probe is tenant-scoped too', () => {
  it("another tenant's live row with the same (userId, dedupKey) is not a duplicate here", async () => {
    existing = [delivered({
      clientNumber: 'OTHER-9', dedupKey: 'shared-key', state: 'queued',
    })];
    const r = await enqueue({ dedupKey: 'shared-key' });
    expect(r.status, "OTHER-9's row must not suppress TMC-0001's push").toBe('queued');
  });

  it("the SAME tenant's live row with that key still deduplicates", async () => {
    existing = [delivered({ dedupKey: 'shared-key', state: 'queued' })];
    const r = await enqueue({ dedupKey: 'shared-key' });
    expect(r.status).toBe('duplicate');
  });
});

describe('DEF-173/DEF-174 — the digest words (Codex iteration-29 CRITICAL, iteration-30 CRITICAL)', () => {
  beforeEach(() => {
    tenantConfig['behavior.selfpruning.digest_enabled'] = 1;
    existing = drip();
  });

  it('is built by the one renderer, byte for byte — and the renderer emits a marker', async () => {
    // Iteration 29: the template moved out of the policy. Iteration 30: moving
    // the literals was not enough — the renderer now emits the SANCTIONED
    // deterministic form (a provenance-stamped marker), so equality here pins
    // both that nothing drifts back inline AND that what is queued is a marker.
    const { renderItemDigest } = await import('../src/services/notifications/proactiveMessageText');
    await enqueue();
    const digest = created.find((c) => c.metadata?.source === 'selfpruning_digest')!;
    expect(digest.question).toBe(renderItemDigest({
      label: '"Leave Request"',
      totalCount: 4,
      unansweredCount: 3,
      windowHours: 24,
      latest: 'Intervention needed on "Leave Request". Please decide whether to remove the blocker.',
    }));
    expect(isSystemMarker(digest.question)).toBe(true);
  });

  it('what the owner READS promises nothing and advertises no absent handler', async () => {
    // The iteration-29 defect was the WORDS ("Reply 'show all' and I'll list
    // each one" — no such handler, invariant #5's shape). The words now come
    // from the curated meaning at render time, so the assertions run against
    // the RENDERED text — what actually reaches him — not the marker body.
    await enqueue();
    const digest = created.find((c) => c.metadata?.source === 'selfpruning_digest')!;
    const rendered = sanitizeAnswerForUser(digest.question);
    expect(rendered, 'the marker was rendered, not delivered').not.toContain('selfpruning_digest');
    expect(rendered).not.toMatch(/show all/i);
    expect(rendered, 'no first-person future commitments').not.toMatch(/i'?ll|i will/i);
    expect(rendered, 'no vocative, no apology').not.toMatch(/\bsir\b|apolog/i);
    expect(rendered, 'the facts are still there').toContain('4 updates');
    expect(rendered).toContain('"Leave Request"');
    expect(rendered).toContain('nothing was discarded');
  });
});

describe('DEF-173 — consent semantics are a DECISION, not an accident', () => {
  it('the master flag IS blanket consent: enabled + no per-item decision digests', async () => {
    // Codex iteration-29 MEDIUM #4 asked for this to be decided and tested
    // rather than implied. Decided: per-item pre-consent would be inert for
    // every new item, because the drip is only visible after it has happened —
    // the CL-033 failure restated. The escape is per-item `keep`, which always
    // wins (tested above), and unknown values are keep, never consent.
    tenantConfig['behavior.selfpruning.digest_enabled'] = 1;
    existing = drip();
    const r = await enqueue();
    expect(r.status).toBe('digested');
  });
});
