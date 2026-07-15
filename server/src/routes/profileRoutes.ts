import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { getUserProfile, updateUserProfile } from '../services/userProfileService';

const router = Router();
router.use(requireAuth);

// Get my profile. gender + preferredTitle are stored inside
// notification_preferences.profile (no dedicated columns, avoids a
// schema migration). JD is read-only here — only HR can edit it.
router.get('/', async (req: Request, res: Response) => {
  const profile = await getUserProfile(req.user!.id);
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true },
  });
  const p = ((u?.notificationPreferences as any) || {}).profile || {};
  res.json({
    profile: {
      ...(profile || {}),
      gender: p.gender ?? null,
      preferredTitle: p.preferredTitle ?? null,
    },
  });
});

// Update my profile (JD is NOT editable here — synced from HR)
router.put('/', async (req: Request, res: Response) => {
  const { city, contactNumber, aboutMe, instructions, tonePreference: rawTone, gender, preferredTitle } = req.body;
  const tonePreference = rawTone || null; // empty string → null

  // Validate tone
  const validTones = ['friendly', 'formal', 'executive', 'casual', 'technical', null];
  if (tonePreference !== null && !validTones.includes(tonePreference)) {
    res.status(400).json({ error: `Invalid tone. Choose from: ${validTones.filter(Boolean).join(', ')}` });
    return;
  }

  // Gender + preferredTitle → notificationPreferences.profile JSON
  if (gender !== undefined || preferredTitle !== undefined) {
    const prisma = (await import('../db/prisma')).default;
    const u = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { notificationPreferences: true },
    });
    const prefs = ((u?.notificationPreferences as any) || {}) as Record<string, any>;
    prefs.profile = {
      ...(prefs.profile ?? {}),
      ...(gender !== undefined ? { gender: gender || null } : {}),
      ...(preferredTitle !== undefined ? { preferredTitle: preferredTitle || null } : {}),
    };
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { notificationPreferences: prefs as any },
    });
  }
  const profile = await updateUserProfile(req.user!.id, { city, contactNumber, aboutMe, instructions, tonePreference });

  // Sync whatsapp_connections from the user's contact number so the
  // tenant WhatsApp inbound handler recognises them. Without this row
  // the inbound handler silently drops their messages — see
  // WhatsAppInbound.handleInboundMessage's "Unregistered number" path.
  // Idempotent: per user we keep a single 'active' row; updating the
  // number simply rewrites it.
  if (contactNumber !== undefined) {
    void (async () => {
      try {
        const { syncWhatsAppConnectionFromProfile } = await import('../services/whatsapp/connectionSync');
        await syncWhatsAppConnectionFromProfile(req.user!.id, contactNumber);
      } catch { /* non-fatal — profile save already succeeded */ }
    })();
  }

  res.json({ success: true, profile });
});

// ─── UI preferences (font scale) ────────────────────────────
// Two layers of precedence, merged at read time:
//
//   1. Tenant default  — stored in system_config (key=app_default_font_scale)
//                        editable by SuperAdmin; applies to every user in
//                        the tenant who hasn't set their own override.
//   2. User override   — stored in notificationPreferences.ui.fontScale
//                        individual user's explicit choice, always wins.
//
// Effective = userOverride ?? tenantDefault ?? 1.0
// Both clamped to [0.85, 1.4]. PUT /ui-prefs with {fontScale: null} clears
// the user override so the tenant default is used again.
const FONT_SCALE_MIN = 0.85;
const FONT_SCALE_MAX = 1.4;
const FONT_SCALE_DEFAULT = 1.0;
const APP_DEFAULT_KEY = 'app_default_font_scale';

function clampScale(v: number): number {
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, v));
}

async function readTenantDefaultFontScale(clientNumber: string): Promise<number> {
  const prisma = (await import('../db/prisma')).default;
  const row = await prisma.systemConfig.findUnique({
    where: { clientNumber_key: { clientNumber, key: APP_DEFAULT_KEY } },
    select: { value: true },
  }).catch(() => null);
  const parsed = row?.value != null ? Number(row.value) : NaN;
  return Number.isFinite(parsed) ? clampScale(parsed) : FONT_SCALE_DEFAULT;
}

router.get('/ui-prefs', async (req: Request, res: Response) => {
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true },
  });
  const ui = ((u?.notificationPreferences as any) || {}).ui || {};
  const appDefault = await readTenantDefaultFontScale(req.user!.clientNumber);
  const userOverride = typeof ui.fontScale === 'number' ? clampScale(ui.fontScale) : null;
  const effective = userOverride ?? appDefault;
  res.json({
    fontScale: effective,
    userOverride,
    appDefault,
    min: FONT_SCALE_MIN,
    max: FONT_SCALE_MAX,
  });
});

router.put('/ui-prefs', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  // Allow explicit null to CLEAR the user override and revert to tenant default.
  const clearOverride = body.fontScale === null || body.fontScale === undefined && body.resetToDefault === true;
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true },
  });
  const prefs = ((u?.notificationPreferences as any) || {}) as Record<string, any>;
  prefs.ui = { ...(prefs.ui ?? {}) };

  if (clearOverride) {
    delete prefs.ui.fontScale;
  } else {
    const rawScale = Number(body.fontScale);
    if (!Number.isFinite(rawScale)) {
      res.status(400).json({ error: 'fontScale must be a number or null to reset' });
      return;
    }
    prefs.ui.fontScale = clampScale(rawScale);
  }

  await prisma.user.update({
    where: { id: req.user!.id },
    data: { notificationPreferences: prefs as any },
  });
  const appDefault = await readTenantDefaultFontScale(req.user!.clientNumber);
  const userOverride = typeof prefs.ui.fontScale === 'number' ? prefs.ui.fontScale : null;
  res.json({
    success: true,
    fontScale: userOverride ?? appDefault,
    userOverride,
    appDefault,
  });
});

// ─── App-wide display defaults (SuperAdmin only) ───────────────
// Sets the font scale every user in this tenant sees by default. A user's
// personal override (set via /profile/ui-prefs) still wins over this.
router.get('/app-defaults/font-scale', async (req: Request, res: Response) => {
  const fontScale = await readTenantDefaultFontScale(req.user!.clientNumber);
  res.json({ fontScale, min: FONT_SCALE_MIN, max: FONT_SCALE_MAX });
});

router.put('/app-defaults/font-scale', async (req: Request, res: Response) => {
  if (!req.user?.isSuperAdmin) {
    res.status(403).json({ error: 'SuperAdmin only' });
    return;
  }
  const raw = Number(req.body?.fontScale);
  if (!Number.isFinite(raw)) {
    res.status(400).json({ error: 'fontScale must be a number' });
    return;
  }
  const fontScale = clampScale(raw);
  const prisma = (await import('../db/prisma')).default;
  await prisma.systemConfig.upsert({
    where: { clientNumber_key: { clientNumber: req.user!.clientNumber, key: APP_DEFAULT_KEY } },
    update: { value: String(fontScale) },
    create: { clientNumber: req.user!.clientNumber, key: APP_DEFAULT_KEY, value: String(fontScale) },
  });
  res.json({ success: true, fontScale });
});

// ─── Brain notification channel (WhatsApp only — see [[project_brain_whatsapp_channel]]) ───
// Persists under users.notification_preferences JSON, keyed by 'brain_channel'.
//
// 2026-05-18 cleanup:
//   - `channel` field retired from the UI (always 'whatsapp'); kept in
//     storage for backward compat with older PUT bodies.
//   - `minConfidence` replaced by `boldness` ('cautious' | 'balanced' |
//     'eager') in the UI. The numeric threshold is derived for back-
//     end consumers that still read minConfidence directly. Default
//     for new users: cautious (0.85) — quiet on day 1.
//   - `dailyCap` retired from the UI; the 20/day ceiling lives in code
//     as a hard safety bound.

type Boldness = 'cautious' | 'balanced' | 'eager';
const BOLDNESS_TO_THRESHOLD: Record<Boldness, number> = {
  cautious: 0.85, balanced: 0.7, eager: 0.55,
};
function thresholdToBoldness(t: number): Boldness {
  if (t >= 0.8) return 'cautious';
  if (t >= 0.65) return 'balanced';
  return 'eager';
}

router.get('/brain-channel', async (req: Request, res: Response) => {
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true, contactNumber: true },
  });
  const prefs = (u?.notificationPreferences as any) || {};
  const bc = prefs.brain_channel || {};
  const storedThreshold = typeof bc.minConfidence === 'number' ? bc.minConfidence : 0.85;
  res.json({
    // Channel is always WhatsApp; included for backward compat.
    channel: 'whatsapp',
    // WhatsApp number defaults to the user's contact number — front-end
    // shows "Pinging on X (your contact number)" and only persists a
    // value here if the user explicitly overrides.
    whatsappNumber: bc.whatsappNumber ?? '',
    registeredContactNumber: u?.contactNumber ?? '',
    quietStart: bc.quietStart ?? '22:00',
    quietEnd: bc.quietEnd ?? '06:00',
    boldness: typeof bc.boldness === 'string' ? bc.boldness : thresholdToBoldness(storedThreshold),
    // Legacy numeric — kept in the response so older clients don't break.
    minConfidence: storedThreshold,
    // Opt-in: defaults to false. User must explicitly enable Brain
    // outbound on WhatsApp from Settings before any push fires.
    outboundEnabled: bc.outboundEnabled === true,
    outboundPaused: !!bc.outboundPaused,
    // dailyCap is a hard safety ceiling enforced in code. Not user-
    // settable from the UI anymore; included for backward compat.
    dailyCap: typeof bc.dailyCap === 'number' && bc.dailyCap >= 1 ? bc.dailyCap : 20,
    // Day Brief delivery (added 2026-05-16). HH:MM in the user's timezone.
    dayBriefTime: bc.dayBriefTime ?? '08:30',
    timezone: bc.timezone ?? 'Asia/Karachi',
  });
});

router.put('/brain-channel', async (req: Request, res: Response) => {
  const { whatsappNumber, quietStart, quietEnd, boldness, outboundEnabled, outboundPaused, dayBriefTime, timezone } = req.body ?? {};
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
  const prefs = ((u?.notificationPreferences as any) || {}) as Record<string, any>;
  const existing = prefs.brain_channel || {};
  const validTime = typeof dayBriefTime === 'string' && /^\d{2}:\d{2}$/.test(dayBriefTime);

  // Boldness: accept the new field; derive the numeric threshold every
  // backend consumer reads. Backward compat: if the caller still sends
  // `minConfidence` (old client), use it directly.
  const incomingBoldness: Boldness | null =
    boldness === 'cautious' || boldness === 'balanced' || boldness === 'eager' ? boldness : null;
  const fallbackThreshold = typeof existing.minConfidence === 'number' ? existing.minConfidence : 0.85;
  const minConfidence = incomingBoldness
    ? BOLDNESS_TO_THRESHOLD[incomingBoldness]
    : (typeof req.body?.minConfidence === 'number' ? req.body.minConfidence : fallbackThreshold);
  const storedBoldness = incomingBoldness ?? thresholdToBoldness(minConfidence);

  prefs.brain_channel = {
    ...existing,
    channel: 'whatsapp',
    whatsappNumber: whatsappNumber ?? '',
    quietStart: quietStart ?? '22:00',
    quietEnd: quietEnd ?? '06:00',
    boldness: storedBoldness,
    minConfidence,
    outboundEnabled: typeof outboundEnabled === 'boolean' ? outboundEnabled : existing.outboundEnabled === true,
    outboundPaused: !!outboundPaused,
    // dailyCap stays at whatever was last set (or default 20); not
    // user-editable from the UI.
    dailyCap: typeof existing.dailyCap === 'number' && existing.dailyCap >= 1 ? existing.dailyCap : 20,
    dayBriefTime: validTime ? dayBriefTime : (existing.dayBriefTime ?? '08:30'),
    timezone: typeof timezone === 'string' && timezone.length > 0 ? timezone : (existing.timezone ?? 'Asia/Karachi'),
    updatedAt: new Date().toISOString(),
  };
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { notificationPreferences: prefs as any },
  });
  // #13 (2026-07-14): a timezone chosen here is an EXPLICIT user
  // selection — stamp User.timezone + timezone_is_explicit so the
  // global resolver honours it (the brain_channel copy remains the
  // documented per-feature override for Day Brief delivery time).
  if (typeof timezone === 'string' && timezone.length > 0) {
    const { setUserTimezone } = await import('../services/userTimezoneService');
    await setUserTimezone(req.user!.id, timezone).catch(() => false);
  }
  res.json({ success: true });
});

// Test ping — fires a single "Hi from Brain" WA message via the
// canonical brainContactsUser path so the user can verify the
// channel actually reaches them. Bypasses the opt-in gate ONLY for
// this one call (user clicked the button, intent is explicit).
router.post('/test-ping', async (req: Request, res: Response) => {
  try {
    const { brainContactsUser } = await import('../services/notifications/brainOutboundService');
    const r = await brainContactsUser({
      userId: req.user!.id,
      kind: 'test_ping',
      summary: 'Test ping from Settings → Brain',
      body: "Hi — this is Brain. The WhatsApp channel is working. You can reply here any time.",
      bypassRateLimit: true,
      // User clicked the button explicitly — their intent IS the
      // consent for this single send. The opt-in remains required
      // for autonomous Brain → user pings.
      bypassOptIn: true,
    });
    if (r.sent) {
      res.json({ ok: true });
    } else {
      res.status(409).json({ ok: false, reason: r.reason ?? 'send_failed' });
    }
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// "Send Day Brief now" — manual one-shot trigger from Settings. Same
// composer the morning cron uses, same brainContactsUser dispatch path.
// Skips the scheduled-time / once-per-day gates because the user clicked
// the button (explicit consent + they want to see the real thing right
// now). Lets the user verify the brief format and the WA channel before
// they commit to the morning autopilot.
router.post('/day-brief/send-now', async (req: Request, res: Response) => {
  try {
    const { manualDispatchDayBrief } = await import('../jobs/dayBriefDispatchJob');
    const r = await manualDispatchDayBrief(req.user!.id);
    if (r.sent) {
      res.json({ ok: true, preview: r.preview });
    } else {
      res.status(409).json({ ok: false, reason: r.reason ?? 'send_failed', preview: r.preview });
    }
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Per-channel confidence thresholds (email / whatsapp / delegation / calendar) ───
router.get('/brain-channel-thresholds', async (req: Request, res: Response) => {
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true },
  });
  const prefs = (u?.notificationPreferences as any) || {};
  res.json(prefs.brain_channel_thresholds ?? {
    email: 0.88, whatsapp: 0.92, delegation: 0.75, calendar: 0.82,
  });
});

router.put('/brain-channel-thresholds', async (req: Request, res: Response) => {
  const thresholds = req.body ?? {};
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
  const prefs = ((u?.notificationPreferences as any) || {}) as Record<string, any>;
  prefs.brain_channel_thresholds = {
    email: clamp(Number(thresholds.email) || 0.88),
    whatsapp: clamp(Number(thresholds.whatsapp) || 0.92),
    delegation: clamp(Number(thresholds.delegation) || 0.75),
    calendar: clamp(Number(thresholds.calendar) || 0.82),
  };
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { notificationPreferences: prefs as any },
  });
  res.json({ success: true });
});

function clamp(v: number): number {
  if (!Number.isFinite(v)) return 0.8;
  return Math.min(1, Math.max(0, v));
}

// ─── Brain autonomy thresholds (how fast Brain learns) ────────────
// `occurrences` = how many times the MD makes the same decision before
//                 Brain starts doing it on its own
// `agreement`   = consistency required (dominant action / total) — if MD
//                 flip-flopped, Brain won't auto-act even at high count

const DEFAULT_AUTONOMY = { occurrences: 10, agreement: 0.9 };

router.get('/brain-autonomy', async (req: Request, res: Response) => {
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true },
  });
  const prefs = (u?.notificationPreferences as any) || {};
  res.json(prefs.brain_autonomy ?? DEFAULT_AUTONOMY);
});

router.put('/brain-autonomy', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
  const prefs = ((u?.notificationPreferences as any) || {}) as Record<string, any>;
  const occ = Number(body.occurrences);
  const agr = Number(body.agreement);
  prefs.brain_autonomy = {
    occurrences: Number.isFinite(occ) && occ >= 2 && occ <= 100 ? Math.round(occ) : DEFAULT_AUTONOMY.occurrences,
    agreement:   Number.isFinite(agr) && agr >= 0.5 && agr <= 1 ? agr : DEFAULT_AUTONOMY.agreement,
  };
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { notificationPreferences: prefs as any },
  });
  res.json({ success: true, ...prefs.brain_autonomy });
});

// ─── Open Items settings (added 2026-05-18) ──────────────────────
// User-facing knobs for the open-items lifecycle. Anything that is a
// stance choice ("how aggressive should Brain be") lives here. Anything
// that needs context (which specific day to send a nudge, what priority
// an item really is) stays Brain-judged per [[feedback_no_hardcoded_judgement]].

interface OpenItemsSettings {
  // Lifecycle
  followUpDays: number;            // Default cadence between chase attempts; 3
  autoArchiveClosedAfterDays: number; // 0 = never; 30 default
  staleThresholdDays: number;      // 0 = never; 14 default — Brain surfaces "is this alive?"
  draftExpiryDays: number;         // 6 default — DRAFT items expire after N days of asks
  draftAskChannel: 'whatsapp' | 'email' | 'both'; // currently WA only; default 'whatsapp'
  // Auto-creation gating
  autoCreateFromEmail: boolean;    // default true (current behaviour)
  autoCreateFromWhatsapp: boolean; // default true
  autoCreateFromVoice: boolean;    // default true
  autoCreateCriticalityFloor: 'all' | 'medium' | 'high'; // default 'all'
  // Display
  defaultSort: 'priority' | 'deadline' | 'recent' | 'oldest'; // default 'priority'
}

const DEFAULT_OPEN_ITEMS: OpenItemsSettings = {
  followUpDays: 3,
  autoArchiveClosedAfterDays: 30,
  staleThresholdDays: 14,
  draftExpiryDays: 6,
  draftAskChannel: 'whatsapp',
  autoCreateFromEmail: true,
  autoCreateFromWhatsapp: true,
  autoCreateFromVoice: true,
  autoCreateCriticalityFloor: 'all',
  defaultSort: 'priority',
};

function clampDays(v: any, min: number, max: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

router.get('/open-items', async (req: Request, res: Response) => {
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true },
  });
  const prefs = (u?.notificationPreferences as any) || {};
  const oi = prefs.open_items ?? {};
  res.json({ ...DEFAULT_OPEN_ITEMS, ...oi });
});

router.put('/open-items', async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
  const prefs = ((u?.notificationPreferences as any) || {}) as Record<string, any>;
  const existing = (prefs.open_items ?? {}) as Partial<OpenItemsSettings>;

  const draftChannel = ['whatsapp', 'email', 'both'].includes(body.draftAskChannel)
    ? body.draftAskChannel
    : (existing.draftAskChannel ?? DEFAULT_OPEN_ITEMS.draftAskChannel);
  const floor = ['all', 'medium', 'high'].includes(body.autoCreateCriticalityFloor)
    ? body.autoCreateCriticalityFloor
    : (existing.autoCreateCriticalityFloor ?? DEFAULT_OPEN_ITEMS.autoCreateCriticalityFloor);
  const sort = ['priority', 'deadline', 'recent', 'oldest'].includes(body.defaultSort)
    ? body.defaultSort
    : (existing.defaultSort ?? DEFAULT_OPEN_ITEMS.defaultSort);

  prefs.open_items = {
    followUpDays: clampDays(body.followUpDays, 1, 30, existing.followUpDays ?? DEFAULT_OPEN_ITEMS.followUpDays),
    autoArchiveClosedAfterDays: clampDays(body.autoArchiveClosedAfterDays, 0, 365, existing.autoArchiveClosedAfterDays ?? DEFAULT_OPEN_ITEMS.autoArchiveClosedAfterDays),
    staleThresholdDays: clampDays(body.staleThresholdDays, 0, 90, existing.staleThresholdDays ?? DEFAULT_OPEN_ITEMS.staleThresholdDays),
    draftExpiryDays: clampDays(body.draftExpiryDays, 2, 30, existing.draftExpiryDays ?? DEFAULT_OPEN_ITEMS.draftExpiryDays),
    draftAskChannel: draftChannel,
    autoCreateFromEmail: typeof body.autoCreateFromEmail === 'boolean' ? body.autoCreateFromEmail : (existing.autoCreateFromEmail ?? DEFAULT_OPEN_ITEMS.autoCreateFromEmail),
    autoCreateFromWhatsapp: typeof body.autoCreateFromWhatsapp === 'boolean' ? body.autoCreateFromWhatsapp : (existing.autoCreateFromWhatsapp ?? DEFAULT_OPEN_ITEMS.autoCreateFromWhatsapp),
    autoCreateFromVoice: typeof body.autoCreateFromVoice === 'boolean' ? body.autoCreateFromVoice : (existing.autoCreateFromVoice ?? DEFAULT_OPEN_ITEMS.autoCreateFromVoice),
    autoCreateCriticalityFloor: floor,
    defaultSort: sort,
    updatedAt: new Date().toISOString(),
  };
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { notificationPreferences: prefs as any },
  });
  // Bust the in-memory settings cache so the next job tick picks up
  // the new values immediately instead of waiting for the 60s TTL.
  try {
    const { invalidateOpenItemsSettings } = await import('../services/openItems/openItemsSettings');
    invalidateOpenItemsSettings(req.user!.id);
  } catch { /* non-critical */ }
  res.json({ success: true });
});

// Purge — destructive. Requires typed-phrase confirmation per
// [[feedback_no_browser_dialogs]]. Server validates that the user
// typed the exact phrase shown to them, AND that the count matches
// what we're about to delete. Two-key handshake: the count guards
// against a window where new items appeared between preview and
// confirm; the phrase guards against accidental fire.
// Status variants treated as "closed/done" — historical data has
// stored these with different casings (lowercase 'closed' + 'done',
// uppercase 'CLOSED' + 'DONE', plus 'ARCHIVED'). The purge gate
// must match every variant or counts come back as 0 even when data
// exists.
const CLOSED_STATUS_VARIANTS = ['CLOSED', 'closed', 'DONE', 'done', 'ARCHIVED', 'archived'];

// Build the where clause + confirmation phrase for a given purge scope.
//
// Scoping rules:
//   - Non-SA: always user-scoped (`userId = me`). Users only see/affect
//     their own items.
//   - SA + tenantWide=true: tenant-scoped (`clientNumber = my_tenant`).
//     Lets the SA wipe the whole tenant's data — useful for fresh-start
//     reset, dev cleanup, data migration. Wraps the typed-phrase with
//     "ACROSS TENANT" so the keystrokes match the consequence.
//   - SA + tenantWide=false: same as non-SA (user-scoped).
//
// Nuclear `all` overrides the dead-item togges but still respects the
// userId-vs-tenant scoping decision above.
function buildPurgeWhereAndPhrase(
  userId: number,
  clientNumber: string,
  isSuperAdmin: boolean,
  scope: any,
): { where: any; phrase: (count: number) => string; isNuclear: boolean; isTenantWide: boolean } {
  const tenantWide = isSuperAdmin && scope?.tenantWide === true;
  // Top-level scope is the entry filter every clause runs under.
  const baseScope: any = tenantWide ? { clientNumber } : { userId };
  const scopeSuffix = tenantWide ? ' ACROSS TENANT' : '';

  const wantAll = scope?.all === true;
  if (wantAll) {
    return {
      where: baseScope,
      phrase: (count) => `DELETE ALL ${count} ITEMS INCLUDING ACTIVE${scopeSuffix}`,
      isNuclear: true,
      isTenantWide: tenantWide,
    };
  }
  const wantClosed = scope?.closed === true;
  const wantExpiredDraft = scope?.expiredDraft === true;
  const wantStale = scope?.stale === true;
  const where: any = { ...baseScope, OR: [] };
  if (wantClosed) where.OR.push({ status: { in: CLOSED_STATUS_VARIANTS } });
  if (wantExpiredDraft) where.OR.push({
    AND: [
      { status: { in: CLOSED_STATUS_VARIANTS } },
      { metadata: { path: ['draft', 'expiredAt'], not: null as any } as any },
    ],
  });
  if (wantStale) where.OR.push({ metadata: { path: ['stale'], equals: true } as any });
  return {
    where,
    phrase: (count) => `PURGE ${count} ITEMS${scopeSuffix}`,
    isNuclear: false,
    isTenantWide: tenantWide,
  };
}

router.post('/open-items/purge/preview', async (req: Request, res: Response) => {
  const { scope } = req.body ?? {};
  const { where, phrase, isNuclear, isTenantWide } = buildPurgeWhereAndPhrase(
    req.user!.id, req.user!.clientNumber, !!req.user!.isSuperAdmin, scope,
  );
  if (!isNuclear && (!where.OR || where.OR.length === 0)) {
    return res.json({ count: 0, phrase: null, nuclear: false, tenantWide: false });
  }
  const prisma = (await import('../db/prisma')).default;
  const count = await prisma.openItem.count({ where });
  res.json({ count, phrase: phrase(count), nuclear: isNuclear, tenantWide: isTenantWide });
});

router.post('/open-items/purge', async (req: Request, res: Response) => {
  const { scope, phrase: typed } = req.body ?? {};
  const { where, phrase: makePhrase, isNuclear, isTenantWide } = buildPurgeWhereAndPhrase(
    req.user!.id, req.user!.clientNumber, !!req.user!.isSuperAdmin, scope,
  );
  if (!isNuclear && (!where.OR || where.OR.length === 0)) {
    return res.status(400).json({ error: 'no_scope_selected' });
  }
  const prisma = (await import('../db/prisma')).default;
  const count = await prisma.openItem.count({ where });
  const expectedPhrase = makePhrase(count);
  if (String(typed ?? '').trim() !== expectedPhrase) {
    // Count moved between preview and confirm, OR user typo'd. Fail
    // closed; return the fresh count so the next attempt is honest.
    return res.status(409).json({ error: 'phrase_mismatch', expectedPhrase, count, nuclear: isNuclear, tenantWide: isTenantWide });
  }
  const r = await prisma.openItem.deleteMany({ where });
  res.json({ success: true, deleted: r.count, nuclear: isNuclear, tenantWide: isTenantWide });
});

// ─── Connector health (drives the in-app stale banner) ───────────
//
// Returns the user's stale / errored / expired connectors so the
// frontend can render a top-of-page banner the moment a connector
// goes silent, instead of the user finding out via the daily Day
// Brief. Polled every ~60s from the client.
//
// Thresholds:
//   - `sync_stale` (set by connectorHealthService) → always surfaced
//   - `error` / `token_expired` → always surfaced
//   - `connected` BUT `last_sync_at` older than 24h → surfaced as
//     "stale" even though status hasn't flipped yet (catches the
//     window where the health service hasn't ticked yet)
router.get('/connector-health', async (req: Request, res: Response) => {
  const prisma = (await import('../db/prisma')).default;
  const rows = await prisma.userConnector.findMany({
    where: { userId: req.user!.id },
    select: {
      id: true,
      status: true,
      lastSyncAt: true,
      errorMessage: true,
      connectorType: { select: { slug: true, name: true } },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const now = Date.now();
  const STALE_MS = 24 * 60 * 60 * 1000;
  const stale = rows
    .map((r) => {
      const ageMs = r.lastSyncAt ? now - r.lastSyncAt.getTime() : null;
      const isDegraded = ['sync_stale', 'error', 'token_expired', 'expired'].includes(r.status);
      const isOverdue = r.status === 'connected' && ageMs !== null && ageMs > STALE_MS;
      if (!isDegraded && !isOverdue) return null;
      return {
        id: r.id,
        slug: r.connectorType.slug,
        name: r.connectorType.name,
        status: r.status,
        lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
        ageMin: ageMs !== null ? Math.floor(ageMs / 60000) : null,
        errorMessage: r.errorMessage,
        reason: isDegraded ? r.status : 'overdue',
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  res.json({ stale, checkedAt: new Date().toISOString() });
});

// ─── Brain name (user can call their Brain anything) ──────────────
router.get('/brain-name', async (req: Request, res: Response) => {
  const { getBrainPersona } = await import('../services/knowledge/brainPersonaService');
  const persona = await getBrainPersona(req.user!.id, req.user!.clientNumber);
  res.json({ name: persona.name, isCustom: persona.name !== 'Brain' });
});

router.put('/brain-name', async (req: Request, res: Response) => {
  const { setBrainName } = await import('../services/knowledge/brainPersonaService');
  const saved = await setBrainName(req.user!.id, req.body?.name ?? null);
  res.json({ success: true, name: saved });
});

export default router;
