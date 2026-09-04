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
    // OWNER RULING 2026-09-04 — the id is no longer the VALUE. "for me it is useless, if u
    // still want to show, then always show with real number"; there is no real number here, so
    // the id is demoted to a 4-char reference that keeps two unknown senders distinguishable.
    // The full id stays in the raw column, the API field and the cell's hover title.
    expect(r.get(key)!.number).toBeNull();
    expect(r.get(key)!.label).toBe('Unknown WhatsApp sender — number not shared (ref 8094)');
    expect(r.get(key)!.label).not.toContain('239487846228094');
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
    const expected = 'Unknown WhatsApp sender — number not shared (ref 8094)';
    expect(unknownLidLabel('239487846228094@lid')).toBe(expected);
    expect(unknownLidLabel('+239487846228094')).toBe(expected);
    // The full id must not survive into what he reads, in either input form.
    expect(unknownLidLabel('239487846228094@lid')).not.toContain('239487846228094');
  });
});

/**
 * DEF-320 — the owner's ruling extended to what Brain SAYS.
 *
 * *"+173555350261799 this is totaly usless for me, don't show me i want to see real number only
 * anywher on UI and communication"* and *"u can synthetic at your end or references ... if u
 * still want to show, then always show with real number"*.
 */
import { scrubSyntheticIdentities } from '../src/services/whatsapp/displayIdentity';

describe('DEF-320 — the synthetic never survives into an outbound message', () => {
  it('replaces the owner\'s alias with his REAL number', async () => {
    rows.conns = [{ phone_number: OWNER_ALIAS, display_name: 'Basit (LID alias 1799)', contact_number: OWNER_REAL, user_name: 'Basit Ahmed' }];
    rows.ents = [];
    const out = await scrubSyntheticIdentities(
      `The most recent reply was from ${OWNER_ALIAS} this morning.`, 'TMC-0001');
    // Asserted EXACTLY, not with toContain. `toContain(OWNER_REAL)` passed even with the
    // real-number branch disabled, because the tier-2 label also contains the number — a
    // mutation that survived, which is the same vacuous-assertion trap DEF-104 recorded.
    expect(out).toBe(`The most recent reply was from ${OWNER_REAL} this morning.`);
    expect(out).not.toContain(OWNER_ALIAS);
  });

  it('uses the NAME when the number is one WhatsApp withholds', async () => {
    rows.conns = [];
    rows.ents = [{ wa_lid: '125408817238041', name: 'Saba Warid', phone: null }];
    const out = await scrubSyntheticIdentities('Message from +125408817238041.', 'TMC-0001');
    expect(out).toContain('Saba Warid');
    expect(out).not.toContain('125408817238041');
  });

  it('emits NO digits at all for an unidentified sender', async () => {
    // DEF-298 verbatim: "+109526195949711 (Mubarak Jharna Mahandri)" reached him in a reply.
    rows.conns = []; rows.ents = [];
    const out = await scrubSyntheticIdentities('Was it +239324201222348 you meant?', 'TMC-0001');
    expect(out).toBe('Was it a WhatsApp sender whose number WhatsApp did not share you meant?');
    expect(out).not.toMatch(/\d{13,}/);
  });

  it('leaves a REAL number untouched', async () => {
    // The scrub must never damage the thing it exists to protect.
    rows.conns = []; rows.ents = [];
    const out = await scrubSyntheticIdentities(`Call him on ${OWNER_REAL}.`, 'TMC-0001');
    expect(out).toBe(`Call him on ${OWNER_REAL}.`);
  });

  it('leaves a bare digit run alone — only a leading + is a number', async () => {
    // Order ids, references and amounts must survive. Mutation: drop the `\\+` from the pattern
    // and this dies, taking every long reference number in his messages with it.
    rows.conns = []; rows.ents = [];
    const out = await scrubSyntheticIdentities('Invoice 1735553502617990 is due.', 'TMC-0001');
    expect(out).toBe('Invoice 1735553502617990 is due.');
  });

  it('returns the ORIGINAL text if resolution throws', async () => {
    // A scrubber that fails must never cost him the message it was cleaning.
    rows.conns = null as any; rows.ents = null as any;
    const text = `From ${OWNER_ALIAS}.`;
    expect(await scrubSyntheticIdentities(text, 'TMC-0001')).toBe(text);
  });

  it('is a no-op on text with nothing to scrub', async () => {
    expect(await scrubSyntheticIdentities('Hi Sir.', 'TMC-0001')).toBe('Hi Sir.');
  });
});
