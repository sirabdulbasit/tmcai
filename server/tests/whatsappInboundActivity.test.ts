import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInboundActivity } from '../src/services/whatsapp/inboundActivity';

afterEach(() => vi.useRealTimers());

describe('WhatsApp inbound processing feedback', () => {
  it('shows typing + hourglass for text and clears them when done', async () => {
    vi.useFakeTimers();
    const react = vi.fn(async () => {});
    const sendStateTyping = vi.fn(async () => {});
    const clearState = vi.fn(async () => {});
    const message = { react, getChat: vi.fn(async () => ({ sendStateTyping, clearState })) };

    const activity = await startInboundActivity(message, false);
    expect(react).toHaveBeenCalledWith('⏳');
    expect(sendStateTyping).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sendStateTyping).toHaveBeenCalledTimes(2);
    await activity.stop();
    expect(clearState).toHaveBeenCalledOnce();
    expect(react).toHaveBeenLastCalledWith('');
  });

  it('shows recording state while a voice turn is processed', async () => {
    const sendStateRecording = vi.fn(async () => {});
    const activity = await startInboundActivity({
      react: vi.fn(async () => {}),
      getChat: vi.fn(async () => ({ sendStateRecording, clearState: vi.fn(async () => {}) })),
    }, true);
    expect(sendStateRecording).toHaveBeenCalledOnce();
    await activity.stop();
  });

  it('does not break Brain when WhatsApp rejects activity APIs', async () => {
    const activity = await startInboundActivity({
      react: vi.fn(async () => { throw new Error('reaction unsupported'); }),
      getChat: vi.fn(async () => ({
        sendStateTyping: vi.fn(async () => { throw new Error('state rejected'); }),
        clearState: vi.fn(async () => { throw new Error('clear rejected'); }),
      })),
    }, false, { clientNumber: 'TMC-0001', userId: 2, messageId: 'wa-1' });
    await expect(activity.pulse()).resolves.toBeUndefined();
    await expect(activity.stop()).resolves.toBeUndefined();
  });
});
