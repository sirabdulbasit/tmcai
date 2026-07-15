import { describe, it, expect } from 'vitest';
import { sanitizeUtf8, safeSlice } from '../src/utils/utf8';

// Prod fix 2026-07-10 — Postgres 22021 "invalid byte sequence for
// encoding UTF8" bursts during the triage/cognitive sweep. Root class:
// lone surrogates from emoji-splitting `.slice()` calls (and possibly
// token-truncated LLM output) reaching DB writes. These utils are the
// class fix; sanitizeUtf8 is applied at the callLLM chokepoint so every
// downstream writer receives valid UTF-8.

describe('sanitizeUtf8', () => {
  it('passes plain ASCII through unchanged (same reference)', () => {
    const s = 'hello world';
    expect(sanitizeUtf8(s)).toBe(s);
  });

  it('passes valid BMP unicode through unchanged (em-dash, Urdu)', () => {
    const s = 'deadline — کل تک';
    expect(sanitizeUtf8(s)).toBe(s);
  });

  it('passes intact emoji (paired surrogates) through unchanged', () => {
    const s = 'done ✅ 🎉 party';
    expect(sanitizeUtf8(s)).toBe(s);
  });

  it('replaces a lone HIGH surrogate so the result is valid UTF-8', () => {
    // Simulate slice() cutting an emoji in half: 🎉 = 🎉
    const broken = 'party \uD83C';
    const clean = sanitizeUtf8(broken);
    // Round-trips losslessly through UTF-8 = valid for Postgres.
    expect(Buffer.from(clean, 'utf8').toString('utf8')).toBe(clean);
    expect(clean).not.toContain('\uD83C');
  });

  it('replaces a lone LOW surrogate mid-string', () => {
    const broken = 'a\uDF89b';
    const clean = sanitizeUtf8(broken);
    expect(Buffer.from(clean, 'utf8').toString('utf8')).toBe(clean);
  });

  it('empty string / falsy input safe', () => {
    expect(sanitizeUtf8('')).toBe('');
  });
});

describe('safeSlice', () => {
  it('behaves like slice for plain text', () => {
    expect(safeSlice('hello world', 5)).toBe('hello');
  });

  it('drops a trailing lone high surrogate when the cut lands mid-emoji', () => {
    // '🎉' is 2 UTF-16 units; slicing at 7 cuts it in half.
    const s = 'party 🎉!';
    const out = safeSlice(s, 7);
    expect(out).toBe('party ');
    // Result must round-trip as valid UTF-8.
    expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
  });

  it('keeps a complete emoji when the cut lands after it', () => {
    const s = 'hi 🎉 there';
    expect(safeSlice(s, 5)).toBe('hi 🎉');
  });

  it('no-ops when end exceeds length', () => {
    expect(safeSlice('short', 100)).toBe('short');
  });

  it('empty string safe', () => {
    expect(safeSlice('', 10)).toBe('');
  });
});
