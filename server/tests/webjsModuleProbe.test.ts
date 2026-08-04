/**
 * WhatsApp Web internal-module probe — the diagnostic that replaces the
 * opaque `r: r` with the actual module names that moved.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { probeWebjsModules, PROBED_MODULES, PROBED_SURFACES } from '../src/services/whatsapp/webjsModuleProbe';

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
