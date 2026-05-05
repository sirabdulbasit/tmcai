/**
 * System Capabilities — Brain's self-knowledge about WHAT IT CAN ACTUALLY DO
 * in the current tenant. Without this, Brain bluffs ("I don't have connectors")
 * or over-claims ("I read all your emails") when neither matches reality.
 *
 * Compiled fresh on every query (cached 60s) from:
 *   - user_connectors (what OAuth is actually live for this user)
 *   - system_config (tenant-level FACL Gdrive folder)
 *   - feed_events (what actually landed in the last 30 days)
 *   - wiki_pages (what Brain has already learned)
 */
import prisma from '../../db/prisma';

export interface SystemCapabilities {
  userConnectors: Array<{ slug: string; status: string; lastSyncAt: Date | null }>;
  tenantConnectors: Array<{ slug: string; connected: boolean; folderConfigured: boolean }>;
  feedCounts30d: Record<string, number>;
  wikiStats: {
    orgDocs: number;
    projects: number;
    policies: number;
    senderHistories: number;
    senderTopics: number;
    entities: number;
    gaps: number;
    answers: number;
  };
  /** Current Brain prompt queue state for THIS user. Drives runtime
   *  introspection: when the user asks "what's in my queue?" Brain has
   *  the live numbers without re-querying. */
  promptQueue: {
    queued: number;
    awaitingReplyTitle: string | null;
    awaitingReplySentAt: Date | null;
    sentLast24h: number;
    answeredLast7d: number;
  };
}

const cache = new Map<string, { caps: SystemCapabilities; at: number }>();
const TTL_MS = 60_000;

export async function getSystemCapabilities(clientNumber: string, userId: number): Promise<SystemCapabilities> {
  const key = `${clientNumber}:${userId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.caps;

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [userConnectors, driveFolderRow, feedCounts, wikiCounts, queueStats, awaitingRow] = await Promise.all([
    prisma.userConnector.findMany({
      where: { userId, clientNumber },
      select: {
        status: true, lastSyncAt: true,
        connectorType: { select: { slug: true } },
      },
    }).catch(() => [] as any[]),
    prisma.systemConfig.findUnique({
      where: { clientNumber_key: { clientNumber, key: 'google_drive_folder_id' } },
      select: { value: true },
    }).catch(() => null),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT source_type AS source, COUNT(*)::int AS n
         FROM feed_events
        WHERE client_number = $1 AND user_id = $2 AND created_at >= $3
        GROUP BY source_type`,
      clientNumber, userId, since30d,
    ).catch(() => []),
    // Tenant-shared page types (org_doc, policy, project, decision,
    // pattern) are counted across the whole tenant, not just this user —
    // FACL docs scribed by the admin are visible to every user's Brain.
    // User-scoped types (sender_*, entity, gap, answer) count only this
    // user's rows.
    prisma.$queryRawUnsafe<any[]>(
      `SELECT page_type, COUNT(*)::int AS n FROM wiki_pages
        WHERE client_number = $1
          AND (
            user_id = $2
            OR page_type IN ('org_doc','policy','project','decision','pattern')
          )
          AND status NOT IN ('superseded','deleted')
        GROUP BY page_type`,
      clientNumber, userId,
    ).catch(() => []),
    // Prompt queue snapshot for THIS user. Three counts so Brain can
    // honestly answer questions about its own runtime activity without
    // a separate query.
    prisma.$queryRawUnsafe<Array<{ state: string; n: number }>>(
      `SELECT state, COUNT(*)::int AS n
         FROM brain_prompt_queue
        WHERE user_id = $1
          AND (
            state = 'queued'
            OR state = 'awaiting_reply'
            OR (state = 'answered' AND answered_at >= $2)
            OR (sent_at IS NOT NULL AND sent_at >= $3)
          )
        GROUP BY state`,
      userId, since7d, since24h,
    ).catch(() => []),
    prisma.brainPromptQueue.findFirst({
      where: { userId, state: 'awaiting_reply' },
      select: { question: true, sentAt: true },
    }).catch(() => null),
  ]);

  const userList = userConnectors.map((c: any) => ({
    slug: c.connectorType?.slug ?? 'unknown',
    status: c.status,
    lastSyncAt: c.lastSyncAt,
  }));

  const driveFolderConfigured = !!(driveFolderRow?.value);
  const tenantList: SystemCapabilities['tenantConnectors'] = [
    {
      slug: 'google-drive',
      // If a folder ID exists in system_config, Brain has a FACL binding.
      // "Connected" still requires at least one user connector to auth with;
      // we surface both bits so Brain can distinguish them honestly.
      connected: userList.some((u) => u.slug === 'google' && u.status === 'connected'),
      folderConfigured: driveFolderConfigured,
    },
  ];

  const feedCounts30dObj: Record<string, number> = {};
  for (const row of feedCounts) feedCounts30dObj[row.source] = row.n;

  const typeCount = (t: string) => Number(wikiCounts.find((r: any) => r.page_type === t)?.n ?? 0);

  // queueStats comes back with at most three rows: queued, awaiting_reply,
  // answered. The "sentLast24h" count is approximated by re-querying
  // (cheap; one row at most) — see below.
  const queuedCount = Number((queueStats as any[]).find((r: any) => r.state === 'queued')?.n ?? 0);
  // Note: a single row can match multiple WHERE clauses (e.g. an
  // 'answered' row that was sent in the last 24h). We approximate
  // "answered last 7d" via the answered count and "sent last 24h" via a
  // separate scalar; the OR-join above keeps the query single-trip.
  const answeredLast7d = Number((queueStats as any[]).find((r: any) => r.state === 'answered')?.n ?? 0);
  const sentLast24h = Number(
    (await prisma.brainPromptQueue.count({
      where: { userId, sentAt: { gte: since24h } },
    }).catch(() => 0)) ?? 0,
  );

  const caps: SystemCapabilities = {
    userConnectors: userList,
    tenantConnectors: tenantList,
    feedCounts30d: feedCounts30dObj,
    wikiStats: {
      orgDocs: typeCount('org_doc'),
      projects: typeCount('project'),
      policies: typeCount('policy'),
      senderHistories: typeCount('sender_history'),
      senderTopics: typeCount('sender_topic'),
      entities: typeCount('entity'),
      gaps: typeCount('gap'),
      answers: typeCount('answer'),
    },
    promptQueue: {
      queued: queuedCount,
      awaitingReplyTitle: awaitingRow ? clipQuestion(awaitingRow.question) : null,
      awaitingReplySentAt: awaitingRow?.sentAt ?? null,
      sentLast24h,
      answeredLast7d,
    },
  };

  cache.set(key, { caps, at: Date.now() });
  return caps;
}

/** Render capabilities as a compact markdown block for LLM prompts. */
export function renderCapabilitiesBlock(caps: SystemCapabilities): string {
  const lines: string[] = [];
  lines.push('## What I can actually access right now');

  if (caps.userConnectors.length === 0) {
    lines.push('- No user connectors are active. I cannot read mail, calendar, chat, or tasks directly yet.');
  } else {
    const connected = caps.userConnectors.filter((c) => c.status === 'connected').map((c) => c.slug);
    const notConnected = caps.userConnectors.filter((c) => c.status !== 'connected').map((c) => `${c.slug} (${c.status})`);
    if (connected.length) lines.push(`- User connectors connected: ${connected.join(', ')}`);
    if (notConnected.length) lines.push(`- User connectors not connected: ${notConnected.join(', ')}`);
  }

  const gdrive = caps.tenantConnectors.find((t) => t.slug === 'google-drive');
  if (gdrive) {
    if (gdrive.connected && gdrive.folderConfigured) {
      lines.push('- Tenant FACL Google Drive: connected, folder configured — I have scribed org docs from it.');
    } else if (gdrive.folderConfigured && !gdrive.connected) {
      lines.push('- Tenant FACL Google Drive: folder configured but admin auth missing.');
    } else if (!gdrive.folderConfigured) {
      lines.push('- Tenant FACL Google Drive: not configured.');
    }
  }

  const f = caps.feedCounts30d;
  const feedBits: string[] = [];
  if (f.gmail) feedBits.push(`${f.gmail} emails`);
  if (f.whatsapp) feedBits.push(`${f.whatsapp} WhatsApp messages`);
  if (f.calendar) feedBits.push(`${f.calendar} calendar events`);
  if (f.tasks) feedBits.push(`${f.tasks} tasks`);
  if (feedBits.length) {
    lines.push(`- Feed I have processed in the last 30 days: ${feedBits.join(', ')}.`);
  } else {
    lines.push('- No feed events processed in the last 30 days.');
  }

  const w = caps.wikiStats;
  const wikiBits: string[] = [];
  if (w.orgDocs) wikiBits.push(`${w.orgDocs} FACL org docs`);
  if (w.projects) wikiBits.push(`${w.projects} project pages`);
  if (w.policies) wikiBits.push(`${w.policies} policy pages`);
  if (w.entities) wikiBits.push(`${w.entities} entity pages`);
  if (w.senderHistories) wikiBits.push(`${w.senderHistories} sender histories`);
  if (w.senderTopics) wikiBits.push(`${w.senderTopics} sender-topic pages`);
  if (w.answers) wikiBits.push(`${w.answers} prior answer pages`);
  if (w.gaps) wikiBits.push(`${w.gaps} known gaps`);
  if (wikiBits.length) {
    lines.push(`- Wiki I have built: ${wikiBits.join(', ')}.`);
  }

  // Prompt queue runtime — what Brain is currently asking the user, and
  // what it has been doing in the last day/week. Lets Brain answer "what's
  // in my queue?" / "what did you ping me about today?" honestly.
  const q = caps.promptQueue;
  if (q && (q.queued > 0 || q.awaitingReplyTitle || q.sentLast24h > 0 || q.answeredLast7d > 0)) {
    lines.push('');
    lines.push('## What I am currently asking you');
    if (q.awaitingReplyTitle) {
      const ageMin = q.awaitingReplySentAt
        ? Math.round((Date.now() - new Date(q.awaitingReplySentAt).getTime()) / 60000)
        : null;
      lines.push(`- Awaiting your reply: "${q.awaitingReplyTitle}"${ageMin !== null ? ` (sent ${ageMin}m ago)` : ''}`);
    }
    if (q.queued > 0) lines.push(`- ${q.queued} more prompt${q.queued === 1 ? '' : 's'} queued behind it.`);
    if (q.sentLast24h > 0) lines.push(`- ${q.sentLast24h} prompt${q.sentLast24h === 1 ? '' : 's'} sent to you in the last 24h.`);
    if (q.answeredLast7d > 0) lines.push(`- You answered ${q.answeredLast7d} prompt${q.answeredLast7d === 1 ? '' : 's'} in the last 7 days.`);
  }

  lines.push('');
  lines.push('Rules based on this:');
  lines.push('- Do not claim to "read all emails continuously" — you know what you have scribed. Say it that way.');
  lines.push('- Do not deny capabilities that are ACTIVE above.');
  lines.push('- If the user asks about a connector that is not ACTIVE above, tell them plainly it is not connected.');
  lines.push('- If the user asks "what\'s in my queue?" or "what did you ping me about?", answer from the runtime numbers above.');
  return lines.join('\n');
}

function clipQuestion(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
}
