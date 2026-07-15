import { describe, it, expect, vi, beforeEach } from 'vitest';

// C1 — GovernedBrainMemory was write-only: users could approve memories via
// the API but no compose path ever read them. Approving something that never
// applies is a broken promise. renderGovernedMemoriesBlock loads ACTIVE
// memories (user-scoped + tenant-wide) and renders the "# Approved memories"
// block the composer injects.

const findMany = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { governedBrainMemory: { findMany: (...a: any[]) => findMany(...a) } },
}));

import { renderGovernedMemoriesBlock } from '../src/services/learning/governedMemoriesBlock';

beforeEach(() => vi.clearAllMocks());

describe('renderGovernedMemoriesBlock', () => {
  it('loads only ACTIVE memories scoped to tenant + user (or tenant-wide)', async () => {
    findMany.mockResolvedValue([]);
    await renderGovernedMemoriesBlock('tmc', 2);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        clientNumber: 'tmc',
        status: 'active',
        OR: [{ userId: 2 }, { userId: null }],
      }),
    }));
  });

  it('renders title + content under an Approved memories header', async () => {
    findMany.mockResolvedValue([
      { title: 'Prefers PKR figures', content: 'Always quote money in PKR unless asked.', memoryType: 'preference', confidenceScore: 0.9 },
    ]);
    const block = await renderGovernedMemoriesBlock('tmc', 2);
    expect(block).toContain('# Approved memories');
    expect(block).toContain('Prefers PKR figures');
    expect(block).toContain('Always quote money in PKR unless asked.');
  });

  it('returns empty string when there are no active memories', async () => {
    findMany.mockResolvedValue([]);
    expect(await renderGovernedMemoriesBlock('tmc', 2)).toBe('');
  });

  it('never throws — DB failure degrades to empty block', async () => {
    findMany.mockRejectedValue(new Error('db down'));
    expect(await renderGovernedMemoriesBlock('tmc', 2)).toBe('');
  });
});
