/**
 * obsidianVaultService — the user's brain, mirrored into THEIR Google
 * Drive as an Obsidian vault (Phase 1: export, 2026-07-14).
 *
 * SaaS trust model (per Basit): "a person has trust on his own GDrive."
 * The vault lives in the CUSTOMER's Drive — storage they already own
 * and already granted Nexeo at onboarding. No third party enters the
 * knowledge path; the customer can read/keep/export their vault as
 * plain markdown forever (no lock-in). Nexeo writes with drive.file
 * scope — it can only touch files it created (the vault), nothing
 * else in the Drive.
 *
 * Layout in Drive ("Nexeo Vault/"):
 *   Contacts/<Name>.md         — frontmatter: email/phone/alt*, company
 *   <PageTypeFolder>/<Title>.md — wiki pages (topics, decisions,
 *                                 observations, instructions, …)
 *
 * Loop-protection groundwork for Phase 2 (Obsidian → Nexeo): every
 * file we write carries appProperties { nexeoId, nexeoHash }. A later
 * ingest pass treats a file whose content hash ≠ nexeoHash as a USER
 * edit; files matching their nexeoHash are our own exports and are
 * never re-ingested.
 *
 * Export is incremental: unchanged content (hash match) is skipped —
 * steady-state runs cost a folder listing and nothing else.
 */
import crypto from 'crypto';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('obsidian-vault');

export const VAULT_FOLDER_NAME = 'Nexeo Vault';

/** Wiki page types worth mirroring; internal machinery types stay out. */
export const EXPORTED_PAGE_TYPES: Record<string, string> = {
  topic: 'Topics',
  decision: 'Decisions',
  observation: 'Observations',
  instruction: 'Instructions',
  pattern: 'Patterns',
  meeting_minutes: 'Meetings',
  mind_state: 'Mind State',
  org_doc: 'Org Docs',
};

export function contentHash(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 32);
}

/** Obsidian-safe filename: no path separators or Drive-hostile chars. */
export function safeFileName(title: string): string {
  const cleaned = (title ?? '').replace(/[\/\\:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Untitled').slice(0, 120);
}

function yamlEscape(v: string): string {
  // Quote when YAML could mis-type it: special chars anywhere, or a
  // leading +/digit/- (phone numbers must stay strings, not parse as
  // numeric-ish scalars).
  return /[:#\[\]{}"'\n]|^[+\-\d]/.test(v) ? JSON.stringify(v) : v;
}

export interface ContactForVault {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  metadata: Record<string, unknown> | null;
}

/** Contact → person note. Frontmatter is the structured truth;
 *  the body is a human-readable card. */
export function renderContactMd(c: ContactForVault): string {
  const meta = (c.metadata as Record<string, any>) ?? {};
  const altEmails: string[] = Array.isArray(meta.altEmails) ? meta.altEmails : [];
  const altPhones: string[] = Array.isArray(meta.altPhones) ? meta.altPhones : [];
  const fm: string[] = ['---', 'type: contact', `nexeo-id: ${c.id}`];
  if (c.email) fm.push(`email: ${yamlEscape(c.email)}`);
  if (c.phone) fm.push(`phone: ${yamlEscape(c.phone)}`);
  if (altEmails.length) fm.push(`alt-emails: [${altEmails.map((e) => yamlEscape(String(e))).join(', ')}]`);
  if (altPhones.length) fm.push(`alt-phones: [${altPhones.map((p) => yamlEscape(String(p))).join(', ')}]`);
  if (c.company) fm.push(`company: ${yamlEscape(c.company)}`);
  fm.push('---');
  const lines = [
    fm.join('\n'),
    '',
    `# ${c.name ?? c.email ?? 'Unknown'}`,
    '',
    ...(c.email ? [`- Email: ${c.email}`] : []),
    ...(c.phone ? [`- Phone: ${c.phone}`] : []),
    ...(altEmails.length ? [`- Also: ${altEmails.join(', ')}`] : []),
    ...(c.company ? [`- Company: ${c.company}`] : []),
  ];
  return lines.join('\n');
}

export interface WikiPageForVault {
  id: string;
  pageType: string;
  title: string;
  bodyMarkdown: string | null;
  lastUpdatedAt: Date | null;
}

/** Wiki page → note. Body is already markdown; we add frontmatter. */
export function renderWikiPageMd(p: WikiPageForVault): string {
  const fm = [
    '---',
    `type: ${p.pageType}`,
    `nexeo-id: ${p.id}`,
    ...(p.lastUpdatedAt ? [`updated: ${p.lastUpdatedAt.toISOString().slice(0, 10)}`] : []),
    '---',
    '',
  ].join('\n');
  return `${fm}${(p.bodyMarkdown ?? '').trim()}\n`;
}

// ─── Drive plumbing (thin; per-user OAuth via integrationService) ───

async function driveFor(userId: number): Promise<any | null> {
  const { getAuthenticatedClient } = await import('../integrationService');
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || error) return null;
  const { google } = await import('googleapis');
  return google.drive({ version: 'v3', auth: client });
}

async function ensureFolder(drive: any, name: string, parentId?: string): Promise<string | null> {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    `mimeType = 'application/vnd.google-apps.folder'`,
    'trashed = false',
    ...(parentId ? [`'${parentId}' in parents`] : []),
  ].join(' and ');
  const found = await drive.files.list({ q, fields: 'files(id)', pageSize: 1 }).catch(() => null);
  const existing = found?.data?.files?.[0]?.id;
  if (existing) return existing;
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    },
    fields: 'id',
  }).catch((e: any) => { log.warn('folder create failed', { name, error: e?.message }); return null; });
  return created?.data?.id ?? null;
}

/** Upsert one vault file. Skips when the stored nexeoHash matches. */
async function upsertVaultFile(
  drive: any,
  folderId: string,
  fileName: string,
  nexeoId: string,
  content: string,
): Promise<'created' | 'updated' | 'skipped' | 'failed'> {
  const hash = contentHash(content);
  const found = await drive.files.list({
    q: `appProperties has { key='nexeoId' and value='${nexeoId}' } and trashed = false`,
    fields: 'files(id, appProperties)',
    pageSize: 1,
  }).catch(() => null);
  const existing = found?.data?.files?.[0];
  if (existing && existing.appProperties?.nexeoHash === hash) return 'skipped';
  try {
    if (existing) {
      await drive.files.update({
        fileId: existing.id,
        requestBody: { name: `${fileName}.md`, appProperties: { nexeoId, nexeoHash: hash } },
        media: { mimeType: 'text/markdown', body: content },
      });
      return 'updated';
    }
    await drive.files.create({
      requestBody: {
        name: `${fileName}.md`,
        parents: [folderId],
        appProperties: { nexeoId, nexeoHash: hash },
      },
      media: { mimeType: 'text/markdown', body: content },
      fields: 'id',
    });
    return 'created';
  } catch (e: any) {
    log.warn('vault file upsert failed', { fileName, error: e?.message });
    return 'failed';
  }
}

// ─── Export pass ────────────────────────────────────────────────────

export interface VaultExportResult {
  ok: boolean;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  reason?: string;
}

export async function exportVaultForUser(clientNumber: string, userId: number): Promise<VaultExportResult> {
  const out: VaultExportResult = { ok: false, created: 0, updated: 0, skipped: 0, failed: 0 };
  const drive = await driveFor(userId);
  if (!drive) { out.reason = 'no_drive_client'; return out; }

  const rootId = await ensureFolder(drive, VAULT_FOLDER_NAME);
  if (!rootId) {
    // Most likely the user hasn't re-consented to drive.file yet —
    // export silently waits rather than erroring their world.
    out.reason = 'no_vault_folder (drive.file scope not granted yet?)';
    return out;
  }

  const bump = (r: 'created' | 'updated' | 'skipped' | 'failed') => { out[r] += 1; };

  // Contacts — user-visible set (same scope filter as candidateResolver).
  const contactsFolder = await ensureFolder(drive, 'Contacts', rootId);
  if (contactsFolder) {
    const contacts = await prisma.entity.findMany({
      where: {
        clientNumber, entityType: 'contact',
        OR: [
          { scope: 'tenant' as any },
          { ownerUserId: userId } as any,
          { AND: [{ ownerUserId: null } as any, { createdBy: userId }] },
        ],
      } as any,
      select: { id: true, name: true, email: true, phone: true, company: true, metadata: true },
      take: 500,
    }).catch(() => [] as any[]);
    for (const c of contacts as ContactForVault[]) {
      bump(await upsertVaultFile(drive, contactsFolder, safeFileName(c.name ?? c.email ?? c.id), `contact:${c.id}`, renderContactMd(c)));
    }
  }

  // Wiki pages — active, exported types, user-visible scope.
  const pages = await prisma.wikiPage.findMany({
    where: {
      clientNumber,
      status: 'active',
      pageType: { in: Object.keys(EXPORTED_PAGE_TYPES) },
      OR: [{ scope: 'tenant' }, { userId }],
    } as any,
    select: { id: true, pageType: true, title: true, bodyMarkdown: true, lastUpdatedAt: true },
    take: 1000,
  }).catch(() => [] as any[]);
  const folderCache = new Map<string, string | null>();
  for (const p of pages as WikiPageForVault[]) {
    const folderName = EXPORTED_PAGE_TYPES[p.pageType] ?? 'Notes';
    if (!folderCache.has(folderName)) folderCache.set(folderName, await ensureFolder(drive, folderName, rootId));
    const folderId = folderCache.get(folderName);
    if (!folderId) { bump('failed'); continue; }
    bump(await upsertVaultFile(drive, folderId, safeFileName(p.title), `page:${p.id}`, renderWikiPageMd(p)));
  }

  out.ok = true;
  if (out.created + out.updated > 0) log.info('vault export', { clientNumber, userId, ...out });
  return out;
}

/** Hourly sweep across active users with a Google connection. */
export async function exportVaultForAllUsers(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { isActive: true, integrationProvider: 'google' } as any,
    select: { id: true, clientNumber: true },
  }).catch(() => [] as Array<{ id: number; clientNumber: string }>);
  for (const u of users) {
    await exportVaultForUser(u.clientNumber, u.id).catch((e) => log.warn('vault export failed', { userId: u.id, error: e?.message }));
  }
}
