// ═════════════════════════════════════════════════════════════════════════════
// fileUploadService.ts — Phase 3.2: Direct file upload + parse pipeline
//
// Supports: PDF, Excel, Word, CSV, plain text
// Parse → chunk → embed → store in personal_documents + personal_chunks
// ═════════════════════════════════════════════════════════════════════════════

import crypto from 'crypto';
import prisma from '../db/prisma';
import { embedBatch } from '../pipeline/embedder';
import { resolveClientNumberForUser } from './tenantScope';
import createLogger from '../utils/logger';

const log = createLogger('fileUpload');

const MAX_FILE_BYTES    = 50 * 1024 * 1024;  // 50 MB per file
const MAX_USER_BYTES    = 500 * 1024 * 1024; // 500 MB total per user
const CHUNK_SIZE_CHARS  = 1500;
const CHUNK_OVERLAP     = 200;

// ─── Storage quota check ──────────────────────────────────────────────────────

export async function checkUserQuota(userId: number): Promise<{ ok: boolean; usedBytes: number; limitBytes: number }> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT COALESCE(SUM(size_bytes), 0) as used FROM personal_documents WHERE user_id = $1 AND source = $2',
    userId, 'upload',
  );
  const usedBytes = Number(rows[0]?.used || 0);
  return { ok: usedBytes < MAX_USER_BYTES, usedBytes, limitBytes: MAX_USER_BYTES };
}

// ─── Text extraction ──────────────────────────────────────────────────────────

async function extractText(buffer: Buffer, mimeType: string, fileName: string): Promise<string> {
  if (mimeType === 'text/plain' || mimeType === 'text/csv' ||
      fileName.endsWith('.txt') || fileName.endsWith('.csv')) {
    return buffer.toString('utf-8');
  }

  if (mimeType === 'application/pdf' || fileName.endsWith('.pdf')) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string }>;
    const parsed = await pdfParse(buffer);
    return parsed.text || '';
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    fileName.endsWith('.docx')
  ) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    fileName.endsWith('.xlsx') || fileName.endsWith('.xls')
  ) {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return workbook.SheetNames.map(name => {
      const sheet = workbook.Sheets[name];
      return `--- Sheet: ${name} ---\n` + XLSX.utils.sheet_to_csv(sheet);
    }).join('\n\n');
  }

  throw new Error(`Unsupported file type: ${mimeType}`);
}

// ─── Text chunking ────────────────────────────────────────────────────────────

function chunkText(text: string): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE_CHARS, clean.length);
    const chunk = clean.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    start = end - CHUNK_OVERLAP;
    if (start <= 0) start = end;
    if (end >= clean.length) break;
  }
  return chunks;
}

// ─── Main upload handler ──────────────────────────────────────────────────────

export interface UploadResult {
  documentId: number;
  fileName: string;
  chunkCount: number;
  sizeBytes: number;
  duplicate: boolean;
}

export async function processUpload(
  userId: number,
  buffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<UploadResult> {
  const sizeBytes = buffer.length;

  if (sizeBytes > MAX_FILE_BYTES) {
    throw new Error(`File too large (${Math.round(sizeBytes / 1024 / 1024)}MB). Maximum is 50MB.`);
  }

  // Quota check
  const quota = await checkUserQuota(userId);
  if (!quota.ok) {
    throw new Error(`Storage quota exceeded (${Math.round(quota.usedBytes / 1024 / 1024)}MB / ${Math.round(quota.limitBytes / 1024 / 1024)}MB).`);
  }

  // Dedup by content hash
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing: any[] = await prisma.$queryRawUnsafe(
    'SELECT id FROM personal_documents WHERE user_id = $1 AND content_hash = $2',
    userId, contentHash,
  );
  if (existing.length > 0) {
    const chunkRows: any[] = await prisma.$queryRawUnsafe(
      'SELECT COUNT(*) as cnt FROM personal_chunks WHERE document_id = $1',
      existing[0].id,
    );
    return {
      documentId: existing[0].id,
      fileName: originalName,
      chunkCount: Number(chunkRows[0]?.cnt || 0),
      sizeBytes,
      duplicate: true,
    };
  }

  // E3/E5: resolve the uploader's tenant once and stamp it on the
  // document AND every chunk, so personal data carries a tenant tag on
  // top of user_id scoping (defense in depth — a wrong userId can no
  // longer cross tenants unnoticed). null only if the user row vanished
  // mid-upload; the row then degrades to legacy user-only scoping.
  const clientNumber = await resolveClientNumberForUser(userId);

  // Create document record
  const docRows: any[] = await prisma.$queryRawUnsafe(
    `INSERT INTO personal_documents (user_id, source, file_name, mime_type, size_bytes, content_hash, parse_status, client_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    userId, 'upload', originalName, mimeType, sizeBytes, contentHash, 'processing', clientNumber,
  );
  const docId: number = docRows[0].id;

  try {
    const text = await extractText(buffer, mimeType, originalName);
    if (!text.trim()) {
      await prisma.$executeRawUnsafe(
        'UPDATE personal_documents SET parse_status = $1, parse_error = $2 WHERE id = $3',
        'error', 'No text content extracted', docId,
      );
      throw new Error('No text content could be extracted from this file.');
    }

    const chunks = chunkText(text);
    const embeddings = await embedBatch(chunks);

    for (let i = 0; i < chunks.length; i++) {
      const chunkHash = crypto.createHash('sha256').update(userId + chunks[i]).digest('hex');
      const embeddingJson = JSON.stringify(embeddings[i] || []);
      // client_number denormalised onto each chunk so retrieval can
      // filter by tenant WITHOUT joining personal_documents.
      await prisma.$executeRawUnsafe(
        `INSERT INTO personal_chunks (user_id, document_id, content, embedding, chunk_index, content_hash, client_number)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        userId, docId, chunks[i], embeddingJson, i, chunkHash, clientNumber,
      );
    }

    await prisma.$executeRawUnsafe(
      'UPDATE personal_documents SET parse_status = $1, parse_error = NULL WHERE id = $2',
      'done', docId,
    );

    log.info('File processed', { userId, fileName: originalName, chunkCount: chunks.length, sizeBytes });
    return { documentId: docId, fileName: originalName, chunkCount: chunks.length, sizeBytes, duplicate: false };
  } catch (e: any) {
    await prisma.$executeRawUnsafe(
      'UPDATE personal_documents SET parse_status = $1, parse_error = $2 WHERE id = $3',
      'error', e.message?.slice(0, 500), docId,
    );
    throw e;
  }
}

// ─── List user uploads ────────────────────────────────────────────────────────

export async function listUserUploads(userId: number): Promise<Array<{
  id: number; fileName: string; mimeType: string; sizeBytes: number;
  parseStatus: string; createdAt: Date; chunkCount: number;
}>> {
  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT pd.id, pd.file_name, pd.mime_type, pd.size_bytes, pd.parse_status, pd.created_at,
            COUNT(pc.id)::int as chunk_count
     FROM personal_documents pd
     LEFT JOIN personal_chunks pc ON pc.document_id = pd.id
     WHERE pd.user_id = $1 AND pd.source = $2
     GROUP BY pd.id ORDER BY pd.created_at DESC`,
    userId, 'upload',
  );
  return rows.map(r => ({
    id: r.id,
    fileName: r.file_name,
    mimeType: r.mime_type,
    sizeBytes: r.size_bytes || 0,
    parseStatus: r.parse_status,
    createdAt: r.created_at,
    chunkCount: Number(r.chunk_count || 0),
  }));
}

// ─── Delete a single upload ───────────────────────────────────────────────────

export async function deleteUpload(userId: number, documentId: number): Promise<void> {
  // Only allow deleting own files
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT id FROM personal_documents WHERE id = $1 AND user_id = $2 AND source = $3',
    documentId, userId, 'upload',
  );
  if (!rows.length) throw new Error('File not found');

  await prisma.$executeRawUnsafe(
    'DELETE FROM personal_documents WHERE id = $1',
    documentId,
  );
  log.info('Upload deleted', { userId, documentId });
}
