/**
 * Native typing/recording on @lid chats. Same root cause as the voice bug:
 * WWebJS.sendChatstate calls the GENERIC createWid() on the chat id, which
 * throws minified `r` for an `@lid` domain. WhatsApp exposes LID-specific
 * constructors (createUserLidOrThrow / asUserLidOrThrow) — use those.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sendChatStateDirect } from '../src/services/whatsapp/webjsChatStateDirect';

const LID = '173555350261799@lid';
const PHONE = '923274572102@c.us';
const page = (impl: (id: string, want: string) => any) => ({
  pupPage: { evaluate: async (_f: any, id: string, want: string) => impl(id, want) },
});

describe('direct chat state', () => {
  it('reports which constructor accepted the @lid id', async () => {
    const r = await sendChatStateDirect(page(() => ({ ok: true, via: 'createUserLidOrThrow' })), LID, 'typing');
    expect(r.ok).toBe(true);
    expect(r.via).toBe('createUserLidOrThrow');
  });

  it('surfaces the reason when no constructor accepts the id', async () => {
    const r = await sendChatStateDirect(page(() => ({
      ok: false, reason: 'no Wid constructor accepted the id — createUserLidOrThrow: r; createWid: r',
    })), LID, 'recording');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('createWid: r');
  });

  it('never throws — no page, no id, exploding page', async () => {
    expect((await sendChatStateDirect({}, LID, 'typing')).reason).toBe('no live page');
    expect((await sendChatStateDirect(page(() => ({})), '', 'typing')).reason).toBe('no chat id');
    const boom = { pupPage: { evaluate: async () => { throw new Error('detached'); } } };
    expect((await sendChatStateDirect(boom, LID, 'stop')).reason).toContain('detached');
  });
});

describe('constructor order and wiring', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'webjsChatStateDirect.ts'), 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('tries LID-aware constructors BEFORE the generic one for @lid', () => {
    const lidBranch = CODE.slice(CODE.indexOf('isLid'), CODE.indexOf(': ['));
    expect(lidBranch.indexOf('createUserLidOrThrow')).toBeGreaterThan(-1);
    expect(lidBranch.indexOf('createUserLidOrThrow')).toBeLessThan(lidBranch.indexOf("['createWid'"));
  });
  it('uses WhatsApp’s own senders, all three states', () => {
    for (const s of ['sendChatStateComposing', 'sendChatStateRecording', 'sendChatStatePaused']) {
      expect(CODE).toContain(s);
    }
  });
  it('is wired as the FIRST limb of the activity pulse, and clears state too', () => {
    const act = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'inboundActivity.ts'), 'utf8');
    expect(act).toContain('sendChatStateDirect');
    expect(act.indexOf('await directState(')).toBeLessThan(act.indexOf('chat ??= await message.getChat()'));
    expect(act).toContain("directState('stop')");
  });
  it('emits no thread message — presence only (owner ruling 2026-07-31)', () => {
    const act = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'inboundActivity.ts'), 'utf8');
    expect(act).not.toMatch(/reply\(\s*['"`](⏳|🎙️)/);
  });
});
