/**
 * DEF-119 — DEF-115's guard read one of the two places the subject is recorded,
 * and the producer it needed to cover used the other one.
 *
 * Measured on the live queue, 2026-08-11, prompts queued in the last 7 days:
 *
 *   source                       total   open_item_id set   metadata.openItemId
 *   action_lifecycle_governor        18                 18                    0
 *   preactive_due_nudge              14                  0                   14
 *   delegation_capture               10                  8                    8
 *   action_lifecycle_reply            7                  7                    0
 *
 * DEF-115 expires a due prompt whose open item has gone terminal, and it read
 * `openItemId` — the column. So it covered the governor completely and
 * `preactive_due_nudge` not at all. That is the source which sends "the deadline
 * for X has arrived" and "X is now overdue": the reminders most likely to go
 * stale, because they wait through quiet hours before dispatch (prompt #321 is
 * sitting in exactly that state, `lastSuppressedReason: quiet_hours`).
 *
 * DEF-115 verified live on prompt #318, which came from the governor. A fix
 * verified on the path that has the column, protecting nothing on the path that
 * does not, is a closed defect and an open class.
 *
 * Same shape as DEF-039/041/044/045/118: two records of one fact, the reader
 * consulting one. Fixed with a single accessor rather than by teaching six
 * producers to agree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { promptSubjectItemId } from '../src/services/brainPrompts/brainPromptQueueService';

describe('the subject is found wherever the producer put it', () => {
  it('reads the column — action_lifecycle_governor, 18 of 18 prompts', () => {
    expect(promptSubjectItemId({ openItemId: 'cmsernb0o000mrto983hvi22t', metadata: {} }))
      .toBe('cmsernb0o000mrto983hvi22t');
  });

  it('reads metadata — preactive_due_nudge, 14 of 14 prompts, 0 in the column', () => {
    // The case DEF-115 could not see. This is the whole defect.
    expect(promptSubjectItemId({
      openItemId: null,
      metadata: { source: 'preactive_due_nudge', overdue: true, openItemId: 'cmsernb0o000mrto983hvi22t' },
    })).toBe('cmsernb0o000mrto983hvi22t');
  });

  it('prefers the column when both are present — delegation_capture writes both', () => {
    expect(promptSubjectItemId({ openItemId: 'col-id', metadata: { openItemId: 'meta-id' } }))
      .toBe('col-id');
  });
});

describe('a prompt with no subject stays untouched', () => {
  it.each([
    ['both absent', { openItemId: null, metadata: {} }],
    ['no metadata at all', { openItemId: null }],
    ['null metadata', { openItemId: null, metadata: null }],
    ['empty strings', { openItemId: '', metadata: { openItemId: '' } }],
    ['whitespace only', { openItemId: '   ', metadata: { openItemId: '  ' } }],
    ['non-string metadata value', { openItemId: null, metadata: { openItemId: 12345 } }],
    ['metadata is not an object', { openItemId: null, metadata: 'nope' }],
  ])('returns null: %s', (_label, row) => {
    // Most prompts have no item. Returning anything truthy here would feed a
    // junk id to the terminal-status lookup, which finds no row, which DEF-115
    // reads as "deleted item — drop the prompt". That would silence real
    // notifications, the one outcome the guard must never cause.
    expect(promptSubjectItemId(row as any)).toBeNull();
  });
});

describe('the guard uses the accessor, and nothing else re-derives it', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'brainPrompts', 'brainPromptQueueService.ts'), 'utf8');

  it('the stale-subject filter resolves through promptSubjectItemId', () => {
    const at = SRC.indexOf('const withItems');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 400);
    expect(block).toContain('promptSubjectItemId');
  });

  it('the filter no longer reads the column directly', () => {
    // `c.openItemId!` was the original line. Its return would restore the hole.
    const at = SRC.indexOf('const withItems');
    const block = SRC.slice(at, SRC.indexOf('catch (err: any)', at));
    expect(block).not.toMatch(/\.openItemId!/);
  });

  it('metadata is still selected, or the accessor has nothing to read', () => {
    // Anchor on the candidate query's own select, not on `state: 'queued'` —
    // that string appears earlier in queuePrompt and slices the wrong block.
    const at = SRC.indexOf('select: { id: true, criticality: true');
    expect(at, 'candidate select not found').toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 300)).toMatch(/metadata: true/);
  });

  it('still fails OPEN — a broken lookup dispatches rather than drops', () => {
    const at = SRC.indexOf('stale-subject check failed');
    expect(at).toBeGreaterThan(-1);
    const block = SRC.slice(at, at + 200);
    expect(block).toMatch(/stalePromptIds = \[\]/);
  });
});
