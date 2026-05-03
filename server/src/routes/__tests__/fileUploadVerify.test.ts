import { describe, it, expect } from 'vitest';
import { verifyUploadContent } from '../fileUploadRoutes';

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const PK_MAGIC  = Buffer.from([0x50, 0x4b, 0x03, 0x04]);        // PK..
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

describe('verifyUploadContent (H7)', () => {
  it('accepts a valid PDF', () => {
    const buf = Buffer.concat([PDF_MAGIC, Buffer.from('rest of pdf')]);
    const res = verifyUploadContent(buf, 'doc.pdf', 'application/pdf');
    expect(res.ok).toBe(true);
  });

  it('rejects a fake .pdf that is actually a PE executable', () => {
    // MZ header — a Windows executable.
    const buf = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]);
    const res = verifyUploadContent(buf, 'payload.pdf', 'application/pdf');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/magic-byte mismatch/);
  });

  it('accepts a valid .docx (PKZIP magic)', () => {
    const buf = Buffer.concat([PK_MAGIC, Buffer.from('zipbody')]);
    const res = verifyUploadContent(
      buf,
      'report.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.ok).toBe(true);
  });

  it('accepts a valid .xlsx', () => {
    const buf = Buffer.concat([PK_MAGIC, Buffer.from('zipbody')]);
    const res = verifyUploadContent(
      buf,
      'sheet.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.ok).toBe(true);
  });

  it('accepts a legacy .xls (OLE CFB magic)', () => {
    const buf = Buffer.concat([OLE_MAGIC, Buffer.from('ole body')]);
    const res = verifyUploadContent(buf, 'old.xls', 'application/vnd.ms-excel');
    expect(res.ok).toBe(true);
  });

  it('rejects an unsupported extension', () => {
    const res = verifyUploadContent(Buffer.from('hi'), 'script.js', 'text/javascript');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/Unsupported extension/);
  });

  it('rejects an ASCII text file claiming to be .pdf', () => {
    const res = verifyUploadContent(
      Buffer.from('This is not a PDF, just plain text.'),
      'text.pdf',
      'application/pdf',
    );
    expect(res.ok).toBe(false);
  });

  it('accepts plain text (.txt)', () => {
    const res = verifyUploadContent(Buffer.from('Hello world.'), 'note.txt', 'text/plain');
    expect(res.ok).toBe(true);
  });

  it('rejects .txt containing NUL bytes (binary payload smuggled in)', () => {
    const buf = Buffer.from([0x48, 0x69, 0x00, 0x21]); // "Hi\0!"
    const res = verifyUploadContent(buf, 'payload.txt', 'text/plain');
    expect(res.ok).toBe(false);
  });

  it('rejects a mime-type mismatch even when magic bytes match', () => {
    const buf = Buffer.concat([PDF_MAGIC, Buffer.from('body')]);
    const res = verifyUploadContent(buf, 'doc.pdf', 'text/html');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/MIME type mismatch/);
  });
});
