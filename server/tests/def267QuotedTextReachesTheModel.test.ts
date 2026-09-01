/**
 * DEF-267(b) — `whatsapp-quoted-text-not-read`.
 *
 * Owner, Session 17, verbatim: *"don't you have ability to read whatsapp reply
 * text function? to know against which i have sent this message"* and then
 * *"build. your ability so you can read txt from quoted message"*. Brain's
 * answer — *"I can't read the text from the quoted message"* — was TRUE, and
 * that is the defect: `WebjsProvider.ts` captured only `quotedStanzaID` (the
 * id, a delegation-correlation key) and dropped the body at ingest, so every
 * reply-to reached the model as a bare message. A capture gap, narrated to the
 * owner as a comprehension limit.
 *
 * The class fix, per the analysis: capture the quoted BODY at ingest and carry
 * it into the turn the model reads — after which no reply-to arrives bare, on
 * any path, because the enrichment happens where the message enters the
 * system, not in any downstream consumer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { extractQuotedBody } from '../src/services/whatsapp/WebjsProvider';
import { composeQuotedReplyTurn } from '../src/services/whatsapp/WhatsAppInbound';

describe('DEF-267(b) — the quoted body is captured at ingest, defensively', () => {
  it('reads the body from the same _data shape the id capture uses', () => {
    const msg = { _data: { quotedStanzaID: 'ABC', quotedMsg: { body: 'Attend Presentation Alignment Call — due today' } } };
    expect(extractQuotedBody(msg)).toBe('Attend Presentation Alignment Call — due today');
  });

  it('falls back to caption for quoted media, where the text actually lives', () => {
    const msg = { _data: { quotedMsg: { body: '', caption: 'screenshot of the pricing email' } } };
    expect(extractQuotedBody(msg)).toBe('screenshot of the pricing email');
  });

  it('returns undefined — never an empty string — when there is nothing to read', () => {
    // An empty capture must be ABSENT so downstream `if (quotedBody)` stays
    // false: an empty-string referent would attach "[replying to: \"\"]" to
    // the turn, which reads as a message that quoted nothing.
    expect(extractQuotedBody({ _data: { quotedMsg: { body: '   ' } } })).toBeUndefined();
    expect(extractQuotedBody({ _data: {} })).toBeUndefined();
    expect(extractQuotedBody({})).toBeUndefined();
    expect(extractQuotedBody(null)).toBeUndefined();
  });

  it('caps a long quote — a referent, not a payload', () => {
    const out = extractQuotedBody({ _data: { quotedMsg: { body: 'x'.repeat(1000) } } })!;
    expect(out.length).toBe(501); // 500 + ellipsis
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('DEF-267(b) — the turn the model reads carries both his words and the referent', () => {
  it('appends the quoted text as a labelled observation, verbatim and quoted', () => {
    const out = composeQuotedReplyTurn('from where you took this?', 'Attend Presentation Alignment Call — created from a calendar invitation');
    expect(out).toBe(
      'from where you took this?\n\n[replying to: "Attend Presentation Alignment Call — created from a calendar invitation"]',
    );
  });

  it('keeps the sender\'s words FIRST — downstream consumers key on the start of the turn', () => {
    const out = composeQuotedReplyTurn('yes', 'Should I archive the Fujairah thread?');
    // Mutation: prepending the quote instead dies here.
    expect(out.startsWith('yes')).toBe(true);
    expect(out.indexOf('[replying to:')).toBeGreaterThan(0);
  });

  it('is the identity function when there is no quote — a bare message stays bare', () => {
    expect(composeQuotedReplyTurn('hello')).toBe('hello');
    expect(composeQuotedReplyTurn('hello', null)).toBe('hello');
    expect(composeQuotedReplyTurn('hello', '  ')).toBe('hello');
  });

  it('caps the quote even if a transport hands it more than the capture cap', () => {
    const out = composeQuotedReplyTurn('what is this?', 'y'.repeat(800));
    expect(out).toContain('…"]');
    expect(out.length).toBeLessThan(600);
  });
});

describe('DEF-267(b) — wiring pins (the plumbing the pure tests above cannot see)', () => {
  // These are deliberate source pins, and they are labelled as such: the
  // behaviour is proven by the pure functions above; these assert only that
  // the two capture/compose sites actually CALL them, because the defect this
  // closes was exactly a field captured in one place and consumed nowhere.
  const provider = readFileSync(join(__dirname, '../src/services/whatsapp/WebjsProvider.ts'), 'utf8');
  const inbound = readFileSync(join(__dirname, '../src/services/whatsapp/WhatsAppInbound.ts'), 'utf8');

  it('the provider capture site populates quotedBody from the shared extractor', () => {
    expect(provider).toMatch(/quotedBody: extractQuotedBody\(message\)/);
  });

  it('the inbound turn is composed through composeQuotedReplyTurn, quotedBody included', () => {
    expect(inbound).toMatch(/composeQuotedReplyTurn\(params\.messageBody, params\.quotedBody\)/);
  });

  it('InboundParams declares the field, so a transport cannot silently drop it at the type boundary', () => {
    expect(inbound).toMatch(/quotedBody\?: string;/);
  });
});
