import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:activity');

export interface InboundActivitySample {
  at: string;
  clientNumber?: string;
  userId?: number;
  messageId?: string;
  voice: boolean;
  state: 'typing' | 'recording' | 'unsupported' | 'failed';
  reactionOk: boolean;
}
const activityHistory: InboundActivitySample[] = [];
export function getInboundActivityHealth(clientNumber?: string): InboundActivitySample[] {
  const scoped = clientNumber
    ? activityHistory.filter((sample) => sample.clientNumber === clientNumber)
    : activityHistory;
  return scoped.slice(-20);
}

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
export async function startInboundActivity(
  message: any,
  voice: boolean,
  context: { clientNumber?: string; userId?: number; messageId?: string } = {},
): Promise<InboundActivity> {
  let stopped = false;
  let chat: any = null;
  let lastState: 'typing' | 'recording' | 'unsupported' | 'failed' = 'unsupported';
  let reactionOk = false;

  const pulse = async () => {
    if (stopped) return;
    try {
      chat ??= await message.getChat();
      if (voice && typeof chat?.sendStateRecording === 'function') {
        await chat.sendStateRecording();
        lastState = 'recording';
      } else if (typeof chat?.sendStateTyping === 'function') {
        await chat.sendStateTyping();
        lastState = 'typing';
      } else {
        lastState = 'unsupported';
        log.warn('Activity state unsupported by chat object', { ...context, voice });
      }
    } catch (error: any) {
      lastState = 'failed';
      log.warn('Activity state send failed', {
        ...context, voice, error: String(error?.message ?? error).slice(0, 180),
      });
    }
  };

  try {
    await message.react('⏳');
    reactionOk = true;
  }
  catch (error: any) {
    log.warn('Activity reaction failed', {
      ...context, error: String(error?.message ?? error).slice(0, 180),
    });
  }
  await pulse();
  activityHistory.push({
    at: new Date().toISOString(), ...context, voice, state: lastState, reactionOk,
  });
  if (activityHistory.length > 100) activityHistory.splice(0, activityHistory.length - 100);
  log.info('Activity started', { ...context, voice, state: lastState });
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
      } catch (error: any) {
        log.warn('Activity clear-state failed', {
          ...context, error: String(error?.message ?? error).slice(0, 180),
        });
      }
      try { await message.react(''); }
      catch (error: any) {
        log.warn('Activity reaction clear failed', {
          ...context, error: String(error?.message ?? error).slice(0, 180),
        });
      }
      log.info('Activity stopped', { ...context, voice, state: lastState });
    },
  };
}
