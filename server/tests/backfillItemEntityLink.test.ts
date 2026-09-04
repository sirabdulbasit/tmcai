/**
 * DEF-314 — the address parser that decides whether an item finds its person.
 *
 * `feed_events.sender_email` is a raw RFC-5322 From header. A naive `[^<> ]+@[^<> ]+` carries
 * the opening quote of `"Dawar Hussain" <dawar.hussain@tmcltd.com>` into the address, which in
 * the live set silently lost exactly one contact — the kind of near-miss that reads as "the
 * data is bad" when the parser is. With this parser the live dry run matched 72 of 72 items
 * that had an address, and 0 unmatched.
 */
import { describe, it, expect } from 'vitest';
import { extractAddress } from '../scripts/backfillItemEntityLink';

describe('DEF-314 — extractAddress', () => {
  it('takes the angle-bracket address, not the display name', () => {
    expect(extractAddress('Basit Ahmed <basit.ahmed@tmcltd.com>')).toBe('basit.ahmed@tmcltd.com');
  });

  it('survives a QUOTED display name — the live miss', () => {
    // Mutation: drop the `<...>` branch and fall back to a bare scan, and this returns
    // `"dawar.hussain@tmcltd.com` with a leading quote — no match, one person lost.
    expect(extractAddress('"Dawar Hussain" <dawar.hussain@tmcltd.com>')).toBe('dawar.hussain@tmcltd.com');
  });

  it('handles a bare address, and lowercases it', () => {
    expect(extractAddress('Anas.Wahab@TMCLTD.com')).toBe('anas.wahab@tmcltd.com');
  });

  it('returns null rather than a guess when there is no address', () => {
    // gchat stores `users/112401471047118061862`. Returning a partial match here would link an
    // item to the wrong person, which is worse than leaving it unlinked.
    expect(extractAddress('users/112401471047118061862')).toBeNull();
    expect(extractAddress(null)).toBeNull();
    expect(extractAddress('')).toBeNull();
  });

  it('does not mistake a display name containing @ for the address', () => {
    expect(extractAddress('noreply@ <real.person@tmcltd.com>')).toBe('real.person@tmcltd.com');
  });
});
