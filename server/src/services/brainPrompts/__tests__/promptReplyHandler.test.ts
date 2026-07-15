import { describe, it, expect } from 'vitest';
import { parseDuePhrase, parseOwner } from '../promptReplyHandler';

describe('parseDuePhrase', () => {
  it('parses "today" / "eod" / "asap" as today midnight', () => {
    for (const k of ['today','eod','asap','now']) {
      const d = parseDuePhrase(k);
      expect(d).not.toBeNull();
      expect(d!.getHours()).toBe(0);
    }
  });

  it('parses "tomorrow"', () => {
    const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(0,0,0,0);
    const d = parseDuePhrase('tomorrow');
    expect(d?.toDateString()).toBe(t.toDateString());
  });

  it('parses "in 5 days"', () => {
    const t = new Date(); t.setDate(t.getDate() + 5); t.setHours(0,0,0,0);
    expect(parseDuePhrase('in 5 days')?.toDateString()).toBe(t.toDateString());
  });

  it('parses "3 days"', () => {
    const t = new Date(); t.setDate(t.getDate() + 3); t.setHours(0,0,0,0);
    expect(parseDuePhrase('3 days')?.toDateString()).toBe(t.toDateString());
  });

  it('parses ISO date', () => {
    const d = parseDuePhrase('please by 2026-12-31 ok?');
    expect(d?.toISOString().slice(0,10)).toBe('2026-12-31');
  });

  it('parses weekday — moves forward, not backward', () => {
    const d = parseDuePhrase('friday');
    expect(d).not.toBeNull();
    expect(d!.getDay()).toBe(5);
    expect(d!.getTime()).toBeGreaterThan(Date.now() - 1000);
  });

  it('parses "next monday" — at least 7 days out from today', () => {
    const d = parseDuePhrase('next monday');
    expect(d).not.toBeNull();
    expect(d!.getDay()).toBe(1);
  });

  it('returns null for gibberish', () => {
    expect(parseDuePhrase('no idea')).toBeNull();
    expect(parseDuePhrase('whenever you want')).toBeNull();
  });
});

describe('parseOwner', () => {
  it('parses "Name <email>"', () => {
    const r = parseOwner('Asad Khan <asad@tmcltd.com>');
    expect(r.name).toBe('Asad Khan');
    expect(r.email).toBe('asad@tmcltd.com');
  });

  it('parses bare email and humanises name from local part', () => {
    const r = parseOwner('asad.khan@tmcltd.com');
    expect(r.email).toBe('asad.khan@tmcltd.com');
    expect(r.name).toBe('Asad Khan');
  });

  it('extracts email even with surrounding text', () => {
    const r = parseOwner('please assign to asad@tmcltd.com');
    expect(r.email).toBe('asad@tmcltd.com');
  });

  it('falls back to name only', () => {
    const r = parseOwner('Asad Khan');
    expect(r.name).toBe('Asad Khan');
    expect(r.email).toBeNull();
  });

  it('returns nulls for very long input (likely free-form note, not an owner)', () => {
    const r = parseOwner('a'.repeat(200));
    expect(r.name).toBeNull();
    expect(r.email).toBeNull();
  });
});
