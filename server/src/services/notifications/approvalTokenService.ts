/**
 * Approval Tokens.
 *
 * One-tap approval / rejection from a push notification works like this:
 *
 *   Brain → createPendingApproval() → pushService.sendToUser()
 *      ↓
 *   issueTokens(actionId, userId) → { approveToken, rejectToken, viewToken }
 *      ↓ (raw tokens land in the push payload only)
 *   service worker shows: "Approve" "Reject" "View"
 *      ↓
 *   user taps Approve → /api/v1/approval/:token/consume
 *      ↓
 *   verifyAndConsume(token) → { actionId, userId, intent } → fires
 *
 * The raw token is a 32-byte b64url string; only its SHA-256 hash is
 * persisted. So a DB read can't recover live tokens; the only copy is
 * in the encrypted push payload + the user's notification.
 *
 * Tokens are scoped to a specific (action_id, user_id, intent) tuple so
 * a leaked approve-token can't act on a different action or impersonate
 * another user. Single-use (consumed_at) and short-lived (24h default).
 */
import crypto from 'crypto';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('approval-token');

const DEFAULT_TTL_HOURS = 24;

export type ApprovalIntent = 'approve' | 'reject' | 'view';

export interface IssueResult {
  approveToken: string;
  rejectToken: string;
  viewToken: string;
  expiresAt: Date;
}

/** Issue the three tokens for a pending action. Caller embeds them in
 *  the push payload (and optionally email/whatsapp links). */
export async function issueTokens(input: {
  clientNumber: string;
  userId: number;
  actionId: number;
  ttlHours?: number;
}): Promise<IssueResult> {
  const expiresAt = new Date(Date.now() + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 60 * 60 * 1000);
  const intents: ApprovalIntent[] = ['approve', 'reject', 'view'];
  const out: Partial<IssueResult> = { expiresAt };
  for (const intent of intents) {
    const raw = generateToken();
    const tokenHash = sha256Hex(raw);
    await prisma.approvalToken.create({
      data: {
        tokenHash,
        clientNumber: input.clientNumber,
        userId: input.userId,
        actionId: input.actionId,
        intent,
        expiresAt,
      },
    });
    if (intent === 'approve') out.approveToken = raw;
    else if (intent === 'reject') out.rejectToken = raw;
    else out.viewToken = raw;
  }
  return out as IssueResult;
}

export interface VerifiedToken {
  id: number;
  clientNumber: string;
  userId: number;
  actionId: number;
  intent: ApprovalIntent;
}

/**
 * Verify a presented raw token. Returns the verified record on success,
 * or throws with a stable error code so the route can return the right
 * HTTP status.
 *
 * Errors:
 *   'not_found'          — token never existed
 *   'expired'            — past expires_at
 *   'already_consumed'   — was used already (replay protection)
 *   'wrong_intent'       — caller asked for /approve but token is /reject
 */
export async function verify(rawToken: string, expectedIntent?: ApprovalIntent): Promise<VerifiedToken> {
  if (!rawToken || rawToken.length < 16) throw err('not_found');
  const row = await prisma.approvalToken.findUnique({
    where: { tokenHash: sha256Hex(rawToken) },
  });
  if (!row) throw err('not_found');
  if (row.consumedAt) throw err('already_consumed');
  if (row.expiresAt < new Date()) throw err('expired');
  if (expectedIntent && row.intent !== expectedIntent) throw err('wrong_intent');
  return {
    id: row.id,
    clientNumber: row.clientNumber,
    userId: row.userId,
    actionId: row.actionId,
    intent: row.intent as ApprovalIntent,
  };
}

/** Mark a verified token consumed. Atomic — second call fails. */
export async function consume(tokenId: number, ipAddress: string | null, via: string): Promise<boolean> {
  const r = await prisma.approvalToken.updateMany({
    where: { id: tokenId, consumedAt: null },
    data: {
      consumedAt: new Date(),
      consumedByIp: ipAddress?.slice(0, 50) ?? null,
      consumedVia: via.slice(0, 20),
    },
  });
  return r.count > 0;
}

/**
 * Cleanup expired tokens. Called from the daily scheduler — keeps the
 * table from growing unbounded. Tokens past expires_at are useless;
 * they can never be consumed.
 */
export async function cleanupExpired(): Promise<number> {
  const r = await prisma.approvalToken.deleteMany({
    where: {
      expiresAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // 7d grace for audit
    },
  });
  if (r.count > 0) log.info('expired tokens cleaned', { count: r.count });
  return r.count;
}

// ─── internals ────────────────────────────────────────────────────

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function err(code: string): Error {
  const e = new Error(code) as Error & { code: string };
  (e as any).code = code;
  return e;
}
