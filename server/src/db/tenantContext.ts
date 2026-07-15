/**
 * Tenant context — AsyncLocalStorage-backed scope for the
 * `clientNumber` of the currently-authenticated request. The Prisma
 * middleware (see `prisma.ts`) reads this on every read/write and
 * injects a `clientNumber` filter on tenant-scoped models, closing
 * the class of `findUnique({where:{id}})` data leaks called out by
 * `tests/tenantIsolation.test.ts` (31 red tests).
 *
 * Auth middleware sets it; agent middleware sets it; SA-only paths
 * may explicitly clear it via `runWithoutTenant()` for cross-tenant
 * admin operations.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface TenantScope {
  clientNumber: string | null;       // null = no tenant scope (admin / SA)
  userId: number | null;
  /** When true, the middleware does NOT inject clientNumber on this call.
   *  Used for SA admin operations that legitimately span tenants. */
  bypass: boolean;
}

const als = new AsyncLocalStorage<TenantScope>();

export function runInTenantScope<T>(scope: TenantScope, fn: () => Promise<T>): Promise<T> {
  return als.run(scope, fn);
}

export function runWithoutTenant<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ clientNumber: null, userId: null, bypass: true }, fn);
}

export function currentTenant(): TenantScope | undefined {
  return als.getStore();
}

export function currentClientNumber(): string | null {
  return als.getStore()?.clientNumber ?? null;
}
