import type { FeedSourceType } from '../feed/feedIngestionService';
import type { FeedAdapter } from './adapterBase';

const adapters = new Map<FeedSourceType, FeedAdapter>();

export function register(adapter: FeedAdapter): void {
  adapters.set(adapter.sourceType, adapter);
}

export function get(sourceType: FeedSourceType): FeedAdapter | undefined {
  return adapters.get(sourceType);
}

export function requireAdapter(sourceType: FeedSourceType): FeedAdapter {
  const a = adapters.get(sourceType);
  if (!a) throw new Error(`no adapter registered for source "${sourceType}"`);
  return a;
}

export function listAll(): FeedAdapter[] {
  return Array.from(adapters.values());
}

export function capabilities(): Array<{ sourceType: string; displayName: string; capabilities: Record<string, boolean> }> {
  return listAll().map((a) => ({
    sourceType: a.sourceType,
    displayName: a.displayName,
    capabilities: a.capabilities(),
  }));
}
