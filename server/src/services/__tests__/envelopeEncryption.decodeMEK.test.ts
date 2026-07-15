import { describe, it, expect } from 'vitest';
import { decodeMEK } from '../envelopeEncryptionService';

describe('decodeMEK (H3)', () => {
  it('decodes a 64-char hex string to 32 bytes', () => {
    const hex = 'a'.repeat(64);
    const buf = decodeMEK(hex);
    expect(buf).toHaveLength(32);
  });

  it('decodes a 44-char standard base64 string to 32 bytes', () => {
    // 32 zero bytes in base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    const b64 = Buffer.alloc(32).toString('base64');
    expect(b64).toHaveLength(44);
    const buf = decodeMEK(b64);
    expect(buf).toHaveLength(32);
    expect(buf.equals(Buffer.alloc(32))).toBe(true);
  });

  it('decodes a url-safe base64 string', () => {
    const raw = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const urlSafe = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const buf = decodeMEK(urlSafe);
    expect(buf.equals(raw)).toBe(true);
  });

  it('rejects a short utf-8 string (the old bug pattern)', () => {
    // Old code accepted any string and used Buffer.from(s.slice(0,32),'utf-8').
    // A 32-char utf-8 string is not a valid encoded 32-byte key.
    expect(() => decodeMEK('thirty-two-characters-of-string!')).toThrow(/must be 32 bytes/);
  });

  it('rejects a too-short value', () => {
    expect(() => decodeMEK('short')).toThrow(/must be 32 bytes/);
  });

  it('rejects a too-long hex value (64 chars is the max)', () => {
    expect(() => decodeMEK('a'.repeat(128))).toThrow(/must be 32 bytes/);
  });

  it('trims surrounding whitespace before decoding', () => {
    const hex = '  ' + 'a'.repeat(64) + '\n';
    const buf = decodeMEK(hex);
    expect(buf).toHaveLength(32);
  });
});
