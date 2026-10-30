/**
 * DEF-362 review (decompression bomb) — the zip size guard, as a pure module.
 * DEF-368 moved it here from docReader.ts (which re-exports it unchanged) so
 * the file reader can check an .xlsx before opening it without importing the
 * AI document reader. No I/O.
 */
import { inflateRaw } from 'zlib';

/**
 * Sum of the uncompressed sizes a zip's central directory declares, or null
 * when the archive cannot be walked (no end record, truncated directory, or a
 * ZIP64 marker — a ZIP64 API document is not plausible, so it is refused, not
 * trusted). Pure; exported for tests.
 */
export function declaredUnzippedBytes(buf: Buffer): number | null {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  // The end record is the last 22 bytes plus at most a 65,535-byte comment.
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) return null;
  let p = cdOffset;
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return null;
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) return null;
    total += size;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}


/**
 * DEF-368 review (zip bomb, local-header bypass) — what xlsx@0.18.5 will
 * ACTUALLY allocate when it opens this zip, measured before it is handed to
 * the worker. xlsx's parse_zip does not trust the central directory's sizes:
 * it walks the entry count at EOCD+8, jumps to each local header and inflates
 * with the LOCAL header's uncompressed size (Buffer.allocUnsafe(usz), up to
 * 4 GB) or, when that is 0, grows its buffer without bound — and compares the
 * sizes only after inflating. Buffer memory is outside a worker's heap limit.
 * So this walks the archive the way xlsx does and, for every deflated entry,
 * inflates it natively with maxOutputLength = the budget left (bounded, and
 * stops at the end of the deflate stream, as xlsx does). Each entry charges
 * max(local usz, directory usz, real inflated length) to the budget.
 *
 * Returns { ok: true, total } or { ok: false, reason } — 'unreadable' when the
 * archive cannot be walked or uses what xlsx refuses anyway (encryption, a
 * method other than stored/deflate, a broken deflate stream), 'too_large'
 * with the bytes counted so far when the budget is exceeded. No I/O.
 */

export type ZipBudget = { ok: true; total: number } | { ok: false; reason: 'unreadable' | 'too_large'; total: number };

function inflateBounded(data: Buffer, limit: number): Promise<number | 'too_large' | 'bad'> {
  return new Promise((resolve) => {
    inflateRaw(data, { maxOutputLength: Math.max(1, limit) }, (err, out) => {
      if (err) resolve((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? 'too_large' : 'bad');
      else resolve(out.length);
    });
  });
}

export async function xlsxInflateBudget(buf: Buffer, cap: number): Promise<ZipBudget> {
  const bad = (total: number): ZipBudget => ({ ok: false, reason: 'unreadable', total });
  // xlsx: the LAST "PK\x05\x06" scanning back from length-4.
  let eocd = -1;
  for (let i = buf.length - 4; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 > buf.length) return bad(0);
  // xlsx walks the count at +8; the directory sum uses +10 — walk the larger.
  const count = Math.max(buf.readUInt16LE(eocd + 8), buf.readUInt16LE(eocd + 10));
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.length) return bad(total);
    const cdUsz = buf.readUInt32LE(p + 24);
    const off = buf.readUInt32LE(p + 42);
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (off + 30 > buf.length) return bad(total);
    const flags = buf.readUInt16LE(off + 6);
    const meth = buf.readUInt16LE(off + 8);
    const localUsz = buf.readUInt32LE(off + 22);
    const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    if (flags & 0x2041) return bad(total);
    if (meth !== 0 && meth !== 8) return bad(total);
    if (dataStart > buf.length) return bad(total);
    let charge = Math.max(localUsz, cdUsz);
    if (total + charge > cap) return { ok: false, reason: 'too_large', total: total + charge };
    if (meth === 8) {
      const actual = await inflateBounded(buf.subarray(dataStart), cap - total);
      if (actual === 'too_large') return { ok: false, reason: 'too_large', total: cap + 1 };
      if (actual === 'bad') return bad(total);
      charge = Math.max(charge, actual);
    }
    total += charge;
    if (total > cap) return { ok: false, reason: 'too_large', total };
  }
  return { ok: true, total };
}
