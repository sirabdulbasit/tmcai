export interface InboundActivity {
  pulse(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * User-visible processing feedback for long Brain/voice turns.
 * - reacts ⏳ to the exact inbound message;
 * - shows "typing…" for text and "recording audio…" for voice;
 * - refreshes the ephemeral chat state until the reply finishes;
 * - always clears both state and reaction on completion/error.
 */
export async function startInboundActivity(message: any, voice: boolean): Promise<InboundActivity> {
  let stopped = false;
  let chat: any = null;

  const pulse = async () => {
    if (stopped) return;
    try {
      chat ??= await message.getChat();
      if (voice && typeof chat?.sendStateRecording === 'function') {
        await chat.sendStateRecording();
      } else if (typeof chat?.sendStateTyping === 'function') {
        await chat.sendStateTyping();
      }
    } catch { /* feedback must never block Brain */ }
  };

  try { await message.react('⏳'); } catch {}
  await pulse();
  const timer = setInterval(() => { void pulse(); }, 15_000);
  timer.unref?.();

  return {
    pulse,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        chat ??= await message.getChat();
        if (typeof chat?.clearState === 'function') await chat.clearState();
      } catch {}
      try { await message.react(''); } catch {}
    },
  };
}
