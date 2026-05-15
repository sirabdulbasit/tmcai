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

// ─── Brain notification channel (WhatsApp / email / in_app) ────────
// Persists under users.notification_preferences JSON, keyed by 'brain_channel'.
router.get('/brain-channel', async (req: Request, res: Response) => {
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { notificationPreferences: true, contactNumber: true },
  });
  const prefs = (u?.notificationPreferences as any) || {};
  const bc = prefs.brain_channel || {};
  res.json({
    channel: bc.channel ?? 'whatsapp',
    whatsappNumber: bc.whatsappNumber ?? u?.contactNumber ?? '',
    quietStart: bc.quietStart ?? '22:00',
    quietEnd: bc.quietEnd ?? '06:00',
    minConfidence: bc.minConfidence ?? 0.7,
    // Opt-in: defaults to false. User must explicitly enable Brain
    // outbound on WhatsApp from Settings before any push fires.
    outboundEnabled: bc.outboundEnabled === true,
    outboundPaused: !!bc.outboundPaused,
    dailyCap: typeof bc.dailyCap === 'number' && bc.dailyCap >= 1 ? bc.dailyCap : 20,
    // Day Brief delivery (added 2026-05-16). Time is HH:MM in the
    // user's timezone. Default 08:30 — early enough to plan, late
    // enough to settle in. Timezone defaults to Asia/Karachi (PKT)
    // since the user base is currently TMC. Cron evaluates the
    // user's wall-clock at this timezone every minute and fires
    // the Day Brief via Nexeo when it matches.
    dayBriefTime: bc.dayBriefTime ?? '08:30',
    timezone: bc.timezone ?? 'Asia/Karachi',
  });
});

router.put('/brain-channel', async (req: Request, res: Response) => {
  const { channel, whatsappNumber, quietStart, quietEnd, minConfidence, outboundEnabled, outboundPaused, dailyCap, dayBriefTime, timezone } = req.body ?? {};
  const prisma = (await import('../db/prisma')).default;
  const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
  const prefs = ((u?.notificationPreferences as any) || {}) as Record<string, any>;
  // Preserve any existing brain_channel keys we don't accept here so a
  // partial PUT doesn't drop sibling settings.
  const existing = prefs.brain_channel || {};
  // Validate HH:MM time format for dayBriefTime; reject silently
  // (keep existing) if malformed.
  const validTime = typeof dayBriefTime === 'string' && /^\d{2}:\d{2}$/.test(dayBriefTime);
  prefs.brain_channel = {
    ...existing,
    channel: channel ?? 'whatsapp',
    whatsappNumber: whatsappNumber ?? '',
    quietStart: quietStart ?? '22:00',
    quietEnd: quietEnd ?? '06:00',
    minConfidence: typeof minConfidence === 'number' ? minConfidence : 0.7,
    // outboundEnabled is the opt-in. Strict boolean — if undefined,
    // preserve existing (don't silently turn it on).
    outboundEnabled: typeof outboundEnabled === 'boolean' ? outboundEnabled : existing.outboundEnabled === true,
    outboundPaused: !!outboundPaused,
    dailyCap: typeof dailyCap === 'number' && dailyCap >= 1 ? Math.min(dailyCap, 200) : 20,
    dayBriefTime: validTime ? dayBriefTime : (existing.dayBriefTime ?? '08:30'),
    timezone: typeof timezone === 'string' && timezone.length > 0 ? timezone : (existing.timezone ?? 'Asia/Karachi'),
    updatedAt: new Date().toISOString(),
  };
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { notificationPreferences: prefs as any },
  });
  res.json({ success: true });
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
