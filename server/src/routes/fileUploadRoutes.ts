// Phase 3.2: File upload routes
// Users upload files for private search. Admin cannot see content.

import path from 'path';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import {
  processUpload, listUserUploads, deleteUpload, checkUserQuota,
} from '../services/fileUploadService';

const router = Router();
router.use(requireAuth);

// H7 — Verify upload bytes match the claimed extension/mimetype.
// multer's fileFilter sees only the client-declared values; real defense
// is the magic-byte check run inside the POST handler.
type AllowedExt = 'pdf' | 'txt' | 'csv' | 'docx' | 'xlsx' | 'xls';

function startsWithPK(b: Buffer): boolean {
  return b.length >= 4
    && b[0] === 0x50 && b[1] === 0x4b
    && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)
    && (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08);
}

function isLikelyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  // Reject any NUL bytes — defeats "rename binary to .txt".
  for (const byte of sample) if (byte === 0) return false;
  // Round-trip UTF-8; if bytes are lost, reject.
  try {
    const s = sample.toString('utf8');
    return Buffer.from(s, 'utf8').equals(sample);
  } catch {
    return false;
  }
}

const MAGIC: Record<AllowedExt, (b: Buffer) => boolean> = {
  // %PDF-
  pdf:  (b) => b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d,
  // OOXML = PKZIP local-file-header "PK..". Same signature for .xlsx.
  docx: startsWithPK,
  xlsx: startsWithPK,
  // Legacy .xls = OLE Compound File (D0 CF 11 E0 A1 B1 1A E1)
  xls:  (b) => b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1,
  txt:  isLikelyText,
  csv:  isLikelyText,
};

const MIME_BY_EXT: Record<AllowedExt, string[]> = {
  pdf:  ['application/pdf'],
  txt:  ['text/plain', 'application/octet-stream'],
  csv:  ['text/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream', 'application/zip'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/octet-stream', 'application/zip'],
  xls:  ['application/vnd.ms-excel', 'application/octet-stream'],
};

export function verifyUploadContent(
  buffer: Buffer,
  originalName: string,
  claimedMime: string,
): { ok: true; ext: AllowedExt } | { ok: false; reason: string } {
  const extRaw = path.extname(originalName).slice(1).toLowerCase();
  if (!(extRaw in MAGIC)) return { ok: false, reason: `Unsupported extension: .${extRaw}` };
  const ext = extRaw as AllowedExt;

  if (!MAGIC[ext](buffer)) {
    return { ok: false, reason: `File content does not match extension .${ext} (magic-byte mismatch)` };
  }

  if (!MIME_BY_EXT[ext].includes(claimedMime)) {
    return { ok: false, reason: `MIME type mismatch: claimed "${claimedMime}" but expected one of ${MIME_BY_EXT[ext].join(', ')}` };
  }

  return { ok: true, ext };
}

// In-memory multer: 50MB limit. In-memory storage has a per-request heap
// cost of up to 50MB. A later pass should stream to GCS for scale.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set([
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream',
      'application/zip',
    ]);
    // The REAL gate is verifyUploadContent() in the handler; this is a
    // first-pass MIME/extension screen to reject obviously-wrong types
    // before buffering the whole file.
    if (allowed.has(file.mimetype) ||
        /\.(pdf|txt|csv|docx|xlsx|xls)$/i.test(file.originalname)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

// GET /api/v1/uploads — list user's uploaded files
router.get('/', async (req, res) => {
  const userId = req.user!.id;
  const files = await listUserUploads(userId);
  res.json({ files });
});

// GET /api/v1/uploads/quota — storage quota
router.get('/quota', async (req, res) => {
  const userId = req.user!.id;
  const quota = await checkUserQuota(userId);
  res.json(quota);
});

// POST /api/v1/uploads — upload a file
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });
  const userId = req.user!.id;

  // H7 — Magic-byte verification before handing off to parsers.
  const verdict = verifyUploadContent(req.file.buffer, req.file.originalname, req.file.mimetype);
  if (!verdict.ok) return res.status(400).json({ error: verdict.reason });

  try {
    const result = await processUpload(
      userId,
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
    );
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/v1/uploads/:id — delete an uploaded file
router.delete('/:id', async (req, res) => {
  const userId = req.user!.id;
  const documentId = parseInt(req.params.id, 10);
  if (isNaN(documentId)) return res.status(400).json({ error: 'Invalid document ID' });

  try {
    await deleteUpload(userId, documentId);
    res.json({ success: true });
  } catch (e: any) {
    res.status(404).json({ error: e.message });
  }
});

export default router;
