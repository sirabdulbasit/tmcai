/**
 * DEF-078 — the same contact received two different formats.
 *
 * The owner, from Hamna's phone, two consecutive messages:
 *
 *   Hi,
 *   Sir is asking about the status of the WhatsApp issue to Zong sim…
 *   Suzi
 *   Assistant Basit
 *
 *   Hi Hamna Latif Bhutta, this is Suzi — Basit's AI assistant. Basit asked me
 *   to let you know:
 *   Sir is asking for an update on the Vision Metric Integration…
 *
 * He asked whether Brain was varying its wording deliberately. It was not.
 * There is no variation logic — there were FOUR implementations of the wrapper:
 *
 *   brainComposer.ts:6292          plan-step notify      fixed earlier
 *   actionLifecycleWorker.ts:51    follow-up worker      fixed earlier (DEF-074)
 *   brainComposer.ts:3800          inline notify         MISSED
 *   genericActionDispatcher.ts:171 generic dispatch      MISSED
 *
 * I unified two this morning, declared it done, and left two. That is the
 * seventh time in this codebase that a rule with several implementations has
 * produced a visible defect — DEF-039, 041, 044, 045, 051, 074, and this.
 *
 * Finding two of four is worse than finding none, because it looks fixed.
 * These tests count the copies rather than trusting a reading.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SEND_SITES = [
  'services/knowledge/brainComposer.ts',
  'services/knowledge/genericActionDispatcher.ts',
  'jobs/actionLifecycleWorker.ts',
];

describe('DEF-078 — exactly one outbound renderer', () => {
  it('no send site builds its own intro string', () => {
    for (const f of SEND_SITES) {
      expect(strip(read(f)), `${f} must not compose the wrapper itself`)
        .not.toMatch(/asked me to let you know/);
      expect(strip(read(f)), `${f} must not hand-roll the assistant intro`)
        .not.toMatch(/this is \$\{[^}]*\} — \$\{[^}]*\}'s AI assistant/);
    }
  });

  it('every WhatsApp send site calls renderOutboundMessage', () => {
    for (const f of SEND_SITES) {
      const code = strip(read(f));
      if (!code.includes('sendTenantWhatsAppText')) continue;
      expect(code, `${f} sends WhatsApp but does not use the shared renderer`)
        .toContain('renderOutboundMessage');
    }
  });

  it('the model is told to write ONLY the substantive sentence', () => {
    // The schema used to describe the old intro as auto-prepended. A model
    // told the wrong wrapper writes around a wrapper that no longer exists.
    const c = read('services/knowledge/brainComposer.ts');
    expect(c).toMatch(/The substantive text ONLY/);
    expect(c).not.toMatch(/Introduction "Hi <name>, this is Nexeo/);
  });

  it('the seeded preview matches what is actually sent', () => {
    const seed = read('scripts/seedActionDefinitions.ts');
    expect(seed).toMatch(/\{userName\}\\'s Assistant/);
    expect(seed).not.toMatch(/asked me to let you know/);
  });

  it('the renderer itself still produces the owner-specified shape', async () => {
    const { renderOutboundMessage } = await import('../src/services/notifications/outboundMessageTemplate');
    expect(renderOutboundMessage('Sir is asking for an update on the Vision Metric Integration.',
      { brainName: 'Suzi', userName: 'Basit' }))
      .toBe("Hi,\nSir is asking for an update on the Vision Metric Integration.\n\nSuzi\nBasit's Assistant");
  });
});
