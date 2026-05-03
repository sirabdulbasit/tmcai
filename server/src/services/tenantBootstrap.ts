/**
 * MyOS — Tenant Bootstrap.
 *
 * Single source of truth for "what does a freshly-created tenant need
 * to be usable from the UI". Without this, new tenants land with an
 * empty connectors list (because tenant_connector_configs is empty),
 * forcing an admin to either click each connector to enable it or run
 * SQL to seed defaults. Both are wrong: the platform should ship safe
 * defaults out of the box.
 *
 * Called from:
 *   - tenantService.createTenant (new tenant signup)
 *   - server.ts boot path (sweep — catches tenants created before this
 *     code shipped, idempotent so safe to re-run)
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('tenant-bootstrap');

/**
 * Enable every active personal connector type for this tenant.
 * Idempotent — uses ON CONFLICT DO NOTHING via Prisma's upsert.
 */
export async function seedTenantConnectorDefaults(clientNumber: string): Promise<{ inserted: number }> {
  // All personal connector types currently in the catalog.
  const types = await prisma.connectorType.findMany({
    where: { isActive: true, scope: 'personal' } as any,
    select: { id: true, slug: true },
  }).catch(() => [] as Array<{ id: string; slug: string }>);

  let inserted = 0;
  for (const t of types) {
    try {
      // Skip if already configured.
      const existing = await prisma.tenantConnectorConfig.findUnique({
        where: { clientNumber_connectorTypeId: { clientNumber, connectorTypeId: t.id } },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.tenantConnectorConfig.create({
        data: {
          clientNumber,
          connectorTypeId: t.id,
          scope: 'personal',
          isEnabled: true,
        },
      });
      inserted += 1;
    } catch (e: any) {
      log.warn('connector seed skipped', { clientNumber, slug: t.slug, error: e.message });
    }
  }

  if (inserted > 0) log.info('seeded tenant connector defaults', { clientNumber, inserted });
  return { inserted };
}

/**
 * Run every bootstrap step for a single tenant. Add new defaults here as
 * the platform grows — keep this function the single entry point so
 * callers don't have to know the full list.
 */
export async function bootstrapTenant(clientNumber: string): Promise<void> {
  await seedTenantConnectorDefaults(clientNumber);
}

/**
 * Boot-time sweep — for every active tenant, run the bootstrap. Catches
 * tenants created before this code shipped (or before a new default was
 * added). All steps are idempotent so re-running is free.
 */
export async function bootstrapAllTenants(): Promise<void> {
  const tenants = await prisma.tenant.findMany({
    where: { isActive: true } as any,
    select: { clientNumber: true },
  }).catch(() => [] as Array<{ clientNumber: string }>);

  let touched = 0;
  for (const t of tenants) {
    try {
      await bootstrapTenant(t.clientNumber);
      touched += 1;
    } catch (e: any) {
      log.warn('tenant bootstrap failed', { clientNumber: t.clientNumber, error: e.message });
    }
  }
  if (touched > 0) log.info('tenant bootstrap sweep complete', { tenants: touched });
}
