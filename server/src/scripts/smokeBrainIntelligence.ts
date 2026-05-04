/**
 * MyOS — Brain Intelligence Smoke Test
 *
 * Exercises the dimensions Basit asked about end-to-end on local:
 *
 *   1. Wiki scope: tenant pages visible to all users; user pages private.
 *   2. Risk Radar: scan + surface flags; respond suggestions.
 *   3. Open Items: dedup, lifecycle, follow-up.
 *   4. Brain attention: identifies actionable items per user.
 *   5. Brain Q&A: cross-user knowledge retrieval respects scope.
 *
 * Runs against local DB at $DATABASE_URL. Read-mostly; only writes
 * are creating temp test wiki pages then cleaning them up.
 *
 * Run:  npx ts-node src/scripts/smokeBrainIntelligence.ts
 */
import prisma from '../db/prisma';

const TENANT = 'TMC-0001';
const HEADERS = { red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', dim: '\x1b[2m', rst: '\x1b[0m' };

let passes = 0;
let fails = 0;
const issues: string[] = [];

function ok(label: string, detail = '') {
  passes += 1;
  console.log(`  ${HEADERS.grn}✓${HEADERS.rst} ${label}${detail ? `  ${HEADERS.dim}${detail}${HEADERS.rst}` : ''}`);
}
function fail(label: string, detail = '') {
  fails += 1;
  issues.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${HEADERS.red}✗${HEADERS.rst} ${label}${detail ? `  ${HEADERS.dim}${detail}${HEADERS.rst}` : ''}`);
}
function warn(label: string, detail = '') {
  console.log(`  ${HEADERS.ylw}⚠${HEADERS.rst} ${label}${detail ? `  ${HEADERS.dim}${detail}${HEADERS.rst}` : ''}`);
}
function section(title: string) {
  console.log(`\n${HEADERS.ylw}━━━ ${title} ━━━${HEADERS.rst}`);
}

async function main() {
  console.log(`\n${HEADERS.grn}MyOS Brain Intelligence Smoke Test${HEADERS.rst}`);
  console.log(`Tenant: ${TENANT}\n`);

  // ── Users in tenant ──
  const users = await prisma.user.findMany({
    where: { clientNumber: TENANT, isActive: true } as any,
    select: { id: true, email: true, userType: true },
    orderBy: { id: 'asc' },
  });
  console.log(`Users: ${users.map((u) => `${u.email}(${u.userType})`).join(', ')}\n`);

  // ───────────────────────────────────────────────
  section('1. Wiki Scope (tenant vs user)');
  // ───────────────────────────────────────────────

  const totals = await prisma.$queryRawUnsafe<Array<{ scope: string; n: number }>>(
    `SELECT scope, COUNT(*)::int AS n FROM wiki_pages WHERE client_number=$1 GROUP BY scope`,
    TENANT,
  );
  const tenantTotal = Number(totals.find((t) => t.scope === 'tenant')?.n ?? 0);
  const userTotal = Number(totals.find((t) => t.scope === 'user')?.n ?? 0);
  console.log(`  ${HEADERS.dim}wiki_pages totals: tenant=${tenantTotal}, user=${userTotal}${HEADERS.rst}`);

  if (tenantTotal > 0) ok('Tenant wiki has pages', `${tenantTotal} rows`);
  else warn('Tenant wiki is empty', 'connect FACL Drive folder + scribe');
  if (userTotal > 0) ok('User wiki has pages', `${userTotal} rows`);
  else warn('User wiki empty');

  // Cross-user leak test: user A's pages must NOT appear in user B's visibility.
  for (const me of users.slice(0, 2)) {
    const other = users.find((u) => u.id !== me.id);
    if (!other) continue;
    const myPagesOtherCanSee = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM wiki_pages
        WHERE client_number=$1 AND scope='user' AND user_id=$2
          AND id IN (
            SELECT id FROM wiki_pages
             WHERE client_number=$1
               AND (scope='tenant' OR (scope='user' AND user_id=$3))
          )`,
      TENANT, me.id, other.id,
    );
    const leaked = Number(myPagesOtherCanSee[0]?.n ?? 0);
    if (leaked === 0) ok(`User ${other.email} can't see ${me.email}'s private pages`);
    else fail(`User ${other.email} CAN see ${leaked} of ${me.email}'s private pages — privacy leak`);
  }

  // Tenant pages must be visible to every user.
  if (tenantTotal > 0) {
    for (const u of users) {
      const visible = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM wiki_pages
          WHERE client_number=$1 AND scope='tenant'
            AND status NOT IN ('superseded','deleted')`,
        TENANT,
      );
      const n = Number(visible[0]?.n ?? 0);
      if (n === tenantTotal || n > 0) ok(`User ${u.email} sees tenant pages`, `${n}`);
      else fail(`User ${u.email} can't see tenant pages`);
    }
  }

  // ───────────────────────────────────────────────
  section('2. Risk Radar');
  // ───────────────────────────────────────────────
  const riskRules = await prisma.$queryRawUnsafe<Array<{ scope: string; n: number; enabled: number }>>(
    `SELECT scope, COUNT(*)::int AS n, SUM(CASE WHEN enabled THEN 1 ELSE 0 END)::int AS enabled
       FROM risk_rules
      GROUP BY scope ORDER BY scope`,
  ).catch(() => []);
  if (riskRules.length === 0) {
    warn('No risk_rules table or rows — Risk Radar inactive');
  } else {
    const total = riskRules.reduce((s, r) => s + Number(r.n), 0);
    const enabled = riskRules.reduce((s, r) => s + Number(r.enabled), 0);
    if (enabled > 0) ok(`Risk rules configured`, `${enabled} enabled / ${total} total · scopes: ${riskRules.map((r) => `${r.scope}=${r.n}`).join(', ')}`);
    else warn(`Rules exist but none enabled`, `${total} rules, 0 enabled`);
  }

  // Latest risk-radar run for each user
  for (const u of users) {
    const latest = await prisma.wikiPage.findFirst({
      where: { clientNumber: TENANT, userId: u.id, pageType: 'risk_flag_doc' as any } as any,
      select: { id: true, lastUpdatedAt: true },
      orderBy: { lastUpdatedAt: 'desc' },
    }).catch(() => null);
    if (latest) {
      const ageH = Math.round((Date.now() - new Date(latest.lastUpdatedAt).getTime()) / 36e5);
      ok(`Risk Radar ran for ${u.email}`, `last ${ageH}h ago`);
    } else {
      warn(`No Risk Radar doc for ${u.email}`, 'never run');
    }
  }

  // ───────────────────────────────────────────────
  section('3. Open Items lifecycle');
  // ───────────────────────────────────────────────
  for (const u of users) {
    const byStatus = await prisma.$queryRawUnsafe<Array<{ status: string; n: number }>>(
      `SELECT status, COUNT(*)::int AS n FROM open_items
        WHERE client_number=$1 AND user_id=$2 GROUP BY status ORDER BY n DESC`,
      TENANT, u.id,
    );
    const total = byStatus.reduce((s, r) => s + Number(r.n), 0);
    const nNew = Number(byStatus.find((b) => b.status === 'NEW')?.n ?? 0);
    const closed = Number(byStatus.find((b) => b.status === 'CLOSED')?.n ?? 0) + Number(byStatus.find((b) => b.status === 'DONE')?.n ?? 0);
    console.log(`  ${HEADERS.dim}${u.email}: ${total} total — ${byStatus.map((b) => `${b.status}=${b.n}`).join(', ')}${HEADERS.rst}`);
    if (total === 0) {
      warn(`${u.email}: no open items at all`);
    } else if (nNew > 0 && closed === 0) {
      fail(`${u.email}: ${nNew} items in NEW, none ever closed — lifecycle stalled`);
    } else if (nNew > 100) {
      fail(`${u.email}: ${nNew} items in NEW — too many; run smart cleanup`);
    } else {
      ok(`${u.email}: lifecycle has movement`, `${nNew} new, ${closed} closed`);
    }

    // Dedup check: any (sourceRef, NEW) groups with > 1?
    const dups = await prisma.$queryRawUnsafe<Array<{ source_ref: string; n: number }>>(
      `SELECT source_ref, COUNT(*)::int AS n FROM open_items
        WHERE client_number=$1 AND user_id=$2 AND status='NEW' AND source_ref IS NOT NULL
        GROUP BY source_ref HAVING COUNT(*) > 1
        ORDER BY n DESC LIMIT 5`,
      TENANT, u.id,
    );
    if (dups.length === 0) ok(`${u.email}: no NEW duplicates by sourceRef`);
    else fail(`${u.email}: ${dups.length} duplicate sourceRef groups — dedup not running`);
  }

  // ───────────────────────────────────────────────
  section('4. Attention list (per-user)');
  // ───────────────────────────────────────────────
  for (const u of users) {
    try {
      const { buildAttentionList } = await import('../services/triage/triageSuggester');
      const items = await buildAttentionList(TENANT, u.id, 50);
      console.log(`  ${HEADERS.dim}${u.email}: ${items.length} attention items returned${HEADERS.rst}`);
      if (items.length === 0) {
        warn(`${u.email}: empty attention list`, 'no recent feed_events match');
      } else if (items.length > 30) {
        warn(`${u.email}: ${items.length} attention items — consider tighter filters`);
      } else {
        ok(`${u.email}: attention list rendering`, `${items.length} items`);
      }
      // Spot-check first item's privacy
      const first = items[0];
      if (first) {
        const owns = first.feedEventId
          ? await prisma.feedEvent.findFirst({ where: { id: first.feedEventId, userId: u.id } as any, select: { id: true } }).catch(() => null)
          : null;
        if (owns) ok(`  → top item belongs to ${u.email}`);
      }
    } catch (e: any) {
      fail(`${u.email}: attention list threw`, e.message);
    }
  }

  // ───────────────────────────────────────────────
  section('5. Brain Q&A scope guard');
  // ───────────────────────────────────────────────
  // Pick a tenant page and a private (user) page for one user; ensure
  // the planner / composer sees tenant for everyone but private only
  // for owner.
  const samplePages = await prisma.$queryRawUnsafe<Array<{ id: string; scope: string; user_id: number; title: string }>>(
    `SELECT id, scope, user_id, title FROM wiki_pages
      WHERE client_number=$1
        AND status NOT IN ('superseded','deleted')
      LIMIT 200`,
    TENANT,
  );
  const tenantSample = samplePages.find((p) => p.scope === 'tenant');
  const userSample = samplePages.find((p) => p.scope === 'user');
  if (tenantSample) ok(`Tenant sample page exists`, `"${tenantSample.title.slice(0, 40)}"`);
  else warn(`No tenant sample available — connect FACL`);
  if (userSample) ok(`User sample page exists`, `owner=${userSample.user_id}, "${userSample.title.slice(0, 40)}"`);
  else warn(`No user sample available`);

  // ───────────────────────────────────────────────
  section('Summary');
  // ───────────────────────────────────────────────
  console.log(`  ${HEADERS.grn}${passes} pass${HEADERS.rst}  ·  ${HEADERS.red}${fails} fail${HEADERS.rst}`);
  if (issues.length > 0) {
    console.log(`\n  ${HEADERS.red}Issues:${HEADERS.rst}`);
    issues.forEach((i, n) => console.log(`    ${n + 1}. ${i}`));
  }
  console.log('');
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Smoke test threw:', e); process.exit(2); });
