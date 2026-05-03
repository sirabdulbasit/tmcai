/**
 * Extract readable text from an email attachment buffer.
 * Dispatches by MIME type; returns { text, pageCount, method }.
 *
 * Bounded by design:
 *   - Max 5 MB per attachment (anything bigger → metadata only).
 *   - Text capped at 40KB (enough for a typical 20-page doc).
 *   - Unknown types return empty string; caller still records metadata.
 */
import createLogger from '../../utils/logger';

const log = createLogger('attachment-extract');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 40_000;

export interface ExtractResult {
  text: string;
  pageCount?: number;
  method: 'pdf' | 'docx' | 'xlsx' | 'text' | 'skipped';
  truncated: boolean;
}

export async function extractAttachmentText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<ExtractResult> {
  if (buffer.byteLength > MAX_BYTES) {
    log.info('attachment too large, skipped', { filename, size: buffer.byteLength });
    return { text: '', method: 'skipped', truncated: true };
  }

  const mt = (mimeType || '').toLowerCase();
  const name = (filename || '').toLowerCase();

  try {
    if (mt.includes('pdf') || name.endsWith('.pdf')) {
      // pdf-parse v2+: class-based API. v1 exported a callable default;
      // we use v2 (verified in package.json).
      const { PDFParse } = (await import('pdf-parse')) as any;
      const parser = new PDFParse({ data: buffer });
      const r = await parser.getText();
      const text = String(r.text ?? '');
      return {
        text: text.slice(0, MAX_TEXT_CHARS),
        pageCount: r.total ?? r.pages ?? r.numpages,
        method: 'pdf',
        truncated: text.length > MAX_TEXT_CHARS,
      };
    }

    if (mt.includes('wordprocessingml') || name.endsWith('.docx')) {
      const mammoth = await import('mammoth');
      const r = await mammoth.extractRawText({ buffer });
      const text = String(r.value ?? '');
      return {
        text: text.slice(0, MAX_TEXT_CHARS),
        method: 'docx',
        truncated: text.length > MAX_TEXT_CHARS,
      };
    }

    if (mt.includes('spreadsheetml') || mt.includes('excel') || name.endsWith('.xlsx') || name.endsWith('.xls') || name.endsWith('.csv')) {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const parts: string[] = [];
      for (const sheet of wb.SheetNames) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheet]);
        parts.push(`# Sheet: ${sheet}\n${csv}`);
        if (parts.join('\n').length > MAX_TEXT_CHARS) break;
      }
      const text = parts.join('\n\n');
      return {
        text: text.slice(0, MAX_TEXT_CHARS),
        method: 'xlsx',
        truncated: text.length > MAX_TEXT_CHARS,
      };
    }

    if (mt.startsWith('text/') || name.endsWith('.txt') || name.endsWith('.md')) {
      const text = buffer.toString('utf8');
      return {
        text: text.slice(0, MAX_TEXT_CHARS),
        method: 'text',
        truncated: text.length > MAX_TEXT_CHARS,
      };
    }

    // Unknown mime — skip extraction but caller still records metadata.
    return { text: '', method: 'skipped', truncated: false };
  } catch (err: any) {
    log.warn('extraction failed', { filename, mimeType, error: err.message });
    return { text: '', method: 'skipped', truncated: false };
  }
}
