import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory prisma stub. Exercises the service logic without a live DB.
type Row = {
  id: bigint;
  clientNumber: string;
  userId: number;
  question: string;
  openItemId: string | null;
  sideEffect: any;
  criticality: 'routine' | 'high' | 'top';
  state: 'queued' | 'awaiting_reply' | 'answered' | 'skipped' | 'expired';
  channelUsed: string | null;
  ackMessageId: string | null;
  dedupKey: string | null;
  queuedAt: Date;
  sentAt: Date | null;
  answeredAt: Date | null;
  expiresAt: Date | null;
  answerText: string | null;
  metadata: any;
};

let nextId = 1n;
const rows: Row[] = [];

function matchesWhere(r: Row, where: any): boolean {
  for (const [k, v] of Object.entries(where)) {
    const actual = (r as any)[k];
    if (v && typeof v === 'object' && 'in' in (v as any)) {
      if (!(v as any).in.includes(actual)) return false;
    } else if (v && typeof v === 'object' && 'lt' in (v as any)) {
      if (!(actual instanceof Date) || actual >= (v as any).lt) return false;
    } else if (v && typeof v === 'object' && 'gte' in (v as any)) {
      if (!(actual instanceof Date) || actual < (v as any).gte) return false;
    } else if (actual !== v) {
      return false;
    }
  }
  return true;
}

vi.mock('../../../db/prisma', () => ({
  default: {
    brainPromptQueue: {
      create: vi.fn(async ({ data, select }: any) => {
        // Enforce partial unique: only one awaiting_reply per user.
        if (data.state === 'awaiting_reply' && rows.some((r) => r.userId === data.userId && r.state === 'awaiting_reply')) {
          const err: any = new Error('partial unique violation'); err.code = 'P2002';
          throw err;
        }
        const row: Row = {
          id: nextId++, clientNumber: data.clientNumber, userId: data.userId,
          question: data.question, openItemId: data.openItemId ?? null,
          sideEffect: data.sideEffect ?? {}, criticality: data.criticality ?? 'routine',
          state: data.state ?? 'queued', channelUsed: data.channelUsed ?? null,
          ackMessageId: data.ackMessageId ?? null, dedupKey: data.dedupKey ?? null,
          queuedAt: new Date(), sentAt: data.sentAt ?? null,
          answeredAt: data.answeredAt ?? null,
          expiresAt: data.expiresAt ?? null, answerText: null,
          metadata: data.metadata ?? {},
        };
        rows.push(row);
        return select ? { id: row.id } : row;
      }),
      findFirst: vi.fn(async ({ where, orderBy, select }: any) => {
        let matches = rows.filter((r) => matchesWhere(r, where ?? {}));
        if (orderBy) {
          const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
          matches = matches.sort((a, b) => {
            for (const o of orders) {
              const [field, dir] = Object.entries(o)[0];
              const av = (a as any)[field]; const bv = (b as any)[field];
              if (av < bv) return dir === 'asc' ? -1 : 1;
              if (av > bv) return dir === 'asc' ? 1 : -1;
            }
            return 0;
          });
        }
        const m = matches[0];
        if (!m) return null;
        if (!select) return m;
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (m as any)[k];
        return out;
      }),
      findMany: vi.fn(async ({ where, take }: any) => {
        const matches = rows.filter((r) => matchesWhere(r, where ?? {}));
        return matches.slice(0, take ?? 200);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error(`row ${where.id} not found`);
        if (data.state === 'awaiting_reply' && rows.some((r) => r.id !== row.id && r.userId === row.userId && r.state === 'awaiting_reply')) {
          const err: any = new Error('partial unique violation'); err.code = 'P2002';
          throw err;
        }
        Object.assign(row, data);
        return row;
      }),
    },
    brainUserMessage: {
      findFirst: vi.fn(async () => null),  // no recent voice call by default
    },
  },
}));

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../../notifications/brainOutboundService', () => ({
  brainContactsUser: sendMock,
}));

import {
  enqueueBrainPrompt, sendNextPrompt, expireStalePrompts,
  getAwaitingPrompt, recordAnswer,
} from '../brainPromptQueueService';

beforeEach(() => {
  rows.length = 0;
  nextId = 1n;
  sendMock.mockClear();
  sendMock.mockImplementation(async () => ({
    sent: true, channelsUsed: ['text'], waMessageIds: ['wa_test_1'], reason: undefined,
  }));
});

describe('enqueueBrainPrompt — routine', () => {
  it('enqueues + dispatches when slot is free', async () => {
    const r = await enqueueBrainPrompt({
      userId: 1, clientNumber: 'TMC-0001',
      question: 'When is the deadline for X?',
      criticality: 'routine',
    });
    expect(r.status).toBe('sent_now');
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].channel).toBe('text');
    const row = rows[0];
    expect(row.state).toBe('awaiting_reply');
    expect(row.channelUsed).toBe('text');
  });

  it('queues second prompt when one is already awaiting_reply', async () => {
    await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Q1' });
    const r = await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Q2' });
    expect(r.status).toBe('queued');
    expect(rows[0].state).toBe('awaiting_reply');
    expect(rows[1].state).toBe('queued');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('respects dedup_key', async () => {
    await enqueueBrainPrompt({
      userId: 1, clientNumber: 'TMC-0001',
      question: 'Same question', dedupKey: 'k1',
    });
    const r = await enqueueBrainPrompt({
      userId: 1, clientNumber: 'TMC-0001',
      question: 'Same question', dedupKey: 'k1',
    });
    expect(r.status).toBe('duplicate');
    expect(rows.length).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('enqueueBrainPrompt — high', () => {
  // CHANGED by owner ruling 2026-08-06 (DEF-084): "always send text message
  // instead of voice (sometime unable to understand)". `high` used to mean a
  // voice note, so every overdue reminder arrived as audio — which cannot be
  // skimmed, searched or re-read, and where a mishearing is silent. Voice is
  // now opt-in via `brain.voice_prompt_min_criticality`; text is the default.
  it('uses TEXT by default, not a voice note', async () => {
    sendMock.mockImplementationOnce(async () => ({
      sent: true, channelsUsed: ['text'], waMessageIds: ['wa_v_1'],
    }));
    const r = await enqueueBrainPrompt({
      userId: 1, clientNumber: 'TMC-0001',
      question: 'CFO needs your call back today.',
      criticality: 'high',
    });
    expect(r.status).toBe('sent_now');
    expect(sendMock.mock.calls[0][0].channel).toBe('text');
    expect(sendMock.mock.calls[0][0].urgency).toBe('high');
  });
});

describe('enqueueBrainPrompt — top', () => {
  it('bypasses queue and fires voice call', async () => {
    sendMock.mockImplementationOnce(async () => ({
      sent: true, channelsUsed: ['call_business'], waMessageIds: ['call_id_1'],
    }));
    const r = await enqueueBrainPrompt({
      userId: 1, clientNumber: 'TMC-0001',
      question: 'Critical: production payment processor down. Decision needed.',
      criticality: 'top',
    });
    expect(r.status).toBe('top_dispatched');
    expect(sendMock.mock.calls[0][0].channel).toBe('call_business');
    expect(sendMock.mock.calls[0][0].urgency).toBe('emergency');
    expect(sendMock.mock.calls[0][0].bypassQuietHours).toBe(true);
    // top doesn't claim awaiting_reply slot.
    expect(rows[0].state).toBe('answered');  // call placed counts as delivered
  });

  it('does NOT block routine conversation already in progress', async () => {
    await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Routine Q' });
    expect(rows[0].state).toBe('awaiting_reply');
    sendMock.mockImplementationOnce(async () => ({
      sent: true, channelsUsed: ['call_business'], waMessageIds: ['call_id_2'],
    }));
    await enqueueBrainPrompt({
      userId: 1, clientNumber: 'TMC-0001',
      question: 'Top urgent', criticality: 'top',
    });
    // Routine still awaiting_reply
    expect(rows[0].state).toBe('awaiting_reply');
    // Top went straight through
    expect(rows[1].state).toBe('answered');
  });
});

describe('reply flow', () => {
  it('getAwaitingPrompt + recordAnswer + sendNextPrompt advances', async () => {
    await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Q1' });
    await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Q2' });
    const awaiting = await getAwaitingPrompt(1);
    expect(awaiting?.question).toBe('Q1');
    await recordAnswer(awaiting!.id, 'answer to Q1');
    expect(rows[0].state).toBe('answered');
    expect(rows[0].answerText).toBe('answer to Q1');
    sendMock.mockClear();
    const next = await sendNextPrompt(1);
    expect(next?.promptId).toBe(String(rows[1].id));
    expect(rows[1].state).toBe('awaiting_reply');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('sendNextPrompt is no-op when slot is full', async () => {
    await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Q1' });
    sendMock.mockClear();
    const next = await sendNextPrompt(1);
    expect(next).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('expiry', () => {
  it('auto-skips past-TTL prompts and advances queue', async () => {
    await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Q1' });
    await enqueueBrainPrompt({ userId: 1, clientNumber: 'TMC-0001', question: 'Q2' });
    // Force Q1 expiry
    rows[0].expiresAt = new Date(Date.now() - 1000);
    sendMock.mockClear();
    const r = await expireStalePrompts();
    expect(r.expired).toBe(1);
    expect(rows[0].state).toBe('expired');
    expect(rows[1].state).toBe('awaiting_reply');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('rollback on outbound suppression', () => {
  it('rolls prompt back to queued when WhatsApp send is suppressed', async () => {
    sendMock.mockImplementationOnce(async () => ({
      sent: false, reason: 'quiet_hours', channelsUsed: [], waMessageIds: [],
    }));
    const r = await enqueueBrainPrompt({
      userId: 1, clientNumber: 'TMC-0001', question: 'Q1',
    });
    expect(r.status).toBe('queued');
    // Internal row state must NOT be awaiting_reply (rolled back)
    expect(rows[0].state).toBe('queued');
    expect(rows[0].sentAt).toBeNull();
  });
});
