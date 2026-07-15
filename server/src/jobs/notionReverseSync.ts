import prisma from '../db/prisma';
import { listEditedSince, fetchPageContent } from '../services/connectors/NotionConnector';
import { isFeatureEnabled } from '../services/featureFlagService';

/**
 * HaseebOS v15 — Notion reverse sync.
 *
 * Polls each tenant's configured thoughts data source for pages edited since
 * the last sync cursor (stored in SystemConfig as `notion_reverse_sync_cursor`).
 * For each edited page with a `tmcai_id` property, compares `lastEditedAt`
 * against local `thought_entries.updatedAt` and applies last-writer-wins.
 *
 * Conflict detection: if both sides were updated within the same minute,
 * we log a conflict and SKIP the update (requires manual reconciliation via
 * the Thought Pipeline UI). This is stricter than the spec's
 * "last-writer-wins" to avoid data loss during bi-directional bursts.
 */

const SYNC_LOOKBACK_MINUTES = 10; // fallback if no cursor stored

export interface ReverseSyncResult {
  clientNumber: string;
  pagesScanned: number;
  updated: number;
  conflicts: number;
  skippedNoLink: number;
  errors: number;
}

export async function reverseSyncTenant(clientNumber: string): Promise<ReverseSyncResult> {
  const cursor = await loadCursor(clientNumber);
  const since = cursor ?? new Date(Date.now() - SYNC_LOOKBACK_MINUTES * 60 * 1000);
  const result: ReverseSyncResult = {
    clientNumber,
    pagesScanned: 0,
    updated: 0,
    conflicts: 0,
    skippedNoLink: 0,
    errors: 0,
  };

  let pages;
  try {
    pages = await listEditedSince(clientNumber, since);
  } catch (err: any) {
    console.warn(`[notionSync] listEditedSince failed for ${clientNumber}: ${err.message}`);
    result.errors += 1;
    return result;
  }

  result.pagesScanned = pages.length;

  for (const page of pages) {
    if (!page.tmcaiId) {
      result.skippedNoLink += 1;
      continue;
    }
    try {
      const local = await prisma.thoughtEntry.findFirst({
        where: { id: page.tmcaiId, clientNumber },
      });
      if (!local) {
        result.skippedNoLink += 1;
        continue;
      }

      const localEditedRecently = Date.now() - local.updatedAt.getTime() < 60_000;
      const bothEditedInSameMinute =
        localEditedRecently && Math.abs(local.updatedAt.getTime() - page.lastEditedAt.getTime()) < 60_000;

      if (bothEditedInSameMinute) {
        result.conflicts += 1;
        console.warn(
          `[notionSync] conflict on thought ${local.id}: local=${local.updatedAt.toISOString()} notion=${page.lastEditedAt.toISOString()} — skipping`,
        );
        continue;
      }

      // Notion is authoritative only if it was edited strictly after local
      if (page.lastEditedAt.getTime() <= local.updatedAt.getTime()) {
        continue;
      }

      const content = await fetchPageContent(clientNumber, page.pageId);
      await prisma.thoughtEntry.update({
        where: { id: local.id },
        data: {
          title: page.title ?? local.title,
          content: content || local.content,
          status: page.status ?? local.status,
          // Don't bump updatedAt to Notion's time — Prisma @updatedAt will stamp now(),
          // which reflects "last reconciled by this worker"
        },
      });
      result.updated += 1;
    } catch (err: any) {
      result.errors += 1;
      console.warn(`[notionSync] page ${page.pageId} failed: ${err.message}`);
    }
  }

  // Advance cursor to the most recent last_edited_time we saw, minus 1s for safety overlap
  if (pages.length > 0) {
    const latest = pages.reduce((a, b) => (a.lastEditedAt > b.lastEditedAt ? a : b)).lastEditedAt;
    await saveCursor(clientNumber, new Date(latest.getTime() - 1000));
  }

  return result;
}

export async function reverseSyncAllTenants(): Promise<ReverseSyncResult[]> {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true }, select: { clientNumber: true } });
  const out: ReverseSyncResult[] = [];
  for (const t of tenants) {
    const enabled = await isFeatureEnabled(t.clientNumber, 'feature_notion_reverse_sync', false);
    if (!enabled) continue;
    try {
      out.push(await reverseSyncTenant(t.clientNumber));
    } catch (err: any) {
      console.warn(`[notionSync] tenant ${t.clientNumber} failed: ${err.message}`);
    }
  }
  return out;
}

async function loadCursor(clientNumber: string): Promise<Date | null> {
  const row = await prisma.systemConfig.findUnique({
    where: { clientNumber_key: { clientNumber, key: 'notion_reverse_sync_cursor' } },
  });
  if (!row?.value) return null;
  const parsed = new Date(row.value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

async function saveCursor(clientNumber: string, at: Date): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber, key: 'notion_reverse_sync_cursor' } },
    create: { clientNumber, key: 'notion_reverse_sync_cursor', value: at.toISOString() },
    update: { value: at.toISOString() },
  });
}
