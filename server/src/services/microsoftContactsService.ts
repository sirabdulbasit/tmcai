/**
 * Microsoft Graph Contacts import.
 *
 * Pulls the user's Outlook contacts (`/me/contacts`) and upserts each
 * as an entity_person wiki page. Mirrors the Google Contacts pattern —
 * stable id `person:<email>` deduplicates across sources, so a contact
 * imported here today and emailed tomorrow merges into one canonical
 * row, not two.
 *
 * Reuses the existing `msGraphHelper` for OAuth + token refresh. Every
 * tenant user with a connected `outlook` connector can import.
 */
import { graphGet } from './adapters/impl/msGraphHelper';

export interface MicrosoftSyncResult {
  scanned: number;
  imported: number;
  skipped: number;
  errors: number;
  error?: string;
}

interface GraphContact {
  id: string;
  displayName?: string;
  emailAddresses?: Array<{ name?: string; address: string }>;
  mobilePhone?: string | null;
  businessPhones?: string[];
  jobTitle?: string | null;
  companyName?: string | null;
}

interface GraphContactsResponse {
  value: GraphContact[];
  '@odata.nextLink'?: string;
}

export async function syncAllContactsFromMicrosoft(
  clientNumber: string,
  userId: number,
): Promise<MicrosoftSyncResult> {
  const result: MicrosoftSyncResult = { scanned: 0, imported: 0, skipped: 0, errors: 0 };

  let url: string | null = '/me/contacts?$top=200&$select=id,displayName,emailAddresses,mobilePhone,businessPhones,jobTitle,companyName';
  const collected = new Map<string, { email: string; name: string; phone: string | null; org: string | null; role: string | null; sourceId: string }>();

  while (url) {
    const page: GraphContactsResponse | null = await graphGet<GraphContactsResponse>(userId, 'outlook', url).catch(() => null);
    if (!page) {
      result.errors += 1;
      if (!result.error) result.error = 'Graph contacts request failed (token expired or no permission)';
      break;
    }
    for (const c of page.value ?? []) {
      const primary = (c.emailAddresses ?? []).find((e) => e.address?.includes('@'));
      const email = (primary?.address ?? '').trim().toLowerCase();
      if (!email) continue;
      if (collected.has(email)) continue;
      collected.set(email, {
        email,
        name: c.displayName || primary?.name || email,
        phone: c.mobilePhone || c.businessPhones?.[0] || null,
        org: c.companyName ?? null,
        role: c.jobTitle ?? null,
        sourceId: c.id,
      });
    }
    // Graph returns absolute @odata.nextLink — strip the prefix so
    // graphGet can append to its base URL. The helper handles either
    // style, but stripping keeps logs readable.
    const next: string | undefined = page['@odata.nextLink'];
    url = next ? next.replace(/^https?:\/\/graph\.microsoft\.com\/v1\.0/, '') : null;
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
      await stampImportMetadata(ensured.id, {
        imported_from: 'microsoft_contacts',
        imported_at: new Date().toISOString(),
        ms_contact_id: c.sourceId,
        role: c.role,
        organization: c.org,
      });
      result.imported += 1;
      enrichEntityPage(clientNumber, ensured.id).catch(() => {});
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

async function stampImportMetadata(entityPageId: string, patch: Record<string, unknown>): Promise<void> {
  const { default: prisma } = await import('../db/prisma');
  await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
      WHERE id = $2`,
    JSON.stringify(patch), entityPageId,
  ).catch(() => {});
}
