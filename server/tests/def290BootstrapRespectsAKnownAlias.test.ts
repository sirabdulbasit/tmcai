/**
 * DEF-290 — a guess overruled stored evidence and put a real person's name on a stranger's words.
 *
 * Owner, 2026-09-02: *"it is wrong, that message was not from Hamna"*. Brain had sent him
 * **`Hamna Latif Bhutta replied: "Ab karo bata"`**. The log settles it — the message arrived
 * `from: "239487846228094@lid"`, and Hamna's stored alias is `255043747987458@lid`. A different
 * identity entirely; the same chatty sender who has been messaging since 08-06.
 *
 * `bootstrapLidBinding` (DEF-075) infers identity from *"exactly one counterpart was messaged
 * recently"*. Brain had recently messaged only her, so the inference named her — **even though
 * her contact already carried a different `waLid`, which is stored evidence that this is somebody
 * else.** It then set `bindingDurable = true` with the comment *"already bound by someone else"*,
 * so the system reported a durable identity while nothing linked this id to her, and because the
 * write was skipped it left no record. The same wrong guess would repeat on every message from
 * that sender, indefinitely and invisibly.
 *
 * This is invariant #5 again — someone he knows quoted as writing words they never wrote — and
 * the DEF-159/DEF-162 class: *a wrong bind is durable and misroutes that person indefinitely*.
 *
 * The rule this file holds: **a contact with a known alias is the strongest evidence that an
 * unknown one is not them.** The reply still routes on its own token (DEF-064 — never thrown
 * away); only the naming is refused.
 */
import { describe, it, expect } from 'vitest';

const src = () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(__dirname, '..', 'src', 'services', 'delegation', 'delegationCaptureService.ts'), 'utf-8');
};
const bootstrapBody = () => {
  const s = src();
  const i = s.indexOf('async function bootstrapLidBinding');
  return s.slice(i, s.indexOf('\n}\n', i));
};
const stripComments = (s: string) =>
  s.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');

describe('DEF-290 — the bootstrap yields to a stored alias', () => {
  it('refuses when the candidate already answers to a DIFFERENT lid', () => {
    const body = stripComments(bootstrapBody());
    expect(body).toContain('meta.waLid !== lid');
    // and refusing means returning nothing — not naming them anyway
    const branch = body.slice(body.indexOf('meta.waLid !== lid'));
    expect(branch.slice(0, branch.indexOf('} else'))).toContain('return null');
  });

  it('no longer claims a durable binding for an id it never bound', () => {
    // The old branch set bindingDurable = true with the comment "already bound by someone else",
    // which reported a durable identity for a lid nothing had linked to that contact.
    const body = stripComments(bootstrapBody());
    const durableLines = body.split('\n').filter((l) => l.includes('bindingDurable = true'));
    // the only surviving one is the branch where THIS lid is the bound one
    expect(durableLines.length).toBe(1);
    // ...and the surviving one is guarded by the refusal branch, not by the old blanket claim.
    expect(body).not.toContain('already bound by someone else');
    expect(durableLines[0]).toContain('this exact lid');
  });

  it('still binds when the candidate has NO alias — DEF-075 keeps working', () => {
    // The feature exists so a delegatee's first reply is attributable at all. Narrowing it must
    // not disable it: an unbound counterpart is still inferred and still recorded.
    const body = stripComments(bootstrapBody());
    expect(body).toContain('if (!meta.waLid)');
    expect(body).toContain("meta.waLidBoundBy = 'reply_bootstrap'");
  });

  it('still declines when there is not exactly one candidate', () => {
    // DEF-075's original guard, untouched: two candidates must never be guessed between.
    const body = stripComments(bootstrapBody());
    expect(body).toContain('distinct.length !== 1');
  });

  it('still refuses a candidate whose number is the lid\'s own digits (DEF-162)', () => {
    const body = stripComments(bootstrapBody());
    expect(body).toContain('lidDigits');
  });

  it('routing is unaffected — the caller still keys on the synthetic token', () => {
    // DEF-064/invariant #6: a reply is never thrown away. Refusing to NAME must not drop it.
    const s = src();
    const resolver = s.slice(s.indexOf('export async function resolveSenderIdentity'));
    const tail = resolver.slice(resolver.indexOf('// 4. We do not know who this is.'));
    expect(tail).toContain('counterpartKey: plainKey');
    expect(tail).toContain("source: 'unknown'");
  });
});
