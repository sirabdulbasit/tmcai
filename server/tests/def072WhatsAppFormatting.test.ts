/**
 * DEF-072 — the Day Brief arrived on WhatsApp as one unreadable paragraph.
 *
 * 2026-08-06 08:31. Calendar, attention items, open items, three delegations
 * and email counts, all in a single block of prose.
 *
 * My first diagnosis was WRONG and is worth recording. I said the WhatsApp
 * renderer flattened the structure. It does not — stripMarkdown already turns
 * "- " into "• " and preserves newlines, collapsing only 3+ blank lines. There
 * was no structure to flatten: the model wrote a paragraph because nothing
 * ever asked it not to.
 *
 * So two real faults, not one:
 *   1. Nothing required the brief to be a list. Fixed in the reasoning prompt.
 *   2. The renderer DISCARDED emphasis instead of translating it. WhatsApp has
 *      *bold* and _italic_; markdown's **bold** renders literally so it had to
 *      go, but converting was the answer, not deleting. Section headers came
 *      through as ordinary sentences, which is what makes a long brief
 *      unscannable even when it IS broken into lines.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const RENDERER = read('services/knowledge/channelRenderer.ts');
const PROMPT = read('services/knowledge/reasoningCompose.ts');

describe('DEF-072 — emphasis is translated, not discarded', () => {
  it('markdown bold becomes WhatsApp bold', () => {
    expect(RENDERER).toMatch(/\\\*\\\*\(\[\^\*\\n\]\+\)\\\*\\\*\/g, '\*\$1\*'/);
  });

  it('a heading becomes a bold line — the only heading WhatsApp has', () => {
    expect(RENDERER).toMatch(/\^#\{1,6\}\\s\+\(\.\*\)\$\/gm, '\*\$1\*'/);
  });

  it('structure that already worked is untouched', () => {
    // These were never the problem; the regression risk is removing them
    // while fixing the emphasis.
    expect(RENDERER).toContain("'• '");
    expect(RENDERER).toMatch(/\\n\{3,\}\/g, '\\n\\n'/);
  });
});

describe('DEF-072 — the brief must be a list', () => {
  it('the prompt forbids running the sections into prose', () => {
    expect(PROMPT).toMatch(/A DAY BRIEF IS A LIST, NOT A PARAGRAPH/);
    expect(PROMPT).toMatch(/one item per line/);
  });

  it('it cites the real failure so the rule is not tidied away later', () => {
    expect(PROMPT).toMatch(/2026-08-06 08:31/);
  });

  it('counts belong on the section title, not buried mid-sentence', () => {
    expect(PROMPT).toMatch(/Counts belong on the section title/);
  });
});
