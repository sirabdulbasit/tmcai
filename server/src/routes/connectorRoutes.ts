/**
 * MyOS Connector Routes — User-facing
 *
 * Users manage their personal connector connections.
 * Users can only see connectors that admin has enabled for their tenant.
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth';
import * as connectorService from '../services/connectorService';
import prisma from '../db/prisma';
import {
  authorizeUrl as notionAuthorizeUrl,
  exchangeCode as notionExchangeCode,
  provisionWikiDatabases,
  saveConnectorRow as saveNotionConnector,
  findNotionConnector,
} from '../services/connectors/notionConnectorService';

const router = Router();

// In-memory OAuth state store (per-instance). For multi-instance deploys,
// back with Redis.
const oauthStates = new Map<string, { clientNumber: string; userId: number; createdAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (now - v.createdAt > 10 * 60 * 1000) oauthStates.delete(k);
}, 60 * 1000);

// ─── List available personal connectors for this user ─────────
router.get('/available', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const available = await connectorService.listAvailableForUser(user.id, user.clientNumber);
    // Stamp each connector with its honest readiness flag so the UI
    // can show a "production / beta / experimental" badge instead of
    // a uniform "Connect" button that misleads users into pairing
    // with adapters that don't yet read or write data.
    const { getReadiness } = await import('../services/connectorRegistry');
    const stamped = available.map((c: any) => ({ ...c, readiness: getReadiness(c.slug) }));
    // Connection state can change between requests (OAuth callback in a
    // different tab, admin enable/disable). Force re-validation every
    // time so two browser tabs don't show divergent connection statuses.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.json({ connectors: stamped });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── List user's active connections ───────────────────────────
router.get('/my', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const connectors = await connectorService.listUserConnectors(user.id, user.clientNumber);
    res.json({ connectors });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Connect a personal connector (test + save) ──────────────
router.post('/connect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId, config } = req.body;

    if (!connectorTypeId) {
      res.status(400).json({ error: 'connectorTypeId is required' });
      return;
    }

    const result = await connectorService.testAndConnect(
      user.id,
      user.clientNumber,
      connectorTypeId,
      config || {},
    );

    if (!result.success) {
      res.status(400).json({ error: result.error, success: false });
      return;
    }

    res.json({ success: true, email: result.email });
  } catch (error: any) {
    res.status(400).json({ error: error.message, success: false });
  }
});

// ─── Get OAuth URL for a connector ────────────────────────────
router.post('/oauth/url', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId, config } = req.body;

    if (!connectorTypeId) {
      res.status(400).json({ error: 'connectorTypeId is required' });
      return;
    }

    const result = await connectorService.getOAuthUrl(user.id, connectorTypeId, config);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }

    res.json({ url: result.url });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── OAuth callback ───────────────────────────────────────────
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;

  if (!code || !state) {
    res.status(400).send('Missing code or state');
    return;
  }

  const result = await connectorService.handleOAuthCallback(code, state);
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5174';

  if (result.success) {
    res.redirect(`${clientUrl}/connectors?connected=${result.slug}&success=true`);
  } else {
    res.redirect(`${clientUrl}/connectors?error=${encodeURIComponent(result.error || 'Connection failed')}`);
  }
});

// ─── Test a connected connector (verify it can actually fetch data) ──
router.post('/test', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId } = req.body;
    if (!connectorTypeId) { res.status(400).json({ error: 'connectorTypeId required' }); return; }

    const result = await connectorService.testConnectedConnector(user.id, connectorTypeId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Disconnect a personal connector ──────────────────────────
router.post('/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { connectorTypeId } = req.body;

    if (!connectorTypeId) {
      res.status(400).json({ error: 'connectorTypeId is required' });
      return;
    }

    await connectorService.disconnectUserConnector(user.id, connectorTypeId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get the redirect URI for OAuth (public — not sensitive) ──
router.get('/oauth/redirect-uri', (_req: Request, res: Response) => {
  res.json({ redirectUri: process.env.GOOGLE_CONNECTOR_REDIRECT_URI || 'http://localhost:4002/api/v1/connectors/oauth/callback' });
});

// ─── Historical Pull — per-user, covers every connected source ─
// Fires warmUpBrainFromSources (Gmail 30d + Calendar) + attachment
// backfill (Gmail) + any future source-specific historical pulls.
// Response lists which connectors were triggered vs skipped so the UI
// can toast a summary.
router.post('/historical-pull', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const days = Number(req.body?.days);
    const cap = Number(req.body?.cap);
    const { runHistoricalPullForUser } = await import('../services/knowledge/historicalPullService');
    const summary = await runHistoricalPullForUser(user.clientNumber, user.id, {
      days: Number.isFinite(days) ? days : undefined,
      cap: Number.isFinite(cap) ? cap : undefined,
    });
    res.json(summary);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Attachment backfill status ─────────────────────────────
// Surfaced in Connectors page so the user sees "Setting up your email — ~N
// minutes remaining" right after they connect Gmail. Polling-based (UI
// polls this endpoint while state !== 'complete').
router.get('/backfill/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { getBackfillStatusForUser } = await import('../jobs/attachmentBackfillWorker');
    const status = await getBackfillStatusForUser(user.clientNumber, user.id);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WhatsApp (Personal) — QR pairing via whatsapp-web.js ─────
// POST /connectors/whatsapp_personal/pair   → kicks off pairing, returns status
// GET  /connectors/whatsapp_personal/status → current status (status, qrDataUrl, connectedNumber)
// POST /connectors/whatsapp_personal/disconnect
// Intentionally path-specific (not under /oauth/*) since pairing is QR-scan,
// not OAuth. Status is polled by the Connectors UI while QR is on screen.

router.post('/whatsapp_personal/pair', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { startPairing } = await import('../services/whatsapp/UserWebjsProvider');
    const result = await startPairing(user.id, user.clientNumber);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/whatsapp_personal/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { getStatus } = await import('../services/whatsapp/UserWebjsProvider');
    const result = await getStatus(user.id);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp_personal/disconnect', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { disconnect } = await import('../services/whatsapp/UserWebjsProvider');
    await disconnect(user.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Excluded contacts (wife, family, close friends) ──────────
// Messages from these numbers are DROPPED at ingest — they never
// enter feed_events, never appear in Day Brief, Brain never reads them.
// Stored in users.notificationPreferences.whatsapp.excludedNumbers (E.164).

router.get('/whatsapp_personal/excluded', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { getExcludedNumbers } = await import('../services/whatsapp/UserWebjsProvider');
    const numbers = await getExcludedNumbers(user.id);
    res.json({ numbers });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/whatsapp_personal/excluded', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const numbers = Array.isArray(req.body?.numbers) ? req.body.numbers.map(String) : [];
    const { setExcludedNumbers } = await import('../services/whatsapp/UserWebjsProvider');
    const saved = await setExcludedNumbers(user.id, numbers);
    res.json({ numbers: saved });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Scribe (per-connector historical pull + wiki backfill) ───
// POST /connectors/scribe/:connectorTypeId
// Body: { gmailDays?, gmailCap?, calendarDaysBack?, calendarDaysAhead? }
// Pulls historical data for this one connector into feed_events, then
// rebuilds the Wiki memory for the user. After it finishes we stamp
// user_connector.metadata.lastScribedAt so the UI can show "never
// scribed" vs "scribed 2h ago" and flag re-scribe when a new connector
// joins the lineup.
// Runs pull + wiki backfill in the background. The HTTP response returns
// immediately with { queued: true } so the browser doesn't hang on a
// long Gmail pull. UI polls /scribe-state to watch progress.
async function runScribeInBackground(userId: number, clientNumber: string, ucId: string, slug: string, opts: any) {
  try {
    const { pullHistoricalFeed } = await import('../services/knowledge/historicalFeedPull');
    const pull = await pullHistoricalFeed(clientNumber, userId, slug, opts);

    const { backfillSenderWiki } = await import('../services/knowledge/senderWikiBackfill');
    const wiki = await backfillSenderWiki(clientNumber, userId, { wipeFirst: true });

    const current = await prisma.userConnector.findUnique({ where: { id: ucId }, select: { metadata: true } });
    await prisma.userConnector.update({
      where: { id: ucId },
      data: {
        lastSyncAt: new Date(),
        metadata: {
          ...((current?.metadata as any) || {}),
          scribeStatus: 'ok',
          lastScribedAt: new Date().toISOString(),
          lastScribeSummary: { pull, wiki },
          scribeError: null,
          scribeStartedAt: null,
        } as any,
      },
    });
  } catch (err: any) {
    const current = await prisma.userConnector.findUnique({ where: { id: ucId }, select: { metadata: true } });
    await prisma.userConnector.update({
      where: { id: ucId },
      data: {
        metadata: { ...((current?.metadata as any) || {}), scribeStatus: 'error', scribeError: err.message, scribeStartedAt: null } as any,
      },
    }).catch(() => {});
  }
}

router.post('/scribe/:connectorTypeId', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const connectorTypeId = String(req.params.connectorTypeId);
    const uc = await prisma.userConnector.findUnique({
      where: { userId_connectorTypeId: { userId: user.id, connectorTypeId } },
      include: { connectorType: { select: { slug: true } } },
    });
    if (!uc) return res.status(404).json({ error: 'connector not found' });
    if (uc.status !== 'connected') return res.status(400).json({ error: 'connector is not connected' });

    const slug = uc.connectorType.slug;
    const body = req.body ?? {};

    await prisma.userConnector.update({
      where: { id: uc.id },
      data: {
        metadata: { ...((uc.metadata as any) || {}), scribeStatus: 'running', scribeStartedAt: new Date().toISOString() } as any,
      },
    });

    // Fire-and-forget — return to UI immediately so the button doesn't
    // stall on a 30+ second Gmail walk. Poll-based UI picks up the
    // completion.
    void runScribeInBackground(user.id, user.clientNumber, uc.id, slug, {
      gmailDays: Number.isFinite(body.gmailDays) ? Number(body.gmailDays) : undefined,
      gmailCap: Number.isFinite(body.gmailCap) ? Number(body.gmailCap) : undefined,
      calendarDaysBack: Number.isFinite(body.calendarDaysBack) ? Number(body.calendarDaysBack) : undefined,
      calendarDaysAhead: Number.isFinite(body.calendarDaysAhead) ? Number(body.calendarDaysAhead) : undefined,
    });

    res.json({ ok: true, queued: true, slug });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /connectors/facl/set-folder
// Body: { folderId: '1abc…' }
// Stores the FACL folder ID on the user's google_drive_personal connector
// metadata and fires an initial scribe in the background.
router.post('/facl/set-folder', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const folderId = String(req.body?.folderId ?? '').trim();
    if (!folderId) return res.status(400).json({ error: 'folderId is required' });

    const uc = await prisma.userConnector.findFirst({
      where: { userId: user.id, clientNumber: user.clientNumber, connectorType: { slug: 'google_drive_personal' } } as any,
      include: { connectorType: true },
    });
    if (!uc) return res.status(400).json({ error: 'Connect Google Drive first' });
    if (uc.status !== 'connected') return res.status(400).json({ error: 'Google Drive is not connected' });

    const meta: any = (uc.metadata as any) ?? {};
    meta.faclFolderId = folderId;
    meta.faclScribeStatus = 'running';
    meta.faclScribeStartedAt = new Date().toISOString();
    await prisma.userConnector.update({ where: { id: uc.id }, data: { metadata: meta as any } });

    // Fire-and-forget: initial scribe
    void (async () => {
      try {
        const { scribeFaclFolder } = await import('../services/knowledge/folderScribeService');
        const result = await scribeFaclFolder(user.clientNumber, user.id, folderId);
        const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
        await prisma.userConnector.update({
          where: { id: uc.id },
          data: {
            metadata: {
              ...((current?.metadata as any) || {}),
              faclScribeStatus: 'ok',
              faclLastScribedAt: new Date().toISOString(),
              faclLastScribeSummary: result,
              faclScribeError: null,
            } as any,
          },
        });
      } catch (err: any) {
        const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
        await prisma.userConnector.update({
          where: { id: uc.id },
          data: { metadata: { ...((current?.metadata as any) || {}), faclScribeStatus: 'error', faclScribeError: err.message } as any },
        }).catch(() => {});
      }
    })();

    res.json({ ok: true, folderId, queued: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /connectors/facl/status — current FACL folder + last scribe state
router.get('/facl/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const uc = await prisma.userConnector.findFirst({
      where: { userId: user.id, clientNumber: user.clientNumber, connectorType: { slug: 'google_drive_personal' } } as any,
    });
    if (!uc) return res.json({ connected: false });
    const m: any = uc.metadata ?? {};
    const count = await prisma.wikiPage.count({
      where: { clientNumber: user.clientNumber, userId: user.id, pageType: 'org_doc' } as any,
    }).catch(() => 0);
    res.json({
      connected: uc.status === 'connected',
      folderId: m.faclFolderId ?? null,
      status: m.faclScribeStatus ?? 'never',
      lastScribedAt: m.faclLastScribedAt ?? null,
      lastSummary: m.faclLastScribeSummary ?? null,
      error: m.faclScribeError ?? null,
      docCount: count,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /connectors/facl/rescribe — manual trigger for a re-scan.
router.post('/facl/rescribe', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const uc = await prisma.userConnector.findFirst({
      where: { userId: user.id, clientNumber: user.clientNumber, connectorType: { slug: 'google_drive_personal' } } as any,
    });
    if (!uc) return res.status(400).json({ error: 'Drive connector missing' });
    const m: any = uc.metadata ?? {};
    if (!m.faclFolderId) return res.status(400).json({ error: 'No FACL folder set — call /facl/set-folder first' });
    await prisma.userConnector.update({
      where: { id: uc.id },
      data: { metadata: { ...m, faclScribeStatus: 'running', faclScribeStartedAt: new Date().toISOString() } as any },
    });
    void (async () => {
      try {
        const { scribeFaclFolder } = await import('../services/knowledge/folderScribeService');
        const result = await scribeFaclFolder(user.clientNumber, user.id, m.faclFolderId);
        const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
        await prisma.userConnector.update({
          where: { id: uc.id },
          data: {
            metadata: {
              ...((current?.metadata as any) || {}),
              faclScribeStatus: 'ok',
              faclLastScribedAt: new Date().toISOString(),
              faclLastScribeSummary: result,
              faclScribeError: null,
            } as any,
          },
        });
      } catch (err: any) {
        const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
        await prisma.userConnector.update({
          where: { id: uc.id },
          data: { metadata: { ...((current?.metadata as any) || {}), faclScribeStatus: 'error', faclScribeError: err.message } as any },
        }).catch(() => {});
      }
    })();
    res.json({ ok: true, queued: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /connectors/scribe-all — one-click scribe for every connected,
// supported source. Runs in background; returns immediately with the
// list of connectors that were queued.
router.post('/scribe-all', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const body = req.body ?? {};
    const supportedSlugs = ['gmail', 'google_calendar'];
    const rows = await prisma.userConnector.findMany({
      where: { userId: user.id, clientNumber: user.clientNumber, status: 'connected' } as any,
      include: { connectorType: { select: { slug: true } } },
    });
    const queued: Array<{ slug: string; connectorTypeId: string }> = [];
    for (const uc of rows) {
      if (!supportedSlugs.includes(uc.connectorType.slug)) continue;
      await prisma.userConnector.update({
        where: { id: uc.id },
        data: {
          metadata: { ...((uc.metadata as any) || {}), scribeStatus: 'running', scribeStartedAt: new Date().toISOString() } as any,
        },
      });
      void runScribeInBackground(user.id, user.clientNumber, uc.id, uc.connectorType.slug, {
        gmailDays: Number.isFinite(body.gmailDays) ? Number(body.gmailDays) : undefined,
        gmailCap: Number.isFinite(body.gmailCap) ? Number(body.gmailCap) : undefined,
        calendarDaysBack: Number.isFinite(body.calendarDaysBack) ? Number(body.calendarDaysBack) : undefined,
        calendarDaysAhead: Number.isFinite(body.calendarDaysAhead) ? Number(body.calendarDaysAhead) : undefined,
      });
      queued.push({ slug: uc.connectorType.slug, connectorTypeId: uc.connectorTypeId });
    }
    res.json({ ok: true, queued });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /connectors/scribe-state — which connectors are scribed, when,
// and whether a re-scribe is recommended (new connector added after
// the last tenant-wide scribe).
router.get('/scribe-state', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const rows = await prisma.userConnector.findMany({
      where: { userId: user.id, clientNumber: user.clientNumber } as any,
      include: { connectorType: { select: { slug: true, name: true } } },
    });
    const items = rows.map((r) => {
      const m: any = r.metadata ?? {};
      return {
        connectorTypeId: r.connectorTypeId,
        slug: r.connectorType.slug,
        name: r.connectorType.name,
        status: r.status,
        lastScribedAt: m.lastScribedAt ?? null,
        scribeStatus: m.scribeStatus ?? 'never',
        scribeError: m.scribeError ?? null,
        supportsScribe: ['gmail', 'google_calendar'].includes(r.connectorType.slug),
        isRunning: m.scribeStatus === 'running',
      };
    });
    // Banner math: only compare SUPPORTED connectors. You can't scribe
    // WhatsApp Personal / Tasks / Drive / Notion — those can never count
    // toward scribedCount, so including them in connectedCount makes the
    // banner persistent. Also ignore currently-running scribes from the
    // "needs scribe" set so the banner doesn't nag mid-run.
    const supportedConnected = items.filter((i) => i.status === 'connected' && i.supportsScribe);
    const unscribed = supportedConnected.filter((i) => !i.lastScribedAt && !i.isRunning);
    const rescribeRecommended = unscribed.length > 0;
    res.json({
      items,
      rescribeRecommended,
      unscribedNames: unscribed.map((i) => i.name),
      runningCount: items.filter((i) => i.isRunning).length,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get connector types registry ─────────────────────────────
router.get('/types', requireAuth, async (req: Request, res: Response) => {
  try {
    const scope = req.query.scope as 'personal' | 'organizational' | undefined;
    const types = await connectorService.listConnectorTypes(scope);
    res.json({ types });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Notion OAuth + provisioning ──────────────────────────────

router.get('/notion/authorize', requireAuth, (req: Request, res: Response) => {
  const user = req.user!;
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, { clientNumber: user.clientNumber, userId: user.id, createdAt: Date.now() });
  try {
    const url = notionAuthorizeUrl(state);
    res.json({ authorizeUrl: url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/notion/callback', async (req: Request, res: Response) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Notion OAuth error: ${error}`);
  if (!code || !state) return res.status(400).send('missing code or state');
  const rec = oauthStates.get(String(state));
  if (!rec) return res.status(400).send('invalid or expired state');
  oauthStates.delete(String(state));
  try {
    const token = await notionExchangeCode(String(code));
    const rootPageId = process.env.NOTION_DEFAULT_ROOT_PAGE_ID ?? null;
    const databases = rootPageId
      ? await provisionWikiDatabases(token.access_token, rootPageId)
      : {};
    await saveNotionConnector(rec.clientNumber, rec.userId, token, databases, rootPageId);
    const clientUrl = process.env.CLIENT_URL || 'https://tai.tmcltd.com';
    res.redirect(`${clientUrl}/steering?tab=settings&connector=notion&status=connected`);
  } catch (err: any) {
    res.status(500).send(`Notion OAuth callback failed: ${err.message}`);
  }
});

router.get('/notion/status', requireAuth, async (req: Request, res: Response) => {
  const user = req.user!;
  const row = await findNotionConnector(user.clientNumber, user.id);
  if (!row || row.connectorType?.slug !== 'notion') return res.json({ connected: false });
  const cfg = (row.config as any) ?? {};
  res.json({
    connected: row.status === 'connected',
    status: row.status,
    workspace: cfg.workspaceName,
    rootPageId: cfg.rootPageId,
    databases: cfg.databases ?? {},
    connectedAt: (row.metadata as any)?.connectedAt,
  });
});

router.post('/notion/disconnect', requireAuth, async (req: Request, res: Response) => {
  const user = req.user!;
  const row = await findNotionConnector(user.clientNumber, user.id);
  if (!row || row.connectorType?.slug !== 'notion') return res.status(404).json({ error: 'not connected' });
  await prisma.userConnector.update({
    where: { id: row.id },
    data: { status: 'disconnected', config: {} as any, errorMessage: null },
  });
  res.json({ ok: true });
});

export default router;
