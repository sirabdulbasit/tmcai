/**
 * DEF-351 — the two loss edges DEF-350's coverage-from-queue-state newly
 * leans on (Codex DEF-350-review risks #1 and #2), closed:
 *
 *  (1) THROW-SAFETY of the dispatcher's optimistic promote. The dispatcher
 *      promotes a prompt to its sent-shaped state (`answered` for a notice,
 *      `awaiting_reply` for a question) BEFORE the channel send. A send that
 *      returned {sent:false} already rolled back to `queued`; a send that
 *      THREW did not — stranding a notice in `answered`, which the stale
 *      sweep never touches and which DEF-350 counts as covering. A learn
 *      digest so stranded would mark its proposals covered-but-undelivered
 *      forever. Now a throw rolls back exactly like {sent:false} and
 *      rethrows the original error.
 *
 *  (2) ONE state vocabulary. `DIGEST_LOST_STATES` was a second definition of
 *      the queue's states — the `protection-with-two-implementations` shape
 *      one level down: a future terminal state (`failed`, `dead`) not added
 *      there would default to covering → silent loss. It is now an ALIAS of
 *      the queue module's own canonical sets, and a TRIPWIRE scans every
 *      state literal written against the prompt queue anywhere in src: an
 *      unclassified state fails the matrix until a human classifies it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  PROMPT_TERMINAL_LOST_STATES, PROMPT_LIVE_OR_DELIVERED_STATES,
} from '../src/services/brainPrompts/brainPromptQueueService';
import { DIGEST_LOST_STATES } from '../src/services/learning/proposalDigest';

const SRC_ROOT = path.join(__dirname, '../src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name))
      : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('DEF-351 — the loss edges under DEF-350 coverage', () => {
  it('ONE vocabulary: DIGEST_LOST_STATES is the queue module\'s own set, by reference — not a copy that can drift', () => {
    expect(DIGEST_LOST_STATES).toBe(PROMPT_TERMINAL_LOST_STATES);
    // the two sets are disjoint and complete over today's vocabulary
    for (const s of PROMPT_TERMINAL_LOST_STATES) {
      expect(PROMPT_LIVE_OR_DELIVERED_STATES.has(s)).toBe(false);
    }
  });

  it('TRIPWIRE: every prompt-queue state literal in src is classified in exactly one of the two sets', () => {
    const classified = new Set([...PROMPT_TERMINAL_LOST_STATES, ...PROMPT_LIVE_OR_DELIVERED_STATES]);
    const unclassified: string[] = [];
    let literalsSeen = 0;
    for (const file of walk(SRC_ROOT)) {
      const src = fs.readFileSync(file, 'utf8');
      if (!/brainPromptQueue|brain_prompt_queue/.test(src)) continue;
      // Scope to the sites that actually touch THIS table — other models'
      // state machines (delegation dispatch_pending, withdrawal-batch
      // pending/sent) legitimately live in the same files:
      //  - a window after each Prisma brainPromptQueue accessor (covers the
      //    tx-aliased `db.brainPromptQueue` in the queue service too);
      //  - any template/string literal containing brain_prompt_queue (raw SQL).
      const sites: string[] = [];
      for (const m of src.matchAll(/\b\w+\.brainPromptQueue\.\w+\(/g)) {
        sites.push(src.slice(m.index!, m.index! + 900));
      }
      for (const m of src.matchAll(/`[^`]*brain_prompt_queue[^`]*`/gs)) sites.push(m[0]);
      for (const site of sites) {
        for (const m of site.matchAll(/\bstate\s*(?::|=|<>|!=)=?\s*'([a-z_]+)'/g)) {
          literalsSeen += 1;
          if (!classified.has(m[1])) {
            unclassified.push(`${path.relative(SRC_ROOT, file)} — state '${m[1]}'`);
          }
        }
      }
    }
    // Floor: if the extractor silently degrades to scanning nothing, fail
    // loudly instead of going green (the DEF-346 lesson).
    expect(literalsSeen).toBeGreaterThan(15);
    expect(unclassified, `prompt-queue state literals not classified in brainPromptQueueService's canonical sets (DEF-350 coverage would guess):\n${unclassified.join('\n')}`).toEqual([]);
  });

  it('THROW-SAFETY: a send that throws rolls the promoted row back to queued — pinned at the call site with its answeredAt reset', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'services/brainPrompts/brainPromptQueueService.ts'), 'utf8');
    // the send is inside a try whose catch rolls back BOTH promote shapes and
    // rethrows the original error
    const tryBlock = src.slice(src.indexOf('let r: Awaited<ReturnType<typeof brainContactsUser>>'), src.indexOf('// ── DEF-063'));
    expect(tryBlock).toContain('brainContactsUser({');
    expect(tryBlock).toContain("state: 'queued'");
    expect(tryBlock).toContain('sentAt: null');
    expect(tryBlock).toContain('answeredAt: null'); // the notice promote set it; the rollback clears it
    expect(tryBlock).toContain('throw sendErr');    // the original error still surfaces
    expect(tryBlock).toContain('.catch(() => undefined)'); // a failing rollback cannot mask it
  });
});
