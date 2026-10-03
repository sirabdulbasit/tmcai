/**
 * DEF-329 remediation (Codex iteration-76 §6.2) — the ONE implementation of
 * "email the operators directly, independent of the user-facing opt-in".
 *
 * Extracted verbatim from DEF-321's `alertWhatsAppDisconnect`, which proved
 * the shape: an ops alert whose delivery depends on `outboundEnabled` can be
 * silenced by a user notification toggle — the exact invisibility it exists
 * to end, reintroduced one layer up. Measured live on 2026-10-03: the
 * DEF-329 judgement-outage alarm, deployed 23.5h earlier during a total
 * model outage, never reached the owner's inbox.
 *
 * This module does the MECHANICS only — recipient resolution and the
 * per-recipient sends with captured reasons (DEF-276e: the reason must be
 * captured at a level production keeps). Interpretation and logging stay
 * with the caller, so each alert keeps its own pinned log lines and this
 * helper never becomes a judgement point. A second copy of the recipient
 * query in a second alert would be `protection-with-two-implementations`
 * #11 in a codebase that has recorded ten — that is why this file exists.
 */
import prisma from '../../db/prisma';
import { sendEmail } from '../emailService';

export interface AdminOpsSendResult {
  /** 0 when no active SA/AD with an email exists — the caller decides how loudly to say so. */
  total: number;
  results: Array<{ email: string; ok: boolean; error: string | null }>;
}

export async function sendAdminOpsEmail(params: {
  clientNumber: string;
  subject: string;
  html: string;
}): Promise<AdminOpsSendResult> {
  // Recipients: every active SuperAdmin + every active admin of the affected
  // tenant. SuperAdmin needs the cross-tenant operational view; the tenant
  // admin is the one who has to act.
  const recipients = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT email, name, user_type, client_number
       FROM users
      WHERE is_active = TRUE
        AND ( user_type = 'SA'
              OR (user_type = 'AD' AND client_number = $1) )
        AND email IS NOT NULL
        AND email <> ''`,
    params.clientNumber,
  ).catch(() => [] as any[]);

  if (recipients.length === 0) return { total: 0, results: [] };

  const results = await Promise.all(
    recipients.map(async (r) => {
      try {
        const ok = await sendEmail(r.email, params.subject, params.html);
        return { email: r.email, ok, error: ok ? null : 'sendEmail returned false' };
      } catch (e: any) {
        return { email: r.email, ok: false, error: String(e?.message ?? e).slice(0, 200) };
      }
    }),
  );
  return { total: recipients.length, results };
}

/** Escape for the factual HTML bodies these alerts carry. */
export function escapeOpsHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
