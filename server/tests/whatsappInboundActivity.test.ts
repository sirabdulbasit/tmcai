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
    expect(reply).toHaveBeenCalledWith('⏳ Thinking…');
    await expect(activity.pulse()).resolves.toBeUndefined();
    expect(reply).toHaveBeenCalledOnce();
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
  it('sends the text marker even when the reaction succeeded (owner override 2026-07-31) — once', async () => {
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
    expect(react).toHaveBeenCalledWith('⏳');
    await vi.advanceTimersByTimeAsync(45_000); // repeated pulses keep failing
    expect(reply).toHaveBeenCalledTimes(1);    // visible signal on every turn…
    expect(reply).toHaveBeenCalledWith('⏳ Thinking…'); // …but never more than once
    await activity.stop();
  });

  it('voice: sends the recording marker when native recording fails', async () => {
    const reply = vi.fn(async () => ({}));
    const activity = await startInboundActivity({
      react: vi.fn(async () => { throw new Error('reaction unsupported'); }),
      reply,
      getChat: vi.fn(async () => ({
        sendStateRecording: vi.fn(async () => { throw 'r'; }),
        clearState: vi.fn(async () => {}),
      })),
    }, true);
    expect(reply).toHaveBeenCalledWith('🎙️ Recording…');
    expect(reply).toHaveBeenCalledOnce();
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
