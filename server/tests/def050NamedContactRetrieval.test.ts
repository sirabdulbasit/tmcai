/**
 * DEF-050 — a hardcoded cap decided who existed.
 *
 * Measured on production 2026-08-05:
 *
 *     total_contacts | hamna_rank | name
 *     ---------------+------------+--------------------
 *                620 |        419 | Hamna Latif Bhutta
 *
 * `buildCandidatesBlockForReasoning` took the top 60 by relationship strength
 * and built that list WITHOUT reference to the question. 560 of 620 contacts
 * were invisible to the model on every turn.
 *
 * Two owner-visible failures, same cause:
 *   14:45 — asked to WhatsApp Hamna, the model emitted candidateId
 *           `cmowq07k70gkqrtk53b8b1a8f`, a well-formed cuid belonging to no row
 *           in `entities` OR `wiki_pages`. Shown a list without her in it, it
 *           invented a plausible id instead of reporting it could not see her.
 *   16:51 — "ask Hamna that will she come office tomorrow" → "Sir, I don't have
 *           contact details for Hamna Latif." Her row had email AND phone.
 *
 * Raising the cap only moves the cliff. The error was building a generic top-N
 * and hoping the person the user just NAMED was inside it. Retrieval is now
 * seeded by the names in the message.
 *
 * The token extractor is a PREFILTER, not a decision: it only widens what the
 * model is shown. The model still chooses, and actionTargetGuard still grounds
 * the choice at dispatch — the allowed use of a regex under the
 * no-hardcoded-judgement rule.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { extractNameTokens } from '../src/services/knowledge/brainComposer';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('DEF-050 — the owner\'s actual phrasing finds the person', () => {
  it('finds Hamna in the sentence that failed on production', () => {
    // "ask" is not in pickToneRecipientsFromMessage's verb list, which is why
    // that matcher missed her too.
    expect(extractNameTokens('ask Hamna that will she come office tomorrow')).toContain('hamna');
  });

  it('handles all-lowercase typing via the addressing verb', () => {
    expect(extractNameTokens('ask hamna whether she is coming tomorrow')).toContain('hamna');
    expect(extractNameTokens('tell yousaf the deadline moved')).toContain('yousaf');
    expect(extractNameTokens('remind asad about the invoice')).toContain('asad');
  });

  it('picks up a capitalised name with no addressing verb at all', () => {
    expect(extractNameTokens('Hamna needs the portal credentials')).toContain('hamna');
  });

  it('does not treat ordinary sentence words as names', () => {
    const tokens = extractNameTokens('ask Hamna that will she come office tomorrow');
    for (const noise of ['that', 'will', 'she', 'come', 'office', 'tomorrow', 'ask']) {
      expect(tokens, `"${noise}" is not a name`).not.toContain(noise);
    }
  });

  it('returns nothing for a question that names nobody', () => {
    expect(extractNameTokens('what is pending today')).toEqual([]);
    expect(extractNameTokens('')).toEqual([]);
  });

  it('is bounded, so a long message cannot flood the prompt', () => {
    const many = 'Ask Hamna Yousaf Asad Rafay Haider Numan Aqsa Basit about it';
    expect(extractNameTokens(many).length).toBeLessThanOrEqual(4);
  });
});

describe('DEF-050 — named contacts bypass the popularity ranking', () => {
  it('the candidates block is built FROM the question, not blind to it', () => {
    expect(CODE).toMatch(/async function buildCandidatesBlockForReasoning\([\s\S]{0,200}question/);
    expect(CODE).toMatch(/findContactsNamedIn\(question,\s*userId,\s*clientNumber\)/);
  });

  it('both call sites pass the question through', () => {
    const calls = [...CODE.matchAll(/buildCandidatesBlockForReasoning\(userId, clientNumber, question\)/g)];
    expect(
      calls.length,
      'a call site that forgets the question silently restores the old top-60 blindness',
    ).toBe(2);
  });

  it('named matches are placed BEFORE the ranked list', () => {
    // Order matters: the merge slices to a bound, so anything appended after
    // the ranked rows could be truncated away again.
    expect(CODE).toMatch(/\[\s*\.\.\.named,\s*\.\.\.rows\.filter/);
  });

  it('a named lookup does not require an email — a phone-only row is valid', () => {
    // The WhatsApp ask needs a phone. The tone matcher's `email: { not: null }`
    // filter would have excluded "Hamna ABAP TMC" entirely.
    const body = CODE.slice(CODE.indexOf('async function findContactsNamedIn'));
    const upToNext = body.slice(0, body.indexOf('\nasync function', 10));
    expect(upToNext).not.toMatch(/email:\s*\{\s*not:\s*null/);
  });

  it('ANY token may match, so a first name alone is enough', () => {
    const body = CODE.slice(CODE.indexOf('async function findContactsNamedIn'));
    const upToNext = body.slice(0, body.indexOf('\nasync function', 10));
    // Requiring every token would fail on "Hamna" vs "Hamna Latif Bhutta".
    expect(upToNext).toMatch(/AND:\s*\[\{\s*OR:\s*tokens\.map/);
  });
});
