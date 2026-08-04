/**
 * Root cause 2026-08-04: webjs's downloadMedia resolves the message from its
 * serialized id, and a LID chat's id EMBEDS the identity
 * (`false_<digits>@lid_<hash>`). Parsing it throws minified `r` before any
 * network call. Everything after the lookup is healthy — proven on production
 * (3646 bytes decrypted). The fix looks the message up by STRING comparison.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { downloadMediaDirect } from '../src/services/whatsapp/webjsMediaDirect';

const LID_MSG_ID = 'false_173555350261799@lid_3BF638C7C45849106817';
const clientWith = (impl: (ids: string[]) => any) => ({
  pupPage: { evaluate: async (_fn: any, ids: string[]) => impl(ids) },
});

describe('direct media download', () => {
  it('returns the media for a @lid message id', async () => {
    const r = await downloadMediaDirect(clientWith(() => ({
      data: 'AAAA', mimetype: 'audio/ogg; codecs=opus', filesize: 3646,
    })), [LID_MSG_ID]);
    expect(r.media?.data).toBe('AAAA');
    expect(r.media?.mimetype).toContain('audio/ogg');
    expect(r.reason).toBeUndefined();
  });

  it('surfaces the in-page reason instead of a bare failure', async () => {
    const r = await downloadMediaDirect(clientWith(() => ({ error: 'media expired (REUPLOADING)' })), [LID_MSG_ID]);
    expect(r.media).toBeNull();
    expect(r.reason).toContain('REUPLOADING');
  });

  it('never throws — no page, no id, exploding page', async () => {
    expect((await downloadMediaDirect({}, [LID_MSG_ID])).reason).toBe('no live page');
    expect((await downloadMediaDirect(clientWith(() => ({})), [null, undefined, ''])).reason).toContain('no usable message id');
    const boom = { pupPage: { evaluate: async () => { throw new Error('detached'); } } };
    expect((await downloadMediaDirect(boom, [LID_MSG_ID])).reason).toContain('detached');
  });
});

describe('the fix avoids the poisoned lookup', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'webjsMediaDirect.ts'), 'utf8');
  /** Comments explain the bug and name those calls; only CODE must avoid them. */
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('never calls the id-parsing lookups that throw on @lid', () => {
    expect(CODE).not.toMatch(/Msg\.get\(/);
    expect(CODE).not.toMatch(/getMessagesById/);
  });
  it('matches by string on the serialized id AND the short id', () => {
    // Production logged only the short id ("3B5730909A5EE9DA2D45"), so the
    // event object's _serialized can be absent — matching one spelling made
    // the limb skip in silence.
    expect(CODE).toContain('m?.id?._serialized');
    expect(CODE).toContain('m?.id?.id');
    expect(CODE).toMatch(/endsWith\(`_\$\{id\}`\)/);
  });
  it('reports how many models it searched, so a miss is diagnosable', () => {
    expect(CODE).toContain('message not in page collection (searched');
  });
  it('still uses the library’s own download + encode calls', () => {
    expect(SRC).toContain('downloadAndMaybeDecrypt');
    expect(SRC).toContain('arrayBufferToBase64Async');
  });
  it('runs BEFORE the library retry ladder in the inbound path', () => {
    const media = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'inboundMedia.ts'), 'utf8');
    expect(media.indexOf('downloadMediaDirect')).toBeLessThan(media.indexOf('for (let attempt = 0'));
  });
});
