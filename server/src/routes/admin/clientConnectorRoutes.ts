/**
 * Admin — Client (tenant) Connectors.
 *
 * The tenant-level equivalent of user-level /connectors. An admin
 * configures knowledge sources ONCE for the whole client; every user in
 * the tenant's Brain reads them as shared context.
 *
 * Storage:
 *   - Connection state + config live in `system_config` keyed per tenant.
 *   - Wiki pages produced by the scribe are stored tenant-wide (pageType
 *     = 'org_doc') and read by every user via getOrgSnapshot().
 *
 * Connector types (POC):
 *   - google_drive_org   → live. Uses an admin's Google OAuth; one FACL
 *                          folder ID configured in system_config.
 *   - onedrive_org       → placeholder (same pattern; Microsoft Graph).
 *   - dropbox_org        → placeholder (same pattern).
 */
import { Router, Request, Response } from 'express';
import prisma from '../../db/prisma';
import { requireAdmin } from '../../middleware/auth';

const router = Router();

// ─── Connector catalog ──────────────────────────────────────────────
// Config schema is a list of system_config keys that need to be set for
// the connector to count as "configured". When all `required` keys have
// a non-empty value, status flips from 'disconnected' to 'configured'.
// Test + Scribe become enabled on 'configured'.
interface ConnectorDef {
  slug: string;
  name: string;
  icon: string;
  category: string;
  liveInPoc: boolean;
  configKeys: Array<{ key: string; label: string; required: boolean; sensitive?: boolean; help?: string }>;
}

const CATALOG: ConnectorDef[] = [
  {
    slug: 'google_drive_org',
    name: 'Google Drive',
    icon: '📁',
    category: 'knowledge',
    liveInPoc: true,
    // Connection step: which admin user's Google OAuth acts as the
    // tenant's Drive reader. Folder + index file are a SECOND step,
    // editable only after a connection is established.
    configKeys: [
      { key: 'google_drive_org_user_id', label: 'Connected via admin user', required: true, help: 'Internal — set by Connect flow' },
      { key: 'google_drive_folder_id', label: 'Folder ID', required: false, help: 'From the URL drive.google.com/drive/folders/<id>' },
      { key: 'google_index_file_name', label: 'Index file name', required: false, help: 'e.g. TMC_Drive_Index.md' },
    ],
  },
  {
    slug: 'onedrive_org',
    name: 'OneDrive',
    icon: '📘',
    category: 'knowledge',
    liveInPoc: false,
    configKeys: [
      { key: 'onedrive_tenant_id', label: 'Azure tenant ID', required: true },
      { key: 'onedrive_folder_path', label: 'Folder path', required: true, help: 'e.g. /Shared Documents/Org Knowledge' },
    ],
  },
  {
    slug: 'dropbox_org',
    name: 'Dropbox',
    icon: '🗂️',
    category: 'knowledge',
    liveInPoc: false,
    configKeys: [
      { key: 'dropbox_access_token', label: 'Access token', required: true, sensitive: true },
      { key: 'dropbox_folder_path', label: 'Folder path', required: true, help: 'e.g. /Org Knowledge' },
    ],
  },
];

// Ephemeral scribe status per (tenant, slug). Resets on server restart.
const scribeState = new Map<string, {
  status: 'idle' | 'running' | 'ok' | 'error';
  startedAt?: string;
  lastScribedAt?: string;
  lastSummary?: any;
  error?: string;
}>();
const skey = (cn: string, slug: string) => `${cn}::${slug}`;

/**
 * Map raw scribe-time errors to actionable, user-facing messages. The
 * Google SDK throws e.g. "request to https://oauth2.googleapis.com/token
 * failed, reason: invalid_grant" — surfacing that verbatim to admins
 * tells them nothing about what to do. Map known patterns to one-line
 * fixes; fall back to a generic "try again" for anything unrecognised.
 */
function sanitizeScribeError(err: any): string {
  const raw = String(err?.message ?? err ?? '');
  if (/oauth2\.googleapis\.com\/token|invalid_grant|invalid_token|Token has been expired|refresh.*token/i.test(raw)) {
    return 'Google access expired — click Re-connect on the Google Drive card to refresh authorisation.';
  }
  if (/insufficientPermissions|not authorized|403/i.test(raw)) {
    return 'Google account does not have read access to that folder. Re-connect with an account that can read the folder, or change the folder ID.';
  }
  if (/404|notFound|file not found/i.test(raw)) {
    return 'Folder ID not found in Google Drive. Open Change folder and paste the correct folder ID.';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network/i.test(raw)) {
    return 'Network error reaching Google. Try again in a minute.';
  }
  if (/quota|rate.?limit|429/i.test(raw)) {
    return 'Google API rate limit reached. Try again in a few minutes.';
  }
  // Unknown — generic message; never leak SDK internals.
  return 'Scribe failed. Try Re-connect, then Re-scribe.';
}

async function readConfig(clientNumber: string, key: string): Promise<string | null> {
  const r = await prisma.systemConfig.findUnique({
    where: { clientNumber_key: { clientNumber, key } },
    select: { value: true },
  }).catch(() => null);
  return r?.value ?? null;
}

async function writeConfig(clientNumber: string, key: string, value: string, isSensitive = false): Promise<void> {
  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber, key } },
    create: { clientNumber, key, value, isSensitive },
    update: { value },
  });
}

async function statusFor(clientNumber: string, def: ConnectorDef) {
  const values = await Promise.all(def.configKeys.map(async (k) => ({ ...k, value: await readConfig(clientNumber, k.key) })));

  // Connection state for Google Drive = a picked admin whose user-level
  // Google OAuth is currently active. Other slugs fall back to
  // "all required keys set".
  let connected = false;
  let connectionDetail: { userId?: number; userEmail?: string | null } = {};
  if (def.slug === 'google_drive_org') {
    const pickedId = Number(values.find((k) => k.key === 'google_drive_org_user_id')?.value ?? '') || null;
    if (pickedId) {
      const u = await prisma.user.findFirst({
        where: { id: pickedId, clientNumber, integrationProvider: 'google', integrationStatus: 'active' } as any,
        select: { id: true, email: true },
      }).catch(() => null);
      connected = !!u;
      connectionDetail = { userId: u?.id, userEmail: u?.email ?? null };
    }
  } else {
    connected = values.filter((k) => k.required).every((k) => !!(k.value && k.value.trim()));
  }

  const folderId = values.find((k) => k.key === 'google_drive_folder_id')?.value || null;
  const indexFile = values.find((k) => k.key === 'google_index_file_name')?.value || null;

  const docCount = def.slug === 'google_drive_org'
    ? await prisma.wikiPage.count({ where: { clientNumber, pageType: 'org_doc' } as any }).catch(() => 0)
    : 0;
  const st = scribeState.get(skey(clientNumber, def.slug)) ?? { status: 'idle' as const };

  // For Drive, scribe requires BOTH connected AND folder set.
  const scribeable = def.slug === 'google_drive_org'
    ? (connected && !!folderId)
    : connected;
  const needsScribe = scribeable && !st.lastScribedAt;

  // Redact sensitive values + the internal user-id value
  const safeKeys = values.map((k) => ({
    ...k,
    value: k.sensitive ? (k.value ? '••••••••' : null) : (k.key === 'google_drive_org_user_id' ? null : k.value),
  }));

  // Surface the last scribe's per-run breakdown so the UI can show
  // "Scribed 12 / 47 scanned · 35 skipped · 0 errors" instead of an
  // opaque "✓ 0 docs" badge that can't tell empty-folder apart from
  // mime-rejected apart from access-denied.
  const lastSummary = st.lastSummary ?? null;
  const lastScribe = lastSummary ? {
    scanned: Number(lastSummary.scanned ?? 0),
    updated: Number(lastSummary.updated ?? 0),
    unchanged: Number(lastSummary.unchanged ?? 0),
    skipped: Number(lastSummary.skipped ?? 0),
    errors: Number(lastSummary.errors ?? 0),
    durationMs: Number(lastSummary.durationMs ?? 0),
  } : null;

  return {
    slug: def.slug, name: def.name, icon: def.icon, category: def.category, liveInPoc: def.liveInPoc,
    connected,
    connectionDetail,
    folderId,
    indexFile,
    scribeable,
    configKeys: safeKeys,
    docCount,
    lastScribedAt: st.lastScribedAt ?? null,
    scribeStatus: st.status,
    scribeError: st.error ?? null,
    lastScribe,
    needsScribe,
  };
}

function pickTenant(req: Request): string {
  const q = (req.query?.cn as string) || (req.body?.clientNumber as string) || req.user?.clientNumber;
  return String(q || '');
}

/** GET /admin/client-connectors — list all tenant-level connectors + status */
router.get('/client-connectors', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = pickTenant(req);
    if (!clientNumber) return res.status(400).json({ error: 'clientNumber required' });
    const items = await Promise.all(CATALOG.map((d) => statusFor(clientNumber, d)));

    const live = items.filter((i) => i.liveInPoc);
    const configuredCount = live.filter((i) => i.scribeable).length;
    const scribedCount = live.filter((i) => i.lastScribedAt).length;
    const anyRunning = items.some((i) => i.scribeStatus === 'running');
    const needsRescribe = configuredCount > scribedCount;

    res.json({
      clientNumber,
      items,
      configuredCount,
      scribedCount,
      needsRescribe,
      anyRunning,
    });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeScribeError(err) });
  }
});

/** POST /admin/client-connectors/:slug/connect
 *  Single-click connect. Uses the CURRENT admin's Google OAuth as the
 *  tenant's reader. If the current admin hasn't connected Google
 *  personally yet, returns 409 with an OAuth URL the client can redirect
 *  to (same path My Connectors uses). After OAuth callback the user
 *  comes back and the second click completes instantly. */
router.post('/client-connectors/:slug/connect', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = pickTenant(req);
    const slug = String(req.params.slug);
    const def = CATALOG.find((d) => d.slug === slug);
    if (!def) return res.status(404).json({ error: 'unknown connector' });
    if (slug !== 'google_drive_org') return res.status(501).json({ error: `${slug} connect not implemented yet` });

    const me = req.user!;
    // Check if current admin has Google active at user level
    const admin = await prisma.user.findFirst({
      where: { id: me.id, clientNumber, integrationProvider: 'google', integrationStatus: 'active' } as any,
      select: { id: true, email: true, integrationEmail: true },
    });

    if (!admin) {
      // Not yet connected personally — hand back an OAuth URL. Frontend
      // redirects to it; after consent the user lands back here and can
      // click Connect again to finalize.
      return res.status(409).json({
        needsOauth: true,
        message: 'You need to connect Google first. Redirecting to authorize…',
        oauthRedirectTo: '/connectors?highlight=gmail',
      });
    }

    await writeConfig(clientNumber, 'google_drive_org_user_id', String(admin.id));
    scribeState.delete(skey(clientNumber, slug));
    const updated = await statusFor(clientNumber, def);
    res.json({ ok: true, item: updated, connectedAs: admin.integrationEmail ?? admin.email });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeScribeError(err) });
  }
});

/** POST /admin/client-connectors/:slug/set-folder
 *  Step 2: configure folder ID + index file. Only valid after /connect. */
router.post('/client-connectors/:slug/set-folder', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = pickTenant(req);
    const slug = String(req.params.slug);
    const def = CATALOG.find((d) => d.slug === slug);
    if (!def) return res.status(404).json({ error: 'unknown connector' });
    if (slug !== 'google_drive_org') return res.status(501).json({ error: `${slug} folder-config not implemented yet` });

    const current = await statusFor(clientNumber, def);
    if (!current.connected) return res.status(400).json({ error: 'Connect the tenant account first, then set the folder.' });

    const folderId = String(req.body?.folderId ?? '').trim();
    const indexFile = String(req.body?.indexFileName ?? '').trim();
    if (!folderId) return res.status(400).json({ error: 'Folder ID is required' });

    await writeConfig(clientNumber, 'google_drive_folder_id', folderId);
    if (indexFile) await writeConfig(clientNumber, 'google_index_file_name', indexFile);
    scribeState.delete(skey(clientNumber, slug));
    const updated = await statusFor(clientNumber, def);
    res.json({ ok: true, item: updated });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeScribeError(err) });
  }
});

/** POST /admin/client-connectors/:slug/disconnect — clear the connector's
 *  picked admin + folder config. Any user in the tenant who still has a
 *  personal Google connector keeps theirs untouched. */
router.post('/client-connectors/:slug/disconnect', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = pickTenant(req);
    const slug = String(req.params.slug);
    const def = CATALOG.find((d) => d.slug === slug);
    if (!def) return res.status(404).json({ error: 'unknown connector' });
    for (const k of def.configKeys) {
      await prisma.systemConfig.deleteMany({ where: { clientNumber, key: k.key } }).catch(() => null);
    }
    scribeState.delete(skey(clientNumber, slug));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeScribeError(err) });
  }
});

/** POST /admin/client-connectors/:slug/test — verify the tenant's
 *  connection works. When a folder is set we also verify the folder is
 *  readable; otherwise we just verify the OAuth can list any file. */
router.post('/client-connectors/:slug/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = pickTenant(req);
    const slug = String(req.params.slug);

    if (slug === 'google_drive_org') {
      const userIdStr = await readConfig(clientNumber, 'google_drive_org_user_id');
      if (!userIdStr) return res.status(400).json({ error: 'Not connected — pick a tenant admin account first.' });
      const userId = Number(userIdStr);
      const admin = await prisma.user.findFirst({
        where: { id: userId, clientNumber, integrationProvider: 'google', integrationStatus: 'active' } as any,
        select: { id: true, email: true, integrationEmail: true },
      });
      if (!admin) return res.status(400).json({ error: 'The connected admin user no longer has an active Google session. Re-connect.' });

      const { google } = await import('googleapis');
      const { getAuthenticatedClient } = await import('../../services/integrationService');
      const auth = await getAuthenticatedClient(admin.id);
      if (!auth?.client) return res.status(500).json({ error: 'Failed to authenticate admin Google account' });
      const drive = google.drive({ version: 'v3', auth: auth.client });

      const folderId = await readConfig(clientNumber, 'google_drive_folder_id');

      if (folderId) {
        const meta = await drive.files.get({ fileId: folderId, fields: 'id,name,mimeType' }).catch((e: any) => ({ data: null, err: e }));
        const folder = (meta as any).data;
        if (!folder || folder.mimeType !== 'application/vnd.google-apps.folder') {
          // Sanitise the inner error so OAuth failures stop leaking
          // verbatim through Test → toast.
          const inner = (meta as any).err;
          const msg = inner
            ? sanitizeScribeError(inner)
            : `Folder ID is not a valid folder (mimeType: ${folder?.mimeType ?? '?'})`;
          return res.status(400).json({ error: msg });
        }
        const list = await drive.files.list({
          q: `'${folderId}' in parents and trashed=false`,
          fields: 'files(id,name,mimeType)',
          pageSize: 20,
        }).catch(() => ({ data: { files: [] } }));
        return res.json({
          ok: true, stage: 'folder_verified',
          folder: { id: folder.id, name: folder.name },
          sample: (list as any).data.files || [],
          adminEmail: admin.integrationEmail ?? admin.email,
        });
      }

      // No folder set — just verify OAuth works at all
      const about = await drive.about.get({ fields: 'user(emailAddress)' }).catch((e: any) => ({ data: null, err: e }));
      if (!(about as any).data) {
        const inner = (about as any).err;
        return res.status(400).json({ error: inner ? sanitizeScribeError(inner) : 'Google Drive API call failed' });
      }
      return res.json({
        ok: true, stage: 'connection_verified',
        adminEmail: admin.integrationEmail ?? admin.email,
        driveUser: (about as any).data.user?.emailAddress ?? null,
      });
    }

    return res.status(501).json({ error: `${slug} test not implemented yet` });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeScribeError(err) });
  }
});

/** POST /admin/client-connectors/scribe-all — queue scribe for every live,
 *  configured tenant connector. Runs in background; poll list endpoint. */
router.post('/client-connectors/scribe-all', requireAdmin, async (req: Request, res: Response) => {
  try {
    const clientNumber = pickTenant(req);
    const queued: string[] = [];

    for (const def of CATALOG.filter((d) => d.liveInPoc)) {
      const st = await statusFor(clientNumber, def);
      if (!st.scribeable) continue;
      scribeState.set(skey(clientNumber, def.slug), { status: 'running', startedAt: new Date().toISOString() });
      queued.push(def.slug);
      void (async () => {
        try {
          if (def.slug === 'google_drive_org') {
            const folderId = await readConfig(clientNumber, 'google_drive_folder_id');
            const { scribeFaclForTenant } = await import('../../services/knowledge/folderScribeService');
            const summary = await scribeFaclForTenant(clientNumber, folderId ?? '');
            // scanned=0 now genuinely means "folder is empty" because
            // auth failures throw and hit the catch below. Always 'ok'
            // here; the pill renderer interprets the summary nicely.
            scribeState.set(skey(clientNumber, def.slug), {
              status: 'ok',
              lastScribedAt: new Date().toISOString(),
              lastSummary: summary,
            });
          }
        } catch (err: any) {
          // Map raw OAuth/Google SDK noise to an actionable message
          // before storing — UI surfaces this verbatim.
          scribeState.set(skey(clientNumber, def.slug), { status: 'error', error: sanitizeScribeError(err) });
        }
      })();
    }

    res.json({ ok: true, queued });
  } catch (err: any) {
    res.status(500).json({ error: sanitizeScribeError(err) });
  }
});

export default router;
