/**
 * Backfill Person records from existing users + entities.
 *
 * Quality Sprint 3 (2026-05-21). One-time data migration: walk the
 * users + entities tables and create Person rows for every distinct
 * (userId, identifier) the brain-using user has encountered.
 *
 * Strategy (idempotent — safe to run multiple times):
 *   1. For each Brain-using user U (i.e., users with a session in
 *      the last 90 days OR with whatsapp/integration paired):
 *      a. For every internal teammate T in the same clientNumber:
 *         findOrCreatePerson(U, T.name, email=T.email).
 *      b. For every Entity E with type='contact' in the same
 *         clientNumber: findOrCreatePerson(U, E.name,
 *         email=E.email OR phone=E.phone).
 *      c. For every UserResolutionAlias the user has already
 *         recorded: ensure the identifier is linked.
 *
 * Auto-link heuristic (in personService.findOrCreatePersonByFacet)
 * handles the cross-channel coherence: when the same name appears
 * with email AND phone facets, they get attached to ONE Person
 * instead of two.
 *
 * Usage:
 *   npx ts-node src/scripts/backfillPersons.ts
 *
 * Output: per-user count of Persons created / facets linked.
 */
import prisma from '../db/prisma';
import { findOrCreatePersonByFacet, linkFacet, findPersonByFacet } from '../services/knowledge/personService';

async function main() {
  console.log('[backfill-persons] starting');

  // Brain-using users: heuristic = paired WA OR Google integration OR active recently.
  const activeUsers = await prisma.user.findMany({
    where: {
      isActive: true,
      OR: [
        { integrationProvider: { not: null } },
        { whatsappConnection: { isNot: null } },
        { sessions: { some: { expiresAt: { gt: new Date() } } } },
      ],
    },
    select: { id: true, clientNumber: true, name: true, email: true },
  });
  console.log(`[backfill-persons] found ${activeUsers.length} active users to process`);

  let totalPersons = 0;
  let totalFacets = 0;

  for (const u of activeUsers) {
    let userPersons = 0;
    let userFacets = 0;

    // (a) Internal teammates in the same tenant — each becomes a
    //     Person from this user's perspective.
    const teammates = await prisma.user.findMany({
      where: {
        clientNumber: u.clientNumber,
        isActive: true,
        id: { not: u.id },
      },
      select: { id: true, name: true, email: true, contactNumber: true },
    });
    for (const t of teammates) {
      if (!t.email) continue;
      try {
        await findOrCreatePersonByFacet({
          clientNumber: u.clientNumber,
          userId: u.id,
          displayName: t.name,
          facetType: 'email',
          facetValue: t.email,
          source: 'backfill',
          verified: true, // teammate email is authoritative
        });
        userPersons++;
        userFacets++;
        if (t.contactNumber) {
          const person = await findPersonByFacet(u.id, 'email', t.email);
          if (person) {
            await linkFacet({
              personId: person.id,
              facetType: 'phone',
              facetValue: t.contactNumber,
              source: 'backfill',
              verified: false,
            });
            userFacets++;
          }
        }
        // Link the internal user_id facet too.
        const personByEmail = await findPersonByFacet(u.id, 'email', t.email);
        if (personByEmail) {
          await linkFacet({
            personId: personByEmail.id,
            facetType: 'user_id',
            facetValue: String(t.id),
            source: 'backfill',
            verified: true,
          });
          userFacets++;
        }
      } catch (e: any) {
        console.warn(`[backfill-persons] teammate ${t.email} for user ${u.id} failed:`, e?.message);
      }
    }

    // (b) External contacts (Entity rows of type='contact') visible
    //     to this tenant. Per-user — we create a Person per (user,
    //     contact-identifier) pair, even if the same identifier
    //     appears in multiple users' worlds.
    const entities = await prisma.entity.findMany({
      where: {
        clientNumber: u.clientNumber,
        entityType: 'contact',
      },
      select: { id: true, name: true, email: true },
    });
    for (const e of entities) {
      const identifier = e.email;
      if (!identifier) continue;
      try {
        const person = await findOrCreatePersonByFacet({
          clientNumber: u.clientNumber,
          userId: u.id,
          displayName: e.name,
          facetType: 'email',
          facetValue: identifier,
          source: 'backfill',
          verified: false,
        });
        userPersons++;
        userFacets++;
        // Link the entity_id facet for traceability.
        await linkFacet({
          personId: person.id,
          facetType: 'entity_id',
          facetValue: e.id,
          source: 'backfill',
          verified: true,
        });
        userFacets++;
      } catch (err: any) {
        console.warn(`[backfill-persons] entity ${e.email} for user ${u.id} failed:`, err?.message);
      }
    }

    // (c) Existing alias-resolution rows — ensure each (alias →
    //     identifier) the user previously confirmed has a Person.
    const aliases = await prisma.userResolutionAlias.findMany({
      where: { userId: u.id },
      select: { displayName: true, identifier: true, identifierKind: true, alias: true },
    });
    for (const a of aliases) {
      try {
        const facetType = a.identifierKind === 'email' ? 'email' : 'phone';
        await findOrCreatePersonByFacet({
          clientNumber: u.clientNumber,
          userId: u.id,
          displayName: a.displayName ?? a.alias,
          facetType,
          facetValue: a.identifier,
          source: 'user_explicit',
          verified: true,
        });
        userFacets++;
      } catch (err: any) {
        console.warn(`[backfill-persons] alias ${a.alias} for user ${u.id} failed:`, err?.message);
      }
    }

    totalPersons += userPersons;
    totalFacets += userFacets;
    console.log(`[backfill-persons] user ${u.id} (${u.email}): ${userPersons} persons, ${userFacets} facets`);
  }

  console.log(`[backfill-persons] done. totals: ${totalPersons} persons, ${totalFacets} facets across ${activeUsers.length} users`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[backfill-persons] fatal:', e);
  process.exit(1);
});
