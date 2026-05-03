/**
 * Audit log service — append-only ledger of every consequential action
 * across MyOS. Required for GDPR/SOC2-style accountability and gives
 * support a single place to answer "what did this user do, when?".
 *
 * Schema is in `audit_logs`:
 *   id, client_number, actor_id, actor_kind, action, subject_type,
 *   subject_id, result, ip, user_agent, request_id, details (JSONB),
 *   created_at.
 *
 * The service is intentionally tiny — it's a structured INSERT plus a
 * couple of read helpers. Callers fire it from any code path that
 * mutates state on behalf of a user (send, delegate, override, archive,
 * data delete, login, instruction CRUD, autonomy slider change, etc.).
 *
 * NEVER throws — audit logging must not block the action it's
 * recording. Failures are logged via the standard logger.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('audit');

export type ActorKind = 'user' | 'agent' | 'system' | 'shadow_rule';

export type AuditAction =
  // Auth
  | 'login.success' | 'login.failed' | 'logout' | 'password.reset' | 'session.revoked'
  // Brain decisions
  | 'brain.action.executed' | 'brain.action.overridden' | 'brain.draft.approved'
  | 'brain.draft.discarded' | 'brain.draft.edited'
  | 'brain.compose.completed'
  // Outbound
  | 'email.sent' | 'whatsapp.sent' | 'calendar.event.created' | 'calendar.event.cancelled'
  // Instructions
  | 'instruction.created' | 'instruction.paused' | 'instruction.resumed'
  | 'instruction.archived' | 'instruction.veto_fired'
  // Connectors
  | 'connector.paired' | 'connector.disconnected' | 'connector.credentials.updated'
  // Multi-tenant / privacy
  | 'tenant.created' | 'tenant.deactivated' | 'user.created' | 'user.deactivated'
  | 'user.data.exported' | 'user.data.deleted'
  // Feedback
  | 'feedback.recorded' | 'feedback.diagnosed';

export interface AuditEntry {
  clientNumber: string;
  actorId?: number | null;
  actorKind?: ActorKind;
  action: AuditAction | string;
  subjectType?: string | null;
  subjectId?: string | null;
  result?: 'success' | 'failure' | 'skipped';
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
}

export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit_logs
         (client_number, actor_id, actor_kind, action,
          subject_type, subject_id, result, ip, user_agent, request_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      entry.clientNumber,
      entry.actorId ?? null,
      entry.actorKind ?? 'user',
      entry.action,
      entry.subjectType ?? null,
      entry.subjectId ?? null,
      entry.result ?? 'success',
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
      JSON.stringify(entry.details ?? {}),
    );
  } catch (err: any) {
    log.warn('audit insert failed', { action: entry.action, error: err.message });
  }
}

/** Lightweight wrapper — stamp from an Express req (capture IP + UA + request id). */
export async function auditFromReq(req: any, entry: Omit<AuditEntry, 'clientNumber' | 'actorId' | 'ip' | 'userAgent' | 'requestId'>): Promise<void> {
  const u = req.user;
  if (!u?.clientNumber) return;
  return audit({
    clientNumber: u.clientNumber,
    actorId: u.id ?? null,
    actorKind: u.isAgent ? 'agent' : 'user',
    ip: req.ip ?? req.socket?.remoteAddress ?? null,
    userAgent: req.headers?.['user-agent']?.toString().slice(0, 250) ?? null,
    requestId: req.id ?? req.headers?.['x-request-id']?.toString() ?? null,
    ...entry,
  });
}

/** List recent entries for a tenant — for the admin "audit log" UI. */
export async function listAuditEntries(
  clientNumber: string,
  opts: { limit?: number; action?: string; actorId?: number; sinceIso?: string } = {},
) {
  const limit = Math.min(opts.limit ?? 50, 500);
  const filters: string[] = ['client_number = $1'];
  const params: any[] = [clientNumber];
  if (opts.action) { filters.push(`action = $${params.length + 1}`); params.push(opts.action); }
  if (opts.actorId != null) { filters.push(`actor_id = $${params.length + 1}`); params.push(opts.actorId); }
  if (opts.sinceIso) { filters.push(`created_at >= $${params.length + 1}::timestamp`); params.push(opts.sinceIso); }
  const sql = `SELECT id, actor_id AS "actorId", actor_kind AS "actorKind", action,
                      subject_type AS "subjectType", subject_id AS "subjectId",
                      result, ip, request_id AS "requestId", details, created_at AS "createdAt"
                 FROM audit_logs
                WHERE ${filters.join(' AND ')}
                ORDER BY created_at DESC LIMIT ${limit}`;
  return prisma.$queryRawUnsafe<any[]>(sql, ...params).catch(() => [] as any[]);
}

/**
 * GDPR data-delete — purge per-user data from MyOS. Audit-trailed, NOT
 * called by mistake (caller must pass `confirm: 'DELETE-MY-DATA'`).
 *
 * Scope:
 *   - User-scoped wiki_pages (email_message, sender_topic, observation,
 *     answer, gap, instruction, mind_state, feedback, feedback_diagnosis,
 *     meeting_minutes, attachment_doc that was authored by this user).
 *   - feed_events the user owns.
 *   - open_items where userId = X.
 *   - whatsapp_messages, whatsapp_connections, whatsapp_sessions where userId = X.
 *   - decision_logs, agent_actions, delegation_logs.
 *   - Conversations + messages.
 *   - sessions (for forced sign-out).
 *   - The user's own profile fields (anonymise rather than drop, so
 *     audit references remain valid: name='[deleted]', email='deleted+id@example.invalid').
 *
 * NOT touched:
 *   - Tenant-shared knowledge (org_doc, policy, project, decision,
 *     pattern, attachment_doc, entity_person, topic) — these survive
 *     because they belong to the tenant, not the individual.
 *   - Audit log entries — we keep audit history per legal retention.
 */
export interface DataDeleteResult {
  ok: boolean;
  reason?: string;
  deletedRows: Record<string, number>;
}

export async function deleteUserData(
  clientNumber: string,
  userId: number,
  opts: { confirm: string; actorId: number; reason?: string },
): Promise<DataDeleteResult> {
  if (opts.confirm !== 'DELETE-MY-DATA') {
    return { ok: false, reason: 'confirm phrase missing', deletedRows: {} };
  }
  const deletedRows: Record<string, number> = {};
  const exec = async (label: string, sql: string, ...params: any[]) => {
    try {
      const n = await prisma.$executeRawUnsafe(sql, ...params);
      deletedRows[label] = Number(n);
    } catch (err: any) {
      log.warn('delete step failed', { label, error: err.message });
      deletedRows[label] = -1;
    }
  };

  const args = [clientNumber, userId];
  await exec('feedback_diagnoses',  `DELETE FROM wiki_pages WHERE client_number=$1 AND user_id=$2 AND page_type='feedback_diagnosis'`, ...args);
  await exec('feedback_pages',      `DELETE FROM wiki_pages WHERE client_number=$1 AND user_id=$2 AND page_type='feedback'`, ...args);
  await exec('observations',        `DELETE FROM wiki_pages WHERE client_number=$1 AND user_id=$2 AND page_type IN ('observation','mind_state','answer','gap','instruction','sender_topic','sender_history','email_message','meeting_minutes')`, ...args);
  await exec('feed_events',         `DELETE FROM feed_events  WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('open_items',          `DELETE FROM open_items   WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('whatsapp_messages',   `DELETE FROM whatsapp_messages   WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('whatsapp_sessions',   `DELETE FROM whatsapp_sessions   WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('whatsapp_connection', `DELETE FROM whatsapp_connections WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('decision_logs',       `DELETE FROM decision_logs WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('agent_actions',       `DELETE FROM agent_actions WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('delegation_logs',     `DELETE FROM delegation_logs WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('conversation_msgs',   `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE client_number=$1 AND user_id=$2)`, ...args);
  await exec('conversations',       `DELETE FROM conversations WHERE client_number=$1 AND user_id=$2`, ...args);
  await exec('sessions',            `DELETE FROM sessions WHERE user_id=$2`, userId);
  await exec('user.anonymised',     `UPDATE users SET name='[deleted]', email='deleted+'||id||'@example.invalid', is_active=false WHERE client_number=$1 AND id=$2`, ...args);

  await audit({
    clientNumber,
    actorId: opts.actorId, actorKind: 'user',
    action: 'user.data.deleted',
    subjectType: 'user', subjectId: String(userId),
    result: 'success',
    details: { reason: opts.reason ?? null, deletedRows },
  });
  return { ok: true, deletedRows };
}
