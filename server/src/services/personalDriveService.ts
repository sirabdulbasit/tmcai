// ═════════════════════════════════════════════════════════════════════════════
// personalDriveService.ts — Phase 3.1: Personal GDrive folder connector
//
// Each user can configure their own GDrive folder. Only they can search it.
// Admin queries NEVER include personal_drive rows.
// Sync runs on demand and on a 30-min cron job.
// ═════════════════════════════════════════════════════════════════════════════

import { google } from 'googleapis';
import crypto from 'crypto';
import prisma from '../db/prisma';
import { getAuthenticatedClient } from './integrationService';
import { embedBatch } from '../pipeline/embedder';
import { isFeatureEnabled } from './featureFlagService';
import createLogger from '../utils/logger';

const log = createLogger('personalDrive');

// Supported MIME types for text extraction
const SUPPORTED_MIME_TYPES = new Set([
  'application/vnd.google-apps.document',           // Google Docs
  'application/vnd.google-apps.spreadsheet',        // Google Sheets
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',       // .xlsx
]);

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB per file
const CHUNK_SIZE_CHARS = 1500;
const CHUNK_OVERLAP_CHARS = 200;

// ─── Folder Management ────────────────────────────────────────────────────────

export async function setUserFolder(userId: number, folderId: string): Promise<{ success: boolean; folderName?: string; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { success: false, error };

  try {
    const drive = google.drive({ version: 'v3', auth: client });
    // Verify the folder exists and user has access
    const folder = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,mimeType',
    });

    if (folder.data.mimeType !== 'application/vnd.google-apps.folder') {
      return { success: false, error: 'Selected item is not a folder' };
    }

    // Save folder ID to user record
    await prisma.$executeRawUnsafe(
      'UPDATE users SET personal_drive_folder_id = $1, updated_at = NOW() WHERE id = $2',
      folderId, userId,
    );

    log.info('Personal drive folder set', { userId, folderId, folderName: folder.data.name });
    return { success: true, folderName: folder.data.name || undefined };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

export async function getUserFolderStatus(userId: number): Promise<{
  configured: boolean;
  folderId?: string;
  lastSync?: Date;
  documentCount?: number;
  chunkCount?: number;
}> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT personal_drive_folder_id, personal_drive_last_sync FROM users WHERE id = $1',
    userId,
  );

  if (!rows.length || !rows[0].personal_drive_folder_id) {
    return { configured: false };
  }

  const [docCount, chunkCount]: any[] = await Promise.all([
    prisma.$queryRawUnsafe('SELECT COUNT(*) as cnt FROM personal_documents WHERE user_id = $1 AND source = $2', userId, 'gdrive'),
    prisma.$queryRawUnsafe('SELECT COUNT(*) as cnt FROM personal_chunks WHERE user_id = $1', userId),
  ]);

  return {
    configured: true,
    folderId: rows[0].personal_drive_folder_id,
    lastSync: rows[0].personal_drive_last_sync || undefined,
    documentCount: Number(docCount[0]?.cnt || 0),
    chunkCount: Number(chunkCount[0]?.cnt || 0),
  };
}

// ─── Text Extraction ──────────────────────────────────────────────────────────

async function extractText(drive: any, fileId: string, mimeType: string): Promise<string> {
  // Google Docs / Sheets → export as plain text
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export({ fileId, mimeType: 'text/plain' }, { responseType: 'text' });
    return String(res.data || '');
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const res = await drive.files.export({ fileId, mimeType: 'text/csv' }, { responseType: 'text' });
    return String(res.data || '');
  }

  // Binary files → download then parse in-memory
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(res.data as ArrayBuffer);

  if (mimeType === 'text/plain' || mimeType === 'text/csv') {
    return buffer.toString('utf-8');
  }

  if (mimeType === 'application/pdf') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
    const parsed = await pdfParse(buffer);
    return parsed.text || '';
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }

  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      return `--- Sheet: ${name} ---\n` + XLSX.utils.sheet_to_csv(sheet);
    }).join('\n\n');
  }

  return '';
}

// ─── Text Chunking ────────────────────────────────────────────────────────────

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE_CHARS, clean.length);
    chunks.push(clean.slice(start, end).trim());
    start = end - CHUNK_OVERLAP_CHARS;
    if (start < 0) start = 0;
    if (end >= clean.length) break;
  }

  return chunks.filter(c => c.length > 50);
}

// ─── Sync Single File ─────────────────────────────────────────────────────────

async function syncFile(
  userId: number,
  drive: any,
  file: { id: string; name: string; mimeType: string; size: string; md5Checksum?: string; modifiedTime: string },
  folderId: string,
  // E3/E5: owner's tenant, resolved ONCE per sync in syncUserDrive and
  // threaded through so every inserted document/chunk is born tenant-
  // tagged (defense in depth on top of user_id scoping).
  clientNumber: string | null,
): Promise<{ status: 'indexed' | 'skipped' | 'error'; reason?: string }> {
  const fileId = file.id;
  const mimeType = file.mimeType;
  const sizeBytes = parseInt(file.size || '0', 10);

  if (!SUPPORTED_MIME_TYPES.has(mimeType)) return { status: 'skipped', reason: 'unsupported type' };
  if (sizeBytes > MAX_FILE_SIZE_BYTES) return { status: 'skipped', reason: 'file too large' };

  // Check if already indexed with same content
  const existing: any[] = await prisma.$queryRawUnsafe(
    'SELECT id, content_hash FROM personal_documents WHERE user_id = $1 AND external_id = $2',
    userId, fileId,
  );

  const contentHash = file.md5Checksum || crypto.createHash('sha256').update(fileId + (file.modifiedTime || '')).digest('hex');
  if (existing.length > 0 && existing[0].content_hash === contentHash) {
    return { status: 'skipped', reason: 'unchanged' };
  }

  // Mark as processing
  let docId: number;
  if (existing.length > 0) {
    docId = existing[0].id;
    await prisma.$executeRawUnsafe(
      'UPDATE personal_documents SET parse_status = $1, content_hash = $2, updated_at = NOW() WHERE id = $3',
      'processing', contentHash, docId,
    );
    // Delete old chunks
    await prisma.$executeRawUnsafe('DELETE FROM personal_chunks WHERE document_id = $1', docId);
  } else {
    const rows: any[] = await prisma.$queryRawUnsafe(
      `INSERT INTO personal_documents (user_id, source, external_id, folder_id, file_name, mime_type, size_bytes, content_hash, parse_status, client_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      userId, 'gdrive', fileId, folderId, file.name, mimeType, sizeBytes, contentHash, 'processing', clientNumber,
    );
    docId = rows[0].id;
  }

  try {
    const text = await extractText(drive, fileId, mimeType);
    if (!text.trim()) {
      await prisma.$executeRawUnsafe(
        'UPDATE personal_documents SET parse_status = $1, parse_error = $2 WHERE id = $3',
        'error', 'Empty content', docId,
      );
      return { status: 'error', reason: 'empty content' };
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await prisma.$executeRawUnsafe(
        'UPDATE personal_documents SET parse_status = $1 WHERE id = $2',
        'done', docId,
      );
      return { status: 'indexed' };
    }

    const embeddings = await embedBatch(chunks);
    for (let i = 0; i < chunks.length; i++) {
      const chunkHash = crypto.createHash('sha256').update(chunks[i]).digest('hex');
      const embeddingJson = JSON.stringify(embeddings[i] || []);
      // client_number denormalised onto each chunk so the hot retrieval
      // query can filter by tenant WITHOUT joining personal_documents.
      await prisma.$executeRawUnsafe(
        `INSERT INTO personal_chunks (user_id, document_id, content, embedding, chunk_index, content_hash, client_number)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
         ON CONFLICT (content_hash) DO NOTHING`,
        userId, docId, chunks[i], embeddingJson, i, chunkHash, clientNumber,
      );
    }

    await prisma.$executeRawUnsafe(
      'UPDATE personal_documents SET parse_status = $1, parse_error = NULL WHERE id = $2',
      'done', docId,
    );

    return { status: 'indexed' };
  } catch (e: any) {
    await prisma.$executeRawUnsafe(
      'UPDATE personal_documents SET parse_status = $1, parse_error = $2 WHERE id = $3',
      'error', e.message?.slice(0, 500), docId,
    );
    return { status: 'error', reason: e.message };
  }
}

// ─── Main Sync ────────────────────────────────────────────────────────────────

export async function syncUserDrive(userId: number): Promise<{
  indexed: number; skipped: number; errors: number; durationMs: number;
}> {
  const start = Date.now();

  // client_number fetched in the SAME users lookup we already do — this
  // is the owner's tenant, stamped onto every document/chunk written
  // below (E3/E5). users.client_number is the ground truth mapping.
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT personal_drive_folder_id, client_number FROM users WHERE id = $1',
    userId,
  );
  const folderId = rows[0]?.personal_drive_folder_id;
  const clientNumber: string | null = rows[0]?.client_number ?? null;
  if (!folderId) return { indexed: 0, skipped: 0, errors: 0, durationMs: 0 };

  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) {
    log.warn('Sync failed — no auth client', { userId, error });
    return { indexed: 0, skipped: 0, errors: 1, durationMs: Date.now() - start };
  }

  const drive = google.drive({ version: 'v3', auth: client });
  let indexed = 0, skipped = 0, errors = 0;
  let pageToken: string | undefined;

  do {
    const res: any = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum,modifiedTime)',
      pageSize: 100,
      pageToken,
    });

    const files = res.data.files || [];
    for (const file of files) {
      const result = await syncFile(userId, drive, file, folderId, clientNumber);
      if (result.status === 'indexed') indexed++;
      else if (result.status === 'error') errors++;
      else skipped++;
    }

    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  // Update last sync timestamp
  await prisma.$executeRawUnsafe(
    'UPDATE users SET personal_drive_last_sync = NOW() WHERE id = $1',
    userId,
  );

  const durationMs = Date.now() - start;
  log.info('Sync complete', { userId, indexed, skipped, errors, durationMs });
  return { indexed, skipped, errors, durationMs };
}

// ─── Personal Retrieval ───────────────────────────────────────────────────────

export async function searchPersonalChunks(
  userId: number,
  queryEmbedding: number[],
  topK: number = 3,
  // E3/E5 tenant defense-in-depth: the caller's tenant. With it, rows
  // tagged to a DIFFERENT tenant are excluded even if the userId is
  // wrong/stale — user_id alone stops being the last line of defense.
  // NULL-tagged rows (pre-backfill stragglers) still pass so nothing a
  // user indexed before the migration silently disappears. Omitted =
  // legacy user-only scoping, for callers with no tenant context.
  clientNumber?: string | null,
): Promise<Array<{ content: string; fileName: string; score: number }>> {
  // Fetch all personal chunks for this user (in-memory cosine — personal data stays small)
  const chunks: any[] = clientNumber
    ? await prisma.$queryRawUnsafe(
        'SELECT pc.content, pc.embedding, pd.file_name FROM personal_chunks pc JOIN personal_documents pd ON pd.id = pc.document_id WHERE pc.user_id = $1 AND (pc.client_number = $2 OR pc.client_number IS NULL)',
        userId, clientNumber,
      )
    : await prisma.$queryRawUnsafe(
        'SELECT pc.content, pc.embedding, pd.file_name FROM personal_chunks pc JOIN personal_documents pd ON pd.id = pc.document_id WHERE pc.user_id = $1',
        userId,
      );

  if (chunks.length === 0) return [];

  // Cosine similarity
  const scored = chunks.map(c => {
    const emb: number[] = Array.isArray(c.embedding) ? c.embedding : JSON.parse(c.embedding || '[]');
    const score = cosineSim(queryEmbedding, emb);
    return { content: c.content, fileName: c.file_name, score };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

function cosineSim(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

// ─── Disconnect / Delete personal data ───────────────────────────────────────

export async function deletePersonalDriveData(userId: number): Promise<void> {
  // Cascades to personal_chunks via FK
  await prisma.$executeRawUnsafe(
    'DELETE FROM personal_documents WHERE user_id = $1 AND source = $2',
    userId, 'gdrive',
  );
  await prisma.$executeRawUnsafe(
    'UPDATE users SET personal_drive_folder_id = NULL, personal_drive_last_sync = NULL WHERE id = $1',
    userId,
  );
  log.info('Personal drive data deleted', { userId });
}
