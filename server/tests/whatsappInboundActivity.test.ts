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
    const reply = vi.fn(async () => ({}));
    const activity = await startInboundActivity({
      react: vi.fn(async () => { throw new Error('reaction unsupported'); }),
      reply,
      getChat: vi.fn(async () => ({
        sendStateTyping: vi.fn(async () => { throw new Error('state rejected'); }),
        clearState: vi.fn(async () => { throw new Error('clear rejected'); }),
      })),
    }, false, { clientNumber: 'TMC-0001', userId: 2, messageId: 'wa-1' });
    // Owner ruling 2026-07-31: no text-marker messages, ever — even when
    // every native limb throws, the turn proceeds with no thread message.
    expect(reply).not.toHaveBeenCalled();
    await expect(activity.pulse()).resolves.toBeUndefined();
    expect(reply).not.toHaveBeenCalled();
    await expect(activity.stop()).resolves.toBeUndefined();
  });

  it('retries native activity through the phone-number chat for @lid inbound', async () => {
    const lidTyping = vi.fn(async () => { throw 'r'; });
    const phoneTyping = vi.fn(async () => {});
    const getChatById = vi.fn(async () => ({
      sendStateTyping: phoneTyping,
      clearState: vi.fn(async () => {}),
    }));
    const reply = vi.fn(async () => ({}));
    const activity = await startInboundActivity({
      from: '173555350261799@lid',
      react: vi.fn(async () => {}),
      reply,
      client: {
        getContactLidAndPhone: vi.fn(async () => [{
          lid: '173555350261799@lid', pn: '923001234567@c.us',
        }]),
        getChatById,
      },
      getChat: vi.fn(async () => ({
        id: { _serialized: '173555350261799@lid' },
        sendStateTyping: lidTyping,
      })),
    }, false);
    expect(phoneTyping).toHaveBeenCalledOnce();
    expect(getChatById).toHaveBeenCalledWith('923001234567@c.us');
    expect(reply).not.toHaveBeenCalled();
    await activity.stop();
  });

  // Reviewer condition (2026-07-22): EITHER successful limb is
  // sufficient visible activity — the text fallback fires only when
  // both the reaction and native presence failed.
  it('never sends a thread message when presence fails (owner ruling 2026-07-31)', async () => {
    vi.useFakeTimers();
    const reply = vi.fn(async () => ({}));
    const react = vi.fn(async () => {});
    const activity = await startInboundActivity({
      react, reply,
      getChat: vi.fn(async () => ({
        sendStateTyping: vi.fn(async () => { throw 'r'; }),
        clearState: vi.fn(async () => {}),
      })),
    }, false);
    expect(react).toHaveBeenCalledWith('⏳'); // the reaction remains the only fallback signal
    await vi.advanceTimersByTimeAsync(45_000); // repeated pulses keep failing
    expect(reply).not.toHaveBeenCalled();      // and never a message in the thread
    await activity.stop();
  });

  it('voice: no thread message even when native recording fails (owner ruling 2026-07-31)', async () => {
    const reply = vi.fn(async () => ({}));
    const activity = await startInboundActivity({
      react: vi.fn(async () => { throw new Error('reaction unsupported'); }),
      reply,
      getChat: vi.fn(async () => ({
        sendStateRecording: vi.fn(async () => { throw 'r'; }),
        clearState: vi.fn(async () => {}),
      })),
    }, true);
    expect(reply).not.toHaveBeenCalled();
    await activity.stop();
  });

  it('voice: reaction emoji is the recording glyph', async () => {
    const react = vi.fn(async () => {});
    const activity = await startInboundActivity({
      react,
      getChat: vi.fn(async () => ({
        sendStateRecording: vi.fn(async () => {}),
        clearState: vi.fn(async () => {}),
      })),
    }, true);
    expect(react).toHaveBeenCalledWith('🎙️');
    await activity.stop();
  });

  it('reaction fails but native typing succeeds → no text fallback', async () => {
    const reply = vi.fn(async () => ({}));
    const activity = await startInboundActivity({
      react: vi.fn(async () => { throw new Error('reaction unsupported'); }),
      reply,
      getChat: vi.fn(async () => ({
        sendStateTyping: vi.fn(async () => {}),
        clearState: vi.fn(async () => {}),
      })),
    }, false);
    expect(reply).not.toHaveBeenCalled();
    await activity.stop();
  });
});
