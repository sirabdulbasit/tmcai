/**
 * DEF-276 / DEF-276b — the liveness probe removes its own message.
 *
 * The owner screenshotted six `[nexeo-liveness …]` messages piling up in his own "Message
 * yourself" chat, one per reconnect, kept forever. Self-chat is the right place to probe and the
 * probe is load-bearing (`@lid` recurrence #2 WAS a liveness probe), so the mechanism stays —
 * what was missing is that nothing removed it.
 *
 * **DEF-276b is why this file exists rather than a source assertion.** The first fix read a
 * variable assigned when `client.sendMessage` resolved, and in production did nothing at all:
 * the probe passes on the EARLY ECHO, which beats the send promise on a healthy connection — the
 * observed pass took 162ms — so the cleanup branch found `null`. `probe_pass` with no
 * `probe_cleaned` and no error was the only trace, and shape assertions on the source could not
 * see it. So cleanup takes the send PROMISE and every outcome is named and returned.
 */
import { describe, it, expect, vi } from 'vitest';
import { cleanUpProbeMessage } from '../src/services/whatsapp/webjsLiveness';

const msg = (del: any = vi.fn().mockResolvedValue(undefined)) => ({ delete: del });

describe('DEF-276 — the probe cleans up after itself', () => {
  it('deletes the message when the send has already resolved', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    expect(await cleanUpProbeMessage(Promise.resolve(msg(del)))).toBe('deleted');
    expect(del).toHaveBeenCalledWith(true);          // for everyone, incl. his own devices
  });

  it('THE REGRESSION: deletes it even when the send resolves AFTER the probe passed', async () => {
    // The live failure. The pass branch ran first and the message object did not exist yet.
    const del = vi.fn().mockResolvedValue(undefined);
    const late = new Promise((resolve) => setTimeout(() => resolve(msg(del)), 40));
    expect(await cleanUpProbeMessage(late)).toBe('deleted');
    expect(del).toHaveBeenCalledTimes(1);
  });

  it('reports a distinct outcome when there is nothing to delete — never silence', async () => {
    // A cleanup that silently does nothing is how DEF-276b survived its own tests.
    expect(await cleanUpProbeMessage(null)).toBe('skipped_no_message');
    expect(await cleanUpProbeMessage(Promise.resolve(null))).toBe('skipped_no_message');
    expect(await cleanUpProbeMessage(Promise.resolve({}))).toBe('skipped_undeletable');
  });

  it('never throws when the delete fails — a probe must not die on cosmetics', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('revoke window passed'));
    await expect(cleanUpProbeMessage(Promise.resolve(msg(boom)))).resolves.toBe('failed');
  });

  it('never throws when the SEND itself failed', async () => {
    await expect(cleanUpProbeMessage(Promise.reject(new Error('transport down')))).resolves.toBe('failed');
  });

  it('does not hang forever on a send that never resolves', async () => {
    // Otherwise a wedged transport leaves this promise pending for the life of the process.
    const never = new Promise(() => { /* never settles */ });
    await expect(cleanUpProbeMessage(never, 30)).resolves.toBe('failed');
  });
});
