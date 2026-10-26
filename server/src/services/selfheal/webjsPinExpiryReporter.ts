/**
 * DEF-353 — the pinned WhatsApp Web build is a dated deadline; announce it.
 *
 * `webjsVersionCache` pins one WhatsApp Web build and correctly fails closed
 * once WhatsApp's own expiry for that build passes. Commit 7b41165 wrote
 * "rotate before 2026-09-17"; nothing watched that date, the pin expired, and
 * from then on every QR pairing was refused before Chrome started. The owner
 * found out by failing to re-pair (CL-059), five weeks later.
 *
 * This turns the expiry into a health finding, per tenant that has a WhatsApp
 * Web channel, so the existing finding_notify_pass delivers it:
 *   - ≤14 days left → `warn`  (daily digest)
 *   - ≤3 days left  → `error` (immediate alert)
 *   - expired       → `critical`
 * and resolves it once the pin is rotated. The pin is resolved from the same
 * env the provider uses, so an env override is watched too. An env rotation
 * that is itself invalid is reported rather than swallowed — that is the same
 * "pairing cannot start" outcome.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { recordFinding, resolveOpenFindings } from './healthFindingService';
import {
  assessWebjsPinExpiry, resolveWebjsVersionPin,
  type WebjsPinExpiryState, type WebjsVersionPin,
} from '../whatsapp/webjsVersionCache';

const log = createLogger('webjs-pin-expiry');

export const WEBJS_PIN_EXPIRY_KIND = 'whatsapp_web_pin_expiry';
const SUBJECT_ID = 'webjs_version_pin';

const SEVERITY: Record<Exclude<WebjsPinExpiryState, 'ok'>, 'warn' | 'error' | 'critical'> = {
  expiring: 'warn',
  urgent: 'error',
  expired: 'critical',
};

export interface WebjsPinExpiryWatchResult {
  state: WebjsPinExpiryState | 'invalid';
  tenants: number;
  recorded: number;
  resolved: number;
}

export async function runWebjsPinExpiryWatch(
  options: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): Promise<WebjsPinExpiryWatchResult> {
  const now = options.now ?? new Date();
  let pin: WebjsVersionPin | null = null;
  let invalidReason: string | null = null;
  try {
    pin = resolveWebjsVersionPin(options.env ?? process.env);
  } catch (e: any) {
    invalidReason = String(e?.message ?? e).slice(0, 200);
  }

  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT w.client_number
       FROM whatsapp_config w
       JOIN tenants t ON t.client_number = w.client_number
      WHERE t.is_active = true`,
  ).catch((e: any) => {
    log.warn('pin-expiry watch could not list tenants', { error: String(e?.message ?? e).slice(0, 200) });
    return [] as Array<{ client_number: string }>;
  });

  const assessed = pin ? assessWebjsPinExpiry(pin, now) : null;
  const state: WebjsPinExpiryWatchResult['state'] = assessed ? assessed.state : 'invalid';
  const result: WebjsPinExpiryWatchResult = { state, tenants: tenants.length, recorded: 0, resolved: 0 };

  for (const t of tenants) {
    if (state === 'ok') {
      const n = await resolveOpenFindings({
        clientNumber: t.client_number,
        kind: WEBJS_PIN_EXPIRY_KIND,
        subjectId: SUBJECT_ID,
        action: `pin rotated: ${pin!.version}`,
      });
      result.resolved += n ?? 0;
      continue;
    }

    const daysLeft = assessed ? Math.floor(assessed.msLeft / 86_400_000) : null;
    const summary = state === 'invalid'
      ? `WhatsApp Web pin configuration is invalid — QR pairing cannot start (${invalidReason})`
      : state === 'expired'
        ? `pinned WhatsApp Web build ${pin!.version} expired at ${pin!.expiresAt} — QR pairing is refused until the pin is rotated`
        : `pinned WhatsApp Web build ${pin!.version} expires at ${pin!.expiresAt} (${daysLeft} day(s) left) — rotate the pin before then or QR pairing stops`;
    const id = await recordFinding({
      clientNumber: t.client_number,
      kind: WEBJS_PIN_EXPIRY_KIND,
      severity: state === 'invalid' ? 'critical' : SEVERITY[state],
      source: 'webjs-pin-expiry',
      subjectType: 'whatsapp_web_pin',
      subjectId: SUBJECT_ID,
      summary,
      evidence: pin
        ? { version: pin.version, expiresAt: pin.expiresAt, sourceUrl: pin.sourceUrl, daysLeft, state }
        : { invalidReason, state },
    });
    if (id) result.recorded += 1;
  }

  if (state !== 'ok') log.warn('WhatsApp Web pin needs rotation', { ...result, version: pin?.version, expiresAt: pin?.expiresAt });
  return result;
}
