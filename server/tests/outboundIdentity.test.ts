import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-07-14 — outbound identity per Basit's two rules:
// 1. Emails from the user's mailbox sign the way the USER signs
//    (explicit pref → learned from Sent items → "Thanks,\n<first>").
// 2. WhatsApp intros use the custom brain name ("Suzi") when set,
//    Nexeo otherwise.

const userFindFirst = vi.fn();
const getSentSamplesMock = vi.fn();
const callLlmMock = vi.fn();
// Pass-through cache so every test exercises the compute path.
const getOrComputeSpy = vi.fn(async (_k: string, _ttl: number, compute: () => Promise<any>) => compute());

vi.mock('../src/db/prisma', () => ({
  default: { user: { findFirst: (...a: any[]) => userFindFirst(...a) } },
}));
vi.mock('../src/utils/redisClient', () => ({
  getOrCompute: (...a: any[]) => getOrComputeSpy(...(a as [string, number, () => Promise<any>])),
}));
vi.mock('../src/services/gmailService', () => ({
  getSentSamples: (...a: any[]) => getSentSamplesMock(...a),
}));
vi.mock('../src/services/llmRouter', () => ({
  callLLM: (...a: any[]) => callLlmMock(...a),
}));

import { getBrainDisplayName, getUserEmailSignature } from '../src/services/knowledge/outboundIdentity';

beforeEach(() => {
  vi.clearAllMocks();
  userFindFirst.mockResolvedValue({ name: 'Basit Ahmed', notificationPreferences: {} });
  getSentSamplesMock.mockResolvedValue({ samples: [] });
  callLlmMock.mockResolvedValue({ text: 'NONE' });
});

describe('getBrainDisplayName — WhatsApp intro identity', () => {
  it('defaults to Nexeo when no custom name is set', async () => {
    expect(await getBrainDisplayName(2)).toBe('Nexeo');
  });

  it('uses the custom brain name when set (Suzi)', async () => {
    userFindFirst.mockResolvedValue({ notificationPreferences: { brainName: 'Suzi' } });
    expect(await getBrainDisplayName(2)).toBe('Suzi');
  });

  it('treats the literal "brain" as unset (legacy default value)', async () => {
    userFindFirst.mockResolvedValue({ notificationPreferences: { brainName: 'Brain' } });
    expect(await getBrainDisplayName(2)).toBe('Nexeo');
  });

  it('falls back to Nexeo on DB failure', async () => {
    userFindFirst.mockRejectedValue(new Error('db down'));
    expect(await getBrainDisplayName(2)).toBe('Nexeo');
  });
});

describe('getUserEmailSignature — sign the way the user signs', () => {
  it('explicit preference wins over everything (no LLM spend)', async () => {
    userFindFirst.mockResolvedValue({
      name: 'Basit Ahmed',
      notificationPreferences: { brain_channel: { emailSignature: 'Regards,\nBasit Ahmed\nSolution Architect | TMC' } },
    });
    const sig = await getUserEmailSignature(2, 'TMC-0001');
    expect(sig).toBe('Regards,\nBasit Ahmed\nSolution Architect | TMC');
    expect(getSentSamplesMock).not.toHaveBeenCalled();
    expect(callLlmMock).not.toHaveBeenCalled();
  });

  it('extracts the recurring sign-off from Sent items when no pref', async () => {
    getSentSamplesMock.mockResolvedValue({
      samples: [
        { subject: 'a', to: 'x@y.com', body: 'Body A\n\nThanks & Regards,\nBasit Ahmed\nSolution Architect' },
        { subject: 'b', to: 'z@y.com', body: 'Body B\n\nThanks & Regards,\nBasit Ahmed\nSolution Architect' },
      ],
    });
    callLlmMock.mockResolvedValue({ text: 'Thanks & Regards,\nBasit Ahmed\nSolution Architect' });
    const sig = await getUserEmailSignature(2, 'TMC-0001');
    expect(sig).toBe('Thanks & Regards,\nBasit Ahmed\nSolution Architect');
    expect(callLlmMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to "Thanks, <first name>" when extraction returns NONE', async () => {
    getSentSamplesMock.mockResolvedValue({
      samples: [
        { subject: 'a', to: 'x', body: 'Body A\ncheers' },
        { subject: 'b', to: 'z', body: 'Body B\nbr' },
      ],
    });
    callLlmMock.mockResolvedValue({ text: 'NONE' });
    expect(await getUserEmailSignature(2, 'TMC-0001')).toBe('Thanks,\nBasit');
  });

  it('falls back safely when Sent items are unavailable (fresh mailbox)', async () => {
    getSentSamplesMock.mockResolvedValue({ samples: [] });
    expect(await getUserEmailSignature(2, 'TMC-0001')).toBe('Thanks,\nBasit');
    expect(callLlmMock).not.toHaveBeenCalled(); // <2 samples → no LLM spend
  });

  it('rejects oversized extraction (LLM ramble) in favour of the fallback', async () => {
    getSentSamplesMock.mockResolvedValue({
      samples: [
        { subject: 'a', to: 'x', body: 'A\nThanks' },
        { subject: 'b', to: 'z', body: 'B\nThanks' },
      ],
    });
    callLlmMock.mockResolvedValue({ text: 'x'.repeat(400) });
    expect(await getUserEmailSignature(2, 'TMC-0001')).toBe('Thanks,\nBasit');
  });

  it('caches under a per-user key with 24h TTL', async () => {
    await getUserEmailSignature(2, 'TMC-0001');
    const [key, ttl] = getOrComputeSpy.mock.calls[0]!;
    expect(key).toBe('emailsig:2');
    expect(ttl).toBe(24 * 3600);
  });
});
