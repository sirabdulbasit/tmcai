import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(),
  initialize: vi.fn(),
  destroy: vi.fn(),
  alert: vi.fn(),
  clients: [] as any[],
}));

vi.mock('../src/db/prisma', () => ({
  default: {
    $executeRawUnsafe: (...args: any[]) => mocks.executeRaw(...args),
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('../src/utils/logger', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../src/services/systemLogService', () => ({ log: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../src/services/whatsapp/connectionWatchdog', () => ({
  alertWhatsAppDisconnect: (...args: any[]) => mocks.alert(...args),
}));
vi.mock('../src/services/whatsapp/webjsVersionCache', () => ({
  prepareVerifiedWebjsVersionCache: vi.fn().mockResolvedValue({
    version: '2.3000.1043346688-alpha',
    sourceUrl: 'https://archive.invalid/immutable.html',
    sha256: 'a'.repeat(64),
    expiresAt: '2099-01-01T00:00:00.000Z',
    cachePath: '/tmp/verified-webjs-cache',
    webVersionCache: { type: 'local', path: '/tmp/verified-webjs-cache', strict: true },
  }),
}));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn() }, toDataURL: vi.fn() }));
vi.mock('whatsapp-web.js', () => {
  class FakeClient {
    handlers = new Map<string, Function>();
    pageHandlers = new Map<string, Function>();
    info = { wid: { user: '923000000000' } };
    pupBrowser = Promise.resolve({ close: vi.fn().mockResolvedValue(undefined) });
    pupPage = {
      url: () => 'https://web.whatsapp.com/?token=must-not-leak#fragment',
      on: (event: string, handler: Function) => this.pageHandlers.set(event, handler),
      off: (event: string) => this.pageHandlers.delete(event),
    };
    constructor(public options: any) { mocks.clients.push(this); }
    on(event: string, handler: Function) { this.handlers.set(event, handler); }
    getWWebVersion() { return Promise.resolve('2.3000.1043351526'); }
    initialize() { return mocks.initialize(); }
    destroy() { return mocks.destroy(); }
  }
  class FakeLocalAuth { constructor(public options: any) {} }
  return { Client: FakeClient, LocalAuth: FakeLocalAuth };
});

import {
  WebjsProvider,
  getWebjsInitHealth,
} from '../src/services/whatsapp/WebjsProvider';

const tenant = 'TMC-INIT-TEST';

describe('Web.js per-tenant initialization lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clients.length = 0;
    mocks.executeRaw.mockResolvedValue(1);
    mocks.destroy.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await new WebjsProvider().disconnect(tenant);
  });

  it('admits only one Chromium initialization for concurrent tenant calls', async () => {
    let resolveInit!: () => void;
    mocks.initialize.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveInit = resolve; }));
    const provider = new WebjsProvider();

    const first = provider.initialize(tenant);
    await vi.waitFor(() => expect(mocks.initialize).toHaveBeenCalledOnce());
    await provider.initialize(tenant);

    expect(mocks.clients).toHaveLength(1);
    expect(getWebjsInitHealth(tenant).state).toBe('connecting');
    resolveInit();
    await first;
  });

  it('classifies a protocol failure, persists init_timeout, and destroys the failed client', async () => {
    mocks.initialize.mockImplementationOnce(async () => {
      await mocks.clients[0].getWWebVersion();
      mocks.clients[0].pageHandlers.get('console')?.({
        type: () => 'error',
        text: () => 'Runtime.callFunctionOn timed out with private browser detail',
        location: () => ({ url: 'https://web.whatsapp.com/bootstrap?token=must-not-leak' }),
      });
      throw new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout setting');
    });
    const provider = new WebjsProvider();

    await expect(provider.initialize(tenant)).rejects.toThrow('Runtime.callFunctionOn timed out');

    const health = getWebjsInitHealth(tenant);
    expect(health.state).toBe('init_timeout');
    expect(health.consecutiveTimeouts).toBe(1);
    expect(health.retryAt).toBeTypeOf('number');
    expect(health.requiresRepair).toBe(false);
    expect(health.telemetry).toMatchObject({
      stage: 'page_reached',
      pageUrl: 'https://web.whatsapp.com/',
      wwebVersion: '2.3000.1043351526',
      qrListenerRegistered: true,
      qrEmitted: false,
      authenticated: false,
    });
    expect(health.telemetry?.consoleErrors).toEqual([{
      at: expect.any(Number),
      source: 'console',
      fingerprint: 'runtime_call_timeout',
      location: 'https://web.whatsapp.com/bootstrap',
    }]);
    expect(JSON.stringify(health.telemetry)).not.toContain('private browser detail');
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.executeRaw.mock.calls.some((call) =>
      String(call[0]).includes('SET status = $2') && call[2] === 'init_timeout'
    )).toBe(true);
  });

  it('opens the repair gate and escalates after three consecutive init timeouts', async () => {
    mocks.initialize.mockRejectedValue(
      new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout setting'),
    );
    const provider = new WebjsProvider();

    for (let attempt = 0; attempt < 3; attempt++) {
      await provider.initialize(tenant).catch(() => undefined);
    }

    const health = getWebjsInitHealth(tenant);
    expect(health.consecutiveTimeouts).toBe(3);
    expect(health.requiresRepair).toBe(true);
    await vi.waitFor(() => expect(mocks.alert).toHaveBeenCalledOnce());

    await provider.initialize(tenant);
    expect(mocks.initialize).toHaveBeenCalledTimes(3);
  });

  it('passes the explicit bounded protocol timeout into Puppeteer', async () => {
    mocks.initialize.mockResolvedValueOnce(undefined);
    await new WebjsProvider().initialize(tenant);
    expect(mocks.clients[0].options.puppeteer.protocolTimeout).toBe(240_000);
  });

  it('passes only the integrity-prepared strict local Web cache to the client', async () => {
    mocks.initialize.mockResolvedValueOnce(undefined);
    await new WebjsProvider().initialize(tenant);
    expect(mocks.clients[0].options.webVersion).toBe('2.3000.1043346688-alpha');
    expect(mocks.clients[0].options.webVersionCache).toEqual({
      type: 'local', path: '/tmp/verified-webjs-cache', strict: true,
    });
  });
});
