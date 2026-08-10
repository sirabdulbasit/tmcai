/**
 * DEF-116 — the preview must say WHICH details and WHY it is asking.
 *
 * Owner, 2026-08-10 23:41:
 *   "create a item of 'Stock Report' and delegate to Ali Haider with high
 *    priority and target today"
 *
 * He received, in full:
 *   "Before I proceed, please confirm the details and reply \"send\"."
 *
 * Confirm WHAT? The reason existed the whole time — the gate logged
 * `why: "I could not match that person to a contact"` — and never left the
 * process. The same thing happened at 16:36 with `why: "The email I have is
 * ali.haidar@tmcltd.ai, not .com. Shall I proceed with .com?"`.
 *
 * His own words for the fix: "it can simply say that i don't have this person
 * in my contact can you provide me his email and contact".
 *
 * Every other action type in this renderer already does this — notify_via_
 * whatsapp names the recipient, their number and the message body. add_open_item
 * had no case and fell through to a fallback that names nothing.
 *
 * These tests assert the RENDERED TEXT, because that is the only thing the
 * owner ever sees. Internal reasoning that never reaches him is exactly the gap
 * he identified: "the reason you providing is totally different from brain
 * given on chat".
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const BLOCK = (() => {
  const at = SRC.indexOf('DEF-116');
  expect(at, 'DEF-116 block not found').toBeGreaterThan(-1);
  return SRC.slice(at, at + 3000);
})();

describe('an unresolvable person is stated plainly, not hidden behind "the details"', () => {
  it('says it does not have the person and asks for what it needs', () => {
    expect(BLOCK).toMatch(/I don't have \$\{hint\} in your contacts/);
    expect(BLOCK).toMatch(/Send me their email and phone/);
  });

  it('names the item so he knows what is stuck', () => {
    expect(BLOCK).toMatch(/can't delegate "\$\{title\}"/);
  });

  it('offers a way forward rather than only a blocker', () => {
    expect(BLOCK).toMatch(/create it unassigned/);
  });
});

describe('a resolvable delegation names the person', () => {
  it('includes the resolved name and email', () => {
    expect(BLOCK).toMatch(/delegate to \$\{r\.name\}/);
    expect(BLOCK).toMatch(/r\.email/);
  });

  it('carries priority and due date into the preview', () => {
    expect(BLOCK).toMatch(/priority \$\{\(act as any\)\.priority\}/);
    expect(BLOCK).toMatch(/due \$\{\(act as any\)\.dueDateRaw\}/);
  });

  it('names the item and distinguishes create from update', () => {
    expect(BLOCK).toMatch(/const verb = act\.type === 'add_open_item' \? 'create' : 'update'/);
  });
});

describe('the fallback no longer says nothing', () => {
  it('names the action type even when no renderer exists', () => {
    // Degrades to "confirm this thing", never to "confirm".
    expect(BLOCK).toMatch(/String\(act\.type\)\.replace\(\/_\/g, ' '\)/);
  });

  it('the bare, detail-free sentence is gone', () => {
    // Asserted on the RETURN form, not on any occurrence: the DEF-116 comment
    // quotes the old sentence verbatim as evidence, and a plain substring
    // check finds the comment. (Fourth time today that a detailed comment has
    // collided with a source guard — anchor on code shapes, not on prose.)
    expect(SRC).not.toMatch(/return `Before I proceed, please confirm the details and reply "send"\.`/);
  });
});
