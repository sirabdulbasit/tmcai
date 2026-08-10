/**
 * DEF-115 — a queued prompt outlived its subject.
 *
 * Production, 2026-08-10, timeline nailed down:
 *
 *   11:48:35  prompt #318 queued for "Notify me when image recognition is available"
 *   13:23:10  that item marked DONE and assigned to Nexeo
 *   17:15:49  "The deadline for ... has arrived. Is it completed?"
 *   17:50:48  and again
 *
 * Four hours after it was finished. The same mechanism produced the reminder
 * for "Watcher to study Brain conversations" at 16:03 after it was closed at
 * 07:17 — which I first misdiagnosed as the reminder job ignoring CLOSED. It
 * does not: ACTIVE excludes closed items in both letter cases. Every producer
 * checks status at QUEUE time; nothing checked it again at SEND time, and quiet
 * hours plus backoff can hold a prompt for hours while the world moves.
 *
 * The check can only ever SUPPRESS a prompt whose subject demonstrably no
 * longer needs it, so it cannot invent or misroute anything. The two properties
 * that keep it safe are asserted below: prompts with no item are untouched, and
 * a failed lookup sends anyway.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'brainPrompts', 'brainPromptQueueService.ts'), 'utf8');
const BLOCK = (() => {
  const at = SRC.indexOf('DEF-115');
  expect(at, 'DEF-115 block not found').toBeGreaterThan(-1);
  return SRC.slice(at, at + 3200);
})();

describe('the subject is revalidated at send time', () => {
  it('re-reads the open item before dispatching', () => {
    expect(BLOCK).toMatch(/prisma\.openItem\.findMany/);
  });

  it('drops prompts whose item reached a terminal status', () => {
    expect(BLOCK).toMatch(/'DONE',\s*'CLOSED',\s*'CANCELLED'/);
  });

  it('compares status case-insensitively — the table has held both cases', () => {
    expect(BLOCK).toMatch(/toUpperCase\(\)/);
  });

  it('drops prompts for an item since reassigned to Brain (DEF-109)', () => {
    expect(BLOCK).toContain('isBrainOwned');
  });

  it('drops prompts whose item no longer exists', () => {
    expect(BLOCK).toMatch(/if \(!item\) return true/);
  });
});

describe('it cannot silence a real notification', () => {
  it('leaves prompts with no openItemId completely alone', () => {
    // Most prompts have no item. Dropping those would silence real news.
    expect(BLOCK).toMatch(/filter\(\(c\) => !!c\.openItemId\)/);
  });

  it('FAILS OPEN — a broken lookup dispatches rather than drops', () => {
    // Silently dropping prompts on a failed query is the DEF-085 laundering
    // this project keeps paying for.
    expect(BLOCK).toMatch(/stalePromptIds = \[\];/);
    expect(BLOCK).toMatch(/dispatching without it/);
  });

  it('marks dropped prompts expired rather than deleting them', () => {
    expect(BLOCK).toMatch(/state: 'expired'/);
    expect(BLOCK).not.toMatch(/deleteMany/);
  });

  it('logs what it dropped, with ids', () => {
    expect(BLOCK).toMatch(/dropped prompts whose subject is finished/);
    expect(BLOCK).toMatch(/promptIds/);
  });
});

describe('the filtered list is what actually gets sent', () => {
  it('sendable reads freshCandidates, not the unfiltered list', () => {
    // A filter computed and then not used is the shape that produced DEF-039.
    const at = SRC.indexOf('const sendable = (inFlight');
    const sendableBlock = SRC.slice(at, at + 300);
    expect(sendableBlock).toContain('freshCandidates');
    expect(sendableBlock).not.toContain('dueCandidates');
  });
});
