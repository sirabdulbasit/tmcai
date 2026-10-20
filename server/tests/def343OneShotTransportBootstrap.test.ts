/**
 * DEF-343 — the transport bootstrap that lets a one-shot process reason.
 *
 * Root-caused 2026-10-20 (Codex it-80 directive #1, "the loop's binding
 * constraint"): the benchmark returned null for ~13 iterations ("I'm having
 * trouble reasoning" on all 12 cases) while production was healthy. The split
 * was neither funding nor credentials (the stored Vertex service account
 * mints a token fine through a working HTTP stack): this box's IPv6 egress is
 * black-holed, and Node 20's autoSelectFamily aggregates that into ETIMEDOUT
 * on cold connects to oauth2.googleapis.com via @google/genai's bundled
 * fetch. One-shot processes always connect cold → failed 10/10; the server
 * rode boot-warmed keep-alive sockets → worked, except its transient
 * `all llm providers failed` (consecutiveFailures:1) cold-reconnect events —
 * the same defect. With both knobs set, the previously-failing callLLM probe
 * returned PROBE_OK provider=gemini from a fresh dist process.
 *
 * Both knobs are required (measured): ipv4first alone still lost the
 * happy-eyeballs race.
 */
import { describe, it, expect } from 'vitest';
import dns from 'node:dns';
import net from 'node:net';
import fs from 'fs';
import path from 'path';
import '../src/config/env';

describe('DEF-343 — one-shot transport bootstrap', () => {
  it('importing config/env pins DNS to ipv4first AND disables the broken happy-eyeballs — both, not either', () => {
    expect(dns.getDefaultResultOrder()).toBe('ipv4first');
    expect(net.getDefaultAutoSelectFamily()).toBe(false);
  });

  it('the knobs live in config/env — the one bootstrap every entry imports — and nowhere else', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/config/env.ts'), 'utf8');
    expect(src).toMatch(/setDefaultResultOrder\('ipv4first'\)/);
    expect(src).toMatch(/setDefaultAutoSelectFamily\(false\)/);
    // A second transport bootstrap elsewhere would be the 11th
    // protection-with-two-implementations: the knobs are process-global, so
    // one module owns them.
    const hits = ['../src/services', '../src/jobs', '../src/scripts']
      .flatMap((dir) => {
        const abs = path.join(__dirname, dir);
        const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
          .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name))
            : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []));
        return walk(abs);
      })
      .filter((f) => /setDefaultAutoSelectFamily|setDefaultResultOrder/.test(fs.readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});
