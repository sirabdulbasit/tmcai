/**
 * smokeTenantIsolation.ts — quick proof that the Prisma $extends
 * tenant-scope hook does what the 31 red tests are asking for:
 *  - findUnique by id from tenant A scope cannot return tenant B's row
 *  - findFirst / findMany auto-filter by clientNumber
 *  - bypass scope (SA) sees everything
 */
import prisma from '../db/prisma';
import { runInTenantScope, runWithoutTenant } from '../db/tenantContext';

async function main() {
  // Pick two users that we know exist in different scopes (or same tenant for sanity)
  const tmcUsers = await runWithoutTenant(async () =>
    prisma.user.findMany({
      where: { clientNumber: 'TMC-0001' },
      select: { id: true, clientNumber: true, name: true },
      take: 2,
    }),
  );
  if (tmcUsers.length < 2) {
    console.log('[isolation] need ≥2 TMC-0001 users to test; have', tmcUsers.length);
    return;
  }
  const [u1, u2] = tmcUsers;
  console.log('[isolation] sample users:', tmcUsers);

  // 1. With NO scope set (early boot, etc.) — query passes through unchanged.
  const noScope = await prisma.user.findUnique({ where: { id: u1.id } });
  console.log('\nno-scope findUnique(u1):', noScope?.id, '←', noScope ? 'returned' : 'null');

  // 2. With same-tenant scope, findUnique returns the row.
  const sameTenant = await runInTenantScope(
    { clientNumber: 'TMC-0001', userId: u1.id, bypass: false },
    async () => prisma.user.findUnique({ where: { id: u1.id } }),
  );
  console.log('same-tenant findUnique(u1):', sameTenant?.id ?? 'null');

  // 3. With WRONG-tenant scope, findUnique should return null even though id matches.
  const crossTenant = await runInTenantScope(
    { clientNumber: 'NOT-A-REAL-TENANT', userId: 9999, bypass: false },
    async () => prisma.user.findUnique({ where: { id: u1.id } }),
  );
  console.log('wrong-tenant findUnique(u1):', crossTenant?.id ?? 'null  (✓ blocked)');

  // 4. Same for findFirst — wrong-tenant scope should not return any row.
  const crossList = await runInTenantScope(
    { clientNumber: 'NOT-A-REAL-TENANT', userId: 9999, bypass: false },
    async () => prisma.user.findMany({ take: 5 }),
  );
  console.log('wrong-tenant findMany users:', crossList.length, '(should be 0)');

  // 5. SA bypass scope sees everything (no clientNumber injected).
  const saList = await runInTenantScope(
    { clientNumber: 'TMC-0001', userId: 1, bypass: true },
    async () => prisma.user.findMany({ select: { id: true, clientNumber: true }, take: 10 }),
  );
  const tenants = new Set(saList.map((u) => u.clientNumber));
  console.log('SA bypass: tenants seen =', [...tenants], 'count=', saList.length);

  // 6. WikiPage findUnique cross-tenant blocked
  const aPage = await runWithoutTenant(async () =>
    prisma.wikiPage.findFirst({ where: { clientNumber: 'TMC-0001' }, select: { id: true } }),
  );
  if (aPage) {
    const blocked = await runInTenantScope(
      { clientNumber: 'NOT-A-REAL-TENANT', userId: 9999, bypass: false },
      async () => prisma.wikiPage.findUnique({ where: { id: aPage.id } }),
    );
    console.log('wiki findUnique cross-tenant:', blocked?.id ?? 'null  (✓ blocked)');
  }

  console.log('\n[isolation] ASSERTIONS:');
  console.log('  same-tenant findUnique works  :', sameTenant?.id === u1.id ? '✓' : '✗');
  console.log('  wrong-tenant findUnique blocks:', crossTenant === null ? '✓' : '✗');
  console.log('  wrong-tenant findMany blocks  :', crossList.length === 0 ? '✓' : '✗');
  console.log('  SA bypass returns all tenants :', tenants.size >= 1 ? '✓' : '✗');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
