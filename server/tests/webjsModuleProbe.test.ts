/**
 * WhatsApp Web internal-module probe — the diagnostic that replaces the
 * opaque `r: r` with the actual module names that moved.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { probeWebjsModules, probeWebjsCallArguments, probeMediaSteps, PROBED_MODULES, PROBED_SURFACES } from '../src/services/whatsapp/webjsModuleProbe';

const pageWith = (impl: (names: string[]) => any) => ({
  pupPage: { evaluate: async (_fn: any, names: string[]) => impl(names) },
});

describe('probe reports facts, never throws', () => {
  it('all modules resolve → ok', async () => {
    const r = await probeWebjsModules(pageWith((names) => ({
      requireAvailable: true, resolved: names, missing: [], suggestions: {},
    })));
    expect(r.ok).toBe(true);
    expect(r.resolved.length).toBe(PROBED_MODULES.length);
  });

  it('names the missing modules with their REAL error text', async () => {
    const r = await probeWebjsModules(pageWith(() => ({
      requireAvailable: true,
      resolved: ['WAWebWidFactory'],
      missing: [{ name: 'WAWebDownloadManager', error: 'Error: Module not found' }],
      suggestions: { WAWebDownloadManager: ['WAWebMediaDownloadManager'] },
    })));
    expect(r.ok).toBe(false);
    expect(r.missing[0].name).toBe('WAWebDownloadManager');
    expect(r.missing[0].error).toContain('Module not found');
    expect(r.suggestions?.WAWebDownloadManager).toContain('WAWebMediaDownloadManager');
  });

  it('window.require gone → reported, not crashed', async () => {
    const r = await probeWebjsModules(pageWith(() => ({
      requireAvailable: false, resolved: [], missing: [], suggestions: {},
    })));
    expect(r.requireAvailable).toBe(false);
    expect(r.ok).toBe(false);
  });

  it('no live client → clear error, no throw', async () => {
    const r = await probeWebjsModules({});
    expect(r.error).toMatch(/no pupPage/);
    expect(r.ok).toBe(false);
  });

  it('an exploding page is caught', async () => {
    const r = await probeWebjsModules({ pupPage: { evaluate: async () => { throw new Error('detached'); } } });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('detached');
  });
});

describe('probe covers the broken paths and stays read-only', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'webjsModuleProbe.ts'), 'utf8');
  it('probes only module names the library actually requires', () => {
    // Grep-confirmed against the installed library. An earlier list guessed
    // WAWebChatPresence / WAWebSendPresenceJob, which the library never
    // calls — the probe dutifully reported them missing and sent us chasing
    // a module that was never involved.
    for (const m of ['WAWebCollections', 'WAWebDownloadManager', 'WAWebChatStateBridge']) {
      expect(PROBED_MODULES).toContain(m as any);
    }
    for (const ghost of ['WAWebChatPresence', 'WAWebSendPresenceJob']) {
      expect(PROBED_MODULES).not.toContain(ghost as any);
    }
  });

  it('probes the deep call surfaces, since a module can resolve while its method is gone', () => {
    expect(PROBED_SURFACES).toContain("require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt" as any);
    expect(PROBED_SURFACES).toContain("require('WAWebChatStateBridge').sendChatStateComposing" as any);
    expect(PROBED_SURFACES).toContain('WWebJS.arrayBufferToBase64Async' as any);
  });
  it('never sends or mutates', () => {
    expect(SRC).not.toMatch(/sendMessage|sendStateTyping|sendSeen|\$executeRaw/);
  });
  it('the admin route is read-only (GET) and refuses without a live client', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin', 'whatsappAdminRoutes.ts'), 'utf8');
    expect(route).toContain("router.get('/diagnose-modules'");
    expect(route).toContain('no live webjs client');
  });
});

describe('argument probe — createWid against the real @lid identity', () => {
  const call = (impl: (lid: string | null, phone: string | null) => any) => ({
    pupPage: { evaluate: async (_fn: any, lid: string | null, phone: string | null) => impl(lid, phone) },
  });

  it('reports a THROWING createWid as the fault, with the real error', async () => {
    const r = await probeWebjsCallArguments(call(() => ({
      WidFactory: 'ok',
      "createWid('923274572102@c.us')  [control]": 'ok: object',
      "createWid('173555350261799@lid')  [lid]": 'THROWS TypeError: invalid wid domain',
    })), { lidId: '173555350261799@lid', phoneId: '923274572102@c.us' });
    expect(r.ok).toBe(false);
    expect(r.steps["createWid('173555350261799@lid')  [lid]"]).toContain('invalid wid domain');
    // The control must still pass, proving it is the domain and not the call.
    expect(r.steps["createWid('923274572102@c.us')  [control]"]).toContain('ok');
  });

  it('all calls fine → ok true (theory refuted, say so)', async () => {
    const r = await probeWebjsCallArguments(call(() => ({
      WidFactory: 'ok',
      "createWid('x@c.us')  [control]": 'ok: object',
      "createWid('y@lid')  [lid]": 'ok: object',
    })), { lidId: 'y@lid', phoneId: 'x@c.us' });
    expect(r.ok).toBe(true);
  });

  it('no live client / exploding page → reported, never thrown', async () => {
    expect((await probeWebjsCallArguments({}, {})).error).toMatch(/no pupPage/);
    const boom = { pupPage: { evaluate: async () => { throw new Error('detached'); } } };
    expect((await probeWebjsCallArguments(boom, {})).error).toContain('detached');
  });

  it('stays pure — constructs a Wid, never sends presence or media', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'webjsModuleProbe.ts'), 'utf8');
    const fn = SRC.slice(SRC.indexOf('export async function probeWebjsCallArguments'));
    expect(fn).not.toMatch(/sendChatState|downloadAndMaybeDecrypt|sendMessage/);
  });
});

describe('media step probe — attributes the throw to one line', () => {
  const pg = (impl: () => any) => ({ pupPage: { evaluate: async () => impl() } });

  it('pinpoints the failing step and keeps the earlier ones', async () => {
    const r = await probeMediaSteps(pg(() => ({
      steps: {
        '1.Msg collection': 'ok',
        '2.collection size': '412',
        '3.find media message': 'found ptt stage=FETCHING',
        '4.msg.downloadMedia(resolve)': 'THROWS Error: r',
        '5.downloadAndMaybeDecrypt': 'THROWS Error: r',
        '6.arrayBufferToBase64Async': 'skipped — no buffer from step 5',
      },
      message: { id: 'false_1735@lid_AC0E', type: 'ptt', mediaStage: 'FETCHING', hasMediaKey: true },
    })));
    expect(r.ok).toBe(false);
    expect(r.steps['4.msg.downloadMedia(resolve)']).toContain('THROWS');
    expect(r.message?.type).toBe('ptt');
  });

  it('a fully working chain reports ok', async () => {
    const r = await probeMediaSteps(pg(() => ({
      steps: { '5.downloadAndMaybeDecrypt': 'ok, 8421 bytes', '6.arrayBufferToBase64Async': 'ok, 11228 chars' },
      message: { type: 'ptt' },
    })));
    expect(r.ok).toBe(true);
  });

  it('no media in the collection says so instead of failing obscurely', async () => {
    const r = await probeMediaSteps(pg(() => ({
      steps: { '3.find media message': 'NONE FOUND — send a voice note, then re-run' }, message: null,
    })));
    expect(r.steps['3.find media message']).toContain('NONE FOUND');
    expect(r.message).toBeUndefined();
  });

  it('never sends or replies', () => {
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'webjsModuleProbe.ts'), 'utf8');
    const fn = SRC.slice(SRC.indexOf('export async function probeMediaSteps'), SRC.indexOf('export interface CallProbeResult'));
    expect(fn).not.toMatch(/sendMessage|\.reply\(|sendChatState/);
  });
});
