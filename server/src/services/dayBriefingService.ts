/**
 * MyOS Day Briefing Service v2
 *
 * READS ONLY from pre-computed DB data. Zero LLM calls at delivery time.
 * All AI work runs during Brain Engine and stores results in DB.
 * All sections built in parallel via Promise.all(). Target: <5 seconds.
 *
 * Sections:
 *   Header  — greeting, date, engine status, stats
 *   A       — Critical items (top 12 by priorityScore)
 *   B       — Today's calendar
 *   C       — Email digest (classified)
 *   D       — Delegation follow-up (stale items + CEO Intent Summary)
 *   E       — Pattern promotion (Monday only)
 *   F       — Thought prompts
 */

import prisma from '../db/prisma';
import { getBriefingConfig, getAlertThresholds } from './brainConfigService';
import { getAuthenticatedClient } from './integrationService';

// ─── Timeout wrapper — never let one section block the whole brief ─

async function withTimeout<T>(fn: Promise<T>, fallback: T, ms = 4000): Promise<T> {
  return Promise.race([fn, new Promise<T>(r => setTimeout(() => r(fallback), ms))]);
}

// ─── Main assembly ──────────────────────────────────────────────

export async function generateDayBriefing(userId: number, clientNumber: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  if (!user) throw new Error('User not found');

  const brainConfig = await prisma.brainConfig.findUnique({ where: { userId } }) as any;
  const briefingConfig = (brainConfig?.briefingConfig as any) || {};
  const sections = briefingConfig.sections || ['summary', 'critical_items', 'calendar', 'feed_digest', 'delegation_followup', 'thought_prompts'];
  const firstName = user.name.split(' ')[0];

  // Header
  const h = new Date().getHours();
  const timeGreeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Engine freshness
  const lastEngine = brainConfig?.lastEngineRun;
  const engineAgo = lastEngine ? Math.round((Date.now() - new Date(lastEngine).getTime()) / 3_600_000) : null;
  const freshnessWarning = !lastEngine || (engineAgo && engineAgo > 25)
    ? '\n> **Warning:** Engine has not run recently. Data may be stale. Go to My Brain → Engine → Run Now.\n'
    : '';

  const engineStatus = lastEngine
    ? `Last updated: ${engineAgo}h ago`
    : 'Engine not yet run';
  const nextEngine = brainConfig?.nextEngineRun
    ? ` · Next run: ${Math.round((new Date(brainConfig.nextEngineRun).getTime() - Date.now()) / 3_600_000)}h`
    : '';

  // Build all sections in parallel
  const [summary, criticalItems, calendar, emailDigest, delegation, patterns, thoughts] = await Promise.all([
    withTimeout(buildSummary(userId, clientNumber), '**Open Items:** loading failed'),
    sections.includes('critical_items') ? withTimeout(buildCriticalItems(userId, clientNumber), 'Critical items unavailable') : Promise.resolve(''),
    sections.includes('calendar') ? withTimeout(buildCalendar(userId), 'Calendar unavailable') : Promise.resolve(''),
    sections.includes('feed_digest') ? withTimeout(buildEmailDigest(userId), 'Email digest unavailable') : Promise.resolve(''),
    sections.includes('delegation_followup') ? withTimeout(buildDelegationFollowup(userId, clientNumber), 'Delegation section unavailable') : Promise.resolve(''),
    sections.includes('patterns') ? withTimeout(buildPatternPromotion(userId, clientNumber), '') : Promise.resolve(''),
    sections.includes('thought_prompts') ? withTimeout(buildThoughtPrompts(userId, clientNumber), '') : Promise.resolve(''),
  ]);

  // Assemble
  const parts: string[] = [];
  parts.push(`# ${timeGreeting}, ${firstName}`);
  parts.push(`${dayName}  |  ${engineStatus}${nextEngine}`);
  parts.push(freshnessWarning);
  parts.push(summary);

  if (criticalItems) parts.push(`\n---\n\n## A — Critical Items\n\n${criticalItems}`);
  if (calendar) parts.push(`\n---\n\n## B — Today's Calendar\n\n${calendar}`);
  if (emailDigest) parts.push(`\n---\n\n## C — Email Digest\n\n${emailDigest}`);
  if (delegation) parts.push(`\n---\n\n## D — Delegation Follow-up\n\n${delegation}`);
  if (patterns) parts.push(`\n---\n\n## E — Pattern Promotion\n\n${patterns}`);
  if (thoughts) parts.push(`\n---\n\n## F — Thought Prompts\n\n${thoughts}`);

  parts.push(`\n---\n*Generated at ${new Date().toLocaleTimeString()} · Sections configured in My Brain → Briefing*`);

  return parts.filter(Boolean).join('\n');
}

// ─── Section builders (all read from DB, zero LLM) ──────────────

async function buildSummary(userId: number, clientNumber: string): Promise<string> {
  const [items, calCount, emailCount] = await Promise.all([
    prisma.openItem.findMany({
      where: { userId, clientNumber, status: { not: 'done' } },
      select: { priority: true, status: true },
    }),
    getCalendarCount(userId),
    getEmailCount(userId),
  ]);

  const critical = items.filter(i => i.priority === 'critical').length;
  const high = items.filter(i => i.priority === 'high').length;
  const overdue = items.filter(i => i.status === 'overdue').length;

  const badges: string[] = [];
  if (critical > 0) badges.push(`**Critical:** ${critical}`);
  if (high > 0) badges.push(`**High:** ${high}`);
  badges.push(`**Meetings:** ${calCount}`);
  badges.push(`**Emails:** ${emailCount}`);
  if (overdue > 0) badges.push(`**Overdue:** ${overdue}`);

  return badges.join('  ·  ');
}

async function buildCriticalItems(userId: number, clientNumber: string): Promise<string> {
  const items = await prisma.openItem.findMany({
    where: { userId, clientNumber, status: { in: ['open', 'in_progress', 'delegated', 'blocked'] } },
    orderBy: { priorityScore: 'desc' },
    take: 12,
  });

  if (items.length === 0) return 'All clear! No items need attention.';

  // Check for situation blocks (3+ items same entity → 1 block)
  const situationEntityIds = new Set<string>();
  let situationBlocks = '';
  try {
    const { getSituationBlocks } = await import('./situationService');
    const situations = await getSituationBlocks(userId, clientNumber);
    for (const sit of situations) {
      situationEntityIds.add(sit.entityId);
      situationBlocks += `### [SITUATION] ${sit.entityName} — ${sit.itemCount} signals · Score ${sit.topScore?.toFixed(1) || '?'}\n`;
      situationBlocks += `> ${sit.situationBlock}\n\n`;
    }
  } catch {}

  // Individual items (exclude those covered by situation blocks)
  const individualItems = items.filter(i => !i.entityId || !situationEntityIds.has(i.entityId));

  const itemLines = individualItems.map(item => {
    const score = item.priorityScore ? ` · ${item.priorityScore.toFixed(1)}` : '';
    const priority = item.priority === 'critical' ? '🔴' : item.priority === 'high' ? '🟡' : '🔵';
    const due = item.dueDate ? ` · due ${new Date(item.dueDate).toLocaleDateString()}` : '';
    const delegatee = item.delegateeName ? ` → ${item.delegateeName}` : '';
    const source = item.sourceFeed ? ` · ${item.sourceFeed}` : '';
    const meta = (item.metadata as any) || {};
    const erg = meta.propagationNote ? `\n   *ERG: ${meta.propagationNote}*` : '';
    const entityCtx = meta.entityContext ? `\n   ${meta.entityContext}` : '';

    // Show ranked suggestions if generated by engine
    let suggestions = '';
    if (meta.rankedSuggestions && Array.isArray(meta.rankedSuggestions) && meta.rankedSuggestions.length > 0) {
      const top = meta.rankedSuggestions[0];
      suggestions = `\n   **Suggested:** ${top.label}${top.reasoning ? ` — ${top.reasoning}` : ''}`;
      if (top.draft) suggestions += `\n   > "${top.draft.slice(0, 150)}${top.draft.length > 150 ? '...' : ''}"`;
    }

    return `${priority} **${item.title}**${score}${due}${delegatee}${source}${entityCtx}${erg}${suggestions}\n   Status: ${item.status} | Type: ${item.type}`;
  }).join('\n\n');

  return (situationBlocks + itemLines).trim();
}

async function buildCalendar(userId: number): Promise<string> {
  try {
    const { client, error } = await getAuthenticatedClient(userId);
    if (!client || error) return 'Calendar not connected. Connect at /connectors.';

    const { google } = await import('googleapis');
    const cal = google.calendar({ version: 'v3', auth: client });
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const events = await cal.events.list({
      calendarId: 'primary', timeMin: startOfDay.toISOString(), timeMax: endOfDay.toISOString(),
      singleEvents: true, orderBy: 'startTime', maxResults: 15,
    });

    const items = events.data.items || [];
    if (items.length === 0) return 'No meetings today.';

    return items.map(e => {
      const time = e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
        : 'All day';
      const attendees = e.attendees?.length ? ` (${e.attendees.length} attendees)` : '';
      return `**${time}** — ${e.summary || '(no title)'}${attendees}`;
    }).join('\n');
  } catch (err: any) {
    return `Calendar error: ${err.message?.slice(0, 80)}`;
  }
}

async function buildEmailDigest(userId: number): Promise<string> {
  try {
    const { client, error } = await getAuthenticatedClient(userId);
    if (!client || error) return 'Email not connected. Connect at /connectors.';

    const { google } = await import('googleapis');
    const gmail = google.gmail({ version: 'v1', auth: client });

    const today = new Date();
    const todayStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    const list = await gmail.users.messages.list({ userId: 'me', q: `after:${todayStr}`, maxResults: 20 });
    const messages = list.data.messages || [];

    if (messages.length === 0) return 'No new emails today.';

    // Get top 4 details
    const topMsgs = await Promise.all(
      messages.slice(0, 4).map(async m => {
        try {
          const msg = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'metadata', metadataHeaders: ['From', 'Subject'] });
          const headers = msg.data.payload?.headers || [];
          const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
          const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
          const isUnread = msg.data.labelIds?.includes('UNREAD');
          return { from: from.replace(/<.*>/, '').trim(), subject, isUnread };
        } catch { return null; }
      }),
    );

    const valid = topMsgs.filter(Boolean) as { from: string; subject: string; isUnread?: boolean }[];
    const unreadCount = valid.filter(m => m.isUnread).length;

    // Check for classified items in OpenItems (from engine run)
    const classifiedItems = await prisma.openItem.findMany({
      where: { userId, sourceFeed: 'gmail', createdAt: { gte: new Date(today.setHours(0, 0, 0, 0)) } },
      select: { title: true, metadata: true, priority: true },
      take: 4,
    });

    const lines: string[] = [];
    lines.push(`**${messages.length} emails** · ${unreadCount} unread`);

    if (classifiedItems.length > 0) {
      lines.push('');
      classifiedItems.forEach(ci => {
        const meta = (ci.metadata as any) || {};
        const pass = meta.classificationPass ? `pass ${meta.classificationPass}` : '';
        const conf = meta.confidence ? `${(meta.confidence * 100).toFixed(0)}%` : '';
        const intent = meta.intent || ci.priority?.toUpperCase() || '';
        lines.push(`[${intent} · ${pass} · ${conf}] ${ci.title}`);
      });
    } else {
      lines.push('');
      valid.forEach(m => {
        const marker = m.isUnread ? '📩' : '✉️';
        lines.push(`${marker} **${m.from}** — ${m.subject}`);
      });
    }

    if (messages.length > 4) lines.push(`\n...and ${messages.length - 4} more`);

    return lines.join('\n');
  } catch (err: any) {
    return `Email error: ${err.message?.slice(0, 80)}`;
  }
}

async function buildDelegationFollowup(userId: number, clientNumber: string): Promise<string> {
  const thresholds = await getAlertThresholds(userId);
  const staleHours = thresholds.overdueHours || 48;
  const staleDate = new Date(Date.now() - staleHours * 60 * 60 * 1000);

  const staleItems = await prisma.openItem.findMany({
    where: { userId, clientNumber, status: { in: ['open', 'in_progress', 'delegated'] }, updatedAt: { lt: staleDate } },
    orderBy: [{ priorityScore: 'desc' }, { updatedAt: 'asc' }],
    take: 10,
  });

  if (staleItems.length === 0) return 'All delegations on track. No stale items.';

  return staleItems.map(item => {
    const hoursAgo = Math.round((Date.now() - item.updatedAt.getTime()) / 3_600_000);
    const meta = (item.metadata as any) || {};
    const badge = hoursAgo > 72 ? `**${hoursAgo}h stale · AUTO-DELEGATE TRIGGERED**` : `${hoursAgo}h stale`;

    let line = `⚠️ ${badge}\n**${item.title}** (${item.delegateeName || 'unassigned'})`;

    if (meta.ceoIntentSummary) {
      line += `\n> ${meta.ceoIntentSummary}`;
    } else if (hoursAgo > 72) {
      line += `\n*Engine will generate delegation message on next run.*`;
    }

    return line;
  }).join('\n\n');
}

async function buildPatternPromotion(userId: number, clientNumber: string): Promise<string> {
  // Monday only
  if (new Date().getDay() !== 1) return '';

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const patterns = await prisma.thoughtEntry.findMany({
    where: { userId, clientNumber, type: 'pattern_insight', status: 'draft', createdAt: { gte: sevenDaysAgo } },
    take: 3,
  });

  if (patterns.length === 0) return '';

  return patterns.map(p => `💡 **${p.title}**\n${p.content.slice(0, 200)}`).join('\n\n');
}

async function buildThoughtPrompts(userId: number, clientNumber: string): Promise<string> {
  const drafts = await prisma.thoughtEntry.findMany({
    where: { userId, clientNumber, status: 'draft', type: { not: 'pattern_insight' } },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });

  if (drafts.length === 0) return '';

  const lines = drafts.map(d => {
    const typeLabel = d.type === 'weekly_review' ? 'WEEKLY REVIEW' :
      d.type === 'reflection_prompt' ? 'REFLECTION' : d.type.toUpperCase();
    return `💭 **${typeLabel}** — ${d.title}\n${d.content.slice(0, 150)}${d.content.length > 150 ? '...' : ''}\n[Read full at /thoughts]`;
  });

  return lines.join('\n\n');
}

// ─── Helpers ────────────────────────────────────────────────────

async function getCalendarCount(userId: number): Promise<number> {
  try {
    const { client, error } = await getAuthenticatedClient(userId);
    if (!client || error) return 0;
    const { google } = await import('googleapis');
    const cal = google.calendar({ version: 'v3', auth: client });
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const events = await cal.events.list({ calendarId: 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true, maxResults: 50 });
    return events.data.items?.length || 0;
  } catch { return 0; }
}

async function getEmailCount(userId: number): Promise<number> {
  try {
    const { client, error } = await getAuthenticatedClient(userId);
    if (!client || error) return 0;
    const { google } = await import('googleapis');
    const gmail = google.gmail({ version: 'v1', auth: client });
    const today = new Date();
    const todayStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;
    const list = await gmail.users.messages.list({ userId: 'me', q: `after:${todayStr}`, maxResults: 1 });
    return list.data.resultSizeEstimate || 0;
  } catch { return 0; }
}

// ─── Legacy export for chat shortcut compatibility ──────────────

export function formatBriefingAsMarkdown(briefing: any): string {
  // v2 generates markdown directly — this is kept for backward compat
  return typeof briefing === 'string' ? briefing : JSON.stringify(briefing);
}
