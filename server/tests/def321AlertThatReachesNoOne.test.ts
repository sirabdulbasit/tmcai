/**
 * DEF-321 — the 09-04 incident: `disconnect alert sent {sent:0, failed:1}` at
 * 07:48:21, and NO ONE was told the WhatsApp channel had died. The owner
 * discovered it himself five hours later ("why silence??") and the channel
 * was still dead at the next harvest.
 *
 * Three defects in three lines, each the codebase's own recorded lesson:
 * the email failure reason was swallowed (`.catch(() => false)` — DEF-276e),
 * sent:0 was logged at INFO (a guard failing quietly — DEF-276b), and email
 * was the ONLY route while `brainContactsUser` — durable audit row, WhatsApp
 * attempt, DEF-296 email fallback — sat unused: `protection-with-two-
 * implementations`, 11th, on the one alert that says "you can no longer
 * reach me".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  emailOk: true,
  emailThrows: false,
  ownerRows: [{ id: 2 }] as any[],
  recipientRows: [{ email: 'admin@tmcltd.com', name: 'A', user_type: 'SA', client_number: 'TMC-0001' }] as any[],
  contacts: [] as any[],
  contactThrows: false,
  llmThrows: false,
  llmText: 'My WhatsApp channel is down — messages to me there go unanswered until you re-pair it: open Admin → WhatsApp and scan a fresh QR.',
  errors: [] as any[],
  warns: [] as any[],
  infos: [] as any[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({
    info: (...a: any[]) => { state.infos.push(a); },
    warn: (...a: any[]) => { state.warns.push(a); },
    error: (...a: any[]) => { state.errors.push(a); },
    debug: () => {},
  }),
}));

vi.mock('../src/db/prisma', () => {
  const p: any = {
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('SELECT DISTINCT email')) return state.recipientRows;
      if (sql.includes('SELECT id FROM users')) return state.ownerRows;
      return [];
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/emailService', () => ({
  __esModule: true,
  sendEmail: async () => {
    if (state.emailThrows) throw new Error('SMTP refused: 550');
    return state.emailOk;
  },
}));

vi.mock('../src/services/llmRouter', () => ({
  __esModule: true,
  callLLM: async () => {
    if (state.llmThrows) throw new Error('model unreachable');
    return { text: state.llmText };
  },
}));

vi.mock('../src/services/notifications/brainOutboundService', () => ({
  __esModule: true,
  brainContactsUser: async (req: any) => {
    if (state.contactThrows) throw new Error('chokepoint down');
    state.contacts.push(req);
    return { sent: true, channelsUsed: ['text'], waMessageIds: [] };
  },
}));

import { alertWhatsAppDisconnect } from '../src/services/whatsapp/connectionWatchdog';

const PARAMS = {
  clientNumber: 'TMC-0001',
  tenantPhone: '+923710042740',
  reason: 'WhatsApp closed the session: LOGOUT',
  requiresAction: 'Open Admin → WhatsApp and click Connect to scan a fresh QR code.',
};

beforeEach(() => {
  state.emailOk = true;
  state.emailThrows = false;
  state.ownerRows = [{ id: 2 }];
  state.recipientRows = [{ email: 'admin@tmcltd.com', name: 'A', user_type: 'SA', client_number: 'TMC-0001' }];
  state.contacts = [];
  state.contactThrows = false;
  state.llmThrows = false;
  state.errors = [];
  state.warns = [];
  state.infos = [];
});

describe('DEF-321 — an undeliverable "I have gone dark" alert is an incident, not an info line', () => {
  it('THE 09-04 SHAPE: every email fails → log.error WITH the per-recipient reasons, and the second route still fires', async () => {
    state.emailThrows = true;
    await alertWhatsAppDisconnect(PARAMS);
    const esc = state.errors.find((e) => String(e[0]).includes('reached NO ONE'));
    expect(esc).toBeTruthy();
    // The diagnosis the incident never had: the actual failure reason.
    expect(JSON.stringify(esc![1])).toContain('SMTP refused: 550');
    // Mutation: removing the chokepoint route dies here.
    expect(state.contacts).toHaveLength(1);
  });

  it('a sendEmail that returns false (not throws) is also captured with a stated reason', async () => {
    state.emailOk = false;
    await alertWhatsAppDisconnect(PARAMS);
    const esc = state.errors.find((e) => String(e[0]).includes('reached NO ONE'));
    expect(JSON.stringify(esc![1])).toContain('sendEmail returned false');
  });
});

describe('DEF-321 — the second route goes through the ONE chokepoint, always', () => {
  it('fires even when the admin emails SUCCEED — the owner gets the notice in his own channel history', async () => {
    await alertWhatsAppDisconnect(PARAMS);
    expect(state.contacts).toHaveLength(1);
    const c = state.contacts[0];
    expect(c.kind).toBe('connector_stale');            // DIAGNOSTIC_KINDS: reserved slice, never crowds humans
    expect(c.clientNumber).toBe('TMC-0001');
    expect(c.userId).toBe(2);
    expect(c.dedupKey).toBe('wa-disconnect:TMC-0001'); // bounded re-alerting while dead
    expect(c.urgency).toBe('high');
  });

  it('the body is the MODEL\'s words when reachable', async () => {
    await alertWhatsAppDisconnect(PARAMS);
    expect(state.contacts[0].body).toBe(state.llmText);
  });

  it('model unreachable → the curated fallback carries the FACTS verbatim (reason + required action)', async () => {
    state.llmThrows = true;
    await alertWhatsAppDisconnect(PARAMS);
    const body = state.contacts[0].body;
    expect(body).toContain('WhatsApp closed the session: LOGOUT');
    expect(body).toContain('scan a fresh QR code');
  });
});

describe('DEF-321 — alert plumbing can never take the disconnect handler down', () => {
  it('no active SA/AD → warn and complete, no throw', async () => {
    state.ownerRows = [];
    await expect(alertWhatsAppDisconnect(PARAMS)).resolves.toBeUndefined();
    expect(state.contacts).toHaveLength(0);
    expect(state.warns.some((w) => String(w[0]).includes('no active SA/AD user'))).toBe(true);
  });

  it('the chokepoint itself throwing → both-routes-down is LOGGED AT ERROR and the function still completes', async () => {
    state.emailThrows = true;
    state.contactThrows = true;
    await expect(alertWhatsAppDisconnect(PARAMS)).resolves.toBeUndefined();
    expect(state.errors.some((e) => String(e[0]).includes('both routes down'))).toBe(true);
  });
});
