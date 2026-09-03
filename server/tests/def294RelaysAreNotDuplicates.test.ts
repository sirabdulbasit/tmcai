/**
 * DEF-294 — a second person's message inside a minute was dropped as a duplicate.
 *
 * Owner, 2026-09-03: *"i also often see that someone has sent messaged to brain but it didnt
 * notify"*. Live evidence from the box:
 *
 *   rate-limited kind=wa_counterpart_message ageSec=8
 *   rate-limited kind=wa_counterpart_message ageSec=55
 *   rate-limited kind=wa_counterpart_message ageSec=9
 *
 * A 60-second per-kind limiter guards against twin pings of the SAME notification, which is a
 * real failure it was built for. But it keys on `kind`, and **every relayed human message shares
 * one kind** — so a second message inside a minute is discarded as a duplicate of the first, even
 * when it is a different human. Two people writing a minute apart and he hears about one.
 *
 * The relay path's own protection is stronger and per-message: a distinct `dedupKey`
 * (`wa_counterpart:<identity>:<body>`) AND a distinct content hash — verified during DEF-271,
 * where all four relays that day were confirmed distinct on both. The twin-notification case this
 * limiter exists for cannot arise here.
 *
 * The narrowness is the point, and the last test holds it: every OTHER kind still rate-limits.
 */
import { describe, it, expect } from 'vitest';

const src = () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  return readFileSync(join(__dirname, '..', 'src', 'services', 'notifications', 'brainOutboundService.ts'), 'utf-8');
};
const noComments = (s: string) =>
  s.split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); }).join('\n');

describe('DEF-294 — relays are exempt from the per-kind limiter', () => {
  it('a relayed human message skips the limiter', () => {
    // DEF-308 — this asserted the literal `req.kind === 'wa_counterpart_message'`
    // until the volume reserve needed the same question answered. Two
    // protections each deciding independently what "a person wrote this" means
    // would be the 11th `protection-with-two-implementations` in a codebase
    // carrying ten, and they would drift the first time a second relay kind was
    // added: it would gain the reserve and silently keep rate-limiting.
    //
    // So the assertion is now the stronger one — the exemption reads the SHARED
    // set. Pinning the literal would have forbidden exactly the de-duplication
    // this codebase keeps paying for.
    const code = noComments(src());
    expect(code).toContain('HUMAN_KINDS.has(req.kind)');
    expect(code).toContain("export const HUMAN_KINDS = new Set(['wa_counterpart_message'])");
    expect(code).toContain('!isRelayedHumanMessage');
  });

  it('the exemption is applied to the limiter QUERY, not merely computed', () => {
    // A flag that nothing reads is the shape of DEF-054: a producer with no consumer.
    const code = noComments(src());
    const at = code.indexOf('const rec =');
    expect(at).toBeGreaterThan(0);
    const line = code.slice(at, code.indexOf('\n', at));
    expect(line).toContain('!isRelayedHumanMessage');
  });

  it('the limiter still exists for every other kind', () => {
    // Deleting the guard would re-open the twin-notification bug of 2026-05-04. Narrowing it is
    // the fix; removing it is a different defect.
    const code = noComments(src());
    expect(code).toContain('KIND_MIN_INTERVAL_MS');
    expect(code).toContain('kind: req.kind');
    expect(code).toContain('bypassRateLimit');
  });

  it('relays are still protected by their own per-message dedup', () => {
    // The exemption is only safe because something stronger already guards this path. If the
    // relay dedupKey ever stops carrying the identity and body, this exemption must be revisited.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const triage = readFileSync(join(__dirname, '..', 'src', 'services', 'whatsapp', 'senderTriage.ts'), 'utf-8');
    expect(triage).toContain('dedupKey: `wa_counterpart:${params.fromNumber}:${params.body.slice(0, 40)}`');
  });
});
