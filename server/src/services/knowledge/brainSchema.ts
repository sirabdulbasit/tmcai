/**
 * Brain Schema — loads docs/brain_schema.md into memory so every Brain LLM call
 * can include it in its prompt (CLAUDE.md-style). Cached 10 min; re-read on edit.
 */
import fs from 'fs';
import path from 'path';

export const BRAIN_SCHEMA_VERSION = 1;

const SCHEMA_PATH = path.resolve(__dirname, '../../../../docs/brain_schema.md');
const TTL_MS = 10 * 60 * 1000;

let cache: { text: string; loadedAt: number } | null = null;

export function getBrainSchemaText(): string {
  if (cache && Date.now() - cache.loadedAt < TTL_MS) return cache.text;
  try {
    const text = fs.readFileSync(SCHEMA_PATH, 'utf8');
    cache = { text, loadedAt: Date.now() };
    return text;
  } catch {
    return '(brain_schema.md not found — Brain is running without its schema; expect degraded reasoning.)';
  }
}

/** Force re-read on next access (call after the docs file is edited in dev). */
export function invalidateBrainSchema(): void {
  cache = null;
}
