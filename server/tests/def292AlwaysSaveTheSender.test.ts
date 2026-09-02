/**
 * DEF-292 — always save who a message came from.
 *
 * Owner ruling, 2026-09-02: *"whenever you receive any message from anyone always save the sender
 * number, can you do this??"*
 *
 * Yes, with one carve-out that is WhatsApp's, not ours. DEF-291 traced it into WhatsApp's own
 * code: for an `@lid` sender it asks its contact store, queries its servers, asks again, and
 * returns nothing until a relationship exists. We cannot invent what it withholds.
 *
 * Everything it DOES give us is now kept, on every message: the raw identifier (the stable key
 * for that human), the display name, and — the point of this — **the real number the first moment
 * WhatsApp ever supplies one**, landing on an identity that already carries the whole history.
 *
 * Two rules the tests below hold, both learned the hard way:
 *   - the SYNTHETIC is never stored as a number (DEF-121: a fabricated number is worse than none,
 *     because it looks actionable);
 *   - a later blank never erases what an earlier message told us, and a later DIFFERENT number
 *     never silently rebinds (DEF-162: a wrong bind is durable and misroutes indefinitely).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const exec = vi.fn();
vi.mock('../src/db/prisma', () => ({ default: { $executeRawUnsafe: (...a: any[]) => exec(...a) } }));

import { rememberSender } from '../src/services/whatsapp/senderTriage';

// index 0 is the SQL; the $1..$6 parameters follow it.
const sql = () => String(exec.mock.calls[0][0]).replace(/\s+/g, ' ');
const args = (n: number) => exec.mock.calls[0][n];

beforeEach(() => { vi.clearAllMocks(); exec.mockResolvedValue(1); });

describe('DEF-292 — every sender is recorded', () => {
  it('saves the raw identifier and the display name', async () => {
    await rememberSender({
      clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+239487846228094',
      rawSenderId: '239487846228094@lid', displayName: 'Ali Raza',
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(args(4)).toBe('239487846228094@lid');
    expect(args(5)).toBe('Ali Raza');
  });

  it('saves a REAL number when WhatsApp supplies one', async () => {
    await rememberSender({
      clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+923001234567',
      rawSenderId: '239487846228094@lid', resolvedPhone: '+923001234567',
    });
    expect(args(6)).toBe('+923001234567');
  });

  it('NEVER stores the synthetic as if it were a number', async () => {
    // DEF-121. `+239487846228094` is the lid's own digits wearing a plus — not dialable, and
    // storing it would make every later reader believe we have a number.
    await rememberSender({
      clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+239487846228094',
      rawSenderId: '239487846228094@lid', resolvedPhone: '+239487846228094',
    });
    expect(args(6)).toBeNull();
  });

  it('still records the identity even with no name and no number', async () => {
    // The common case on first contact. An anonymous sender is still a sender we have seen.
    await rememberSender({
      clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+239487846228094',
      rawSenderId: '239487846228094@lid',
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(args(5)).toBeNull();
    expect(args(6)).toBeNull();
  });

  it('counts every inbound rather than overwriting the row', async () => {
    await rememberSender({ clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+1' });
    expect(sql()).toContain('inbound_count = wa_sender_policy.inbound_count + 1');
  });

  it('a later blank never erases what an earlier message told us', async () => {
    await rememberSender({ clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+1' });
    const sql = String(args(0));
    expect(sql).toContain('COALESCE(EXCLUDED.raw_sender_id, wa_sender_policy.raw_sender_id)');
    expect(sql).toContain('COALESCE(EXCLUDED.display_name,  wa_sender_policy.display_name)');
  });

  it('the number is written once and never silently rebound', async () => {
    // DEF-162: a wrong identity bind is durable and misroutes that person indefinitely. The
    // first real answer wins; a later different one must not overwrite it.
    await rememberSender({ clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+1' });
    expect(sql()).toContain('COALESCE(wa_sender_policy.resolved_phone, EXCLUDED.resolved_phone)');
  });

  it('stamps WHEN the number first became known, not on every message', async () => {
    await rememberSender({ clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+1' });
    expect(sql()).toContain('resolved_phone IS NULL AND EXCLUDED.resolved_phone IS NOT NULL');
  });

  it('never costs the owner a message when the write fails', async () => {
    exec.mockRejectedValue(new Error('db down'));
    await expect(rememberSender({ clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+1' }))
      .resolves.toBeUndefined();
  });

  it('trims and bounds the display name', async () => {
    await rememberSender({
      clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+1', displayName: '  ' + 'x'.repeat(400),
    });
    expect(String(args(5)).length).toBeLessThanOrEqual(120);
    await rememberSender({ clientNumber: 'TMC-0001', ownerUserId: 2, phone: '+1', displayName: '   ' });
    expect(exec.mock.calls[1][5]).toBeNull();
  });
});

describe('DEF-292 — it runs for EVERY inbound, not only strangers', () => {
  it('is called from the single inbound funnel', () => {
    // Previously only senders who reached stranger-triage were recorded at all, and that record
    // stored the synthetic in place of a number.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'whatsapp', 'WhatsAppInbound.ts'), 'utf-8');
    const fn = src.slice(src.indexOf('export async function handleInboundMessage'));
    expect(fn.slice(0, 1800)).toContain('rememberSender(');
  });
});
