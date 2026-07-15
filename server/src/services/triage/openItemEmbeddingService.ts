/**
 * HaseebOS v15 L2+ — OpenItem vector memory.
 *
 * On createItem(), embed (title + description + archetype) and persist into
 * open_item_embeddings. Consumers (Triage Analyst, Brain) can query similar
 * past items to inform priority / response suggestions.
 *
 * Embedding backend:
 *   - Gemini `text-embedding-004` when GEMINI_API_KEY is present (768 dims)
 *   - Dev fallback: deterministic hash-based 256-dim stub so local tests still
 *     round-trip without hitting the API.
 */
import crypto from 'crypto';
import prisma from '../../db/prisma';

const MODEL_GEMINI = 'gemini-embedding-004';
const MODEL_STUB = 'stub-256';

export async function embedAndStore(openItemId: string, clientNumber: string, text: string): Promise<void> {
  if (!text.trim()) return;
  const textHash = crypto.createHash('sha256').update(text).digest('hex');
  try {
    // Skip if we already embedded this exact text (idempotent)
    const existing = await (prisma as any).openItemEmbedding.findUnique({
      where: { openItemId },
      select: { textHash: true },
    }).catch(() => null);
    if (existing?.textHash === textHash) return;

    const res = await embed(text);
    if (!res) return; // provider down in prod → no stub write; re-embeds on next content change
    const { embedding, model, dim } = res;
    await (prisma as any).openItemEmbedding.upsert({
      where: { openItemId },
      update: { embedding: embedding as any, model, dim, textHash, createdAt: new Date() },
      create: { openItemId, clientNumber, embedding: embedding as any, model, dim, textHash },
    });
  } catch (err: any) {
    console.warn(`[embeddings] store failed for ${openItemId}: ${err.message}`);
  }
}

export interface SimilarItem {
  openItemId: string;
  score: number;
}

export async function findSimilar(clientNumber: string, openItemId: string, limit = 5): Promise<SimilarItem[]> {
  const root = await (prisma as any).openItemEmbedding.findUnique({
    where: { openItemId },
    select: { embedding: true, dim: true, model: true },
  });
  if (!root) return [];
  const rootVec = root.embedding as number[];

  const candidates = await (prisma as any).openItemEmbedding.findMany({
    where: { clientNumber, openItemId: { not: openItemId }, model: root.model, dim: root.dim } as any,
    select: { openItemId: true, embedding: true },
    take: 500,
    orderBy: { createdAt: 'desc' },
  });

  const scored = candidates.map((c: any) => ({
    openItemId: c.openItemId,
    score: cosine(rootVec, c.embedding as number[]),
  }));
  scored.sort((a: SimilarItem, b: SimilarItem) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─── internals ───────────────────────────────────────────────────

/** null = provider unavailable in production (stub writes forbidden —
 *  audit 2026-07-14 #7). Retrieval already filters by model+dim, so
 *  dev-mode stubs stay internally consistent. */
async function embed(text: string): Promise<{ embedding: number[]; model: string; dim: number } | null> {
  const { stubsAllowed, recordEmbeddingDegradation, recordEmbeddingRecovery } = await import('../knowledge/embeddingGuard');
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  let lastError = 'no GEMINI_API_KEY/GOOGLE_API_KEY configured';
  if (key) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        },
      );
      if (r.ok) {
        const j: any = await r.json();
        const vec: number[] = j.embedding?.values ?? j.embedding ?? [];
        if (vec.length > 0) {
          recordEmbeddingRecovery('open_items');
          return { embedding: vec, model: MODEL_GEMINI, dim: vec.length };
        }
        lastError = 'empty embedding in response';
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e: any) { lastError = e?.message ?? 'fetch failed'; }
  }
  if (stubsAllowed()) return { embedding: stubEmbed(text), model: MODEL_STUB, dim: 256 };
  await recordEmbeddingDegradation('open_items', lastError);
  return null;
}

/** Deterministic 256-dim stub — hash-based so similar inputs land near each other. */
function stubEmbed(text: string): number[] {
  const vec = new Array(256).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    const h = crypto.createHash('sha256').update(tok).digest();
    for (let i = 0; i < 256; i += 1) vec[i] += (h[i % h.length] / 255) - 0.5;
  }
  const mag = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / mag);
}

function cosine(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
