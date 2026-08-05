/**
 * A preview must name WHAT is being changed, not just the action.
 * Reported twice: 08-04 19:57 ("• update open item" ×3) and 08-04 20:25
 * ("• Delegate item to Hamna Latif Bhutta" ×3). In both cases the owner was
 * asked to approve three operations he could not distinguish.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8',
);
/** Comments quote the broken labels; only executable code counts. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const START = CODE.indexOf('const itemTitleOf');
const PREVIEW = CODE.slice(START, CODE.indexOf('Reply "send" to confirm everything', START));
/** The helper body alone — anchored AFTER its own start, because 'const lines'
 *  also occurs earlier in this very large file. */
const HELPER = CODE.slice(START, CODE.indexOf('const lines', START));

describe('plan preview names the item', () => {
  it('resolves the open-item TITLE for previews', () => {
    expect(CODE).toContain('const itemTitleOf');
    expect(PREVIEW).toContain('prisma.openItem.findFirst');
    // Tenant + user scoped, like every other read.
    expect(HELPER).toContain('clientNumber, userId');
  });
  it('delegate steps name the item AND the delegatee', () => {
    expect(PREVIEW).toMatch(/Delegate \$\{await itemTitleOf\(s\.openItemId\)\} to/);
  });
  it('update steps name the item AND every changed field', () => {
    const upd = PREVIEW.slice(PREVIEW.indexOf("case 'update_open_item'"));
    expect(upd).toContain('itemTitleOf(s.openItemId)');
    for (const f of ['priority', 'dueDateRaw', 'title', 'note']) expect(upd).toContain(f);
  });
  it('an unresolvable item is labelled, never silently blank', () => {
    expect(HELPER).toContain('(no item)');
    expect(HELPER).toContain('unknown item');
  });
  it('no plan step can render as the bare kind for these two kinds', () => {
    // The default branch stringifies the kind — that is what produced
    // "update open item" ×3. Both kinds must have explicit cases before it.
    const dflt = PREVIEW.indexOf('default:');
    expect(PREVIEW.indexOf("case 'delegate_open_item'")).toBeLessThan(dflt);
    expect(PREVIEW.indexOf("case 'update_open_item'")).toBeLessThan(dflt);
  });
});
