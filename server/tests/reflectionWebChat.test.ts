import { describe, it, expect, vi, beforeEach } from 'vitest';

// C6 — the reflection job scanned WhatsApp session history ONLY; web-chat
// turns (higher volume) were excluded from preference extraction, so a
// user who mostly corrects Brain on the web taught it nothing. The scan
// now merges the web `messages` table (excluding the WhatsApp-synced
// copies, which would double-count).

const queryRaw = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: (...a: any[]) => queryRaw(...a) },
}));
vi.mock('../src/services/knowledge/userMemoryService', () => ({
  getApplicableMemories: vi.fn(async () => []),
  recordInferredMemory: vi.fn(async () => ({})),
}));
const callGemini = vi.fn(async () => '{"proposals": []}');
vi.mock('../src/services/geminiService', () => ({
  callGemini: (...a: any[]) => callGemini(...a),
}));

import { runReflectionForUser } from '../src/jobs/reflectionJob';

beforeEach(() => vi.clearAllMocks());

describe('reflection scans web chat too', () => {
  it('merges web messages so web-only users still get reflection', async () => {
    queryRaw.mockImplementation(async (sql: string) => {
      if (/whatsapp_sessions/.test(sql)) return []; // no WA history at all
      if (/FROM messages/.test(sql)) {
        return Array.from({ length: 8 }, (_, i) => ({
          role: i % 2 ? 'assistant' : 'user',
          content: `web turn ${i} — keep replies short please`,
        }));
      }
      return [];
    });
    await runReflectionForUser(2, 'tmc');
    // Web turns alone crossed the >=6 threshold → the LLM ran.
    expect(callGemini).toHaveBeenCalled();
    const prompt = String(callGemini.mock.calls[0].slice(0, 2).join('\n'));
    expect(prompt).toContain('web turn');
  });

  it('excludes WhatsApp-synced copies from the web query (no double-count)', async () => {
    queryRaw.mockResolvedValue([]);
    await runReflectionForUser(2, 'tmc');
    const webSql = String(queryRaw.mock.calls.find((c) => /FROM messages/.test(String(c[0])))?.[0] ?? '');
    expect(webSql).toMatch(/source[^\n]*whatsapp/i);
  });
});
