import { describe, it, expect, vi, beforeEach } from 'vitest';

// #13 (2026-07-14) — explicit-vs-inherited timezone semantics. The old
// column default made every legacy row look user-chosen, silently
// blocking tenant fallback. Now User.timezone participates ONLY when
// timezone_is_explicit = true.

let userRow: any = null;
vi.mock('../src/db/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(async () => userRow),
      update: vi.fn(async (args: any) => { Object.assign(userRow ?? {}, args.data); return userRow; }),
    },
  },
}));
vi.mock('../src/utils/redisClient', () => ({
  getOrCompute: vi.fn(async (_k: string, _ttl: number, fn: () => Promise<any>) => fn()),
  del: vi.fn(async () => 1),
}));
let tenantTz: string | null = null;
vi.mock('../src/services/configService', () => ({
  getConfig: vi.fn(async () => tenantTz),
}));

import { resolveUserTimezone, setUserTimezone } from '../src/services/userTimezoneService';

beforeEach(() => { userRow = null; tenantTz = null; delete process.env.NEXEO_DEFAULT_TIMEZONE; });

describe('resolveUserTimezone — explicit → tenant → system → UTC', () => {
  it('an EXPLICIT user zone wins over tenant and system', async () => {
    userRow = { timezone: 'America/New_York', timezoneIsExplicit: true, clientNumber: 'TMC-0001' };
    tenantTz = 'Europe/London';
    expect(await resolveUserTimezone(2)).toBe('America/New_York');
  });

  it('a legacy INHERITED zone (explicit=false) falls through to the tenant zone', async () => {
    userRow = { timezone: 'Asia/Karachi', timezoneIsExplicit: false, clientNumber: 'TMC-0001' };
    tenantTz = 'Europe/London';
    expect(await resolveUserTimezone(2)).toBe('Europe/London');
  });

  it('no explicit user + no tenant zone → system default (existing users keep Karachi)', async () => {
    userRow = { timezone: 'Asia/Karachi', timezoneIsExplicit: false, clientNumber: 'TMC-0001' };
    expect(await resolveUserTimezone(2)).toBe('Asia/Karachi'); // via systemDefaultTimezone()
  });

  it('invalid values fall through the chain', async () => {
    userRow = { timezone: 'Broken/Zone', timezoneIsExplicit: true, clientNumber: 'TMC-0001' };
    tenantTz = 'also-broken';
    expect(await resolveUserTimezone(2)).toBe('Asia/Karachi'); // system default survives
  });
});

describe('setUserTimezone — the only path that makes a zone explicit', () => {
  it('stores a valid zone with the explicit flag', async () => {
    userRow = { timezone: null, timezoneIsExplicit: false, clientNumber: 'TMC-0001' };
    expect(await setUserTimezone(2, 'Europe/Berlin')).toBe(true);
    expect(userRow.timezone).toBe('Europe/Berlin');
    expect(userRow.timezoneIsExplicit).toBe(true);
  });

  it('rejects an invalid zone without storing it', async () => {
    userRow = { timezone: null, timezoneIsExplicit: false, clientNumber: 'TMC-0001' };
    expect(await setUserTimezone(2, 'Not/A_Zone')).toBe(false);
    expect(userRow.timezone).toBeNull();
    expect(userRow.timezoneIsExplicit).toBe(false);
  });
});
