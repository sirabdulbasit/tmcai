/**
 * DEF-322 — an RFC 2822 header must be 7-bit ASCII.
 *
 * Owner, 2026-09-07, on his Day Brief email:
 *
 *   Subject: [day_brief] Day Brief Ã¢Â€Â" 2026-09-07
 *
 * The stored summary is correct — `brain_user_messages` holds `Day Brief — 2026-09-05` with a
 * proper em-dash — and the em-dash in the BODY of the very same email rendered fine. That pair
 * of facts is the diagnosis: `Content-Type: text/html; charset=utf-8` governs the BODY only.
 * The subject went out as raw UTF-8 bytes in a header with nothing declaring their charset, so
 * the receiving client decoded E2 80 94 as Latin-1.
 *
 * `Buffer.from(message)` was never the bug — it correctly emits UTF-8. The bug is that a header
 * may not CARRY UTF-8. Non-ASCII belongs in an RFC 2047 encoded-word.
 */
import { describe, it, expect } from 'vitest';
import { encodeHeaderValue } from '../src/services/gmailService';

/** Decode an encoded-word run the way a mail client does, so the assertions are about what he
 *  actually SEES rather than about the shape of the encoding. */
function decodeHeader(h: string): string {
  return h
    .split(/\r\n /)
    .map((w) => {
      const m = /^=\?UTF-8\?B\?(.*)\?=$/.exec(w);
      return m ? Buffer.from(m[1], 'base64').toString('utf8') : w;
    })
    .join('');
}

describe('DEF-322 — the subject survives the wire', () => {
  it('encodes the em-dash that produced the mojibake', () => {
    const subject = '[day_brief] Day Brief — 2026-09-07';
    const encoded = encodeHeaderValue(subject);
    // Mutation: return the value unencoded and this dies — raw UTF-8 reaches the header again.
    expect(encoded).not.toBe(subject);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?/);
    // 7-bit clean, which is the actual RFC requirement being met.
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(encoded)).toBe(true);
    // And it round-trips to exactly what he should read.
    expect(decodeHeader(encoded)).toBe(subject);
  });

  it('leaves a pure-ASCII subject byte-identical', () => {
    // The overwhelming majority of subjects. Encoding them anyway would churn threading and
    // appearance for no reason, so untouched is the correct behaviour, not an optimisation.
    const subject = '[deploy_report] Deploy 2026-09-07';
    expect(encodeHeaderValue(subject)).toBe(subject);
  });

  it('never splits a multi-byte character across encoded-words', () => {
    // Chunking the UTF-8 BUFFER instead of the code points would cut a character in half and
    // produce exactly the corruption this function exists to remove. Mutation: chunk by bytes
    // and this dies on the round-trip.
    const subject = '—'.repeat(60);
    const encoded = encodeHeaderValue(subject);
    expect(encoded).toContain('\r\n ');           // it did fold
    expect(decodeHeader(encoded)).toBe(subject);  // and nothing was lost
  });

  it('keeps every encoded-word within the RFC 2047 75-char limit', () => {
    const encoded = encodeHeaderValue('Réunion — ' + 'é'.repeat(200));
    for (const word of encoded.split(/\r\n /)) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('round-trips non-Latin scripts', () => {
    for (const s of ['اجلاس — پیر', '会議 — 月曜日', 'Naïve café — 2026']) {
      expect(decodeHeader(encodeHeaderValue(s))).toBe(s);
    }
  });
});
