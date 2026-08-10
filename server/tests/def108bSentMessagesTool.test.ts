/**
 * DEF-108b — "what did you send?" had no tool that could answer it.
 *
 * Production, 2026-08-10 16:21. Third time of asking. Brain's own rationale was
 * right — "I need to check my actual sent items to answer accurately and
 * resolve the discrepancy they've pointed out" — and then it called
 * `fetch_sent_emails`, because that was the only sent-items tool in the
 * registry. It searched Gmail to answer a question about WhatsApp, got 221
 * bytes of nothing, and told the owner it had sent nothing. He had watched
 * those messages arrive.
 *
 * DEF-108 fixed the recording side. This fixes the reading side: without a tool
 * over the ledger, `fetch_sent_emails` stays the only answer to "what did you
 * send" no matter what the ledger contains.
 *
 * The assertion that matters most is the empty case. Reporting an empty ledger
 * as "I sent nothing" is the DEF-085 laundering that caused the original false
 * denial, so the tool must distinguish "nothing recorded" from "nothing sent",
 * and must never answer "nothing" when the lookup FAILED.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const getRecentDispatches = vi.fn();
vi.mock('../src/services/knowledge/dispatchLedgerService', () => ({
  getRecentDispatches: (...a: any[]) => getRecentDispatches(...a),
}));

import { BRAIN_TOOLS } from '../src/services/knowledge/brainTools';

const tool = () => BRAIN_TOOLS.find((t: any) => t.name === 'fetch_sent_messages')!;
const CTX = { userId: 2, clientNumber: 'TMC-0001' };

beforeEach(() => getRecentDispatches.mockReset());

describe('the tool exists and is reachable by the model', () => {
  it('is registered', () => {
    expect(tool()).toBeDefined();
  });

  it('its description steers WhatsApp questions here, not to the email tool', () => {
    const d = tool().description.toLowerCase();
    expect(d).toContain('whatsapp');
    expect(d).toMatch(/did you message|what did you send/);
    // Must actively disambiguate from the tool that mis-answered on 08-10.
    expect(d).toContain('fetch_sent_emails');
  });
});

describe('it reports facts from the ledger', () => {
  it('lists dispatches with time, type, status and delivery', async () => {
    getRecentDispatches.mockResolvedValue([
      { at: new Date('2026-08-10T00:13:06Z'), actionType: 'notify_via_whatsapp', status: 'succeeded',
        summary: 'Hamna Latif Bhutta', externalId: 'ABC123', delivery: 'read' },
    ]);
    const out = await tool().handler({}, CTX);
    expect(out).toContain('notify_via_whatsapp');
    expect(out).toContain('Hamna Latif Bhutta');
    expect(out).toContain('delivery: read');
    expect(out).toContain('2026-08-10 00:13');
  });

  it('caps the result set', async () => {
    getRecentDispatches.mockResolvedValue([]);
    await tool().handler({ max: 999 }, CTX);
    expect(getRecentDispatches).toHaveBeenCalledWith(2, 'TMC-0001', 50);
  });
});

describe('the empty and failed cases — where the original false denial came from', () => {
  it('says NOTHING RECORDED, not "nothing sent"', async () => {
    getRecentDispatches.mockResolvedValue([]);
    const out = await tool().handler({}, CTX);
    expect(out).toMatch(/nothing recorded/i);
    // The distinction that stops a flat denial being generated from an empty
    // table — this is the sentence that would have prevented 2026-08-10 14:58.
    expect(out).toMatch(/not the same as/i);
  });

  it('never answers "nothing" when the lookup FAILED', async () => {
    // Set and consume within the same tick: a rejected promise left dangling
    // across a mockReset boundary is reported by vitest as an unhandled
    // rejection and attributed to whichever test is running.
    getRecentDispatches.mockImplementation(() => Promise.reject(new Error('relation does not exist')));
    const out = await tool().handler({}, CTX);
    getRecentDispatches.mockResolvedValue([]);
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/do not report this as/i);
    expect(out).toContain('relation does not exist');
  });
});

describe('read-only, per the registry contract', () => {
  it('the handler performs no writes', () => {
    const SRC = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainTools.ts'), 'utf8');
    const at = SRC.indexOf('const fetchSentMessages');
    const block = SRC.slice(at, SRC.indexOf('const fetchSentEmails'));
    for (const w of ['.create(', '.update(', '.delete(', '.upsert(']) {
      expect(block, `tool must not ${w}`).not.toContain(w);
    }
  });
});
