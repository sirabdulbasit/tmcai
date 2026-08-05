/**
 * DEF-060 — five days of silence from one wrong string literal.
 *
 * The owner: "brain send message to Hamna and she responded to Brain but it
 * didnt notify me." Production log:
 *
 *   "whatsapp:sender-triage" — "sender triage failed — inbound held"
 *   Invalid `prisma.brainPromptQueue.create()` invocation:
 *   PostgresError { code: "23514", ... violates check constraint }
 *
 * 23514 is a CHECK-constraint violation. `triageUnregisteredInbound` enqueued
 * with `criticality: 'normal'`, but the type is 'routine' | 'high' | 'top' and
 * the database enforces it. So EVERY notification about an unknown sender
 * failed to insert, the inbound was "held", and the only trace was a warn line
 * the owner never sees. `brain_prompt_queue` had no new row since 2026-07-31.
 *
 * Three separate failures made a one-word typo invisible for five days:
 *
 *   1. `as any` on the call suppressed the compile error that would have
 *      caught it instantly.
 *   2. The catch swallowed the failure into a log line, so the system looked
 *      healthy while dropping real people's messages.
 *   3. The queue was the ONLY route to the owner, so its failure meant total
 *      silence rather than degraded service.
 *
 * All three are fixed here, not just the literal.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const P = path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'senderTriage.ts');
const SRC = fs.readFileSync(P, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('DEF-060 — the literal', () => {
  it("never enqueues an invalid criticality again", () => {
    expect(
      CODE,
      "'normal' is not a Criticality — the DB rejects it with 23514 and the "
      + 'owner hears nothing',
    ).not.toMatch(/criticality:\s*['"]normal['"]/);
  });

  it('uses routine, so a wrong number cannot ring the owner', () => {
    // channelForCriticality escalates 'high' to a voice note or business call.
    // An unknown sender is exactly the case where that must not happen.
    const branch = CODE.slice(CODE.indexOf('enqueueBrainPrompt({'));
    expect(branch.slice(0, 600)).toMatch(/criticality:\s*'routine'/);
  });

  it('the enqueue is no longer cast to any', () => {
    // The cast is what let a bad literal past the compiler and left the
    // database to find it, at runtime, five days later.
    const branch = CODE.slice(CODE.indexOf('enqueueBrainPrompt({'));
    const call = branch.slice(0, branch.indexOf('log.info'));
    expect(call).not.toMatch(/\}\s*as any\s*\)/);
  });
});

describe('DEF-060 — the queue is no longer a single point of silence', () => {
  it('a failed enqueue still reaches the owner by a different route', () => {
    const cat = CODE.slice(CODE.indexOf('sender triage failed'));
    expect(cat).toContain('brainContactsUser');
    expect(
      cat,
      'brainContactsUser is a direct send and does not touch brain_prompt_queue, '
      + 'so it survives the exact failure that caused this',
    ).not.toContain('enqueueBrainPrompt');
  });

  it('the fallback can still name the owner and the sender', () => {
    // Both were scoped inside the try, so at the moment they were needed the
    // code could not answer "who do I tell, and about whom?".
    expect(CODE).toMatch(/let ownerUserId: number \| null = null/);
    expect(CODE).toMatch(/let senderName: string \| null = null/);
    expect(CODE).not.toMatch(/const \[evidence, senderName\]/); // no shadowing
  });

  it('a fallback that also fails is logged at ERROR, not warn', () => {
    // Silence is the failure mode being fixed; it must be loud when total.
    expect(CODE).toMatch(/log\.error\([\s\S]{0,80}owner not informed/);
  });

  it('the fallback says plainly that it could not queue properly', () => {
    expect(SRC).toMatch(/could not queue this for a proper decision/);
  });
});
