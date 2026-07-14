import prisma from '../db/prisma';
import { streamGemini } from './geminiService';
import createLogger from '../utils/logger';

const sysLog = createLogger('systemLog');

/**
 * SystemLogService — records errors, warnings, truncation issues, and system events.
 *
 * Features:
 * - Auto-dedup: same error increments recurrence_count instead of creating new row
 * - AI suggestions: generates fix recommendations for admins
 * - Recurrence detection: flags if a resolved issue comes back
 * - Admin workflow: open → catered → monitors for recurrence
 */

export type LogLevel = 'error' | 'warning' | 'info';
export type LogCategory =
  | 'data_truncation'    // Data was cut due to context limits
  | 'api_error'          // External API failed (Gmail, Calendar, Weather, News, Gemini)
  | 'auth_error'         // OAuth/token issues
  | 'intent_error'       // Intent classification failed or timed out
  | 'memory_error'       // Memory extraction/update failed
  | 'email_error'        // Email send/read failed
  | 'calendar_error'     // Calendar read/write failed
  | 'scheduler_error'    // Scheduled task failed
  | 'data_quality'       // Data validation issue (missing fields, duplicates)
  | 'performance'        // Slow response (>20s)
  | 'system'             // General system issues
  | 'security'           // Auth failures, suspicious activity
  // Hardening audit 2026-07-14:
  | 'job_failure'        // background job failed repeatedly (jobRunner)
  | 'self_heal'          // allowlisted repair exhausted/escalated (repairService)
  | 'embedding_degraded' // real embedding provider unavailable (embeddingGuard)
  | 'health_transition'; // component up/down transition (connectionWatchdog etc.)

interface LogEntry {
  clientNumber?: string;
  userId?: number;
  level: LogLevel;
  category: LogCategory;
  source: string;        // e.g., 'chatController', 'gmailService', 'schedulerService'
  message: string;       // Human-readable description
  details?: string;      // Stack trace, raw error, context
  suggestion?: string;   // Auto-generated or manual fix suggestion
}

// ─── Record a log entry (auto-dedup) ──────────────────────────

export async function log(entry: LogEntry): Promise<void> {
  try {
    // Check for existing similar log (same category + source + message pattern)
    const messageKey = entry.message.slice(0, 100); // First 100 chars as key
    const existing: any[] = await prisma.$queryRawUnsafe(`
      SELECT id, status, recurrence_count FROM system_logs
      WHERE category = $1 AND source = $2 AND LEFT(message, 100) = $3
      AND status != 'resolved'
      ORDER BY last_seen_at DESC LIMIT 1
    `, entry.category, entry.source, messageKey);

    if (existing.length > 0) {
      // Same issue recurring — increment count
      await prisma.$executeRawUnsafe(`
        UPDATE system_logs SET
          recurrence_count = recurrence_count + 1,
          last_seen_at = NOW(),
          details = $1
        WHERE id = $2
      `, entry.details || '', existing[0].id);

      // If it was marked as "catered" but came back, flag it
      if (existing[0].status === 'catered') {
        await prisma.$executeRawUnsafe(`
          UPDATE system_logs SET status = 'recurring', last_seen_at = NOW() WHERE id = $1
        `, existing[0].id);
        sysLog.warn('RECURRING issue detected', { category: entry.category, source: entry.source, messageKey });
      }
      return;
    }

    // New issue — create log entry
    await prisma.$executeRawUnsafe(`
      INSERT INTO system_logs (client_number, user_id, level, category, source, message, details, suggestion, status, recurrence_count, first_seen_at, last_seen_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', 1, NOW(), NOW())
    `,
      entry.clientNumber || null,
      entry.userId || null,
      entry.level,
      entry.category,
      entry.source,
      entry.message,
      entry.details || null,
      entry.suggestion || null,
    );
  } catch (err: any) {
    // Don't let logging errors crash the app
    sysLog.error('Failed to record log', { error: err.message });
  }
}

// ─── Convenience methods ──────────────────────────────────────

export async function logError(category: LogCategory, source: string, message: string, details?: string): Promise<void> {
  await log({ level: 'error', category, source, message, details });
}

export async function logWarning(category: LogCategory, source: string, message: string, details?: string): Promise<void> {
  await log({ level: 'warning', category, source, message, details });
}

export async function logInfo(category: LogCategory, source: string, message: string, details?: string): Promise<void> {
  await log({ level: 'info', category, source, message, details });
}

// ─── Truncation logging ───────────────────────────────────────

export async function logTruncation(sectionName: string, fullSize: number, truncatedTo: number, userId?: number): Promise<void> {
  const pctLost = Math.round((1 - truncatedTo / fullSize) * 100);
  const neededLimit = Math.ceil(fullSize * 1.2); // 20% buffer above actual size
  await log({
    level: pctLost > 50 ? 'warning' : 'info',
    category: 'data_truncation',
    source: 'sectionRetriever',
    message: `Section "${sectionName}" truncated: ${fullSize.toLocaleString()} → ${truncatedTo.toLocaleString()} chars (${pctLost}% data lost)`,
    details: `Full section: ${fullSize.toLocaleString()} chars\nShown to AI: ${truncatedTo.toLocaleString()} chars\nData lost: ${(fullSize - truncatedTo).toLocaleString()} chars (${pctLost}%)`,
    suggestion: `ACTION: Go to Admin → Settings → AI Context & Tokens → set "context_limit_full" to at least ${neededLimit.toLocaleString()}. Current value is too low to fit the "${sectionName}" section (${fullSize.toLocaleString()} chars). This causes the AI to see incomplete data and report wrong counts or miss records.`,
    userId,
  });
}

// ─── Performance logging ──────────────────────────────────────

export async function logSlowResponse(prompt: string, elapsed: number, provider: string, userId?: number): Promise<void> {
  await log({
    level: elapsed > 30 ? 'error' : 'warning',
    category: 'performance',
    source: 'chatController',
    message: `Slow response: ${elapsed}s for "${prompt.slice(0, 50)}" via ${provider}`,
    details: `Prompt: ${prompt}\nProvider: ${provider}\nElapsed: ${elapsed}s`,
    suggestion: elapsed > 30
      ? `ACTION: This query took ${elapsed}s which is too slow. Steps to fix:\n1. Go to Admin → Settings → AI Context & Tokens → reduce "context_limit_full" (lower = faster but less data)\n2. Or switch default provider to "gemini-flash" which is 2-3x faster\n3. Or create an artifact template for this query type (Admin → check artifact templates) so it uses cached HTML instead of generating from scratch`
      : `MONITOR: Response took ${elapsed}s (target is <20s). If this keeps happening, consider reducing "max_output_tokens_text" in Admin → Settings → AI Context & Tokens, or reducing "context_limit_full" for faster processing.`,
    userId,
  });
}

// ─── Get logs for admin ───────────────────────────────────────

export async function getLogs(options?: {
  status?: string;
  level?: string;
  category?: string;
  limit?: number;
}): Promise<any[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIdx = 1;

  if (options?.status) { conditions.push(`status = $${paramIdx++}`); params.push(options.status); }
  if (options?.level) { conditions.push(`level = $${paramIdx++}`); params.push(options.level); }
  if (options?.category) { conditions.push(`category = $${paramIdx++}`); params.push(options.category); }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
  const limit = options?.limit || 50;

  return prisma.$queryRawUnsafe(`
    SELECT * FROM system_logs ${where}
    ORDER BY
      CASE status WHEN 'recurring' THEN 0 WHEN 'open' THEN 1 WHEN 'catered' THEN 2 WHEN 'resolved' THEN 3 END,
      last_seen_at DESC
    LIMIT ${limit}
  `, ...params);
}

// ─── Get log summary for dashboard ────────────────────────────

export async function getLogSummary(): Promise<{
  total: number;
  open: number;
  recurring: number;
  catered: number;
  byCategory: { category: string; count: number }[];
  byLevel: { level: string; count: number }[];
}> {
  const [total]: any[] = await prisma.$queryRawUnsafe("SELECT COUNT(*) as cnt FROM system_logs WHERE status != 'resolved'");
  const [open]: any[] = await prisma.$queryRawUnsafe("SELECT COUNT(*) as cnt FROM system_logs WHERE status = 'open'");
  const [recurring]: any[] = await prisma.$queryRawUnsafe("SELECT COUNT(*) as cnt FROM system_logs WHERE status = 'recurring'");
  const [catered]: any[] = await prisma.$queryRawUnsafe("SELECT COUNT(*) as cnt FROM system_logs WHERE status = 'catered'");
  const byCategory: any[] = await prisma.$queryRawUnsafe("SELECT category, COUNT(*) as count FROM system_logs WHERE status != 'resolved' GROUP BY category ORDER BY count DESC");
  const byLevel: any[] = await prisma.$queryRawUnsafe("SELECT level, COUNT(*) as count FROM system_logs WHERE status != 'resolved' GROUP BY level ORDER BY count DESC");

  return {
    total: Number(total.cnt),
    open: Number(open.cnt),
    recurring: Number(recurring.cnt),
    catered: Number(catered.cnt),
    byCategory: byCategory.map((r: any) => ({ category: r.category, count: Number(r.count) })),
    byLevel: byLevel.map((r: any) => ({ level: r.level, count: Number(r.count) })),
  };
}

// ─── Mark log as catered ──────────────────────────────────────

export async function caterLog(logId: number, userId: number, note?: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE system_logs SET status = 'catered', resolved_by = $1, resolved_at = NOW(), resolution_note = $2 WHERE id = $3
  `, userId, note || 'Marked as catered', logId);
}

// ─── Mark log as ignored ─────────────────────────────────────

export async function ignoreLog(logId: number, userId: number, note?: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE system_logs SET status = 'ignored', resolved_by = $1, resolved_at = NOW(), resolution_note = $2 WHERE id = $3
  `, userId, note || 'Ignored by admin');
}

// ─── Mark log as resolved ─────────────────────────────────────

export async function resolveLog(logId: number, userId: number, note?: string): Promise<void> {
  await prisma.$executeRawUnsafe(`
    UPDATE system_logs SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), resolution_note = $2 WHERE id = $3
  `, userId, note || 'Resolved', logId);
}

// ─── Severity escalation ─────────────────────────────────────

export async function escalateHighRecurrence(): Promise<number> {
  // Auto-escalate: recurring 10+ times → error level, 50+ → critical notification
  const escalated = await prisma.$executeRawUnsafe(`
    UPDATE system_logs SET level = 'error'
    WHERE recurrence_count >= 10 AND level = 'warning' AND status IN ('open', 'recurring')
  `);

  // Log critical threshold breaches for admin notification
  const critical: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, category, message, recurrence_count
    FROM system_logs
    WHERE recurrence_count >= 50 AND status IN ('open', 'recurring')
    AND NOT message LIKE '%[ESCALATED]%'
  `);

  for (const log of critical) {
    await prisma.$executeRawUnsafe(`
      UPDATE system_logs SET message = $1, level = 'error' WHERE id = $2
    `, `[ESCALATED] ${log.message}`, log.id);
    sysLog.error('CRITICAL: Log exceeded 50 recurrences', { logId: log.id, category: log.category, count: log.recurrence_count });
  }

  return critical.length;
}

// ─── Auto-fix known patterns ─────────────────────────────────

interface AutoFixRule {
  category: LogCategory;
  pattern: RegExp;
  fixes: { key: string; valueFn: (details: string) => string }[];
  maxAutoFixes: number; // Don't auto-fix more than N times
}

const AUTO_FIX_RULES: AutoFixRule[] = [
  {
    category: 'data_truncation',
    pattern: /set "context_limit_full" to at least ([\d,]+)/,
    fixes: [{
      key: 'context_limit_full',
      valueFn: (suggestion) => {
        const match = suggestion.match(/at least ([\d,]+)/);
        return match ? match[1].replace(/,/g, '') : '';
      },
    }],
    maxAutoFixes: 3,
  },
];

export async function runAutoFix(clientNumber: string): Promise<{ fixed: number; details: string[] }> {
  const { getConfig, setConfig } = await import('./configService');
  const { clearAIConfigCache } = await import('./aiConfigService');
  const details: string[] = [];
  let fixed = 0;

  for (const rule of AUTO_FIX_RULES) {
    // Tenant scope: only this caller's logs (or NULL = system-wide
    // infra issues with no tenant attribution). Previously the
    // clientNumber arg was accepted but never applied — a tenant admin
    // could sweep any tenant's matching logs.
    const logs: any[] = await prisma.$queryRawUnsafe(`
      SELECT id, suggestion, details, recurrence_count
      FROM system_logs
      WHERE category = $1
        AND status IN ('open', 'recurring')
        AND suggestion IS NOT NULL
        AND (client_number = $2 OR client_number IS NULL)
      ORDER BY recurrence_count DESC LIMIT 5
    `, rule.category, clientNumber);

    for (const logEntry of logs) {
      if (!rule.pattern.test(logEntry.suggestion || '')) continue;

      // Check auto-fix count — don't auto-fix endlessly
      const autoFixCount = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) as cnt FROM system_logs WHERE category = $1 AND resolution_note LIKE '%Auto-fixed%' AND resolved_at > NOW() - INTERVAL '24 hours'`,
        rule.category,
      ) as any[];
      if (Number(autoFixCount[0]?.cnt || 0) >= rule.maxAutoFixes) continue;

      for (const fix of rule.fixes) {
        const newValue = fix.valueFn(logEntry.suggestion);
        if (!newValue) continue;

        const currentValue = await getConfig(clientNumber, fix.key);
        // Only increase, never decrease
        if (currentValue && Number(newValue) <= Number(currentValue)) continue;

        await setConfig(clientNumber, fix.key, newValue);
        details.push(`${fix.key}: ${currentValue} → ${newValue} (log #${logEntry.id}, ${logEntry.recurrence_count}x)`);
      }

      await caterLog(logEntry.id, 0, `Auto-fixed: ${details[details.length - 1] || 'applied rule'}`);
      fixed++;
    }
  }

  if (fixed > 0) {
    const { clearAIConfigCache } = await import('./aiConfigService');
    clearAIConfigCache();
    sysLog.info('Auto-fix applied', { clientNumber, fixed, details });
  }

  return { fixed, details };
}

// ─── Log retention cleanup ───────────────────────────────────

export async function cleanupOldLogs(retentionDays = 90): Promise<number> {
  const result = await prisma.$executeRawUnsafe(`
    DELETE FROM system_logs WHERE status = 'resolved' AND resolved_at < NOW() - INTERVAL '${retentionDays} days'
  `);
  // Also clean ignored logs older than 30 days
  await prisma.$executeRawUnsafe(`
    DELETE FROM system_logs WHERE status = 'ignored' AND resolved_at < NOW() - INTERVAL '30 days'
  `);
  return typeof result === 'number' ? result : 0;
}

// ─── Trend analysis ──────────────────────────────────────────

export async function getLogTrends(days = 7): Promise<{
  daily: { date: string; errors: number; warnings: number; total: number }[];
  topRecurring: { id: number; category: string; message: string; count: number }[];
}> {
  const daily: any[] = await prisma.$queryRawUnsafe(`
    SELECT DATE(created_at) as date,
      COUNT(*) FILTER (WHERE level = 'error') as errors,
      COUNT(*) FILTER (WHERE level = 'warning') as warnings,
      COUNT(*) as total
    FROM system_logs
    WHERE created_at > NOW() - INTERVAL '${days} days'
    GROUP BY DATE(created_at) ORDER BY date
  `);

  const topRecurring: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, category, message, recurrence_count as count
    FROM system_logs
    WHERE status IN ('open', 'recurring')
    ORDER BY recurrence_count DESC LIMIT 10
  `);

  return {
    daily: daily.map((d: any) => ({
      date: d.date?.toISOString?.()?.split('T')[0] || String(d.date),
      errors: Number(d.errors),
      warnings: Number(d.warnings),
      total: Number(d.total),
    })),
    topRecurring: topRecurring.map((r: any) => ({
      id: Number(r.id),
      category: r.category,
      message: r.message,
      count: Number(r.count),
    })),
  };
}

// ─── AI-generated suggestions for open logs ───────────────────

export async function generateSuggestionsForLogs(): Promise<{ logId: number; suggestion: string }[]> {
  const openLogs: any[] = await prisma.$queryRawUnsafe(`
    SELECT id, category, source, message, details, recurrence_count
    FROM system_logs WHERE status IN ('open', 'recurring') AND suggestion IS NULL
    ORDER BY recurrence_count DESC LIMIT 10
  `);

  if (openLogs.length === 0) return [];

  const logSummary = openLogs.map(l =>
    `Log #${l.id} [${l.category}] (${l.recurrence_count}x): ${l.message}\n  Details: ${(l.details || '').slice(0, 200)}`
  ).join('\n\n');

  let suggestions = '';
  try {
    await streamGemini(
      `You are a senior platform engineer advising on TMC AI Enterprise Intelligence Platform.

PLATFORM CONTEXT:
- Stack: Express + React + PostgreSQL + BigQuery + Vertex AI + Redis
- Smart cache available (ff_smart_cache) — reduces LLM token consumption
- Three-tier retrieval: Vertex AI Vector Search → BQ ML.DISTANCE → in-memory cosine
- Feature flags in system_config table (ff_* keys, configurable per tenant)
- Key config keys: context_limit_full, context_limit_fast, max_output_tokens_text, max_output_tokens_widget, rag_top_k
- Provider options: gemini-flash (fast), gemini (deep), claude, openai, groq
- BullMQ agent queue with circuit breaker (3 errors → open)
- PgBouncer connection pool in production

For each log, provide a SPECIFIC actionable fix (1-2 sentences).
- Reference exact config keys to change and suggested values
- Suggest feature flag changes if relevant (e.g., enable ff_smart_cache to reduce API calls)
- For performance issues, recommend provider/model changes
- For recurring issues, suggest root cause not just symptom fixes

Format: #ID: suggestion`,
      `System logs needing attention:\n\n${logSummary}`,
      (chunk) => { suggestions += chunk; },
      true, 1024, true
    );
  } catch { return []; }

  // Parse suggestions and update logs
  const results: { logId: number; suggestion: string }[] = [];
  for (const log of openLogs) {
    const match = suggestions.match(new RegExp(`#${log.id}:?\\s*(.+?)(?=#\\d|$)`, 's'));
    if (match) {
      const suggestion = match[1].trim();
      await prisma.$executeRawUnsafe('UPDATE system_logs SET suggestion = $1 WHERE id = $2', suggestion, log.id);
      results.push({ logId: log.id, suggestion });
    }
  }

  return results;
}
