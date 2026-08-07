/**
 * Stage 5 of the watch → analyse → build → deploy → NOTIFY loop.
 *
 * The owner's ask, verbatim (2026-08-07): *"after every deploy i want you to
 * evaluate the brain capability if you have improved it significantly improved
 * then notify me"*, and *"notify should be through whatsapp"*. Behind it sits
 * the older one this whole loop exists to answer: *"i don't want to send
 * screenshots of my whatsapp again and again."*
 *
 * The direction of reporting inverts. He stops being the detector. There is no
 * dashboard to remember to open, because a dashboard nobody opens is precisely
 * what `gapDetectionJob` already is — it "persists gap candidates for admin
 * review" and there has never been a reviewer.
 *
 * ── WHY THIS TALKS TO THE SERVER INSTEAD OF SENDING ──────────────────────────
 * The first version of this file imported `brainContactsUser` and sent
 * directly. It ran once, on 2026-08-07 at 19:01:40 PKT, and the watcher caught
 * what it did four seconds later:
 *
 *   19:02:15 CHANNEL {"event":"probe_fail","action":"bounded_reinit"}
 *
 * An out-of-process caller builds its OWN whatsapp-web.js client against the
 * same LocalAuth directory the running server is holding, "removes stale
 * chromium locks" that were not stale, and the live client fails its next
 * liveness probe. The channel went `connected → liveness_failed → connected`
 * over about 45 seconds and the message never reached the ledger. That is the
 * fragile layer AGENTS.md §4 names outright: *treat WA failures as
 * session/runtime issues first*.
 *
 * The rule that falls out of it: **only the process holding the WhatsApp client
 * may send on it.** This script therefore asks the server over loopback and
 * sends nothing itself. It never imports the outbound service — the import
 * alone is what constructs the client.
 *
 * Auth: sessions in this system are opaque tokens hashed into `session`, not
 * JWTs, so there is nothing to forge offline. The script mints a real session
 * for the owner with a two-minute expiry, uses it once, and revokes it in a
 * `finally` — a token that outlives the call it was minted for is a credential
 * nobody is tracking.
 *
 * Usage (from server/, against the built output):
 *   node -r dotenv/config dist/scripts/nexeoNotifyOwner.js \
 *     --kind deploy_report --summary "D-12 PROGRESS" --body "..." \
 *     [--urgency normal] [--dedup-key none] [--dry-run]
 *
 * Exit codes: 0 sent · 3 deliberately not sent (quiet hours, dedup, suppressed)
 * · 1 genuine failure. The loop must distinguish these: "we chose not to wake
 * him at 3am" is not "notification failed", and conflating them trains us to
 * ignore the real thing.
 */

import crypto from 'crypto';
import prisma from '../db/prisma';

/**
 * Who receives the report.
 *
 * Owner instruction, 2026-08-07: *"always remember i am the user and
 * communicating with brain through client's whatsapp. later we can have another
 * user so nothing should be hardcoded related me it should be user under
 * tenant/client"*.
 *
 * So there is no "the owner" constant. `--user <id>` names the recipient, or
 * NEXEO_NOTIFY_USER_ID configures a default per deployment. When neither is
 * given the recipient is RESOLVED — the active super-admin of the tenant — and
 * the script refuses rather than guessing if that is ambiguous.
 */
const ENV_USER_ID = process.env.NEXEO_NOTIFY_USER_ID ? Number(process.env.NEXEO_NOTIFY_USER_ID) : null;
const ENV_CLIENT_NUMBER = process.env.NEXEO_NOTIFY_CLIENT_NUMBER || null;
const PORT = Number(process.env.PORT || 4002);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const SESSION_TTL_MS = 2 * 60 * 1000;

const hashToken = (t: string): string => crypto.createHash('sha256').update(t).digest('hex');

interface Args {
  kind: string;
  summary: string;
  body: string;
  urgency: string;
  dedupKey: string | null;
  dryRun: boolean;
  /** Explicit recipient. No default person — see resolveRecipient. */
  userId: number | null;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(`--${flag}`);
    return i > -1 ? argv[i + 1] : undefined;
  };
  const urgency = get('urgency') || 'normal';
  if (!['low', 'normal', 'high', 'emergency'].includes(urgency)) {
    throw new Error(`--urgency must be low|normal|high|emergency, got "${urgency}"`);
  }
  const summary = get('summary');
  const body = get('body');
  if (!summary || !body) throw new Error('--summary and --body are both required');

  const kind = get('kind') || 'deploy_report';
  const rawDedup = get('dedup-key');
  return {
    kind,
    summary,
    body,
    urgency,
    // Stable per kind+day so a re-run of the loop cannot re-send the same
    // report. `--dedup-key none` is for a genuine one-off.
    dedupKey: rawDedup === 'none' ? null : (rawDedup || `${kind}:${new Date().toISOString().slice(0, 10)}`),
    dryRun: argv.includes('--dry-run'),
    userId: get('user') ? Number(get('user')) : null,
  };
}

/**
 * Resolve the recipient without hardcoding a person.
 *
 * Explicit id wins. Otherwise: the active super-admin of the named tenant, or
 * of the only tenant if there is exactly one. More than one candidate is an
 * error, not a coin flip — sending a health report to the wrong user of the
 * wrong tenant is a data leak, not an inconvenience.
 */
async function resolveRecipient(explicitUserId: number | null): Promise<{ id: number; clientNumber: string }> {
  if (explicitUserId != null) {
    const u = await prisma.user.findUnique({
      where: { id: explicitUserId },
      select: { id: true, isActive: true, clientNumber: true },
    });
    if (!u) throw new Error(`user ${explicitUserId} not found`);
    if (!u.isActive) throw new Error(`user ${explicitUserId} is not active`);
    return { id: u.id, clientNumber: u.clientNumber };
  }

  // Super-admin types are derived from USER_TYPES rather than a literal, so a
  // new type with isSuperAdmin never silently drops out of this lookup.
  const { USER_TYPES } = await import('../config/userTypes');
  const saTypes = Object.entries(USER_TYPES).filter(([, c]) => c.isSuperAdmin).map(([k]) => k);

  const candidates = await prisma.user.findMany({
    where: {
      isActive: true,
      userType: { in: saTypes },
      ...(ENV_CLIENT_NUMBER ? { clientNumber: ENV_CLIENT_NUMBER } : {}),
    },
    select: { id: true, clientNumber: true },
    orderBy: { id: 'asc' },
    take: 5,
  });
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) {
    throw new Error('no active super-admin found — pass --user <id> or set NEXEO_NOTIFY_USER_ID');
  }
  throw new Error(
    `${candidates.length} active super-admins found (${candidates.map((c) => `${c.id}@${c.clientNumber}`).join(', ')}) — ` +
    'pass --user <id> or set NEXEO_NOTIFY_CLIENT_NUMBER to disambiguate',
  );
}

async function mintSession(userId: number): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isActive: true, clientNumber: true },
  });
  if (!user) throw new Error(`user ${userId} not found`);
  if (!user.isActive) throw new Error(`user ${userId} is not active`);

  const token = crypto.randomBytes(48).toString('hex');
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
  return token;
}

async function revokeSession(token: string): Promise<void> {
  // Best-effort: a failure to revoke must not mask the send result, but it is
  // worth a line on stderr — a live token nobody is tracking is the sort of
  // thing that is only ever noticed later.
  try {
    await prisma.session.updateMany({
      where: { tokenHash: hashToken(token) },
      data: { isRevoked: true },
    });
  } catch (err) {
    process.stderr.write(`warning: could not revoke the loop session: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    process.stdout.write(
      `[dry-run] would POST ${BASE}/admin/nexeo-loop/notify\n` +
      `  toUserId: ${args.userId ?? ENV_USER_ID ?? '(resolved at send time)'}\n  kind: ${args.kind}\n  urgency: ${args.urgency}\n` +
      `  dedupKey: ${args.dedupKey ?? '(none)'}\n  summary: ${args.summary}\n  body:\n${args.body}\n`,
    );
    return 0;
  }

  const recipient = await resolveRecipient(args.userId ?? ENV_USER_ID);
  const token = await mintSession(recipient.id);
  try {
    const res = await fetch(`${BASE}/admin/nexeo-loop/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        toUserId: recipient.id,
        kind: args.kind,
        summary: args.summary,
        body: args.body,
        urgency: args.urgency,
        dedupKey: args.dedupKey,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      process.stderr.write(`NOT SENT (http ${res.status}): ${(await res.text()).slice(0, 300)}\n`);
      return 1;
    }

    const r = await res.json() as { sent: boolean; reason?: string; channelsUsed?: string[]; waMessageIds?: string[]; recordId?: string };
    if (r.sent) {
      process.stdout.write(`SENT via ${(r.channelsUsed ?? []).join('+') || '-'} · record=${r.recordId ?? '-'} · waIds=${(r.waMessageIds ?? []).join(',') || '-'}\n`);
      return 0;
    }

    // Not sent, on purpose. Quiet hours and dedup are the system working.
    const deliberate = ['suppressed', 'quiet_hours', 'user_suspended', 'deduped', 'rate_limited'];
    if (r.reason && deliberate.includes(r.reason)) {
      process.stdout.write(`NOT SENT (deliberate): ${r.reason}\n`);
      return 3;
    }
    process.stderr.write(`NOT SENT (failure): ${r.reason ?? 'unknown'}\n`);
    return 1;
  } finally {
    await revokeSession(token);
    await prisma.$disconnect();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`nexeoNotifyOwner failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
