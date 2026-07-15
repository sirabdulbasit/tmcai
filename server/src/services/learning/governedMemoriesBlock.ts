// ═════════════════════════════════════════════════════════════════════════════
// governedMemoriesBlock — the READ path for GovernedBrainMemory.
//
// C1 (2026-07-08): users could approve governed memories via the API but no
// compose/retrieval/decision path ever read them — dead storage, a broken
// promise ("I approved it, Brain still doesn't know it"). This renders the
// "# Approved memories" block brainComposer injects into every prompt.
//
// Scope: ACTIVE memories only; user-scoped rows for this user plus
// tenant-wide rows (userId NULL). Ordered by confidence then recency so the
// strongest memories lead. Capped to keep prompt weight bounded.
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('governed-memories');

const MAX_MEMORIES = 20;

export async function renderGovernedMemoriesBlock(clientNumber: string, userId: number): Promise<string> {
  try {
    const rows = await prisma.governedBrainMemory.findMany({
      where: {
        clientNumber,
        status: 'active',
        OR: [{ userId }, { userId: null }],
      },
      select: { title: true, content: true, memoryType: true, confidenceScore: true },
      orderBy: [{ confidenceScore: 'desc' }, { approvedAt: 'desc' }],
      take: MAX_MEMORIES,
    });
    if (rows.length === 0) return '';

    const lines = rows.map((m) => `- **${m.title}** (${m.memoryType}): ${m.content}`);
    return [
      '# Approved memories (user-governed — the user explicitly approved these; apply them)',
      ...lines,
    ].join('\n');
  } catch (err: any) {
    // Prompt assembly must never fail because governance storage hiccuped.
    log.warn('governed memories load failed — omitting block', { err: err?.message });
    return '';
  }
}
