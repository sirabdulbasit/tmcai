import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn();
const executeRaw = vi.fn();
const ingest = vi.fn();
const enqueueBrainPrompt = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: (...args: any[]) => queryRaw(...args),
    $executeRawUnsafe: (...args: any[]) => executeRaw(...args),
  },
}));
vi.mock('../src/services/feed/feedIngestionService', () => ({ ingest: (...a: any[]) => ingest(...a) }));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueueBrainPrompt(...a),
}));

import { captureExpectedExternalReply } from '../src/services/whatsapp/expectedExternalReplyService';

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
  ingest.mockResolvedValue({ status: 'new', feedEventId: 'feed-1', contentHash: 'hash' });
  enqueueBrainPrompt.mockResolvedValue({ id: 'prompt-1' });
});

describe('expected external WhatsApp replies', () => {
  it('drops an unknown sender with no recent authorized outbound', async () => {
    queryRaw.mockResolvedValueOnce([]);
    const result = await captureExpectedExternalReply({
      clientNumber: 'TMC-0001', fromNumber: '+923000000000', body: 'hello',
      messageType: 'text', sourceId: 'wa-unknown',
    });
    expect(result).toEqual({ matched: false });
    expect(queryRaw.mock.calls[0].slice(1, 7)).not.toContain(undefined);
    expect(ingest).not.toHaveBeenCalled();
    expect(enqueueBrainPrompt).not.toHaveBeenCalled();
  });

  it('captures Yousaf reply, confirms delivery, and attaches it to EXIM', async () => {
    queryRaw
      .mockResolvedValueOnce([{
        id: 44, user_id: 2, to_number: '+923028000553',
        content: 'Please update the EXIM solution item', created_at: new Date(),
      }])
      .mockResolvedValueOnce([{ id: 'contact-y', name: 'Muhammad Yousaf' }])
      .mockResolvedValueOnce([{ id: 'oi-exim', title: 'EXIM solution' }]);

    const result = await captureExpectedExternalReply({
      clientNumber: 'TMC-0001', fromNumber: '+923028000553',
      body: 'We have given all documentation to Basit. We are now working on ITL and Feroze1888.',
      messageType: 'text', sourceId: 'wa-yousaf-1', timestamp: Date.now(),
    });

    expect(result).toMatchObject({
      matched: true, userId: 2, contactName: 'Muhammad Yousaf',
      openItemId: 'oi-exim', feedEventId: 'feed-1',
    });
    expect(executeRaw.mock.calls[0][0]).toContain("SET status = 'delivered'");
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'whatsapp', userId: 2,
      payload: expect.objectContaining({
        expectedExternalReply: true,
        relatedOpenItemId: 'oi-exim',
      }),
    }));
    expect(executeRaw.mock.calls[1][0]).toContain('lastDelegateeWhatsAppReply');
    expect(enqueueBrainPrompt).toHaveBeenCalledWith(expect.objectContaining({
      userId: 2, openItemId: 'oi-exim',
      question: expect.stringContaining('Muhammad Yousaf replied'),
    }));
  });
});
