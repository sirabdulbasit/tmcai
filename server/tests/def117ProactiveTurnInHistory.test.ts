/**
 * DEF-117 — the owner replied to a message Brain could not see.
 *
 * Production, 2026-08-11:
 *
 *   05:18  brain → owner: "Hi, this is a reminder from Nexeo. The 'Vision
 *          Metric's service sales package video' is now overdue."
 *   05:52  owner → brain: "did u ask this from Hamna?"
 *   05:52  brain → owner: "Sir, to clarify, what did you want me to ask Hamna
 *          about? We were just discussing the 'Stock Report' task for Ali
 *          Haider, and I haven't sent anything about that yet."
 *
 * Scored 71 — C3 50, C5 50, C6 30. The judge called it ignoring the question
 * and changing the subject. It was neither: the reminder was sent by the prompt
 * queue, which writes `brain_user_messages` and nothing else. Only
 * WhatsAppInbound ever appended to `whatsapp_sessions.conversation_history`, so
 * the thread Brain reads had no record of it and "this" resolved against the
 * previous HUMAN turn — yesterday's Stock Report.
 *
 * The assertions that carry weight are the exclusions. Appending a failed or
 * suppressed send would leave Brain believing it said something the owner never
 * received, and it would then defend that statement — the same fabrication
 * DEF-108's ledger rules exist to prevent, one table over.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const executeRawUnsafe = vi.fn(async () => 1);
vi.mock('../src/db/prisma', () => ({
  default: { $executeRawUnsafe: (...a: any[]) => executeRawUnsafe(...a) },
}));

import { appendBrainTurnToSession } from '../src/services/whatsapp/sessionHistoryService';

const SQL = () => String(executeRawUnsafe.mock.calls[0][0]);
const ARGS = () => executeRawUnsafe.mock.calls[0].slice(1);

beforeEach(() => {
  executeRawUnsafe.mockReset();
  executeRawUnsafe.mockResolvedValue(1);
});

describe('the message lands in the thread', () => {
  it('appends it as an assistant turn — the shape the inbound reader maps to role "brain"', async () => {
    await appendBrainTurnToSession('TMC-0001', 2, 'The video is now overdue.');
    const entry = JSON.parse(String(ARGS()[2]));
    expect(entry).toEqual([{ role: 'assistant', content: 'The video is now overdue.' }]);
  });

  it('stores the body verbatim — Brain\'s view of the thread must match the owner\'s', async () => {
    const long = 'x'.repeat(900);
    await appendBrainTurnToSession('TMC-0001', 2, long);
    // The audit row truncates summary at 500; the thread must not, or Brain
    // reads half of what it sent and answers about the wrong half.
    expect(JSON.parse(String(ARGS()[2]))[0].content).toHaveLength(900);
  });

  it('scopes to the tenant and user', async () => {
    await appendBrainTurnToSession('TMC-0001', 2, 'hi');
    expect(ARGS()[0]).toBe(2);
    expect(ARGS()[1]).toBe('TMC-0001');
    expect(SQL()).toMatch(/user_id = \$1 AND client_number = \$2/);
  });

  it('targets the live session only — never a closed or expired one', async () => {
    await appendBrainTurnToSession('TMC-0001', 2, 'hi');
    expect(SQL()).toMatch(/closed_at IS NULL/);
    expect(SQL()).toMatch(/last_message_at > NOW\(\) - INTERVAL '24 hours'/);
  });

  it('trims to the same window the inbound path keeps', async () => {
    await appendBrainTurnToSession('TMC-0001', 2, 'hi');
    // WhatsAppInbound writes history.slice(-20). A different cap here would
    // mean the thread length changes depending on who wrote last.
    expect(SQL()).toMatch(/- 20, 0/);
  });

  it('never reads the array into JS — a read-modify-write would drop concurrent appends', async () => {
    await appendBrainTurnToSession('TMC-0001', 2, 'hi');
    expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(SQL().trim().startsWith('UPDATE')).toBe(true);
  });
});

describe('it reports honestly when there was nowhere to put it', () => {
  it('returns false when no live session matched', async () => {
    executeRawUnsafe.mockResolvedValue(0);
    expect(await appendBrainTurnToSession('TMC-0001', 2, 'hi')).toBe(false);
  });

  it('returns true when a session was updated', async () => {
    expect(await appendBrainTurnToSession('TMC-0001', 2, 'hi')).toBe(true);
  });

  it('writes nothing for an empty body', async () => {
    expect(await appendBrainTurnToSession('TMC-0001', 2, '   ')).toBe(false);
    expect(executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('the send path only records what the owner actually received', () => {
  const OUT = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'notifications', 'brainOutboundService.ts'), 'utf8');
  // Anchored on the call, not on prose: this file's comments quote status
  // strings verbatim, and an indexOf on a comment finds the wrong block.
  const at = OUT.indexOf('appendBrainTurnToSession');
  const block = OUT.slice(Math.max(0, at - 900), at + 400);

  it('is wired into the outbound send path at all', () => {
    expect(at).toBeGreaterThan(-1);
  });

  it('appends on sent or partial only', () => {
    expect(block).toMatch(/o\.status === 'sent' \|\| o\.status === 'partial'/);
  });

  it('never appends a failed or suppressed send', () => {
    // A message the owner never received must not become something Brain
    // believes it said. This is the assertion that matters most in the file.
    const guard = /if \(o\.status === 'sent' \|\| o\.status === 'partial'\)/.exec(block);
    expect(guard, 'append must sit under its own status guard').not.toBeNull();
    const afterGuard = block.slice(guard!.index, guard!.index + 400);
    expect(afterGuard).not.toMatch(/'failed'/);
    expect(afterGuard).not.toMatch(/'suppressed'/);
  });

  it('passes the delivered body, not the truncated audit summary', () => {
    expect(block).toMatch(/appendBrainTurnToSession\([^)]*o\.body\)/);
  });

  it('cannot break a delivered send, and does not fail silently', () => {
    expect(block).toContain('catch');
    expect(block).toMatch(/will not see this message next turn/);
  });
});

describe('one implementation', () => {
  it('no other module writes conversation_history except the inbound path and this service', () => {
    const root = path.join(__dirname, '..', 'src');
    const writers: string[] = [];
    const walk = (dir: string) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.ts')) {
          const s = fs.readFileSync(p, 'utf8');
          if (/SET\s+conversation_history|conversation_history\s*=\s*\$/i.test(s)) writers.push(f.name);
        }
      }
    };
    walk(root);
    // Two writers is the design. A third is the shape that produced DEF-039,
    // DEF-041, DEF-044 and DEF-045 — a rule with more than one implementation.
    expect(writers.sort()).toEqual(['WhatsAppInbound.ts', 'sessionHistoryService.ts']);
  });
});
