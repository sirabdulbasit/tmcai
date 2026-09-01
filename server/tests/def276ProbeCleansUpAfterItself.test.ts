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
import { cleanUpProbeMessage, PROBE_CLEANUP_BACKOFF_MS } from '../src/services/whatsapp/webjsLiveness';

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

/**
 * DEF-276c — the second live failure, and the reason the echo is now the primary handle.
 *
 * The promise-based version logged `probe_cleaned outcome=skipped_no_message`: on this client
 * `client.sendMessage()` resolves with a FALSY value, so there was never a message object to
 * delete. The surrounding code had been writing `sent?.id?._serialized` for months — the hint was
 * there and I did not read it. The echoed message is a real Message object and a pass guarantees
 * it exists, because the echo is what makes it a pass.
 */
describe('DEF-276c — the echo is the handle that actually exists', () => {
  it('deletes the ECHOED message even when the send resolves falsy', async () => {
    // The exact live failure: sendMessage resolved with undefined.
    const del = vi.fn().mockResolvedValue(undefined);
    const r = await cleanUpProbeMessage(Promise.resolve(undefined), 10_000, msg(del));
    expect(r).toBe('deleted');
    expect(del).toHaveBeenCalledWith(true);
  });

  it('prefers the echo over the send result, so it never waits on the transport', async () => {
    const echoDel = vi.fn().mockResolvedValue(undefined);
    const sendDel = vi.fn().mockResolvedValue(undefined);
    const never = new Promise(() => { /* a wedged send must not matter */ });
    expect(await cleanUpProbeMessage(never, 50, msg(echoDel))).toBe('deleted');
    expect(echoDel).toHaveBeenCalledTimes(1);
    expect(sendDel).not.toHaveBeenCalled();
  });

  it('reports failed — not deleted — when deleting the echo throws', async () => {
    const boom = vi.fn().mockRejectedValue(new Error('revoke window passed'));
    expect(await cleanUpProbeMessage(Promise.resolve(undefined), 10_000, msg(boom))).toBe('failed');
  });

  it('still falls back to the send result when there is no echo', async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    expect(await cleanUpProbeMessage(Promise.resolve(msg(del)), 10_000, null)).toBe('deleted');
  });
});

/**
 * DEF-276d — the third live failure: `outcome: "failed"`, 43ms after the pass.
 *
 * `Message.delete()` runs inside the page and looks the message up in WhatsApp Web's own
 * collections before reading `msg.id.remote`. That early the message is often not in that store,
 * so the lookup returns undefined and the property read throws. Retrying is the right shape
 * because cleanup runs entirely off the critical path — the verdict is already recorded.
 */
describe('DEF-276d — the echo is not deletable immediately', () => {
  it('retries and succeeds when the first attempt loses the store race', async () => {
    let calls = 0;
    const del = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("Cannot read properties of undefined (reading 'id')");
      return undefined;
    });
    expect(await cleanUpProbeMessage(null, 10_000, msg(del))).toBe('deleted');
    expect(calls).toBe(3);
  });

  it('gives up with a named failure rather than retrying forever', async () => {
    const del = vi.fn().mockRejectedValue(new Error('permanently gone'));
    expect(await cleanUpProbeMessage(null, 10_000, msg(del))).toBe('failed');
    // two strategies per attempt: revoke-for-everyone, then delete-for-me
    expect(del.mock.calls.length).toBe(PROBE_CLEANUP_BACKOFF_MS.length * 2);
  });

  it('falls back to delete-for-me when revoke-for-everyone is refused', async () => {
    // In the account's own chat there is nobody to revoke for; removing it from his view is
    // delete(false). This is the strategy that matters for the owner's screenshot.
    const del = vi.fn().mockImplementation(async (everyone: boolean) => {
      if (everyone) throw new Error('canSenderRevokeMsg is false');
      return undefined;
    });
    expect(await cleanUpProbeMessage(null, 10_000, msg(del))).toBe('deleted');
    expect(del).toHaveBeenNthCalledWith(1, true);
    expect(del).toHaveBeenNthCalledWith(2, false);
  });

  it('does not sleep at all when the first attempt works', async () => {
    // The common case must stay instant; patience is only for the race.
    const started = Date.now();
    expect(await cleanUpProbeMessage(null, 10_000, msg())).toBe('deleted');
    expect(Date.now() - started).toBeLessThan(120);
  });
});
