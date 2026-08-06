/**
 * DEF-037 — "did you…?" is a ledger query, and DEF-049 — introduce once.
 *
 * The failure, verbatim. Owner: "did you inform hamna about items delegated to
 * her?" Brain: "No Sir, I have not. I was waiting for you to confirm her
 * contact details. I don't have a contact entry for 'Hamna Latif'." It had
 * emailed her an hour earlier (messageId 19fd12e8abc16d71) and held both her
 * email and her phone.
 *
 * Brain was not lying. The only view of dispatches available to it was
 * renderArtifactsBlock(history) — a filter over the CONVERSATION TRANSCRIPT.
 * An hour and a dozen turns later that action had fallen out of the trimmed
 * window, so the model answered "did I?" by inference. The row was in
 * brain_action_artifacts the entire time.
 *
 * Same root cause as DEF-019 ("my WhatsApp connection is degraded" while the DB
 * said connected for four days) and both DEF-034 denials. One class:
 *
 *     A MEMORY OF A CONVERSATION IS NOT EVIDENCE ABOUT THE WORLD.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const H = vi.hoisted(() => ({
  prismaMock: {
    brainActionArtifact: { findMany: vi.fn() },
    whatsAppMessage: { findMany: vi.fn() },
    entity: { findFirst: vi.fn(), update: vi.fn() },
  },
}));
vi.mock('../src/db/prisma', () => ({ default: H.prismaMock }));

import { buildDispatchLedgerBlock } from '../src/services/knowledge/dispatchLedgerService';
import {
  renderOutboundMessage, isFirstContactWith, markIntroduced,
} from '../src/services/notifications/outboundMessageTemplate';

beforeEach(() => {
  vi.clearAllMocks();
  H.prismaMock.whatsAppMessage.findMany.mockResolvedValue([]);
});

describe('DEF-037 — the dispatch record reaches the prompt', () => {
  it('lists a real send with its time and target', async () => {
    H.prismaMock.brainActionArtifact.findMany.mockResolvedValue([{
      createdAt: new Date('2026-08-05T09:08:44Z'), actionType: 'send_email',
      status: 'succeeded', payload: { recipientName: 'Hamna Latif Bhutta', subject: 'Updates on delegated items' },
      artifactExtId: '19fd12e8abc16d71', errorMessage: null,
    }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('Emailed');
    expect(block).toContain('Hamna Latif Bhutta');
    expect(block).toContain('19fd12e8abc16d71'.slice(-12));
  });

  it('an EMPTY ledger still renders — silence would restore the guessing', async () => {
    H.prismaMock.brainActionArtifact.findMany.mockResolvedValue([]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('no actions dispatched');
    expect(block.length).toBeGreaterThan(0);
  });

  it('states plainly that it, not the conversation, is the source of truth', async () => {
    H.prismaMock.brainActionArtifact.findMany.mockResolvedValue([]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toMatch(/not the conversation/i);
    expect(block).toMatch(/did you/i);
  });

  it('folds in the delivery tick when there is one (DEF-052)', async () => {
    H.prismaMock.brainActionArtifact.findMany.mockResolvedValue([{
      createdAt: new Date('2026-08-05T12:17:00Z'), actionType: 'notify_via_whatsapp',
      status: 'succeeded', payload: { recipientName: 'Hamna' }, artifactExtId: 'wamid.ABC', errorMessage: null,
    }]);
    H.prismaMock.whatsAppMessage.findMany.mockResolvedValue([{ messageId: 'wamid.ABC', status: 'read' }]);
    const block = await buildDispatchLedgerBlock(2, 'TMC-0001');
    expect(block).toContain('[read]');
  });

  it('a ledger read failure never breaks the turn', async () => {
    H.prismaMock.brainActionArtifact.findMany.mockRejectedValue(new Error('db down'));
    await expect(buildDispatchLedgerBlock(2, 'TMC-0001')).resolves.toContain('no actions dispatched');
  });

  it('the composer passes it as its own block, and the prompt forbids guessing', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
    expect(c).toContain('buildDispatchLedgerBlock');
    expect(c).toContain('dispatchLedger:');
    expect(c).toMatch(/DID YOU…\?" IS ANSWERED FROM THE DISPATCH RECORD/);
  });
});

describe('DEF-049 — introduced once, then just talked to', () => {
  const sig = { brainName: 'Suzi', userName: 'Basit Ahmed' };

  it('a stranger is told who is writing and where their reply goes', () => {
    const out = renderOutboundMessage('Sir Basit is asking if you will be coming to the office tomorrow.', sig, { firstContact: true });
    // First name only — spelling the full name three times in four lines is
    // the wordiness the owner rejected in the Day Brief (2026-08-06).
    expect(out).toContain("Suzi here — I'm Basit's assistant");
    expect(out, 'people over-share with machines; the reply destination must be stated')
      .toContain('comes straight to Basit');
  });

  it('the second message has no preamble at all', () => {
    const out = renderOutboundMessage('Any update on the portal?', sig, { firstContact: false });
    expect(out).not.toContain('assistant.');
    expect(out).toBe('Hi,\nAny update on the portal?\n\nSuzi\nBasit Ahmed\'s Assistant');
  });

  it('matches the owner-specified format exactly', () => {
    expect(renderOutboundMessage('Sir Basit is asking if you will be coming to the office tomorrow', sig))
      .toBe('Hi,\nSir Basit is asking if you will be coming to the office tomorrow\n\nSuzi\nBasit Ahmed\'s Assistant');
  });

  it('both names come from the caller — nothing hardcoded', () => {
    const out = renderOutboundMessage('hello', { brainName: 'Jarvis', userName: 'Someone Else' });
    expect(out).toContain("Jarvis\nSomeone Else's Assistant");
    expect(out).not.toContain('Suzi');
    expect(out).not.toContain('Basit');
  });

  it('never stacks a greeting on a re-render', () => {
    const once = renderOutboundMessage('hello', sig);
    expect(renderOutboundMessage(once, sig)).toBe(once);
  });

  it('an unknown contact is treated as a first contact', async () => {
    H.prismaMock.entity.findFirst.mockResolvedValue(null);
    expect(await isFirstContactWith('nope')).toBe(true);
    expect(await isFirstContactWith(undefined)).toBe(true);
  });

  it('someone already introduced to is not introduced again', async () => {
    H.prismaMock.entity.findFirst.mockResolvedValue({ metadata: { introducedAt: '2026-08-05T10:00:00Z' } });
    expect(await isFirstContactWith('c1')).toBe(false);
  });

  it('a DB failure introduces rather than staying silent', async () => {
    H.prismaMock.entity.findFirst.mockRejectedValue(new Error('down'));
    expect(await isFirstContactWith('c1')).toBe(true);
  });

  it('marking is idempotent — the first timestamp stands', async () => {
    H.prismaMock.entity.findFirst.mockResolvedValue({ metadata: { introducedAt: '2026-08-05T10:00:00Z' } });
    await markIntroduced('c1');
    expect(H.prismaMock.entity.update).not.toHaveBeenCalled();
  });

  it('only marks introduced AFTER a confirmed send', () => {
    const c = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
    // A failed send must not consume the introduction and leave the next
    // message reading like a stranger's.
    expect(c).toMatch(/if \(r\.ok\) \{[\s\S]{0,300}markIntroduced/);
  });
});
