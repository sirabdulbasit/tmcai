/**
 * DEF-225 — the record of a sent message, read from the message.
 *
 * The scorer's own stated reason for Accurate Communication sitting at 87
 * through six iterations of composer work (`state/capability_scorecard.json`):
 *
 *   > "Pack: 0 provider receipts; worker send bodies not stored —
 *   >  wording/delivery quality unconfirmed on chase path."
 *
 * Nothing composed can raise a score for prose nobody kept. And it is the
 * owner's class, not a scoring artefact: `fabricated-status`'s falsifier is
 * *"Provider receipts, Sent-folder evidence or confirmed database transitions
 * prove the disputed outcomes occurred exactly as claimed"* — evidence this
 * system did not keep, against his *"i am unable to see ur email in my sent
 * items"*.
 *
 * The defect proper, as opposed to the gap: the chase audit wrote
 * `disclosureFooter: true` as a **hardcoded literal**. A record asserting a
 * property of a message without reading the message is the class pointing at
 * itself — and the footer is the whole structural mitigation for "Brain never
 * speaks as the user", so a false claim about it is not cosmetic.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  sentRecord,
  DISCLOSURE_MARK,
  SENT_BODY_EXCERPT_CHARS,
} from '../src/services/delegation/sentRecord';

const src = (rel: string) => {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  // Comments stripped: a guard must read code, not prose about it (DEF-195).
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
};

/** A chase body in the shape `composeChaseEmail` returns it. */
const WITH_FOOTER = [
  'Hi Hamna,',
  '',
  'Where are we on the Fujairah pricing? It was due on the 5th.',
  '',
  'Basit',
  '',
  '',
  '—',
  `${DISCLOSURE_MARK} Basit Ahmed's AI assistant. Your reply goes directly to Basit Ahmed at basit@tmcltd.com.`,
].join('\n');

const WITHOUT_FOOTER = WITH_FOOTER.slice(0, WITH_FOOTER.indexOf('—')).trimEnd();

describe('DEF-225 — the disclosure claim is READ, never asserted', () => {
  it('reports the footer when it is there', () => {
    expect(sentRecord(WITH_FOOTER).disclosureFooter).toBe(true);
  });

  it('THE DEFECT: a body without the footer reports FALSE', () => {
    // The old audit wrote `disclosureFooter: true` unconditionally, so this
    // case was recorded as compliant. The footer is the structural mitigation
    // for "Brain never speaks as the user"; a false claim about it is not
    // cosmetic.
    expect(sentRecord(WITHOUT_FOOTER).disclosureFooter).toBe(false);
  });

  it('an empty or absent body reports false rather than defaulting to true', () => {
    for (const b of ['', null, undefined]) {
      expect(sentRecord(b as string).disclosureFooter, String(b)).toBe(false);
      expect(sentRecord(b as string).bodyChars).toBe(0);
    }
  });

  it('the footer builder and the check share ONE definition of the sentence', () => {
    // Two copies would drift, and the audit would then report a footer that is
    // not there — this module's own defect, one layer down.
    const chase = src('src/services/delegation/smartChaseService.ts');
    expect(chase).toMatch(/import \{ DISCLOSURE_MARK \} from '\.\/sentRecord'/);
    expect(chase).toMatch(/\$\{DISCLOSURE_MARK\} \$\{userName\}'s AI assistant/);
    expect(chase, 'the sentence is not re-typed').not.toContain("`Sent by Nexeo, ${userName}");
  });
});

describe('DEF-225 — the body is kept, bounded, and provably the real one', () => {
  it('keeps what was written', () => {
    const r = sentRecord(WITH_FOOTER);
    expect(r.bodyExcerpt).toContain('Where are we on the Fujairah pricing?');
    expect(r.bodyChars).toBe(WITH_FOOTER.length);
    expect(r.excerptTruncated).toBe(false);
  });

  it('a long body is bounded, and the TRUE length still travels', () => {
    // A truncated excerpt with no length beside it would read as the whole
    // message — a quieter version of the same defect.
    const long = 'x'.repeat(SENT_BODY_EXCERPT_CHARS + 500);
    const r = sentRecord(long);
    expect(r.bodyExcerpt).toHaveLength(SENT_BODY_EXCERPT_CHARS);
    expect(r.bodyChars).toBe(SENT_BODY_EXCERPT_CHARS + 500);
    expect(r.excerptTruncated).toBe(true);
  });

  it('the digest is over the FULL body, so the excerpt cannot misrepresent it', () => {
    const long = 'x'.repeat(SENT_BODY_EXCERPT_CHARS + 500);
    expect(sentRecord(long).bodySha256)
      .toBe(createHash('sha256').update(long, 'utf8').digest('hex'));
    // …and it is NOT the digest of the excerpt, which would verify nothing.
    expect(sentRecord(long).bodySha256)
      .not.toBe(createHash('sha256').update(long.slice(0, SENT_BODY_EXCERPT_CHARS), 'utf8').digest('hex'));
  });

  it('one changed character changes the digest', () => {
    expect(sentRecord(WITH_FOOTER).bodySha256)
      .not.toBe(sentRecord(`${WITH_FOOTER} `).bodySha256);
  });
});

describe('DEF-225 — the chase job records it, and stops asserting it', () => {
  const job = src('src/jobs/delegationFollowUpJob.ts');

  it('the hardcoded claim is gone', () => {
    expect(job).not.toContain('disclosureFooter: true');
  });

  it('the record is spread from the body that was actually sent', () => {
    expect(job).toMatch(/\.\.\.sentRecord\(composed\.body\)/);
    expect(job).toMatch(/import \{ sentRecord \} from '\.\.\/services\/delegation\/sentRecord'/);
  });

  it('a failed audit write is LOGGED, not swallowed', () => {
    // A lost audit row means a chase went out in the owner's name with no
    // record of what it said — the hole this DEF closes. `.catch(() => {})`
    // would hide it rather than close it.
    expect(job).not.toMatch(/\}\)\.catch\(\(\) => \{\}\);\s*\n\s*summary\.sent \+= 1;/);
    expect(job).toMatch(/CHASE SENT but its audit row did not write/);
  });

  it('the subject and messageId it already stored are untouched', () => {
    // The fix ADDS evidence. Losing the provider receipt while adding the body
    // would trade one blind spot for another.
    expect(job).toMatch(/subject: composed\.subject,/);
    expect(job).toMatch(/messageId: r\.messageId,/);
  });
});
