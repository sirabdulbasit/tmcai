/**
 * Admin — Client (tenant) Google Drive connector.
 *
 * One folder per tenant (the "FACL" folder) holds the curated org
 * knowledge that Brain reads into its memory. Folder ID lives in
 * system_config under key `google_drive_folder_id`. The scribe is
 * manual from here, plus a daily job runs from server.ts.
 */
import { Router, Request, Response } from 'express';
import prisma from '../../db/prisma';
import { requireAdmin } from '../../middleware/auth';

const router = Router();

// In-memory scribe status per tenant (ephemeral; resets on boot)
const scribeState = new Map<string, {
  status: 'idle' | 'running' | 'ok' | 'error';
  startedAt?: string;
  lastScribedAt?: string;
  lastSummary?: any;
  error?: string;
}>();

async function readConfig(clientNumber: string, key: string): Promise<string | null> {
  const r = await prisma.systemConfig.findUnique({
    where: { clientNumber_key: { clientNumber, key } },
    select: { value: true },
  }).catch(() => null);
  return r?.value ?? null;
}

/** GET /admin/client-drive/status — folder ID + live scribe + doc count. */
router.get('/client-drive/status', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = String(req.query.cn || req.user?.clientNumber);
    if (!clientNumber) return res.status(400).json({ error: 'clientNumber required' });
    const [folderId, indexFile, docCount] = await Promise.all([
      readConfig(clientNumber, 'google_drive_folder_id'),
      readConfig(clientNumber, 'google_index_file_name'),
      prisma.wikiPage.count({ where: { clientNumber, pageType: 'org_doc' } as any }).catch(() => 0),
    ]);
    const state = scribeState.get(clientNumber) ?? { status: 'idle' };
    res.json({
      clientNumber,
      folderId: folderId || null,
      indexFileName: indexFile || null,
      docCount,
      scribeStatus: state.status,
      scribeStartedAt: state.startedAt ?? null,
      lastScribedAt: state.lastScribedAt ?? null,
      lastSummary: state.lastSummary ?? null,
      error: state.error ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/client-drive/scribe — kick off the walk+summarise pipeline
 *  for this tenant. Runs in background; poll /status for completion. */
router.post('/client-drive/scribe', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = String(req.body?.clientNumber || req.user?.clientNumber);
    if (!clientNumber) return res.status(400).json({ error: 'clientNumber required' });
    const folderId = await readConfig(clientNumber, 'google_drive_folder_id');
    if (!folderId) return res.status(400).json({ error: 'Set google_drive_folder_id in Client Config first' });

    scribeState.set(clientNumber, { status: 'running', startedAt: new Date().toISOString() });

    void (async () => {
      try {
        const { scribeFaclForTenant } = await import('../../services/knowledge/folderScribeService');
        const summary = await scribeFaclForTenant(clientNumber, folderId);
        scribeState.set(clientNumber, {
          status: summary.scanned > 0 || summary.updated > 0 ? 'ok' : 'error',
          lastScribedAt: new Date().toISOString(),
          lastSummary: summary,
          error: summary.scanned === 0 && summary.updated === 0 ? 'Folder returned no text-extractable docs (check folder ID + admin auth)' : undefined,
        });
      } catch (err: any) {
        scribeState.set(clientNumber, { status: 'error', error: err.message });
      }
    })();

    res.json({ ok: true, queued: true, clientNumber, folderId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /admin/client-drive/test — verify we can list the folder. */
router.post('/client-drive/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = String(req.body?.clientNumber || req.user?.clientNumber);
    const folderId = await readConfig(clientNumber, 'google_drive_folder_id');
    if (!folderId) return res.status(400).json({ error: 'Set google_drive_folder_id first' });

    const admin = await prisma.user.findFirst({
      where: { clientNumber, isActive: true, integrationProvider: 'google', integrationStatus: 'active' } as any,
      orderBy: { userType: 'asc' },
      select: { id: true, email: true },
    });
    if (!admin) return res.status(400).json({ error: 'No admin user in this tenant has a Google connector. Connect Google Drive on at least one admin account.' });

    const { google } = await import('googleapis');
    const { getAuthenticatedClient } = await import('../../services/integrationService');
    const auth = await getAuthenticatedClient(admin.id);
    if (!auth?.client) return res.status(500).json({ error: 'Failed to authenticate admin Google account' });
    const drive = google.drive({ version: 'v3', auth: auth.client });
    const meta = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType' }).catch((e: any) => ({ data: null, err: e.message }));
    const folder = (meta as any).data;
    if (!folder || folder.mimeType !== 'application/vnd.google-apps.folder') {
      return res.status(400).json({ error: (meta as any).err ?? `Not a valid folder ID (mimeType: ${folder?.mimeType ?? '?'})` });
    }
    const list = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'files(id,name,mimeType)',
      pageSize: 20,
    }).catch(() => ({ data: { files: [] } }));
    res.json({
      ok: true,
      folder: { id: folder.id, name: folder.name },
      sample: (list as any).data.files || [],
      adminEmail: admin.email,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
