/**
 * MyOS User Context Service
 *
 * Builds a snapshot of the user's full setup for injection into the LLM system prompt.
 * Includes: connected connectors, brain config, open items stats, agents, schedules.
 * Cached per user for 2 minutes to avoid DB calls on every message.
 */

import prisma from '../db/prisma';

interface UserContextSnapshot {
  connectors: { slug: string; name: string; category: string; status: string }[];
  openItems: { total: number; critical: number; high: number; delegated: number; overdue: number };
  brainConfig: { hasContext: boolean; automationLevel: string; briefingSections: string[]; hasDelegationRules: boolean };
  agents: { name: string; isActive: boolean; schedule: string | null }[];
  schedules: { title: string; isActive: boolean; cronExpression: string }[];
}

// Cache: userId → { data, timestamp }
//
// WHY 30-SECOND TTL IS THE RIGHT APPROACH:
// - Per-user isolation: User A's cache is separate from User B's. 100 users = 100 entries.
// - No explicit invalidation needed: any setting change appears within 30s automatically.
// - No middleware/hooks to maintain: works with raw SQL tables too (agents, etc.)
// - 5 parallel DB queries take ~30-50ms (warm), so even cache misses are fast.
// - Future-proof: new tables/settings don't need code changes — cache just expires.
// - Memory-safe: LRU cleanup removes inactive users after 10 minutes.
//
const cache = new Map<number, { data: UserContextSnapshot; ts: number }>();
const CACHE_TTL = 30 * 1000; // 30 seconds

// Cleanup inactive users every 10 minutes (prevent memory leak with many users)
setInterval(() => {
  const now = Date.now();
  for (const [userId, entry] of cache) {
    if (now - entry.ts > 10 * 60 * 1000) cache.delete(userId);
  }
}, 10 * 60 * 1000);

export async function getUserContextSnapshot(userId: number, clientNumber: string): Promise<UserContextSnapshot> {
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const [connectors, openItems, brainConfig, agents, schedules] = await Promise.all([
    // Connected connectors
    prisma.userConnector.findMany({
      where: { userId, clientNumber },
      include: { connectorType: true },
    }).then(ucs => ucs.map(uc => ({
      slug: uc.connectorType.slug,
      name: uc.connectorType.name,
      category: uc.connectorType.category,
      status: uc.status,
    }))),

    // Open items stats
    prisma.openItem.findMany({
      where: { userId, clientNumber, status: { not: 'done' } },
      select: { status: true, priority: true },
    }).then(items => ({
      total: items.length,
      critical: items.filter(i => i.priority === 'critical').length,
      high: items.filter(i => i.priority === 'high').length,
      delegated: items.filter(i => i.status === 'delegated').length,
      overdue: items.filter(i => i.status === 'overdue').length,
    })),

    // Brain config
    prisma.brainConfig.findUnique({ where: { userId } }).then(bc => ({
      hasContext: !!(bc?.masterContext),
      automationLevel: bc?.automationLevel || 'drafts_only',
      briefingSections: ((bc?.briefingConfig as any)?.sections as string[]) || [],
      hasDelegationRules: ((bc?.delegationRules as any[]) || []).length > 0,
    })),

    // Agents
    prisma.$queryRawUnsafe(
      `SELECT name, is_active, schedule FROM agents WHERE user_id = $1 AND client_number = $2 ORDER BY is_active DESC, name`,
      userId, clientNumber,
    ).then((rows: any) => (rows as any[]).map((r: any) => ({
      name: r.name,
      isActive: r.is_active,
      schedule: r.schedule,
    }))).catch(() => []),

    // Scheduled tasks
    prisma.scheduledTask.findMany({
      where: { userId, clientNumber },
      select: { title: true, isActive: true, cronExpression: true },
      orderBy: { isActive: 'desc' },
    }),
  ]);

  // Also check org connectors
  const orgConnectors = await prisma.tenantConnectorConfig.findMany({
    where: { clientNumber, scope: 'organizational', isEnabled: true },
    include: { connectorType: true },
  }).then(configs => configs.map(c => ({
    slug: c.connectorType.slug,
    name: c.connectorType.name,
    category: c.connectorType.category,
    status: 'connected',
  }))).catch(() => []);

  const snapshot: UserContextSnapshot = {
    connectors: [...connectors, ...orgConnectors],
    openItems,
    brainConfig,
    agents,
    schedules,
  };

  cache.set(userId, { data: snapshot, ts: Date.now() });
  return snapshot;
}

/**
 * Build a text block for injection into the LLM system prompt.
 */
export async function buildContextBlock(userId: number, clientNumber: string): Promise<string> {
  const ctx = await getUserContextSnapshot(userId, clientNumber);

  const lines: string[] = ['── USER SETUP & CAPABILITIES ──'];

  // Connectors
  const connected = ctx.connectors.filter(c => c.status === 'connected');
  const disconnected = ctx.connectors.filter(c => c.status !== 'connected');
  if (connected.length > 0) {
    lines.push('Connected data sources:');
    connected.forEach(c => lines.push(`  ✓ ${c.name} (${c.category})`));
  }
  if (disconnected.length > 0) {
    lines.push('Configured but not active:');
    disconnected.forEach(c => lines.push(`  ✗ ${c.name} (${c.status})`));
  }
  if (connected.length === 0 && disconnected.length === 0) {
    lines.push('No personal connectors configured. Org data available via BigQuery.');
  }

  // What you can do based on connectors
  const capabilities: string[] = [];
  const slugs = new Set(connected.map(c => c.slug));
  if (slugs.has('gmail') || slugs.has('outlook')) capabilities.push('Read and send emails');
  if (slugs.has('google_calendar') || slugs.has('outlook_calendar')) capabilities.push('View and create calendar events');
  if (slugs.has('google_tasks') || slugs.has('ms_todo') || slugs.has('todoist')) capabilities.push('Read and manage tasks');
  if (slugs.has('whatsapp') || slugs.has('telegram')) capabilities.push('Send messages via ' + (slugs.has('whatsapp') ? 'WhatsApp' : 'Telegram'));
  if (slugs.has('google_drive_personal') || slugs.has('onedrive_personal')) capabilities.push('Access personal drive files');
  // Org capabilities
  if (connected.some(c => c.category === 'data_warehouse')) capabilities.push('Query organizational business data (projects, sales, HR, strategy)');
  if (connected.some(c => c.category === 'erp')) capabilities.push('Access ERP financial data');
  if (connected.some(c => c.category === 'crm')) capabilities.push('Access CRM pipeline data');

  if (capabilities.length > 0) {
    lines.push('You CAN:');
    capabilities.forEach(c => lines.push(`  • ${c}`));
  }

  // Open items
  if (ctx.openItems.total > 0) {
    lines.push(`Open items: ${ctx.openItems.total} total (${ctx.openItems.critical} critical, ${ctx.openItems.high} high, ${ctx.openItems.delegated} delegated, ${ctx.openItems.overdue} overdue)`);
  } else {
    lines.push('Open items: none');
  }

  // Brain config
  if (ctx.brainConfig.hasContext) {
    lines.push('Brain: user has configured their master context');
  }
  if (ctx.brainConfig.hasDelegationRules) {
    lines.push('Delegation rules: configured');
  }

  // Agents
  const activeAgents = ctx.agents.filter(a => a.isActive);
  if (activeAgents.length > 0) {
    lines.push(`Active agents: ${activeAgents.map(a => a.name + (a.schedule ? ` (${a.schedule})` : '')).join(', ')}`);
  }

  // Schedules
  const activeSchedules = ctx.schedules.filter(s => s.isActive);
  if (activeSchedules.length > 0) {
    lines.push(`Scheduled reports: ${activeSchedules.map(s => s.title).join(', ')}`);
  }

  lines.push('── END USER SETUP ──');
  return lines.join('\n');
}

export function invalidateCache(userId: number) {
  cache.delete(userId);
}
