/**
 * DEF-189 (Codex iteration-2 HIGH / directive 1) — the REAL
 * `getOpenItemsSettings` implementation, not a mock of it, against a
 * rejecting Prisma.
 *
 * The old implementation caught a database error and returned DEFAULTS —
 * so "could not read his preference" became "he holds the default
 * preference", and the cleanup job quarantined items for an owner whose
 * stale sweep may be disabled. Fail-open authorization from a failed read.
 *
 * The contract now: a DATABASE ERROR THROWS; only a CONFIRMED read returns —
 * a row's preferences coerced, or pure defaults for a confirmed no-row pair
 * (foreign or nonexistent — the tenant-constrained query reads nothing).
 * Errors are never cached; the next healthy read serves real values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock('../src/db/prisma', () => ({
  default: { user: { findFirst: mocks.findFirst } },
}));

import {
  getOpenItemsSettings,
  invalidateOpenItemsSettings,
  DEFAULTS,
} from '../src/services/openItems/openItemsSettings';

// Distinct (user, tenant) per test — the module caches per pair for 60s and
// the module instance is shared across this file.
let user = 100;
const tenant = () => `t-${user}`;

beforeEach(() => {
  vi.clearAllMocks();
  user++;
});

describe('DEF-189 — preference reads fail CLOSED', () => {
  it('a database error THROWS — it is never converted into a default preference', async () => {
    mocks.findFirst.mockRejectedValue(new Error('connection reset'));

    await expect(getOpenItemsSettings(user, tenant())).rejects.toThrow('connection reset');
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: user, clientNumber: tenant() },
      select: { notificationPreferences: true },
    });
  });

  it('an error is not cached — the next healthy read serves the real values, zero included', async () => {
    mocks.findFirst.mockRejectedValueOnce(new Error('transient'));
    await expect(getOpenItemsSettings(user, tenant())).rejects.toThrow('transient');

    mocks.findFirst.mockResolvedValue({
      notificationPreferences: { open_items: { staleThresholdDays: 0 } },
    });
    const value = await getOpenItemsSettings(user, tenant());
    expect(value.staleThresholdDays, 'the owner’s 0 is a real value, not absence').toBe(0);
  });

  it('a confirmed no-row read (foreign or nonexistent pair) is the defined absence: pure defaults', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const value = await getOpenItemsSettings(user, tenant());
    expect(value).toEqual(DEFAULTS);
  });

  it('a confirmed row with no open_items block also coerces to defaults', async () => {
    mocks.findFirst.mockResolvedValue({ notificationPreferences: {} });
    const value = await getOpenItemsSettings(user, tenant());
    expect(value).toEqual(DEFAULTS);
  });

  it('a healthy read is cached per (tenant, user) and invalidation is tenant-scoped', async () => {
    mocks.findFirst.mockResolvedValue({
      notificationPreferences: { open_items: { staleThresholdDays: 45 } },
    });
    const first = await getOpenItemsSettings(user, tenant());
    expect(first.staleThresholdDays).toBe(45);

    await getOpenItemsSettings(user, tenant());
    expect(mocks.findFirst, 'second read served from cache').toHaveBeenCalledTimes(1);

    invalidateOpenItemsSettings(user, tenant());
    await getOpenItemsSettings(user, tenant());
    expect(mocks.findFirst, 'invalidation forces a fresh read').toHaveBeenCalledTimes(2);
  });
});
