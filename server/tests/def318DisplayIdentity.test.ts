/**
 * DEF-318 — never show a routing key where a person's number belongs.
 *
 * Owner, 2026-09-04, pointing at the admin Recent Messages panel: *"always show correct number
 * not lid"*, then *"+173555350261799 this is not valid number of whatsapp"*. He is right — it is
 * not a number at all. It is his own phone, rendered as an `@lid`-derived routing key with a
 * `+` glued on, and it was **every one of his 58 inbound messages in seven days**.
 *
 * The synthetic itself stays: removing it was `@lid` recurrence #4, when every `@lid`
 * counterpart collapsed and a delegatee's reply was dropped as "Unregistered number". It is
 * correct as a KEY and wrong as a NUMBER. So this is resolved at the DISPLAY boundary, and the
 * edge it follows has existed since 2026-06-10 —
 * `whatsapp_connections { phone_number: '+173555350261799', user_id: 2,
 *   display_name: 'Basit (LID alias 1799)' }`.
 */
import { describe, it, expect, vi } from 'vitest';

const rows = vi.hoisted(() => ({ conns: [] as any[], ents: [] as any[] }));

vi.mock('../src/db/prisma', () => {
  const p: any = {
    $queryRawUnsafe: async (sql: string) => (
      /whatsapp_connections/.test(sql) ? rows.conns : /entities/.test(sql) ? rows.ents : []),
  };
  return { __esModule: true, default: p, prisma: p };
});

import { resolveDisplayIdentities, unknownLidLabel } from '../src/services/whatsapp/displayIdentity';

const OWNER_ALIAS = '+173555350261799';
const OWNER_REAL = '+923226288256';

describe('DEF-318 — the alias resolves to the real person', () => {
  it('shows the owner\'s REAL number for his @lid alias', async () => {
    // The exact row the owner was shown 58 times. Mutation: drop the alias branch and this
    // returns the synthetic, which is the reported defect verbatim.
    rows.conns = [{ phone_number: OWNER_ALIAS, display_name: 'Basit (LID alias 1799)', contact_number: OWNER_REAL, user_name: 'Basit Ahmed' }];
    rows.ents = [];
    const r = await resolveDisplayIdentities('TMC-0001', [OWNER_ALIAS]);
    expect(r.get(OWNER_ALIAS)!.number).toBe(OWNER_REAL);
    expect(r.get(OWNER_ALIAS)!.label).toContain(OWNER_REAL);
    expect(r.get(OWNER_ALIAS)!.label).not.toContain('173555350261799');
    expect(r.get(OWNER_ALIAS)!.wasAlias).toBe(true);
  });

  it('does not flag a REAL number as an alias', async () => {
    // The comparison is on digits, so '+92322...' and '92322...' must not read as different
    // numbers and trigger a false alias.
    rows.conns = [{ phone_number: OWNER_REAL, display_name: 'Basit', contact_number: '923226288256', user_name: 'Basit Ahmed' }];
    rows.ents = [];
    const r = await resolveDisplayIdentities('TMC-0001', [OWNER_REAL]);
    expect(r.get(OWNER_REAL)!.wasAlias).toBe(false);
    expect(r.get(OWNER_REAL)!.number).toBe(OWNER_REAL);
  });
});

describe('DEF-318 — a known contact whose number WhatsApp withholds', () => {
  it('shows the NAME and states the gap, never a fabricated number', async () => {
    // 26 live entities carry a wa_lid; every one has `phone` null, because WhatsApp does not
    // share it. A name is the whole of what can honestly be shown.
    rows.conns = [];
    rows.ents = [{ wa_lid: '125408817238041', name: 'Saba Warid', phone: null }];
    const key = '+125408817238041';
    const r = await resolveDisplayIdentities('TMC-0001', [key]);
    expect(r.get(key)!.label).toBe('Saba Warid — number not shared by WhatsApp');
    expect(r.get(key)!.number).toBeNull();
  });
});

describe('DEF-318 — an unidentified lid is never rendered as a number', () => {
  it('labels it as an ID and strips the leading +', async () => {
    // `+239487846228094` reached the panel through this branch. The '+' is the single character
    // that makes a routing key read as dialable, so it must not survive.
    rows.conns = []; rows.ents = [];
    const key = '+239487846228094';
    const r = await resolveDisplayIdentities('TMC-0001', [key]);
    expect(r.get(key)!.number).toBeNull();
    expect(r.get(key)!.label).toBe('WhatsApp ID 239487846228094 — number not shared');
    expect(r.get(key)!.label.startsWith('+')).toBe(false);
  });

  it('leaves a plausible unknown number alone', async () => {
    // The backstop is length-based and must not swallow ordinary numbers. 12 digits is what
    // every real number in the live table has.
    rows.conns = []; rows.ents = [];
    const key = '+923001234567';
    const r = await resolveDisplayIdentities('TMC-0001', [key]);
    expect(r.get(key)!.number).toBe(key);
    expect(r.get(key)!.label).toBe(key);
  });
});

describe('DEF-318 — unknownLidLabel', () => {
  it('accepts a raw @lid id and a synthetic alike', () => {
    expect(unknownLidLabel('239487846228094@lid')).toBe('WhatsApp ID 239487846228094 — number not shared');
    expect(unknownLidLabel('+239487846228094')).toBe('WhatsApp ID 239487846228094 — number not shared');
  });
});
