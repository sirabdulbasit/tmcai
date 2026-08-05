/**
 * DEF-051 — the janitor could not see the duplicates the UI was already showing.
 *
 * Production, 2026-08-05: two rows for one person sharing +923134199294 —
 * "Hamna Latif Bhutta" (email, no phone until the owner supplied it) and
 * "Hamna ABAP TMC" (her WhatsApp pushname, phone only). The nightly pruner ran
 * and left them, because it grouped by EXACT NAME.
 *
 * Meanwhile the Contacts UI had flagged them the whole time — it groups by
 * shared phone or email (ContactsPage.jsx:741) and offers Merge. Two duplicate
 * detectors, different rules, and only the one that cannot act unattended was
 * right. Same protection-with-two-implementations shape as DEF-039/041/044/045.
 *
 * The sequence that creates these is the ordinary one, so it recurs forever
 * without this: someone WhatsApps before they are saved (pushname row created,
 * correctly), then the owner supplies the number for the contact he already
 * had. Names that will never match, one identifier.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { planMerge } from '../src/services/knowledge/contactPruneService';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'contactPruneService.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const row = (o: Partial<any>) => ({
  id: o.id ?? 'r', name: o.name ?? 'X', email: o.email ?? null, phone: o.phone ?? null,
  ownerUserId: o.ownerUserId ?? 2, createdAt: o.createdAt ?? new Date('2026-01-01'), metadata: o.metadata ?? {},
});

describe('DEF-051 — grouping by shared identifier', () => {
  it('the pruner now groups by email and phone, not only by name', () => {
    expect(CODE).toMatch(/SELECT lower\(email\) AS ident FROM entities/);
    expect(CODE).toMatch(/regexp_replace\(phone, '\[\^0-9\]', '', 'g'\) AS ident/);
  });

  it('the exact-name pass is kept — it is correct, just insufficient', () => {
    expect(CODE).toMatch(/GROUP BY lower\(name\) HAVING count\(\*\) > 1/);
  });

  it('normalised digits must match exactly — a substring is not a person', () => {
    // Prisma `contains` on phone can over-match a short digit run; the code
    // re-filters on equality before treating rows as the same human.
    expect(CODE).toMatch(/p === g\.ident/);
    expect(CODE).toMatch(/sameIdent\.length < 2/);
  });

  it('the real Hamna pair merges: one phone, one email, no conflict', () => {
    const plan = planMerge([
      row({ id: 'a', name: 'Hamna Latif Bhutta', email: 'hamna.latif@tmcltd.com', phone: '+923134199294', createdAt: new Date('2026-05-23') }),
      row({ id: 'b', name: 'Hamna ABAP TMC', email: null, phone: '+923134199294', createdAt: new Date('2026-07-14') }),
    ] as any);
    expect(plan).not.toBeNull();
    // Oldest owned row wins as canonical — the named, emailed one.
    expect(plan!.canonicalId ?? (plan as any).canonical?.id).toBe('a');
  });

  it('two PEOPLE sharing one office number are flagged, never merged', () => {
    // Distinct emails conflict, so planMerge refuses. This is the safety
    // property that makes identifier-grouping safe to run unattended.
    const plan = planMerge([
      row({ id: 'a', name: 'Person One', email: 'one@tmcltd.com', phone: '+92300111222' }),
      row({ id: 'b', name: 'Person Two', email: 'two@tmcltd.com', phone: '+92300111222' }),
    ] as any);
    expect(plan).toBeNull();
  });

  it('a conflicting identifier group is logged as flagged, not silently skipped', () => {
    expect(CODE).toMatch(/shared-identifier group with conflicting identifiers/);
  });
});
