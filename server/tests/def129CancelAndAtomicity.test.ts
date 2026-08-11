/**
 * DEF-129 — CANCELLED as a real, reversible outcome, and transitions that are
 * atomic with the fields they carry.
 *
 * Three things came together here.
 *
 * 1. `remove_open_item` wrote `status: 'CANCELLED'` straight to the row. Not
 *    carelessness: the matrix had no such state, so there was no legal
 *    transition to ask for. CLOSED was the only terminal state, and closing an
 *    item the owner asked to REMOVE records work as completed that never
 *    happened — the fabricated-completion class, in the data instead of a
 *    sentence.
 *
 * 2. Delegation wrote `delegateeName`/`delegateeEmail`/`delegateeId` in a
 *    SEPARATE update BEFORE requesting the transition. After DEF-128 made
 *    refusals visible, a refused delegation left those fields behind: an item
 *    that was not DELEGATED but carried a delegatee, reading as an assignment
 *    nobody made.
 *
 * 3. Six production items sat in `DONE`, outside the v15 vocabulary, so
 *    `transitionStatus` refused them outright — unmovable by any path.
 *
 * The tests below exercise behaviour through the real service with a fake
 * Prisma that honours transaction rollback; the migration assertions are
 * supplementary.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const H = vi.hoisted(() => {
  const state = {
    item: null as any,
    ledger: [] as any[],
    failLedger: false,
    /** what the item looks like after committed writes */
    committed: {} as Record<string, unknown>,
  };

  const client = {
    openItem: {
      findFirst: vi.fn(async () => state.item),
      update: vi.fn(async ({ data }: any) => {
        Object.assign(state.committed, data);
        return { ...state.item, ...data };
      }),
    },
    itemStatusHistory: {
      create: vi.fn(async ({ data }: any) => {
        if (state.failLedger) throw new Error('ledger unavailable');
        const row = { id: state.ledger.length + 1, ...data };
        state.ledger.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: any) => {
      const snapshot = { ...state.committed };
      try {
        return await fn(client);
      } catch (e) {
        // Real rollback: everything the callback wrote is discarded.
        state.committed = snapshot;
        throw e;
      }
    }),
  };
  return { state, client };
});

vi.mock('../src/db/prisma', () => ({ default: H.client }));
vi.mock('../src/services/infra/pubsubPublisher', () => ({ publish: vi.fn(async () => undefined) }));

import { transitionStatus } from '../src/services/itemLifecycle/lifecycleService';
import {
  ALL_STATUSES, findTransition, INACTIVE_STATUS_VALUES, INACTIVE_STATUS_SQL,
} from '../src/services/itemLifecycle/transitionMatrix';

/**
 * Comments are stripped before any assertion on source. Four earlier
 * source-guard tests in this codebase passed by matching the very comment that
 * described the rule, which made them worse than nothing.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The migration already APPLIED to production (D-22): DONE -> CLOSED only. */
const DONE_SQL = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', '20260811_normalise_legacy_done_status', 'migration.sql'), 'utf-8',
);
/**
 * DEF-132 — the widened repair, in its OWN folder. The one above has already run
 * on production, and an applied migration is never edited: the tree would then
 * disagree with what the database actually executed.
 */
const SHAPE_SQL = readFileSync(
  join(__dirname, '..', 'prisma', 'migrations', '20260811b_normalise_remaining_legacy_statuses', 'migration.sql'), 'utf-8',
);

const ctx = (extra: Record<string, unknown> = {}) => ({
  clientNumber: 'TMC-0001', actor: 'user:7', reason: 'because the owner said so', ...extra,
});

beforeEach(() => {
  H.state.ledger.length = 0;
  H.state.failLedger = false;
  H.state.committed = {};
  H.state.item = {
    id: 'item-1', status: 'TRIAGED', userId: 7, ownerId: 7,
    delegateeId: null, delegateeEmail: null, delegateeName: null,
    entityId: null, priority: 'medium', title: 'Test item',
  };
});

describe('DEF-129 — CANCELLED is a real, reversible outcome', () => {
  it('is part of the lifecycle vocabulary', () => {
    expect(ALL_STATUSES).toContain('CANCELLED');
  });

  it('is reachable from every non-terminal state', async () => {
    for (const from of ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED', 'INFORMED'] as const) {
      expect(findTransition(from, 'CANCELLED'), `${from} -> CANCELLED`).toBeTruthy();
    }
  });

  it('cannot be reached from CLOSED — completed work is not cancellable', () => {
    // Cancelling something already done would rewrite history rather than
    // record a decision.
    expect(findTransition('CLOSED', 'CANCELLED')).toBeUndefined();
  });

  it('RESTORES to TRIAGED, so a withdrawal can be undone', async () => {
    H.state.item.status = 'CANCELLED';
    const r = await transitionStatus('item-1', 'TRIAGED', ctx());
    expect(r.ok).toBe(true);
    expect(H.state.committed.status).toBe('TRIAGED');
    expect(H.state.ledger[0]).toMatchObject({ fromStatus: 'CANCELLED', toStatus: 'TRIAGED', outcome: 'accepted' });
  });

  it('requires a reason — a cancelled item with no explanation looks lost', async () => {
    const r = await transitionStatus('item-1', 'CANCELLED', { clientNumber: 'TMC-0001', actor: 'user:7' });
    expect(r.ok).toBe(false);
    expect(r.guardsFailed).toContain('resolution_reason');
    expect(H.state.committed.status).toBeUndefined();
  });

  it('cancelling records the reason in the ledger', async () => {
    const r = await transitionStatus('item-1', 'CANCELLED', ctx({ reason: 'user_marked_wrong: not mine' }));
    expect(r.ok).toBe(true);
    expect(H.state.ledger[0]).toMatchObject({ toStatus: 'CANCELLED', outcome: 'accepted' });
    expect(H.state.ledger[0].reason).toContain('user_marked_wrong');
  });

  it('a cancelled item is treated as OFF the plate everywhere', () => {
    // One shared definition. Without CANCELLED here, withdrawn work would keep
    // appearing in the owner's list and keep being chased by the radar.
    expect(INACTIVE_STATUS_VALUES).toContain('CANCELLED');
    expect(INACTIVE_STATUS_VALUES).toContain('CLOSED');
    expect(INACTIVE_STATUS_VALUES).toContain('DONE');
  });
});

describe('DEF-129 — a transition and the fields it carries are one atomic unit', () => {
  it('an ACCEPTED delegation writes status and delegatee together', async () => {
    const r = await transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com', delegateeId: null },
    }));

    expect(r.ok).toBe(true);
    expect(H.state.committed).toMatchObject({
      status: 'DELEGATED', delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com',
    });
    expect(H.state.ledger).toHaveLength(1);
  });

  it('a REFUSED delegation leaves NO delegatee fields behind', async () => {
    // The HIGH finding. NEW -> DELEGATED is not in the matrix, so this is
    // refused before anything is written.
    H.state.item.status = 'NEW';

    const r = await transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com' },
    }));

    expect(r.ok).toBe(false);
    expect(H.state.committed.delegateeName).toBeUndefined();
    expect(H.state.committed.delegateeEmail).toBeUndefined();
    expect(H.state.committed.status).toBeUndefined();
  });

  it('a ledger failure rolls back the delegatee fields too', async () => {
    // Not just the status: everything that travelled with the transition.
    H.state.failLedger = true;

    await expect(transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeName: 'Hamna', delegateeEmail: 'hamna@example.com' },
    }))).rejects.toThrow(/ledger unavailable/);

    expect(H.state.committed.delegateeName).toBeUndefined();
    expect(H.state.committed.status).toBeUndefined();
  });

  it('the delegatee guard is satisfied by a delegatee arriving WITH the transition', async () => {
    // Before `itemData`, the guard read the stored row, so the caller had to
    // write the fields first — which is exactly what left them behind.
    const r = await transitionStatus('item-1', 'DELEGATED', ctx({
      itemData: { delegateeEmail: 'hamna@example.com' },
    }));
    expect(r.ok).toBe(true);
    expect(r.guardsFailed).toBeUndefined();
  });

  it('still refuses when NO delegatee is supplied by either route', async () => {
    const r = await transitionStatus('item-1', 'DELEGATED', ctx());
    expect(r.ok).toBe(false);
    expect(r.guardsFailed).toContain('delegatee_set');
  });

  it('itemData can NEVER override the status the matrix approved', async () => {
    // A caller smuggling `status` past the guards would defeat the whole matrix.
    const r = await transitionStatus('item-1', 'CANCELLED', ctx({
      itemData: { status: 'CLOSED', metadata: { archivedReason: 'user_marked_wrong' } },
    }));
    expect(r.ok).toBe(true);
    expect(H.state.committed.status).toBe('CANCELLED');
    expect(H.state.committed.metadata).toMatchObject({ archivedReason: 'user_marked_wrong' });
  });

  it('tenant isolation: the item is loaded by tenant, and a foreign tenant finds nothing', async () => {
    H.state.item = null;
    const r = await transitionStatus('item-1', 'CANCELLED', ctx({ clientNumber: 'OTHER-9' }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('not found');
    expect(H.state.ledger).toHaveLength(0);
    const call = (H.client.openItem.findFirst as any).mock.calls.at(-1)[0];
    expect(call.where.clientNumber).toBe('OTHER-9');
  });
});

describe('DEF-129 — the acting identity reaches the ledger unchanged', () => {
  // Found while reviewing this change: `changeStatus` had been rewritten to
  // pass `actor: 'system'` while still ACCEPTING an `actor` argument, so every
  // caller's identity was silently discarded. Two consequences, both bad:
  // the ledger DEF-127 exists to keep would attribute every human close to
  // 'system', and `is_owner_or_agent` — which treats 'system' as always
  // authorised — would pass for any caller, including a non-owner restoring a
  // cancelled item.
  it('stamps the CALLER on the ledger row, not "system"', async () => {
    const { changeStatus } = await import('../src/services/openItemsService');
    await changeStatus('item-1', 'TMC-0001', 'IN_PROGRESS' as any, 'starting work', 'user:7');
    expect(H.state.ledger[0].actor).toBe('user:7');
  });

  it('an agent actor survives too', async () => {
    const { changeStatus } = await import('../src/services/openItemsService');
    await changeStatus('item-1', 'TMC-0001', 'IN_PROGRESS' as any, 'starting work', 'agent:triage');
    expect(H.state.ledger[0].actor).toBe('agent:triage');
  });

  it('falls back to "system" ONLY when no actor is supplied', async () => {
    const { changeStatus } = await import('../src/services/openItemsService');
    await changeStatus('item-1', 'TMC-0001', 'IN_PROGRESS' as any, 'starting work');
    expect(H.state.ledger[0].actor).toBe('system');
  });

  it('a NON-OWNER cannot restore a cancelled item', async () => {
    // The mutation check on the fix above: with the actor collapsed to
    // 'system' this passed, which is the authorisation hole in one assertion.
    H.state.item.status = 'CANCELLED';
    H.state.item.ownerId = 7;
    const { changeStatus } = await import('../src/services/openItemsService');
    await expect(
      changeStatus('item-1', 'TMC-0001', 'TRIAGED' as any, 'putting it back', 'user:99'),
    ).rejects.toThrow();
    expect(H.state.committed.status).toBeUndefined();
    expect(H.state.ledger[0]).toMatchObject({ outcome: 'rejected', actor: 'user:99' });
  });

  it('delegateItem attributes the delegation to whoever made it', async () => {
    const { delegateItem } = await import('../src/services/openItemsService');
    await delegateItem('item-1', 'TMC-0001', null, 'Hamna', 'hamna@example.com', 'please take this', 'user:7');
    expect(H.state.ledger[0]).toMatchObject({ toStatus: 'DELEGATED', actor: 'user:7' });
  });

  it('a cancelled item stops its star cadence, so withdrawn work stops pinging', async () => {
    const svc = await import('../src/services/openItemsService');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'openItemsService.ts'), 'utf-8');
    const pauseLine = stripComments(src).match(/const PAUSE_STATES = \[[^\]]*\]/)?.[0] ?? '';
    expect(pauseLine).toContain("'CANCELLED'");
    expect(typeof svc.changeStatus).toBe('function');
  });
});

describe('DEF-129 — "off the plate" has exactly ONE definition', () => {
  // `protection-with-two-implementations` is the dominant defect shape in this
  // system (6 recorded instances). `INACTIVE_STATUS_VALUES` was introduced as
  // "the ONE definition" and `INACTIVE_STATUS_SQL` beside it — while every
  // raw-SQL query kept its own hand-written list. That is the same shape: a
  // constant asserting it is canonical, and call sites proving it is not.
  // These assertions are the containment, and they strip comments first so a
  // guard can never pass by matching the prose that describes it.
  it('the SQL form is generated FROM the TypeScript form', () => {
    for (const s of INACTIVE_STATUS_VALUES) {
      expect(INACTIVE_STATUS_SQL).toContain(`'${s}'`);
    }
    expect(INACTIVE_STATUS_SQL.split(',')).toHaveLength(INACTIVE_STATUS_VALUES.length);
  });

  it('every terminal status appears in both spellings', () => {
    for (const s of ['CLOSED', 'CANCELLED', 'DONE', 'ARCHIVED']) {
      expect(INACTIVE_STATUS_VALUES).toContain(s);
      expect(INACTIVE_STATUS_VALUES).toContain(s.toLowerCase());
    }
  });

  it('NO raw-SQL query hand-writes its own inactive-status list', () => {
    const files = [
      'services/brain/riskRadarService.ts',
      'services/brain/riskRulesService.ts',
      'services/triage/criticalityEngineService.ts',
      'services/whatsapp/expectedExternalReplyService.ts',
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const src = stripComments(readFileSync(join(__dirname, '..', 'src', f), 'utf-8'));
      // A `status NOT IN (...)` whose list opens with a literal terminal status
      // instead of the shared constant is a second implementation.
      for (const m of src.matchAll(/status\s+NOT\s+IN\s*\(\s*'(CLOSED|CANCELLED|DONE|ARCHIVED)'/gi)) {
        offenders.push(`${f}: ${m[0]}`);
      }
    }
    expect(offenders, 'use INACTIVE_STATUS_SQL instead').toEqual([]);
  });

  it('and each of those files actually references the shared constant', () => {
    for (const f of [
      'services/brain/riskRadarService.ts',
      'services/brain/riskRulesService.ts',
      'services/triage/criticalityEngineService.ts',
      'services/whatsapp/expectedExternalReplyService.ts',
    ]) {
      const src = stripComments(readFileSync(join(__dirname, '..', 'src', f), 'utf-8'));
      expect(src, f).toContain('INACTIVE_STATUS_SQL');
    }
  });
});

describe('DEF-129 — no writer mints a status the matrix cannot move', () => {
  // The harm was never "an ungoverned write" in the abstract. It was that a
  // write of `DONE`/`done`/`closed`/`archived` produces a row `transitionStatus`
  // REFUSES — "current status X is not in the v15 lifecycle" — so the item can
  // never be moved again by any path in the system. Six such rows existed, and
  // the scripts that minted them were still running.
  //
  // This scans SOURCE rather than trusting the fixes to stay, and strips
  // comments first so the prose above cannot satisfy it.
  const STATUS_WRITERS = [
    'jobs/openItemsBacklogCleanupJob.ts',
    'jobs/openItemDraftAskJob.ts',
    'scripts/cleanupDuplicateOpenItems.ts',
    'scripts/backfillOpenItemDelegationStatus.ts',
    'services/actions/handlers/lifecycle/archive.ts',
    'services/actions/handlers/lifecycle/close.ts',
    'services/delegation/delegationTrackerService.ts',
    'services/openItemsService.ts',
    'services/knowledge/brainComposer.ts',
    'routes/openItemsRoutes.ts',
    'routes/briefRoutes.ts',
  ];
  const OUT_OF_VOCAB = ['DONE', 'done', 'closed', 'archived', 'ARCHIVED', 'cancelled', 'delegated', 'in_progress', 'blocked', 'overdue'];

  it('NO source file writes an out-of-vocabulary status to open_items', () => {
    const offenders: string[] = [];
    for (const f of STATUS_WRITERS) {
      const src = stripComments(readFileSync(join(__dirname, '..', 'src', f), 'utf-8'));
      for (const bad of OUT_OF_VOCAB) {
        // `status: '<legacy>'` in an object literal — how every one of these was
        // written. Excludes `status: 'done'` on OTHER tables (agent_action uses
        // it legitimately) by requiring the openItem/data context nearby.
        for (const m of src.matchAll(new RegExp(`status:\\s*'${bad}'`, 'g'))) {
          const window = src.slice(Math.max(0, m.index! - 700), m.index!);
          if (/openItem\.(update|updateMany|create)|open_items/.test(window)) {
            offenders.push(`${f}: ${m[0]}`);
          }
        }
      }
    }
    expect(offenders, 'these mint rows transitionStatus can never move').toEqual([]);
  });

  it('every status any writer sets is one the matrix recognises', () => {
    for (const f of STATUS_WRITERS) {
      const src = stripComments(readFileSync(join(__dirname, '..', 'src', f), 'utf-8'));
      for (const m of src.matchAll(/status:\s*'([A-Za-z_]+)'\s*(as any)?[,\s}]/g)) {
        const window = src.slice(Math.max(0, m.index! - 700), m.index!);
        if (!/openItem\.(update|updateMany|create)/.test(window)) continue;
        expect(ALL_STATUSES, `${f} writes status '${m[1]}'`).toContain(m[1] as any);
      }
    }
  });

  it('the two scripts that stranded the six rows now write a movable status', () => {
    const src = stripComments(readFileSync(
      join(__dirname, '..', 'src', 'scripts', 'cleanupDuplicateOpenItems.ts'), 'utf-8'));
    expect(src).not.toContain(`status: 'DONE'`);
    expect(src.match(/status: 'CANCELLED'/g) ?? []).toHaveLength(2);
  });

  it('the backlog pruner records withdrawal, not completion', () => {
    // Five of its writes used the legacy lowercase 'closed'. All six prune paths
    // now record CANCELLED — junk was never work that got completed.
    const src = stripComments(readFileSync(
      join(__dirname, '..', 'src', 'jobs', 'openItemsBacklogCleanupJob.ts'), 'utf-8'));
    expect(src).not.toMatch(/status: 'closed'/);
    expect((src.match(/status: 'CANCELLED' as any/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });

  it('the archive handler goes through the matrix, and its preview says so', () => {
    const src = stripComments(readFileSync(
      join(__dirname, '..', 'src', 'services', 'actions', 'handlers', 'lifecycle', 'archive.ts'), 'utf-8'));
    expect(src).toContain('transitionStatus');
    expect(src).not.toMatch(/status: 'done'/);
    // Preview and result must name the same outcome — DEF-044's class.
    expect(src).toContain(`willSetStatus: 'CANCELLED'`);
    expect(src).toContain(`row.status !== 'CANCELLED'`);
  });
});

describe('DEF-129 — the DONE normalisation migration (applied, D-22)', () => {
  it('writes an audit row for every item it changes', () => {
    expect(DONE_SQL).toContain('INSERT INTO "item_status_history"');
    expect(DONE_SQL).toMatch(/'DONE',\s*'CLOSED',\s*'accepted'/);
    expect(DONE_SQL).toContain("'system'");
  });

  it('carries tenant AND user onto each audit row', () => {
    expect(DONE_SQL).toContain('oi."client_number"');
    expect(DONE_SQL).toContain('oi."user_id"');
  });

  it('is idempotent — a re-run matches nothing', () => {
    const guarded = DONE_SQL.match(/WHERE\s+(oi\.)?"status" = 'DONE'/g) ?? [];
    expect(guarded.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT add DONE as a status — it removes it', () => {
    expect(ALL_STATUSES).not.toContain('DONE' as any);
    expect(DONE_SQL).toContain(`SET "status" = 'CLOSED'`);
  });

  it('is UNCHANGED by the DEF-132 widening — an applied migration is never edited', () => {
    // If the tree's copy of an applied migration is rewritten, the file no longer
    // describes what the database ran. The widened repair therefore lives in its
    // own folder, and this asserts the boundary rather than trusting it.
    expect(DONE_SQL).not.toContain('DEF-132');
    expect(DONE_SQL).not.toContain('_def132_map');
  });

  it('leaves the recorded April migration untouched', () => {
    const april = readFileSync(
      join(__dirname, '..', 'prisma', 'migrations', '20260419_v15_item_lifecycle', 'migration.sql'), 'utf-8');
    expect(april).not.toContain('DEF-129');
    expect(april).not.toContain('DEF-132');
  });
});

describe('DEF-132 — the widened repair: by SHAPE, not by the one name I had a count for', () => {
  it('writes an audit row, with tenant and user, for every item it changes', () => {
    expect(SHAPE_SQL).toContain('INSERT INTO "item_status_history"');
    expect(SHAPE_SQL).toContain(`'accepted'`);
    expect(SHAPE_SQL).toContain('oi."client_number"');
    expect(SHAPE_SQL).toContain('oi."user_id"');
  });

  it('covers every spelling the writers actually emitted', () => {
    // D-22 matched `status = 'DONE'` — the one spelling with a count. The writers
    // emitted DONE, done and closed, and `transitionStatus` rejects ANY value
    // outside the 9, so a name-matched repair fixed six rows and left the rest
    // equally unmovable while reporting success. That is the failure already
    // recorded as "a migration that silently did nothing".
    for (const legacy of ['DONE', 'done', 'closed', 'archived', 'ARCHIVED', 'open', 'blocked', 'overdue']) {
      expect(SHAPE_SQL, `legacy spelling ${legacy}`).toContain(`('${legacy}'`);
    }
  });

  it('maps every legacy spelling to a status the matrix actually knows', () => {
    const pairs = [...SHAPE_SQL.matchAll(/\('([A-Za-z_]+)',\s*'([A-Z_]+)'\)/g)];
    expect(pairs.length).toBeGreaterThanOrEqual(15);
    for (const [, legacy, v15] of pairs) {
      expect(ALL_STATUSES, `${legacy} -> ${v15}`).toContain(v15 as any);
    }
  });

  it('is idempotent — both statements are driven by the SAME map', () => {
    // After the first run no row's status matches a `legacy` key, so the insert
    // selects nothing and the update matches nothing. One map read by two
    // statements — not two hand-written predicates that could drift apart, which
    // is this codebase's most frequently recorded defect shape.
    expect((SHAPE_SQL.match(/_def132_map/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(SHAPE_SQL).toContain('JOIN _def132_map m ON m."legacy" = oi."status"');
    expect(SHAPE_SQL).toContain('FROM _def132_map m\n   WHERE m."legacy" = oi."status"');
    expect(SHAPE_SQL).toContain(`SET "status" = m."v15"`);
  });

  it('REPORTS anything it could not interpret instead of guessing', () => {
    // A status nobody can interpret must stay visible. Inventing a value would
    // put fabricated state in the ledger, and reporting success while rows stay
    // stranded is what the April backfill did.
    expect(SHAPE_SQL).toContain('RAISE WARNING');
    expect(SHAPE_SQL).toMatch(/still OUTSIDE the v15 lifecycle/);
  });

  it('says out loud that it says nothing when there is nothing to do', () => {
    // A migration that prints only on success is indistinguishable from one that
    // matched nothing — the 2026-04-19 failure mode.
    expect(SHAPE_SQL).toContain('no legacy statuses found');
  });
});
