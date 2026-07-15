import prisma from '../db/prisma';

/**
 * TenantService — manages client/tenant lifecycle.
 *
 * Client Number Format: [A-Z]{2,5}-\d{4}
 * Examples: TMC-0001, ACPL-0002, PSO-0003
 *
 * Auto-generated from company name:
 *   "TallyMarks Consulting" → TMC-0001
 *   "Pakistan State Oil"    → PSO-0002
 */

const CLIENT_NUMBER_REGEX = /^[A-Z]{2,5}-\d{4}$/;

export function isValidClientNumber(clientNumber: string): boolean {
  return CLIENT_NUMBER_REGEX.test(clientNumber);
}

/**
 * Generate a prefix from company name (2-5 uppercase letters).
 * Takes first letter of each word, or first 3-4 chars if single word.
 */
function generatePrefix(name: string): string {
  const words = name.trim().split(/\s+/).filter(w => w.length > 0);

  if (words.length >= 2) {
    // Take first letter of each word (max 5)
    const prefix = words
      .map(w => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 5);
    return prefix.length >= 2 ? prefix : words[0].slice(0, 3).toUpperCase();
  }

  // Single word: take first 3-4 chars
  return words[0].slice(0, 4).toUpperCase();
}

/**
 * Auto-generate the next client_number for a given prefix.
 * Finds the highest existing number with that prefix and increments.
 */
async function getNextClientNumber(prefix: string): Promise<string> {
  const existing = await prisma.tenant.findMany({
    where: { clientNumber: { startsWith: `${prefix}-` } },
    orderBy: { clientNumber: 'desc' },
    take: 1,
  });

  let nextNum = 1;
  if (existing.length > 0) {
    const lastNum = parseInt(existing[0].clientNumber.split('-')[1]) || 0;
    nextNum = lastNum + 1;
  }

  return `${prefix}-${String(nextNum).padStart(4, '0')}`;
}

/**
 * Create a new tenant with auto-generated client_number.
 */
export async function createTenant(name: string, clientNumber?: string) {
  let finalClientNumber: string;

  if (clientNumber) {
    // Manual override — validate format
    if (!isValidClientNumber(clientNumber)) {
      throw new Error(`Invalid client number format. Expected: ABC-0001 (2-5 letters, hyphen, 4 digits)`);
    }
    // Check uniqueness
    const exists = await prisma.tenant.findUnique({ where: { clientNumber } });
    if (exists) throw new Error(`Client number ${clientNumber} already exists`);
    finalClientNumber = clientNumber;
  } else {
    // Auto-generate
    const prefix = generatePrefix(name);
    finalClientNumber = await getNextClientNumber(prefix);
  }

  const tenant = await prisma.tenant.create({
    data: { clientNumber: finalClientNumber, name },
  });

  // Seed defaults so the new tenant lands in a usable state — connector
  // catalog enabled, etc. Without this, an admin opening the Connectors
  // page on day 1 sees nothing and assumes the system is broken.
  // Fire-and-forget — never block tenant creation on bootstrap failure.
  void (async () => {
    try {
      const { bootstrapTenant } = await import('./tenantBootstrap');
      await bootstrapTenant(tenant.clientNumber);
    } catch (e: any) {
      console.warn(`[Tenant] bootstrap failed for ${tenant.clientNumber}: ${e.message}`);
    }
  })();

  console.log(`[Tenant] Created: ${tenant.clientNumber} (${tenant.name})`);
  return tenant;
}

/**
 * Get tenant by client_number.
 */
export async function getTenant(clientNumber: string) {
  return prisma.tenant.findUnique({ where: { clientNumber } });
}

/**
 * List all active tenants.
 */
export async function listTenants() {
  return prisma.tenant.findMany({
    where: { isActive: true },
    orderBy: { clientNumber: 'asc' },
  });
}

/**
 * Deactivate a tenant (soft delete).
 *
 * M11 — Also evict the tenant's cached WhatsApp provider so that a
 * disabled tenant can't keep sending messages through an instance that
 * was warmed up before the flag flipped. The import is dynamic to avoid
 * a circular dependency at module load.
 */
export async function deactivateTenant(clientNumber: string) {
  const result = await prisma.tenant.update({
    where: { clientNumber },
    data: { isActive: false },
  });
  try {
    const { clearProviderCache } = await import('./whatsapp/WhatsAppManager');
    clearProviderCache(clientNumber);
  } catch {
    // Cache clear is best-effort; never fail the deactivation on it.
  }
  return result;
}
