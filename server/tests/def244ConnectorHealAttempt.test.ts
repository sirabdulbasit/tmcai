/**
 * DEF-244 — `connector-selfheal-absent`: the stale-connector job attempts the
 * repair before it nags.
 *
 * The lived fixture (S24/S25, 08-22→08-24): the owner's Google grant died
 * ~08-15; for nine days Brain sent ~14 "reconnect it yourself" nags and never
 * once tried the refresh it was asking him to cause. Rung 1 of Self-Healing
 * (detect) without rung 2 (recover).
 *
 * Under test:
 *  - a stale Google-family row triggers ONE heal attempt per user per sweep;
 *  - grant ALIVE → no nag this sweep (the probe healed/validated state);
 *  - grant DEAD → the nag ships WITH the receipt of the attempt, in the body
 *    fact and in durable metadata;
 *  - probe THROWS → the alert still ships (the healer must never silence the
 *    alarm);
 *  - non-Google connectors keep detection-only behaviour, receipted as
 *    `no_probe`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const state = {
  staleRows: [] as any[],
  authResult: { client: null as any, error: 'Integration token expired. Reconnect in My Connectors.' },
  authThrows: false,
  authCalls: 0,
  enqueued: [] as any[],
};

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    { $queryRawUnsafe: async () => state.staleRows },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/integrationService', () => ({
  __esModule: true,
  getAuthenticatedClient: async () => {
    state.authCalls += 1;
    if (state.authThrows) throw new Error('probe exploded');
    return state.authResult;
  },
}));

vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  __esModule: true,
  enqueueBrainPrompt: async (input: any) => {
    state.enqueued.push(input);
    return { status: 'queued', promptId: '1' };
  },
}));

const gmailRow = (over: Record<string, unknown> = {}) => ({
  user_id: 2,
  connector_type_id: 'ct_gmail_personal',
  status: 'sync_stale',
  last_sync_at: new Date(Date.now() - 216 * 60 * 60 * 1000),
  last_oauth_error: 'invalid_grant',
  client_number: 'TMC-0001',
  ...over,
});

describe('DEF-244 — the job attempts the repair before it nags', () => {
  beforeEach(() => {
    state.staleRows = [];
    state.authResult = { client: null, error: 'Integration token expired. Reconnect in My Connectors.' };
    state.authThrows = false;
    state.authCalls = 0;
    state.enqueued = [];
  });

  it('grant ALIVE → healed, no nag this sweep', async () => {
    state.staleRows = [gmailRow()];
    state.authResult = { client: {}, error: undefined as any };
    const { runStaleConnectorPing } = await import('../src/jobs/staleConnectorPing');
    const out = await runStaleConnectorPing();
    expect(state.authCalls).toBe(1);
    expect(out.healed).toBe(1);
    expect(out.pinged).toBe(0);
    expect(state.enqueued).toHaveLength(0);
  });

  it('grant DEAD → the nag ships WITH the receipt of the attempt', async () => {
    state.staleRows = [gmailRow()];
    const { runStaleConnectorPing } = await import('../src/jobs/staleConnectorPing');
    const out = await runStaleConnectorPing();
    expect(out.pinged).toBe(1);
    expect(out.healed).toBe(0);
    const ping = state.enqueued[0];
    expect(ping.question).toContain('I tried to refresh its access myself just now and could not');
    expect(ping.metadata.healAttempt.outcome).toBe('grant_dead');
    expect(ping.metadata.healAttempt.error).toContain('token expired');
  });

  it('ONE heal attempt covers a user\'s whole Google family — five stale siblings, one refresh', async () => {
    state.staleRows = [
      gmailRow(),
      gmailRow({ connector_type_id: 'ct_google_calendar_personal' }),
      gmailRow({ connector_type_id: 'ct_google_drive_personal' }),
      gmailRow({ connector_type_id: 'ct_gtasks_personal' }),
      gmailRow({ connector_type_id: 'ct_google_chat_personal' }),
    ];
    const { runStaleConnectorPing } = await import('../src/jobs/staleConnectorPing');
    const out = await runStaleConnectorPing();
    expect(state.authCalls).toBe(1);
    expect(out.pinged).toBe(5);
  });

  it('a THROWING probe never silences the alarm', async () => {
    state.staleRows = [gmailRow()];
    state.authThrows = true;
    const { runStaleConnectorPing } = await import('../src/jobs/staleConnectorPing');
    const out = await runStaleConnectorPing();
    expect(out.pinged).toBe(1);
    const ping = state.enqueued[0];
    // No false "I tried and the grant is dead" claim — the probe itself failed.
    expect(ping.question).not.toContain('I tried to refresh');
    expect(ping.metadata.healAttempt.outcome).toBe('probe_error');
  });

  it('a non-Google connector keeps detection-only behaviour, receipted as no_probe', async () => {
    state.staleRows = [gmailRow({ connector_type_id: 'ct_slack_personal' })];
    const { runStaleConnectorPing } = await import('../src/jobs/staleConnectorPing');
    const out = await runStaleConnectorPing();
    expect(state.authCalls).toBe(0);
    expect(out.pinged).toBe(1);
    expect(state.enqueued[0].metadata.healAttempt.outcome).toBe('no_probe');
    expect(state.enqueued[0].question).not.toContain('I tried to refresh');
  });
});
