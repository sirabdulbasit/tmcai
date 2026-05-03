/**
 * MyOS — FACL Folder Scribe.
 *
 * The tenant (client) designates a folder in Google Drive (or OneDrive)
 * called "FACL" that holds the organisation's curated knowledge —
 * SOPs, playbooks, org charts, deal memos, policies. Brain reads these
 * into `wiki_pages` with `pageType='org_doc'` so the triage layer can
 * reference them when forming suggestions.
 *
 * Trigger points:
 *   1. Admin/user configures the folder on the Drive connector →
 *      first full scribe kicks off in the background.
 *   2. A daily scheduler (runs from server.ts) walks every user who
 *      has `faclFolderId` set and re-scribes to catch new/updated docs.
 *
 * Scope for POC: Google Drive only. OneDrive follows the same pattern
 * but through Microsoft Graph; can be added without changing the Wiki
 * storage layer.
 *
 * Cost guardrails:
 *   - Max 100 files per scribe run (configurable).
 *   - Only text-extractable types: Google Docs/Sheets/Slides, plain
 *     text, markdown, PDF (via Drive's text export).
 *   - LLM summary per doc is capped at 300 words; skipped if the doc
 *     content hasn't changed since last scribe (md5 of text).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import crypto from 'crypto';

const log = createLogger('folder-scribe');

export interface FolderScribeSummary {
  clientNumber: string;
  /** The user whose Google OAuth credentials were used to read the folder.
   *  Wiki pages are stored tenant-scoped (readable by every user in the
   *  tenant), but the DB row carries this admin's userId for audit. */
  scribedAs: number;
  folderId: string;
  scanned: number;
  updated: number;
  unchanged: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

/** Find an admin/super-admin in the tenant with an active Google OAuth
 *  connection. This is the user whose credentials will read the FACL
 *  folder on behalf of the whole tenant. */
async function pickTenantScribeUser(clientNumber: string): Promise<number | null> {
  const admin = await prisma.user.findFirst({
    where: {
      clientNumber,
      isActive: true,
      userType: { in: ['SA', 'AD'] } as any,
      integrationProvider: 'google',
      integrationStatus: 'active',
    } as any,
    select: { id: true },
    orderBy: { userType: 'asc' }, // SA before AD
  }).catch(() => null);
  if (admin) return admin.id;
  // Fallback: any active user in the tenant with a Google connector
  const anyGoogleUser = await prisma.user.findFirst({
    where: {
      clientNumber, isActive: true,
      integrationProvider: 'google', integrationStatus: 'active',
    } as any,
    select: { id: true },
  }).catch(() => null);
  return anyGoogleUser?.id ?? null;
}

const MAX_FILES = 100;
const MAX_TEXT_CHARS = 15_000;

const TEXT_EXTRACTABLE_MIMES = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  'text/plain', 'text/markdown', 'text/csv',
  'application/pdf',
]);

const TABULAR_MIMES = new Set([
  'application/vnd.google-apps.spreadsheet',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function isTabularMime(mime: string | undefined | null): boolean {
  return TABULAR_MIMES.has(String(mime ?? ''));
}

/**
 * Parse a CSV body and compute count-by-value for each categorical
 * column (non-numeric, cardinality 2..50). Emit a markdown block so
 * aggregation questions ("how many employees by GL") can be answered
 * from pre-computed facts instead of LLM row-counting (which
 * hallucinates over 500+ rows).
 *
 * Scope-bounded: skip if text isn't recognisable as CSV, or if the
 * detected header row has fewer than 2 columns.
 */
function computeTabularAggregates(csvText: string): string {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 3) return '';

  const header = splitCsvLine(lines[0]);
  if (header.length < 2) return '';

  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    rows.push(cells);
  }
  if (rows.length < 5) return '';

  const out: string[] = [];
  out.push('## Computed aggregates');
  out.push(`_Deterministic counts computed at scribe time from ${rows.length} data rows. Use these for "how many X by Y" questions — they are exact._`);
  out.push('');
  out.push(`**Total rows:** ${rows.length}`);
  out.push('');

  let renderedCols = 0;
  for (let c = 0; c < header.length; c++) {
    const colName = (header[c] ?? '').trim();
    if (!colName) continue;
    const values = rows.map((r) => (r[c] ?? '').trim()).filter(Boolean);
    if (values.length < 5) continue;
    // Skip numeric columns (amounts, dates, IDs) — not useful as categoricals.
    const numericRatio = values.filter((v) => /^-?\d+(\.\d+)?$/.test(v.replace(/,/g, ''))).length / values.length;
    if (numericRatio > 0.6) continue;
    // Skip free-text columns (email addresses, long notes) — cardinality too high.
    const unique = new Set(values);
    if (unique.size < 2 || unique.size > Math.min(50, values.length / 3)) continue;

    const counts: Record<string, number> = {};
    for (const v of values) counts[v] = (counts[v] ?? 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    out.push(`### Count by ${colName}`);
    out.push(sorted.map(([k, n]) => `- ${k}: ${n}`).join('\n'));
    out.push('');
    renderedCols += 1;
    if (renderedCols >= 6) break;  // cap the block size
  }

  return renderedCols > 0 ? out.join('\n') : '';
}

/** Minimal CSV line splitter that handles quoted fields + embedded commas. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Tenant-level FACL scribe. Uses the tenant admin's Google credentials
 * to read the designated folder and stores each doc as a tenant-scoped
 * org_doc wiki page readable by every user in the tenant.
 */
/**
 * Tenant-scoped scribe. Reads the FACL folder ID from system_config
 * (`google_drive_folder_id`) so tenants can set it once via Admin /
 * Client Config and every user in the tenant shares one knowledge base.
 */
export async function scribeFaclForTenant(
  clientNumber: string,
  explicitFolderId?: string,
): Promise<FolderScribeSummary> {
  const t0 = Date.now();
  // Resolve folder ID: explicit arg wins, otherwise pull from system_config
  let folderId = explicitFolderId;
  if (!folderId) {
    const cfg = await prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: 'google_drive_folder_id' } },
    }).catch(() => null);
    folderId = cfg?.value ?? '';
  }
  const scribedAs = await pickTenantScribeUser(clientNumber);
  const summary: FolderScribeSummary = {
    clientNumber, scribedAs: scribedAs ?? 0, folderId: folderId || '',
    scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, durationMs: 0,
  };
  if (!folderId) {
    log.warn('no FACL folder configured for tenant', { clientNumber });
    return { ...summary, durationMs: Date.now() - t0 };
  }
  if (!scribedAs) {
    log.warn('no admin with Google auth in tenant — cannot scribe FACL', { clientNumber });
    return { ...summary, durationMs: Date.now() - t0 };
  }

  return await scribeFaclFolder(clientNumber, scribedAs, folderId);
}

export async function scribeFaclFolder(
  clientNumber: string,
  userId: number,
  folderId: string,
): Promise<FolderScribeSummary> {
  const t0 = Date.now();
  const summary: FolderScribeSummary = {
    clientNumber, scribedAs: userId, folderId,
    scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, durationMs: 0,
  };

  const { google } = await import('googleapis');
  const { getAuthenticatedClient } = await import('../integrationService');
  const auth = await getAuthenticatedClient(userId);
  if (!auth?.client) {
    log.warn('no Google auth for FACL scribe', { userId });
    return { ...summary, durationMs: Date.now() - t0 };
  }
  const drive = google.drive({ version: 'v3', auth: auth.client });

  // List files in the folder — recurse one level into sub-folders to catch
  // simple "FACL/SOPs" layouts without a full tree walk.
  const files: any[] = [];
  let pageToken: string | undefined;
  while (files.length < MAX_FILES) {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size)',
      pageSize: 50,
      ...(pageToken ? { pageToken } : {}),
    }).catch((e: any) => { log.warn('drive list failed', { folderId, error: e.message }); return null; });
    if (!r?.data?.files?.length) break;
    for (const f of r.data.files) files.push(f);
    if (!r.data.nextPageToken) break;
    pageToken = r.data.nextPageToken;
  }

  // Recurse into sub-folders (one level deep) — common for FACL/{SOPs,Deals,…}
  const subFolders = files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder').slice(0, 10);
  for (const sf of subFolders) {
    const r = await drive.files.list({
      q: `'${sf.id}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType,modifiedTime,size)',
      pageSize: 50,
    }).catch(() => null);
    if (r?.data?.files) {
      for (const f of r.data.files) {
        if (files.length >= MAX_FILES) break;
        files.push({ ...f, _parentName: sf.name });
      }
    }
  }

  summary.scanned = files.length;

  for (const f of files) {
    if (f.mimeType === 'application/vnd.google-apps.folder') continue;
    if (!TEXT_EXTRACTABLE_MIMES.has(f.mimeType)) { summary.skipped += 1; continue; }
    try {
      const text = await exportFileText(drive, f.id, f.mimeType);
      if (!text || text.trim().length < 20) { summary.skipped += 1; continue; }

      const hash = crypto.createHash('md5').update(text).digest('hex');
      const pageTitle = f._parentName ? `${f._parentName}/${f.name}` : f.name;

      const existing = await prisma.wikiPage.findFirst({
        where: { clientNumber, userId, pageType: 'org_doc', title: pageTitle } as any,
        select: { id: true, metadata: true },
      }).catch(() => null);

      const prevMeta: any = existing?.metadata ?? {};
      if (prevMeta.contentHash === hash) { summary.unchanged += 1; continue; }

      // New or changed — build the wiki page body from BOTH an LLM summary
      // (for quick context) AND the raw doc text (so Brain can answer
      // row-level questions: "what's the TMC Exec Sponsor for PSO?").
      // Storing only the summary drops the data; storing only the raw
      // text hides the gist. We keep both.
      //
      // No storage cap — Postgres TEXT handles GBs. The embedding layer
      // bounds itself (~6K chars), and the composer uses semantic chunking
      // to pick relevant regions of long docs. Storing the full body
      // makes it the source of truth regardless of query.
      const fullText = text;
      const truncated = false;

      let summaryMd: string | null = null;
      try {
        const { callLLM } = await import('../llmRouter');
        const sys = `You write concise summaries of organisational knowledge docs for an AI assistant. 3-6 bullet points, <180 words total. Lead with the DOC'S PURPOSE (one line). Then bullets: key policies, named people, named projects, dates, and anything actionable. Never invent facts. Plain markdown.`;
        const usr = `Doc title: ${pageTitle}\nModified: ${f.modifiedTime}\n\n${text.slice(0, MAX_TEXT_CHARS)}`;
        const r = await callLLM(sys, usr, { maxTokens: 320, userId, clientNumber, purpose: 'facl_scribe' });
        const s = r.text.trim();
        if (s.length > 20) summaryMd = s;
      } catch {
        // LLM unavailable — not fatal. Raw text below still makes the page useful.
        summaryMd = null;
      }

      // For tabular docs (CSV / XLSX / Google Sheets), compute deterministic
      // aggregates — count by each categorical column — so aggregation
      // questions ("how many by GL") get answered from pre-computed facts,
      // not LLM row-counting (which hallucinates on 500+ rows).
      const aggregatesBlock = isTabularMime(f.mimeType) ? computeTabularAggregates(fullText) : '';

      const bodyParts = [
        `# ${pageTitle}`,
        '',
        `**Source:** Google Drive (FACL folder)`,
        `**Modified:** ${f.modifiedTime}`,
        `**File ID:** \`${f.id}\``,
        '',
      ];
      if (summaryMd) {
        bodyParts.push('## Summary', summaryMd, '');
      }
      if (aggregatesBlock) {
        bodyParts.push(aggregatesBlock, '');
      }
      bodyParts.push('## Full content', fullText);
      if (truncated) bodyParts.push('', `*[…truncated at ${text.length.toLocaleString()} chars]*`);
      const body = bodyParts.join('\n');

      const nextMeta = {
        folderId,
        driveFileId: f.id,
        mimeType: f.mimeType,
        modifiedTime: f.modifiedTime,
        contentHash: hash,
        lastScribedAt: new Date().toISOString(),
        scope: 'tenant', // readable by every user in the tenant
      };

      let scribePageId: string;
      if (existing) {
        await prisma.wikiPage.update({
          where: { id: existing.id },
          data: { bodyMarkdown: body, metadata: nextMeta as any, lastUpdatedBy: 'facl_scribe', lastUpdatedAt: new Date(), status: 'active' },
        });
        scribePageId = existing.id;
      } else {
        const created = await prisma.wikiPage.create({
          data: {
            clientNumber, userId, pageType: 'org_doc', title: pageTitle,
            storage: 'postgres', bodyMarkdown: body, metadata: nextMeta as any,
            lastUpdatedBy: 'facl_scribe', status: 'active',
          } as any,
        });
        scribePageId = created.id;
      }
      // Embed each FACL doc for semantic retrieval. Tenant-scope, so
      // every user in the tenant can find it.
      void (async () => {
        try {
          const { embedWikiPage } = await import('./wikiEmbeddingService');
          await embedWikiPage(scribePageId);
        } catch { /* best effort */ }
      })();
      summary.updated += 1;
    } catch (err: any) {
      summary.errors += 1;
      log.warn('file scribe failed', { file: f.name, error: err.message });
    }
  }

  summary.durationMs = Date.now() - t0;
  log.info('FACL scribe complete', summary as any);
  return summary;
}

/** Extract plain text from a Drive file using the right export format. */
async function exportFileText(drive: any, fileId: string, mimeType: string): Promise<string> {
  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      const r = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
      return typeof r.data === 'string' ? r.data : String(r.data ?? '');
    }
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const r = await drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' });
      return typeof r.data === 'string' ? r.data : String(r.data ?? '');
    }
    if (mimeType === 'application/vnd.google-apps.presentation') {
      const r = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
      return typeof r.data === 'string' ? r.data : String(r.data ?? '');
    }
    if (mimeType.startsWith('text/')) {
      const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      return typeof r.data === 'string' ? r.data : String(r.data ?? '');
    }
    if (mimeType === 'application/pdf') {
      // Drive doesn't export PDFs to text directly; skip for POC.
      return '';
    }
  } catch { /* fall through */ }
  return '';
}

/** Walk every tenant with a google_drive_folder_id configured in
 *  system_config and re-scribe using that tenant's admin Google OAuth. */
export async function runDailyFaclScribe(): Promise<Array<FolderScribeSummary>> {
  const targets = await prisma.systemConfig.findMany({
    where: { key: 'google_drive_folder_id', value: { not: '' } } as any,
    select: { clientNumber: true, value: true },
  }).catch(() => [] as any[]);

  const out: FolderScribeSummary[] = [];
  for (const t of targets) {
    try {
      const s = await scribeFaclForTenant(t.clientNumber, t.value);
      out.push(s);
    } catch (err: any) {
      log.warn('daily tenant FACL scribe failed', { clientNumber: t.clientNumber, error: err.message });
    }
  }
  return out;
}
