/**
 * DEF-189 / DEF-190 (Codex iteration-2 directive 1, iteration-3 directive 4)
 * — the REAL `openItemsSettings` implementation, not a mock of it, against a
 * rejecting Prisma and against the three authority states.
 *
 * The contract:
 *   - a DATABASE ERROR THROWS — it is never converted into a preference, and
 *     it is never cached;
 *   - 'found'              — confirmed user row with an open_items block →
 *                            his real values (zero included);
 *   - 'absent_preferences' — confirmed user row, no block → defaults are
 *                            authorized (the user exists, never set them);
 *   - 'no_user'            — the (tenant, user) pair reads as NO row →
 *                            value null; a mutating caller must HOLD.
 * `getOpenItemsSettings` stays as the read-side convenience for
 * authenticated-context callers and returns defaults for 'no_user'.
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
  resolveOpenItemsSettings,
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

    await expect(resolveOpenItemsSettings(user, tenant())).rejects.toThrow('connection reset');
    await expect(getOpenItemsSettings(user, tenant())).rejects.toThrow('connection reset');
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: user, clientNumber: tenant() },
      select: { notificationPreferences: true },
    });
  });

  it('an error is not cached — the next healthy read serves the real values, zero included', async () => {
    mocks.findFirst.mockRejectedValueOnce(new Error('transient'));
    await expect(resolveOpenItemsSettings(user, tenant())).rejects.toThrow('transient');

    mocks.findFirst.mockResolvedValue({
      notificationPreferences: { open_items: { staleThresholdDays: 0 } },
    });
    const resolved = await resolveOpenItemsSettings(user, tenant());
    expect(resolved.authority).toBe('found');
    expect(resolved.value!.staleThresholdDays, 'the owner’s 0 is a real value, not absence').toBe(0);
  });
});

describe('DEF-190 — settings AUTHORITY is explicit', () => {
  it('a confirmed no-row pair is no_user with a null value — a mutating caller must hold', async () => {
    mocks.findFirst.mockResolvedValue(null);
    const resolved = await resolveOpenItemsSettings(user, tenant());
    expect(resolved.authority).toBe('no_user');
    expect(resolved.value).toBeNull();
    // The read-side convenience keeps defaults for authenticated contexts.
    expect(await getOpenItemsSettings(user, tenant())).toEqual(DEFAULTS);
  });

  it('a confirmed row with no open_items block is absent_preferences — defaults are authorized', async () => {
    mocks.findFirst.mockResolvedValue({ notificationPreferences: {} });
    const resolved = await resolveOpenItemsSettings(user, tenant());
    expect(resolved.authority).toBe('absent_preferences');
    expect(resolved.value).toEqual(DEFAULTS);
  });

  it('a confirmed row with a block is found, coerced', async () => {
    mocks.findFirst.mockResolvedValue({
      notificationPreferences: { open_items: { staleThresholdDays: 45 } },
    });
    const resolved = await resolveOpenItemsSettings(user, tenant());
    expect(resolved.authority).toBe('found');
    expect(resolved.value!.staleThresholdDays).toBe(45);
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
