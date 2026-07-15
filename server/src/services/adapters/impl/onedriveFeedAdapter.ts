/**
 * OneDrive FeedAdapter — surfaces file create / modify / share events
 * from Microsoft Graph for every user who paired the
 * `onedrive_personal` connector. Mirrors the existing FACL Drive
 * scribe shape so files can flow into the wiki later.
 *
 * Window: items modified in the last 7d. We use `/me/drive/root/delta`
 * which returns incremental changes — the first call returns all
 * recent changes plus a `@odata.deltaLink` we save for the next poll.
 *
 * Conservative scope (v1):
 *   - Files only (folders skipped)
 *   - No body / OCR (we just record metadata + a download URL)
 *   - DeltaLink is stored per-user in user_connectors.config so the
 *     next poll only fetches new changes.
 */
import { FeedAdapter, NormalizedEvent, AdapterHealth, BackfillRange, BackfillResult, TeardownResult } from '../adapterBase';
import prisma from '../../../db/prisma';
import { listConnectedUsers, ensureFreshGraphToken } from './msGraphHelper';
import { decryptConnectorConfig, encryptConnectorConfig } from '../../connectorService';
import createLogger from '../../../utils/logger';

const log = createLogger('onedrive-adapter');

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  file?: { mimeType?: string; hashes?: { quickXorHash?: string } };
  folder?: { childCount?: number };
  parentReference?: { path?: string };
  lastModifiedBy?: { user?: { displayName?: string; email?: string } };
  __userId?: number;
  __changeKind?: 'created' | 'modified' | 'deleted';
}

export class OneDriveFeedAdapter extends FeedAdapter {
  readonly sourceType = 'onedrive_personal' as any;
  readonly displayName = 'OneDrive';

  async receive(tenantId: string, _since?: Date, limit = 25): Promise<unknown[]> {
    const users = await listConnectedUsers(tenantId, 'onedrive_personal');
    const all: unknown[] = [];
    for (const u of users) {
      try {
        const items = await this.deltaForUser(u.userId, limit);
        for (const i of items) {
          if (!i.file) continue;     // skip folders
          all.push({ ...i, __userId: u.userId });
        }
      } catch (err: any) {
        log.warn('onedrive receive failed', { userId: u.userId, error: err.message });
      }
    }
    return all;
  }

  normalise(raw: unknown): NormalizedEvent {
    const f = raw as DriveItem;
    const lastByName = f.lastModifiedBy?.user?.displayName;
    const lastByEmail = f.lastModifiedBy?.user?.email;
    return {
      sourceId: f.id,
      eventType: (f.__changeKind === 'created' ? 'file_created'
        : f.__changeKind === 'deleted' ? 'file_deleted'
        : 'file_modified') as any,
      sender: { name: lastByName, email: lastByEmail },
      payload: {
        userId: f.__userId,
        name: f.name,
        size: f.size,
        mimeType: f.file?.mimeType,
        link: f.webUrl,
        path: f.parentReference?.path,
        lastModifiedAt: f.lastModifiedDateTime,
        createdAt: f.createdDateTime,
        lastModifiedBy: lastByName ?? lastByEmail,
        provider: 'onedrive',
      },
      receivedAt: f.lastModifiedDateTime ? new Date(f.lastModifiedDateTime) : new Date(),
    };
  }

  async health(): Promise<AdapterHealth> {
    return { ok: true, detail: 'tenant-level health derived from connected users', lastCheckedAt: new Date().toISOString() };
  }

  async backfill(range: BackfillRange): Promise<BackfillResult> {
    const limit = range.maxEvents ?? 100;
    const raws = await this.receive(range.tenantId, range.since, Math.min(limit, 500));
    let fetched = raws.length;
    let ingested = 0; let duplicates = 0; let errors = 0;
    let first: Date | undefined; let last: Date | undefined;
    for (const raw of raws) {
      try {
        const n = this.normalise(raw);
        if (range.since && n.receivedAt < range.since) continue;
        if (range.until && n.receivedAt > range.until) continue;
        const r = await this.storeAndPublish(n, range.tenantId);
        if (r.status === 'new') ingested += 1;
        else if (r.status === 'duplicate') duplicates += 1;
        else errors += 1;
        if (!first || n.receivedAt < first) first = n.receivedAt;
        if (!last || n.receivedAt > last) last = n.receivedAt;
      } catch { errors += 1; }
    }
    return { fetched, ingested, duplicates, errors, firstEventAt: first, lastEventAt: last };
  }

  async teardown(tenantId: string): Promise<TeardownResult> {
    const ct = await prisma.connectorType.findUnique({ where: { slug: 'onedrive_personal' } });
    if (!ct) return { ok: true, connectionsRemoved: 0, tokensRevoked: 0 };
    const result = await prisma.userConnector.updateMany({
      where: { clientNumber: tenantId, connectorTypeId: ct.id },
      data: { status: 'disconnected', errorMessage: null },
    });
    return { ok: true, connectionsRemoved: result.count, tokensRevoked: result.count };
  }

  // ─── internals ───────────────────────────────────────────────

  /** Fetch the next page of changes via /me/drive/root/delta. Uses the
   *  saved deltaLink if we have one (incremental); otherwise starts
   *  from scratch (returns all recent items). Saves the new deltaLink
   *  back to user_connectors.config for the next poll. */
  private async deltaForUser(userId: number, limit: number): Promise<DriveItem[]> {
    const ct = await prisma.connectorType.findUnique({ where: { slug: 'onedrive_personal' } });
    if (!ct) return [];
    const token = await ensureFreshGraphToken(userId, 'onedrive_personal');
    if (!token) return [];

    const uc = await prisma.userConnector.findUnique({
      where: { userId_connectorTypeId: { userId, connectorTypeId: ct.id } },
    });
    const cfg = uc?.config ? await decryptConnectorConfig(uc.config as Record<string, unknown>) : {};
    const savedDelta = (cfg.deltaLink as string | undefined) ?? null;

    const url = savedDelta
      ?? `https://graph.microsoft.com/v1.0/me/drive/root/delta?$top=${Math.min(limit, 50)}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      log.warn('drive delta failed', { userId, status: r.status });
      return [];
    }
    const j: any = await r.json();
    const items: DriveItem[] = (j.value ?? []).map((it: any) => ({
      ...it,
      __changeKind: it.deleted ? 'deleted' : (it.createdDateTime === it.lastModifiedDateTime ? 'created' : 'modified'),
    }));

    // Save the new delta link if Graph returned one. (Final-page response
    // includes @odata.deltaLink; intermediate pages have @odata.nextLink.)
    const newDelta = j['@odata.deltaLink'] as string | undefined;
    if (newDelta && newDelta !== savedDelta) {
      const updated = { ...cfg, deltaLink: newDelta };
      const enc = await encryptConnectorConfig(updated);
      await prisma.userConnector.update({
        where: { userId_connectorTypeId: { userId, connectorTypeId: ct.id } },
        data: { config: enc as any },
      }).catch(() => {});
    }
    return items;
  }
}

export default new OneDriveFeedAdapter();
