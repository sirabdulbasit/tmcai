/**
 * Google Contacts (People API) search — for the delegatee picker.
 *
 * MyOS-level search against the user's Google address book. Covers
 * colleagues the MD has emailed even if they aren't registered MyOS users
 * and never appeared as scribed external contacts (internal-domain senders
 * are deliberately skipped by the scribe).
 *
 * Uses `otherContacts:search` (auto-saved contacts from Gmail) + falls
 * back to `people:searchDirectoryPeople` (Google Workspace directory).
 * Requires the `contacts.readonly` OAuth scope — already part of the
 * scope set we grant at connect time.
 */
import { google } from 'googleapis';
import { getAuthenticatedClient } from './integrationService';

export interface GoogleContact {
  name: string;
  email: string;
  organization?: string;
  role?: string;
  source: 'other_contacts' | 'directory' | 'contacts';
}

export async function searchGoogleContacts(
  userId: number,
  query: string,
  limit = 10,
): Promise<{ contacts: GoogleContact[]; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { contacts: [], error };
  const q = query.trim();
  if (q.length < 2) return { contacts: [] };

  const people = google.people({ version: 'v1', auth: client });
  const results: GoogleContact[] = [];

  try {
    // 1. Search "other contacts" — people you've emailed but haven't saved
    const other = await people.otherContacts.search({
      query: q,
      pageSize: limit,
      readMask: 'emailAddresses,names,organizations',
    }).catch(() => null);

    for (const r of other?.data.results ?? []) {
      const p = r.person;
      const email = p?.emailAddresses?.[0]?.value;
      const name = p?.names?.[0]?.displayName ?? email ?? '';
      if (!email) continue;
      results.push({
        name, email,
        organization: p?.organizations?.[0]?.name ?? undefined,
        role: p?.organizations?.[0]?.title ?? undefined,
        source: 'other_contacts',
      });
    }

    // 2. Search saved contacts (the user's address book proper)
    const saved = await people.people.searchContacts({
      query: q,
      pageSize: limit,
      readMask: 'emailAddresses,names,organizations',
    }).catch(() => null);

    for (const r of saved?.data.results ?? []) {
      const p = r.person;
      const email = p?.emailAddresses?.[0]?.value;
      if (!email) continue;
      // Dedupe
      if (results.some((x) => x.email.toLowerCase() === email.toLowerCase())) continue;
      const name = p?.names?.[0]?.displayName ?? email ?? '';
      results.push({
        name, email,
        organization: p?.organizations?.[0]?.name ?? undefined,
        role: p?.organizations?.[0]?.title ?? undefined,
        source: 'contacts',
      });
    }

    // 3. Workspace directory (only works if the user is on Google Workspace)
    try {
      const dir = await people.people.searchDirectoryPeople({
        query: q,
        pageSize: limit,
        readMask: 'emailAddresses,names,organizations',
        sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT', 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
      });
      for (const p of dir.data.people ?? []) {
        const email = p.emailAddresses?.[0]?.value;
        if (!email) continue;
        if (results.some((x) => x.email.toLowerCase() === email.toLowerCase())) continue;
        const name = p.names?.[0]?.displayName ?? email;
        results.push({
          name, email,
          organization: p.organizations?.[0]?.name ?? undefined,
          role: p.organizations?.[0]?.title ?? undefined,
          source: 'directory',
        });
      }
    } catch {
      /* personal Gmail accounts don't have directory API — silently skip */
    }
  } catch (err: any) {
    return { contacts: results, error: `People API error: ${err.message}` };
  }

  return { contacts: results.slice(0, limit) };
}

// ─── Full sync: import all contacts as entity_person pages ──────────
//
// Used by the contacts catalog "Import from Google" flow. Pages through
// the user's saved contacts (people.connections.list) AND the auto-saved
// "other contacts" (otherContacts.list). For each, upserts an
// entity_person wiki page tagged `imported_from='google_contacts'`. If
// the contact has already been auto-discovered from the feed, the
// stable id collides and we just update metadata in place — no
// duplicates.

export interface GoogleSyncResult {
  scanned: number;
  imported: number;
  skipped: number;
  errors: number;
  error?: string;
}

interface ListedContact {
  email: string;
  name: string;
  phone: string | null;
  organization: string | null;
  role: string | null;
  source: 'saved' | 'other';
}

export async function syncAllContactsFromGoogle(
  clientNumber: string,
  userId: number,
): Promise<GoogleSyncResult> {
  const result: GoogleSyncResult = { scanned: 0, imported: 0, skipped: 0, errors: 0 };
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { ...result, error: error ?? 'no Google integration for this user' };

  const people = google.people({ version: 'v1', auth: client });
  const collected = new Map<string, ListedContact>();

  try {
    // 1) Saved contacts — paginate via people.connections.list
    let pageToken: string | undefined;
    do {
      const r = await people.people.connections.list({
        resourceName: 'people/me',
        pageSize: 1000,
        pageToken,
        personFields: 'emailAddresses,names,phoneNumbers,organizations',
      });
      for (const p of r.data.connections ?? []) {
        for (const ec of (p.emailAddresses ?? [])) {
          const email = (ec.value ?? '').trim().toLowerCase();
          if (!email) continue;
          collected.set(email, {
            email,
            name: p.names?.[0]?.displayName ?? email,
            phone: p.phoneNumbers?.[0]?.value ?? null,
            organization: p.organizations?.[0]?.name ?? null,
            role: p.organizations?.[0]?.title ?? null,
            source: 'saved',
          });
        }
      }
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: any) {
    // 403 = user hasn't granted contacts.readonly. Surface error but
    // continue (other_contacts may still work; in practice it usually
    // requires the same scope, but we try anyway).
    result.errors += 1;
    result.error = `saved contacts: ${err.message}`;
  }

  try {
    // 2) Other contacts — auto-saved (people you've emailed)
    let pageToken: string | undefined;
    do {
      const r = await people.otherContacts.list({
        pageSize: 1000,
        pageToken,
        readMask: 'emailAddresses,names,phoneNumbers',
      });
      for (const p of r.data.otherContacts ?? []) {
        for (const ec of (p.emailAddresses ?? [])) {
          const email = (ec.value ?? '').trim().toLowerCase();
          if (!email || collected.has(email)) continue; // saved wins on dup
          collected.set(email, {
            email,
            name: p.names?.[0]?.displayName ?? email,
            phone: p.phoneNumbers?.[0]?.value ?? null,
            organization: null,
            role: null,
            source: 'other',
          });
        }
      }
      pageToken = r.data.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err: any) {
    result.errors += 1;
    if (!result.error) result.error = `other contacts: ${err.message}`;
  }

  // Upsert each into entity_person.
  const { ensureEntityForSender, enrichEntityPage } = await import('./knowledge/entitySweepService');
  for (const c of collected.values()) {
    result.scanned += 1;
    try {
      const ensured = await ensureEntityForSender({
        clientNumber, userId,
        senderEmail: c.email,
        senderName: c.name,
        senderPhone: c.phone,
      });
      if (!ensured) { result.skipped += 1; continue; }

      // Stamp metadata.imported_from + role/org so the source pill +
      // detail page render correctly even before the nightly sweep
      // re-enriches.
      await stampImportMetadata(ensured.id, {
        imported_from: 'google_contacts',
        imported_at: new Date().toISOString(),
        google_source: c.source,
        role: c.role,
        organization: c.organization,
      });

      result.imported += 1;
      // Light enrich is fire-and-forget — pulls in feed signals if any.
      enrichEntityPage(clientNumber, ensured.id).catch(() => {});
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

async function stampImportMetadata(entityPageId: string, patch: Record<string, unknown>): Promise<void> {
  // Direct merge on metadata JSONB — preserves any prior fields
  // (user_stars, signature, scope, etc.) and only writes the new keys.
  const { default: prisma } = await import('../db/prisma');
  await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    JSON.stringify(patch), entityPageId,
  ).catch(() => {});
}
