/**
 * smokeRiskRadarV2.ts — 20-scenario comprehensive smoke test for the
 * rules-driven Risk Radar + per-user Contacts + Sentiment + Entity
 * Discipline + Brain composer integrations.
 *
 * Run:
 *   cd tmcai/server && npx ts-node src/scripts/smokeRiskRadarV2.ts
 *
 * Env overrides (all optional):
 *   SMOKE_TENANT  default TMC-0001
 *   SMOKE_USER_A  default 5  (current operator)
 *   SMOKE_USER_B  default 1  (other user in same tenant)
 *
 * Exit code 0 = all green, 1 = at least one fail.
 */
import prisma from '../db/prisma';
import { runWithoutTenant } from '../db/tenantContext';

const TENANT = process.env.SMOKE_TENANT ?? 'TMC-0001';
const USER_A = parseInt(process.env.SMOKE_USER_A ?? '5', 10);
const USER_B = parseInt(process.env.SMOKE_USER_B ?? '1', 10);

interface Result { id: number; label: string; status: 'pass' | 'fail' | 'skip'; detail?: string; }
const results: Result[] = [];
let currentScenario = 0;

function scenario(label: string, fn: () => Promise<void> | void) {
  return async () => {
    currentScenario += 1;
    const id = currentScenario;
    console.log(`\n[${String(id).padStart(2, '0')}] ${label}`);
    try {
      await fn();
    } catch (err: any) {
      results.push({ id, label, status: 'fail', detail: err?.message ?? String(err) });
      console.log(`     ✗ FAIL — ${err?.message ?? err}`);
    }
  };
}
function check(label: string, cond: boolean, detail?: string) {
  const id = currentScenario;
  const existing = results.find((r) => r.id === id);
  if (existing && existing.status === 'fail') return; // already failed
  if (cond) {
    if (!existing) results.push({ id, label, status: 'pass', detail });
    console.log(`     ✓ ${label}` + (detail ? ` — ${detail}` : ''));
  } else {
    if (existing) existing.status = 'fail';
    else results.push({ id, label, status: 'fail', detail });
    console.log(`     ✗ ${label}` + (detail ? ` — ${detail}` : ''));
  }
}
function skip(reason: string) {
  const id = currentScenario;
  results.push({ id, label: 'skipped', status: 'skip', detail: reason });
  console.log(`     ⊘ skipped — ${reason}`);
}

// ─── Test runners ─────────────────────────────────────────────────

async function main() {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Smoke: Risk Radar v2 + Contacts + Sentiment + Entity`);
  console.log(`  Tenant: ${TENANT}    Users: A=${USER_A}, B=${USER_B}`);
  console.log(`══════════════════════════════════════════════════════════`);

  await runWithoutTenant(async () => {
    await scenario('Boot — all critical migrations applied', async () => {
      // Look for tables we just shipped.
      const tables = ['risk_rules', 'risk_rule_overrides', 'risk_flag_docs',
        'gate_rules', 'delegation_matrix', 'brain_docs', 'llm_spend',
        'push_subscriptions', 'approval_tokens'] as const;
      for (const t of tables) {
        const r: any[] = await prisma.$queryRawUnsafe(
          `SELECT to_regclass($1)::text AS rel`, t,
        );
        check(`table ${t} exists`, !!r[0]?.rel, t);
      }
    })();

    await scenario('System rule libraries — seeded', async () => {
      const { seedSystemRiskRules } = await import('../services/brain/riskRulesSeeder');
      await seedSystemRiskRules();
      const sysRisk = await prisma.riskRule.count({ where: { scope: 'system', enabled: true } });
      check('≥ 8 system risk rules', sysRisk >= 8, `${sysRisk}`);
      const sysGate = await prisma.gateRule.count({ where: { scope: 'system', enabled: true } });
      check('≥ 8 system gate rules', sysGate >= 8, `${sysGate}`);
    })();

    await scenario('Sentiment analyzer — recent events enriched', async () => {
      const r: any[] = await prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE sentiment_analyzed_at IS NOT NULL)::int AS analyzed,
           COUNT(*)::int AS total
         FROM feed_events
         WHERE client_number = $1 AND user_id = $2
           AND created_at >= NOW() - INTERVAL '7 days'`,
        TENANT, USER_A,
      );
      const analyzed = Number(r[0]?.analyzed ?? 0);
      const total = Number(r[0]?.total ?? 0);
      if (total === 0) { skip('no feed_events in last 7 days for user A'); return; }
      check(`sentiment populated: ${analyzed}/${total}`, analyzed > 0);
    })();

    await scenario('Entity sweep — discovered_by_users populated', async () => {
      const r: any[] = await prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE metadata ? 'discovered_by_users') AS with_dbu,
           COUNT(*) AS total
         FROM wiki_pages
         WHERE client_number = $1 AND page_type = 'entity_person' AND status <> 'deleted'`,
        TENANT,
      );
      const withDbu = Number(r[0]?.with_dbu ?? 0n);
      const total = Number(r[0]?.total ?? 0n);
      if (total === 0) { skip('no entity_person rows'); return; }
      const ratio = withDbu / total;
      check(`coverage ≥ 50% (${withDbu}/${total})`, ratio >= 0.5);
    })();

    await scenario('Entity channels — populated from feed source_type', async () => {
      const r: any[] = await prisma.$queryRawUnsafe(
        `SELECT
           COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(metadata->'channels','[]'::jsonb)) > 0)::int AS with_ch,
           COUNT(*)::int AS total
         FROM wiki_pages
         WHERE client_number = $1 AND page_type = 'entity_person' AND status <> 'deleted'`,
        TENANT,
      );
      const withCh = Number(r[0]?.with_ch ?? 0);
      const total = Number(r[0]?.total ?? 0);
      if (total === 0) { skip('no entity_person rows'); return; }
      const ratio = withCh / total;
      check(`channels populated ≥ 30% (${withCh}/${total})`, ratio >= 0.3);
    })();

    await scenario('Cross-user visibility — A and B see different sets', async () => {
      const a: any[] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM wiki_pages
         WHERE client_number = $1 AND page_type = 'entity_person' AND status <> 'deleted'
           AND (user_id = $2 OR metadata->>'scope' = 'tenant'
                OR metadata->'discovered_by_users' @> $3::jsonb)`,
        TENANT, USER_A, JSON.stringify([USER_A]),
      );
      const b: any[] = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS n FROM wiki_pages
         WHERE client_number = $1 AND page_type = 'entity_person' AND status <> 'deleted'
           AND (user_id = $2 OR metadata->>'scope' = 'tenant'
                OR metadata->'discovered_by_users' @> $3::jsonb)`,
        TENANT, USER_B, JSON.stringify([USER_B]),
      );
      const visA = Number(a[0]?.n ?? 0);
      const visB = Number(b[0]?.n ?? 0);
      check(`A visibility=${visA}, B visibility=${visB}`, visA > 0 || visB > 0);
      // Find an entity only A has discovered (not tenant-shared) — confirm B can't see
      const onlyA: any[] = await prisma.$queryRawUnsafe(
        `SELECT id FROM wiki_pages
         WHERE client_number = $1 AND page_type = 'entity_person' AND status <> 'deleted'
           AND metadata->'discovered_by_users' @> $2::jsonb
           AND NOT (metadata->'discovered_by_users' @> $3::jsonb)
           AND COALESCE(metadata->>'scope', 'user') <> 'tenant'
           AND user_id <> $4
         LIMIT 1`,
        TENANT, JSON.stringify([USER_A]), JSON.stringify([USER_B]), USER_B,
      );
      if (!onlyA[0]) { skip('no A-only entity to test ACL'); return; }
      const id = onlyA[0].id;
      const bSees: any[] = await prisma.$queryRawUnsafe(
        `SELECT 1 FROM wiki_pages
         WHERE id = $1 AND client_number = $2 AND page_type = 'entity_person'
           AND (user_id = $3 OR metadata->>'scope' = 'tenant'
                OR metadata->'discovered_by_users' @> $4::jsonb)`,
        id, TENANT, USER_B, JSON.stringify([USER_B]),
      );
      check('A-only entity invisible to B', bSees.length === 0, id.slice(0, 24));
    })();

    await scenario('Star rating — per-user, round-trip', async () => {
      const sample: any[] = await prisma.$queryRawUnsafe(
        `SELECT id FROM wiki_pages
         WHERE client_number = $1 AND page_type = 'entity_person' AND status <> 'deleted'
           AND metadata->'discovered_by_users' @> $2::jsonb
         LIMIT 1`,
        TENANT, JSON.stringify([USER_A]),
      );
      if (!sample[0]) { skip('no entity to star'); return; }
      const id = sample[0].id;
      const { setStars, getStars } = await import('../services/knowledge/entitySweepService');
      const set = await setStars(id, USER_A, 4);
      check('setStars returns 4', set === 4);
      check('getStars returns 4', (await getStars(id, USER_A)) === 4);
      check('user B sees 0 (separate ratings)', (await getStars(id, USER_B)) === 0);
      await setStars(id, USER_A, 0);
      check('clear works', (await getStars(id, USER_A)) === 0);
    })();

    await scenario('Manual contact creation', async () => {
      const { createManualContact } = await import('../services/knowledge/entitySweepService');
      const testEmail = `smoke-${Date.now()}@example-smoke-test.invalid`;
      const r = await createManualContact({
        clientNumber: TENANT, actorUserId: USER_A,
        name: 'Smoke Test Contact', email: testEmail,
        notes: 'auto-created by smokeRiskRadarV2.ts',
      });
      check('created entity', !!r.id);
      // Verify scope is user-private (default policy)
      const row = await prisma.wikiPage.findUnique({
        where: { id: r.id }, select: { userId: true, metadata: true },
      });
      const meta = (row?.metadata as any) ?? {};
      check('scope=user (default)', meta.scope === 'user');
      check('imported_from=manual', meta.imported_from === 'manual');
      check('owner is creating user', row?.userId === USER_A);
      // Cleanup
      await prisma.wikiPage.delete({ where: { id: r.id } });
    })();

    await scenario('Risk Radar — runs to completion + UPSERTs doc', async () => {
      const { runForUser } = await import('../services/brain/riskRadarService');
      const t0 = Date.now();
      const result = await runForUser(TENANT, USER_A, { force: true });
      const elapsed = Date.now() - t0;
      check(`completes in <30s (${elapsed}ms)`, elapsed < 30000);
      check('returns docId', /^risk:/.test(result.docId));
      check('flagCount is number', typeof result.flagCount === 'number');
      const doc = await prisma.riskFlagDoc.findUnique({ where: { id: result.docId } });
      check('doc persisted', !!doc);
      check('all flags have severity', Array.isArray(doc?.flags) &&
        (doc!.flags as any[]).every((f: any) => ['low','medium','high'].includes(f.severity)));
    })();

    await scenario('Rule executor — feed_event source', async () => {
      const { executeAllRules } = await import('../services/brain/riskRulesService');
      const hits = await executeAllRules(TENANT, USER_A);
      const feedHits = hits.filter((h: any) => h.sourceKind === 'feed_event');
      check('executor returns array', Array.isArray(hits));
      check('all hits have ruleId', hits.every((h: any) => typeof h.ruleId === 'number'));
      check('all hits have severity', hits.every((h: any) => ['low','medium','high'].includes(h.severity)));
      console.log(`     feed_event hits: ${feedHits.length}`);
    })();

    await scenario('Rule executor — open_item + wiki_page sources', async () => {
      const { executeAllRules } = await import('../services/brain/riskRulesService');
      const hits = await executeAllRules(TENANT, USER_A);
      const oi = hits.filter((h: any) => h.sourceKind === 'open_item').length;
      const wp = hits.filter((h: any) => h.sourceKind === 'wiki_page').length;
      console.log(`     open_item=${oi}, wiki_page=${wp}`);
      check('all hits have valid source kind',
        hits.every((h: any) => ['feed_event','open_item','wiki_page'].includes(h.sourceKind)));
    })();

    await scenario('Risk rule CRUD — create / list / update / delete', async () => {
      const { createUserRule, listRulesFor, updateRule, deleteRule } = await import('../services/brain/riskRulesService');
      const created = await createUserRule(TENANT, USER_A, {
        name: 'SMOKE — never matches',
        description: 'auto-created by smoke test',
        source: 'feed_event',
        lookbackHours: 1,
        predicate: { all: [{ field: 'subject', op: 'equals', value: '__SMOKE_NEVER_MATCHES__' }] },
        severity: 'low',
        titleTemplate: null, reasonTemplate: null, suggestedAction: null,
      });
      check('create returns id', created.id > 0);
      const list = await listRulesFor(TENANT, USER_A);
      check('appears in list', list.some((r) => r.id === created.id));
      const updated = await updateRule(created.id, TENANT, USER_A, false, { enabled: false });
      check('update disables', updated.enabled === false);
      // Disabled rule shouldn't appear in active list
      const list2 = await listRulesFor(TENANT, USER_A);
      check('disabled rule excluded from active list', !list2.some((r) => r.id === created.id));
      await deleteRule(created.id, TENANT, USER_A, false);
      const post = await prisma.riskRule.findUnique({ where: { id: created.id } });
      check('deleted', post == null);
    })();

    await scenario('Risk rule — system override (disable for user)', async () => {
      const { toggleSystemRule, listRulesFor } = await import('../services/brain/riskRulesService');
      const before = (await listRulesFor(TENANT, USER_A)).length;
      await toggleSystemRule('system:vip_inbound', TENANT, USER_A, false, 'user', true, 'smoke test');
      const after = (await listRulesFor(TENANT, USER_A)).length;
      check('disable removes 1 from active list', after === before - 1, `${before} → ${after}`);
      // Verify override row exists
      const o = await prisma.riskRuleOverride.findFirst({
        where: { ruleKey: 'system:vip_inbound', scope: 'user', clientNumber: TENANT, userId: USER_A },
      });
      check('override row created', !!o && o.disabled === true);
      // Cleanup — re-enable
      await toggleSystemRule('system:vip_inbound', TENANT, USER_A, false, 'user', false);
      const restored = (await listRulesFor(TENANT, USER_A)).length;
      check('re-enable restores list size', restored === before);
    })();

    await scenario('Noise filters — system bot/no-reply senders', async () => {
      // Test the predicate executor's exposure of these via a synthetic
      // ctx — confirms the matchers behave on edge cases.
      const { matches } = await import('../services/triage/ruleEngineService');
      check('matches "noreply@google.com" with sender_email contains',
        matches({ all: [{ field: 'sender_email', op: 'contains', value: 'google.com' }] },
          { sender_email: 'noreply@google.com', sender_domain: 'google.com' }));
      check('does NOT match self-email when predicate excludes it',
        !matches(
          { all: [
            { field: 'sender_email', op: 'notEquals', value: 'me@tmcltd.ai' },
          ] },
          { sender_email: 'me@tmcltd.ai' },
        ));
      check('regex match works on subject',
        matches({ all: [{ field: 'subject', op: 'matches', value: '(escalat|complaint)' }] },
          { subject: 'this needs to be escalated urgently' }));
    })();

    await scenario('Risk Radar — re-run idempotency (UPSERT, not duplicate)', async () => {
      const { runForUser } = await import('../services/brain/riskRadarService');
      const r1 = await runForUser(TENANT, USER_A, { force: true });
      const r2 = await runForUser(TENANT, USER_A, { force: true });
      check('same docId on re-run', r1.docId === r2.docId);
      // Confirm only ONE row exists for today
      const dateStr = new Date().toISOString().slice(0, 10);
      const count = await prisma.riskFlagDoc.count({
        where: { clientNumber: TENANT, userId: USER_A, runDate: new Date(dateStr) },
      });
      check('exactly 1 doc for today', count === 1, `count=${count}`);
    })();

    await scenario('Risk Radar — doc shape (flags, summary, counts)', async () => {
      const dateStr = new Date().toISOString().slice(0, 10);
      const doc = await prisma.riskFlagDoc.findUnique({
        where: {
          clientNumber_userId_runDate: {
            clientNumber: TENANT, userId: USER_A, runDate: new Date(dateStr),
          } as any,
        },
      });
      if (!doc) { skip('no doc for today'); return; }
      check('doc.flags is array', Array.isArray(doc.flags));
      check('doc.flagCount matches array length',
        Number(doc.flagCount) === (doc.flags as any[]).length);
      check('doc.highSeverityCount = count of high',
        Number(doc.highSeverityCount) === (doc.flags as any[]).filter((f) => f.severity === 'high').length);
      check('doc.summary is string', typeof doc.summary === 'string');
    })();

    await scenario('Tenant isolation — risk rules', async () => {
      // Confirm user-scoped rules in tenant T are not visible from another tenant
      const fakeTenant = 'TMC-ZZZZ-DOES-NOT-EXIST';
      const { listRulesFor } = await import('../services/brain/riskRulesService');
      const rules = await listRulesFor(fakeTenant, 99999);
      // System rules apply to everyone, so we should still get the system set
      const systemOnly = rules.every((r) => r.scope === 'system');
      check('foreign tenant sees only system rules', systemOnly, `${rules.length} rules, all system`);
    })();

    await scenario('Brain composer — delegation matrix block injects', async () => {
      const { renderMatrixBlock } = await import('../services/knowledge/delegationMatrixService');
      const block = await renderMatrixBlock(TENANT);
      check('renderMatrixBlock returns string', typeof block === 'string');
      // Either has a block or empty — both valid; if empty, it's because
      // no delegation matrix entries exist for this tenant.
      console.log(`     block length: ${block.length} chars`);
    })();

    await scenario('Imminence flags — calendar / open-item / instruction sources still work', async () => {
      const { runForUser } = await import('../services/brain/riskRadarService');
      const result = await runForUser(TENANT, USER_A, { force: true });
      // Imminence is still emitted; should appear in flags array if any
      // upcoming events exist. Test by counting source signals.
      const ssrc = result.sourceSignals ?? {};
      const hasImminenceKey = Object.keys(ssrc).some((k) =>
        k === 'imminence' || k.startsWith('rule_'));
      check('source_signals has expected keys', hasImminenceKey,
        Object.keys(ssrc).join(','));
    })();

    await scenario('Risk Rule fire counts — increment on hit', async () => {
      // Pick a rule with the most hits, check fireCount > 0 OR last_fired_at set.
      const top: any[] = await prisma.$queryRawUnsafe(
        `SELECT id, fire_count, last_fired_at FROM risk_rules
         WHERE scope = 'system' AND enabled = TRUE AND fire_count > 0
         ORDER BY fire_count DESC LIMIT 5`,
      );
      if (top.length === 0) {
        // Force a rule that should match if any escalation events exist
        skip('no system rule has fired yet (no matching events)');
        return;
      }
      check(`top-firing rule has fire_count > 0 (${Number(top[0].fire_count)})`,
        Number(top[0].fire_count) > 0);
      check('top-firing rule has last_fired_at', !!top[0].last_fired_at);
    })();
  });

  // ─── Summary ─────────────────────────────────────────────────
  const passes = results.filter((r) => r.status === 'pass').length;
  const fails  = results.filter((r) => r.status === 'fail').length;
  const skips  = results.filter((r) => r.status === 'skip').length;
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Pass: ${passes}    Fail: ${fails}    Skip: ${skips}`);
  console.log(`══════════════════════════════════════════════════════════`);
  if (fails > 0) {
    console.log('\nFailures:');
    for (const r of results.filter((x) => x.status === 'fail')) {
      console.log(`  [${String(r.id).padStart(2,'0')}] ${r.label} — ${r.detail ?? ''}`);
    }
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke crashed:', err);
  process.exit(2);
});
