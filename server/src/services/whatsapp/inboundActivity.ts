import createLogger from '../../utils/logger';
import { resolvePhoneChat } from './waIdentity';

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

const activityError = (error: unknown): string => {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 180);
  try { return JSON.stringify(error).slice(0, 180); }
  catch { return String(error).slice(0, 180); }
};

/**
 * Modern WhatsApp delivers some 1:1 chats as @lid. whatsapp-web.js can reply
 * to those messages, but its Chat state helpers may reject the LID Wid. Resolve
 * the phone-number Wid explicitly and retry against that equivalent chat.
 *
 * REQ-009: the implementation now lives in the SHARED waIdentity module.
 * It used to be private to this file, which is why the liveness probe and
 * the media downloader — written later — each reopened the same @lid hole
 * that Chat 12 believed it had closed. Keep it shared.
 */
async function resolveActivityPhoneChat(message: any, currentChat: any): Promise<any | null> {
  const rawId = currentChat?.id?._serialized || message?.from || '';
  return resolvePhoneChat(message?.client, rawId);
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
  let stateChat: any = null;
  let lastState: 'typing' | 'recording' | 'unsupported' | 'failed' = 'unsupported';
  let reactionOk = false;
  let visibleFallbackSent = false;

  const sendState = async (target: any): Promise<boolean> => {
    if (voice && typeof target?.sendStateRecording === 'function') {
      await target.sendStateRecording();
      lastState = 'recording';
      return true;
    }
    if (typeof target?.sendStateTyping === 'function') {
      await target.sendStateTyping();
      lastState = 'typing';
      return true;
    }
    return false;
  };

  const sendVisibleFallback = async () => {
    // Owner override 2026-07-31 (supersedes the reviewer condition of
    // 2026-07-22 that treated a successful reaction as sufficient): the
    // owner wants an unmistakable "Brain is working" signal on EVERY
    // turn. While whatsapp-web.js's chat-state APIs are broken upstream
    // (the minified `r: r` class — native typing/recording throw), a
    // tiny reaction emoji does not read as one, so the text marker fires
    // whenever native presence fails, reaction or not — still at most
    // once per turn (invariant §2.4: bounded deterministic transport
    // signal, no semantic content, never blocks Brain processing).
    if (visibleFallbackSent || typeof message?.reply !== 'function') return;
    visibleFallbackSent = true;
    try {
      await message.reply(voice ? '🎙️ Recording…' : '⏳ Thinking…');
      log.info('Visible activity fallback sent', { ...context, voice });
    } catch (error: unknown) {
      log.warn('Visible activity fallback failed', { ...context, voice, error: activityError(error) });
    }
  };

  const pulse = async () => {
    if (stopped) return;
    try {
      chat ??= await message.getChat();
      if (!stateChat) stateChat = chat;
      if (!await sendState(stateChat)) {
        lastState = 'unsupported';
        log.warn('Activity state unsupported by chat object', { ...context, voice });
        await sendVisibleFallback();
      }
      return;
    } catch (firstError: unknown) {
      try {
        chat ??= await message.getChat();
        const phoneChat = await resolveActivityPhoneChat(message, chat);
        if (phoneChat && await sendState(phoneChat)) {
          stateChat = phoneChat;
          log.info('Activity state sent through LID phone mapping', { ...context, voice });
          return;
        }
      } catch (mappedError: unknown) {
        log.warn('LID-mapped activity state failed', {
          ...context, voice, error: activityError(mappedError),
        });
      }
      lastState = 'failed';
      log.warn('Activity state send failed', { ...context, voice, error: activityError(firstError) });
      await sendVisibleFallback();
    }
  };

  try {
    await message.react(voice ? '🎙️' : '⏳');
    reactionOk = true;
  }
  catch (error: unknown) {
    log.warn('Activity reaction failed', {
      ...context, error: activityError(error),
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
        const target = stateChat || chat || await message.getChat();
        if (typeof target?.clearState === 'function') await target.clearState();
      } catch (error: unknown) {
        log.warn('Activity clear-state failed', {
          ...context, error: activityError(error),
        });
      }
      try { await message.react(''); }
      catch (error: unknown) {
        log.warn('Activity reaction clear failed', {
          ...context, error: activityError(error),
        });
      }
      log.info('Activity stopped', { ...context, voice, state: lastState });
    },
  };
}
