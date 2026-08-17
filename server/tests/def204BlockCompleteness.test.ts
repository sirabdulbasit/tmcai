/**
 * DEF-204 — every read block states whether what it shows is ALL of it.
 *
 * THE FIRED REGRESSION. `B05-warmth` C6 fell 100 -> 85 on a calendar section
 * holding one entry. The judge: *"If there truly was only one calendar item, it
 * should have stated that explicitly … If there were more, it should have listed
 * them or explained why it only listed one."* The entry WAS the whole day —
 * `buildTodayCalendarBlock` does not truncate — but nothing said so, and a
 * complete answer was marked down as incomplete.
 *
 * The blocks beside it have the same hole pointing the other way: emails and
 * WhatsApp `LIMIT` to `max` and print "N of last max", which reads as complete
 * even when N === max and more exist. That is DEF-193/194's truncation lesson on
 * a different surface.
 *
 * Both directions are one missing fact — the block never declares its own
 * completeness — so there is ONE helper, asserted here, not three sentences.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = path.resolve(__dirname, '..', 'src/services/knowledge/brainComposer.ts');
const raw = fs.readFileSync(SRC, 'utf8');
/** Comments stripped: a guard must read code, not prose about it (DEF-195). */
const code = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('DEF-204 — the completeness fact is stated, and stated ONCE', () => {
  it('exists as a single shared helper, not one sentence per block', () => {
    expect(code).toMatch(/function completenessLine\(shown: number, hitCap: boolean, noun: string\)/);
    // Mutation: inlining the wording into each block makes this 0 and is the
    // protection-with-two-implementations shape on a truthfulness property.
    expect((code.match(/function completenessLine\(/g) ?? []).length).toBe(1);
  });

  it('is used by ALL THREE read blocks that list things', () => {
    // Mutation: dropping any call leaves that block unable to say whether its
    // list is whole — which is exactly what B05 was marked down for.
    expect((code.match(/completenessLine\(/g) ?? []).length).toBe(4); // 1 definition + 3 call sites
    expect(code).toMatch(/completenessLine\(events\.length, false, 'event'\)/);
    expect(code).toMatch(/completenessLine\(rows\.length, rows\.length >= max, 'email'\)/);
    expect(code).toMatch(/completenessLine\(rows\.length, rows\.length >= max, 'message'\)/);
  });

  it('the calendar declares COMPLETE, because getTodayCalendar does not truncate', () => {
    // The B05 case in one assertion: a one-event day must be sayable as a
    // one-event day. Mutation: passing `true` here would make Brain hedge about
    // a list it can actually vouch for.
    expect(code).toMatch(/completenessLine\(events\.length, false, 'event'\)/);
  });

  it('the capped blocks declare CAPPED only when they actually hit the cap', () => {
    // `rows.length >= max` is the honest predicate: "10 of last 10" is the cap,
    // "3 of last 10" is the whole window. Mutation: hardcoding `true` would make
    // every complete list read as partial — the B05 defect, mirrored.
    expect(code).not.toMatch(/completenessLine\(rows\.length, true,/);
    expect(code).not.toMatch(/completenessLine\(rows\.length, false,/);
  });
});

describe('DEF-204 — what the two branches actually say', () => {
  /** The helper is module-private, so its contract is asserted from the source
   *  text it will emit. Both branches must be unambiguous to a model. */
  const body = /function completenessLine\([\s\S]*?\n\}/.exec(code)?.[0] ?? '';

  it('the COMPLETE branch authorises a plain yes, rather than hedging', () => {
    expect(body).toMatch(/this is the COMPLETE list for this window/);
    expect(body).toMatch(/the answer is yes; say so plainly rather than hedging/);
  });

  it('the CAPPED branch forbids presenting a cut list as the whole one', () => {
    expect(body).toMatch(/CAPPED AT \$\{shown\}/);
    expect(body).toMatch(/MORE MAY EXIST/);
    expect(body).toMatch(/Never present this as the complete list/);
  });

  it('singularises the noun, so "1 events" never reaches the owner-facing reasoning', () => {
    expect(body).toMatch(/shown === 1 \? noun : `\$\{noun\}s`/);
  });
});
