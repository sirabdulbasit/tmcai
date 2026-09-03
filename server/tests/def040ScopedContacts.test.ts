/**
 * DEF-040 — one user could read another's private contacts.
 *
 * External audit, 2026-08-05: *"`fetch_contact_full` returns another user's private contact —
 * email, phone, saved-phonebook name, provenance and the other owner's user id — all readable by
 * any user in the tenant."* Still live when re-verified on **2026-09-03**, four weeks later, and
 * the exposure was measurable: **user 2 could read all 351 contacts belonging to user 3**, and
 * vice versa.
 *
 * All three lookup limbs filtered on `client_number` alone. `client_number` is a TENANT boundary
 * and never was a user boundary, and conflating the two is the entire defect. Worse than a
 * missing filter: the renderer *detected* the foreign owner — `another user (id ${row.userId})` —
 * and printed the email and phone anyway.
 *
 * The audit was explicit that a patched `WHERE` would not do: *"one shared scoped-contact
 * accessor that every reader must use … CI guard naming it sole owner, same shape as
 * `waIdentity.ts`."* The last test in this file is that guard, and it is the load-bearing one:
 * this is a **recurrence of the class fixed on 2026-05-25**, so the thing that matters is not
 * that today's two readers are correct but that tomorrow's third cannot be wrong.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryRaw = vi.fn();
vi.mock('../src/db/prisma', () => ({ default: { $queryRawUnsafe: (...a: any[]) => queryRaw(...a) } }));

import { findScopedContactPage, findScopedContactPhonesByEmail } from '../src/services/knowledge/scopedContacts';

const sqlOf = () => String(queryRaw.mock.calls[0][0]).replace(/\s+/g, ' ');
const argsOf = () => queryRaw.mock.calls[0].slice(1);

beforeEach(() => { vi.clearAllMocks(); queryRaw.mockResolvedValue([]); });

describe('DEF-040 — a contact is private to the user who owns it', () => {
  it('scopes a lookup by id to the requester', async () => {
    await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'person:abc' });
    expect(sqlOf()).toContain("user_id = $2");
    expect(sqlOf()).toContain("metadata->'discovered_by_users' @> $3::jsonb");
    expect(argsOf()[1]).toBe(2);
  });

  it('scopes a lookup by email', async () => {
    await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byEmail: 'X@Y.com' });
    expect(sqlOf()).toContain("user_id = $2");
    expect(sqlOf()).toContain("metadata->'discovered_by_users' @> $3::jsonb");
    expect(argsOf()[3]).toBe('x@y.com');       // case-folded, as SMTP is
  });

  it('scopes a lookup by phone', async () => {
    await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byPhone: '+923001234567' });
    expect(sqlOf()).toContain("user_id = $2");
    expect(sqlOf()).toContain("metadata->'discovered_by_users' @> $3::jsonb");
  });

  it('scopes the email→phone resolution too — the second leaking reader', async () => {
    await findScopedContactPhonesByEmail({ clientNumber: 'TMC-0001', userId: 2, email: 'a@b.c' });
    expect(sqlOf()).toContain("user_id = $2");
    expect(sqlOf()).toContain("metadata->'discovered_by_users' @> $3::jsonb");
  });

  it('still keeps the tenant boundary — scoping by user does not replace it', async () => {
    await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'x' });
    expect(sqlOf()).toContain('client_number = $1');
    expect(argsOf()[0]).toBe('TMC-0001');
  });

  it('matches the scope rule the rest of the codebase already enforces', async () => {
    // My first version omitted `discovered_by_users` and was therefore MORE restrictive than
    // `entityCatalogRoutes` and `riskRulesService`, which have enforced all three clauses all
    // along — it would have hidden contacts the requester legitimately discovered, trading a
    // leak for a different wrong answer.
    await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'x' });
    const sql = sqlOf();
    expect(sql).toContain("metadata->>'scope' = 'tenant'");
    expect(sql).toContain("metadata->'discovered_by_users' @> $3::jsonb");
    expect(argsOf()[2]).toBe('[2]');
  });

  it('fails CLOSED when the query errors', async () => {
    // A lookup that throws must not fall back to an unscoped read — that is how this defect
    // would return wearing a try/catch.
    queryRaw.mockRejectedValue(new Error('db down'));
    expect(await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2, byId: 'x' })).toBeNull();
    expect(await findScopedContactPhonesByEmail({ clientNumber: 'TMC-0001', userId: 2, email: 'a@b.c' })).toEqual([]);
  });

  it('returns nothing when asked for nothing', async () => {
    expect(await findScopedContactPage({ clientNumber: 'TMC-0001', userId: 2 })).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('DEF-040 — THE GUARD: no reader may query contacts unscoped', () => {
  it('every entity_person read in brainTools goes through the accessor', () => {
    // This is the test that matters. Today's two readers being correct is worth little; what
    // stops the 2026-05-25 class recurring a third time is that a NEW reader cannot be wrong
    // without failing here. Same shape as waIdentity.ts's CI-enforced sole ownership.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'brainTools.ts'), 'utf-8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

    // Any SQL in this file that selects contact pages must carry the scope predicate.
    const offenders: string[] = [];
    for (const m of code.matchAll(/page_type\s*=\s*'entity_person'/g)) {
      const stmt = code.slice(Math.max(0, m.index! - 700), m.index! + 700);
      if (!stmt.includes("metadata->>'scope'") && !stmt.includes('findScopedContact')) {
        offenders.push(code.slice(Math.max(0, m.index! - 90), m.index! + 60).replace(/\s+/g, ' '));
      }
    }
    expect(offenders, `unscoped entity_person read(s):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the accessor is the only CONTACT reader that names the rule', () => {
    // Not sole ownership in the whole tree: `entityCatalogRoutes` and `riskRulesService` were
    // already enforcing it correctly and are legitimate owners of their own queries. What must
    // not happen is a THIRD copy appearing inside the contact-tool path, where the leak was.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const tools = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'brainTools.ts'), 'utf-8');
    expect(tools).not.toContain("metadata->>'scope' = 'tenant'");
    expect(tools).toContain('findScopedContact');
  });
});
