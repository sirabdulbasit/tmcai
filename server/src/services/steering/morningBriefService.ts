/**
 * HaseebOS v15 L4.4 / L4.5 — Morning Brief service.
 *
 * Called from the 06:00 PKT cron in server.ts. Delegates the actual LLM
 * narrative composition to the agent worker's morning_brief ADK agent, but
 * pre-fetches structured data so the agent has concrete inputs.
 *
 * The L4.6 steering-wheel-events publisher fires once per brief with
 * `event: 'morning_brief_composed'`.
 */
import prisma from '../../db/prisma';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';

export interface BriefOutput {
  clientNumber: string;
  userId: number;
  generatedAt: string;
  kpis: { key: string; value: number | string }[];
  topOpenItems: Array<{ id: string; title: string; priority: string | null; status: string; type?: string }>;
  riskItems: Array<{ actionId: number; actionType: string; riskTier: string }>;
  meetingsToday: number;
  patternInsight?: string;
  /** v2 — volume roll-up per channel */
  volume: {
    emailsHandled: number;
    emailsNeedYou: number;
    emailsUrgent: number;
    emailsReceivedToday: number;
    whatsappHandled: number;
    whatsappNeedYou: number;
    meetingsToday: number;
    tasksOpen: number;
    tasksDueToday: number;
  };
  /** v2 — drafts Brain wrote but wasn't confident enough to send */
  drafts: Array<{
    id: number;
    channel: 'email' | 'whatsapp' | 'chat';
    to?: string;
    subject?: string;
    preview?: string;
    body?: string;
    confidence?: number;
    reason?: string;
    createdAt: string;
  }>;
  /** v2 — shadow rules ready for MD to promote */
  rulePromotions: Array<{
    id: string;
    name: string;
    description?: string;
    evidence: number;
    agreement: number;
  }>;
  /** v2 — pattern insights from Reflection agent */
  patterns: Array<{ description: string; ruleDraftId?: string }>;
  /** v2 — structured calendar entries */
  meetings: Array<{
    id: string;
    title: string;
    start: string;
    durationMin?: number;
    attendees?: number;
    external?: boolean;
  }>;
  /** v2 — autonomy score (%% handled without MD input in the past 24h) */
  autonomy: { autonomyPct: number; handledAlone: number; neededUser: number };
}

export async function composeBriefFor(clientNumber: string, userId: number): Promise<BriefOutput> {
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const tomorrow0 = new Date(today0.getTime() + 24 * 60 * 60 * 1000);

  const [kpis, items, risks] = await Promise.all([
    (prisma as any).kpiValue?.findMany?.({
      where: { clientNumber, recordedAt: { gte: today0 } } as any,
      select: { kpiKey: true, value: true },
      orderBy: { recordedAt: 'desc' },
      take: 10,
    }).catch(() => []) ?? [],
    prisma.openItem.findMany({
      where: {
        clientNumber,
        userId,
        status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO'] as any },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 5,
      select: { id: true, title: true, priority: true, status: true },
    }),
    prisma.agentAction.findMany({
      where: { clientNumber, riskTier: 'HIGH', status: 'pending' } as any,
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, actionType: true, riskTier: true },
    }),
  ]);

  // Scope feed counts to THIS user's own connections. A user only sees
  // volume for channels they've personally wired up — otherwise the Brief
  // would show a tenant-mate's inbox.
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { integrationStatus: true, integrationProvider: true },
  });
  const myConnectors = await prisma.userConnector.findMany({
    where: { userId, clientNumber, status: 'connected' },
    include: { connectorType: true },
  });
  const hasGmail =
    (userRow?.integrationProvider === 'google' && userRow.integrationStatus === 'active') ||
    myConnectors.some((c) => c.connectorType.slug === 'gmail');
  // hasWhatsapp is true if either provider is connected: `whatsapp` (Meta
  // Cloud API, tenant-level) or `whatsapp_personal` (QR-paired via
  // whatsapp-web.js, user-level). Both feed feed_events with sourceType='whatsapp'.
  const hasWhatsapp = myConnectors.some((c) => c.connectorType.slug === 'whatsapp' || c.connectorType.slug === 'whatsapp_personal');
  const hasCalendar =
    (userRow?.integrationProvider === 'google' && userRow.integrationStatus === 'active') ||
    myConnectors.some((c) => c.connectorType.slug === 'google_calendar' || c.connectorType.slug === 'outlook_calendar');

  // Count meetings whose *start time* (from the payload) falls in today,
  // not the row's ingest time. Poller pulls events for the next 48h — the
  // row may have been ingested yesterday.
  const meetingsToday = hasCalendar
    ? await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint AS count
         FROM feed_events
         WHERE client_number = $1
           AND user_id = $2
           AND source_type = 'gcal'
           AND (raw_payload->>'start')::timestamptz >= $3
           AND (raw_payload->>'start')::timestamptz <  $4`,
        clientNumber, userId, today0, tomorrow0,
      ).then((r) => Number(r?.[0]?.count ?? 0)).catch(() => 0)
    : 0;

  // ─── v2 aggregates (cheap counters; Brain enriches them over time) ───
  // Headline Email count = total Gmail feed_events Brain has ingested for
  // this user. DB-first read — no Gmail API call. We deliberately do NOT:
  //   - call Gmail API live (token expiry would drop count to 0)
  //   - gate on hasGmail (DB still holds prior ingests when OAuth dies)
  //   - bound to a tight window (local dumps + tenants with stale polling
  //     would always show 0 — defeats the point of going DB-first)
  //
  // The number reflects "what Brain knows about" — total emails it has
  // seen for this user. Matches the source My Attention + Brief draw
  // from, so the 100% accountability math balances. Gmail upstream
  // still feeds feed_events via genericFeedPoller every 2 min; we just
  // stopped reading from Gmail synchronously on every page load.
  const gmailUnreadLive = await prisma.feedEvent.count({
    where: { clientNumber, userId, sourceType: 'gmail' } as any,
  }).catch(() => 0);
  const [emailsReceivedToday, emailsNeedYou, whatsappHandled, whatsappNeedYou, drafts, promotions, handledAlone, neededUser, tasksOpen, tasksDueToday] = await Promise.all([
    hasGmail
      ? prisma.feedEvent.count({ where: { clientNumber, userId, sourceType: 'gmail', createdAt: { gte: today0 } } as any }).catch(() => 0)
      : Promise.resolve(0),
    prisma.openItem.count({ where: { clientNumber, userId, type: 'email', status: { in: ['NEW', 'TRIAGED'] as any } } as any }).catch(() => 0),
    hasWhatsapp
      ? prisma.feedEvent.count({ where: { clientNumber, userId, sourceType: 'whatsapp', createdAt: { gte: today0 } } as any }).catch(() => 0)
      : Promise.resolve(0),
    prisma.openItem.count({ where: { clientNumber, userId, sourceFeed: 'whatsapp', status: { in: ['NEW', 'TRIAGED'] as any } } as any }).catch(() => 0),
    prisma.agentAction.findMany({
      where: { clientNumber, userId, status: 'draft' } as any,
      select: { id: true, actionType: true, input: true, output: true, riskTier: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 15,
    }).catch(() => []),
    // Promotions: SHADOW rules ready for MD review (agreement ≥ 95%, evidence ≥ 10)
    prisma.shadowRule.findMany({
      where: {
        clientNumber,
        mode: 'SHADOW',
        agreement: { gte: 0.95 },
        evidence: { gte: 10 },
        OR: [
          { nextPromotionPromptAt: null },
          { nextPromotionPromptAt: { lte: new Date() } },
        ],
      } as any,
      select: { id: true, name: true, description: true, evidence: true, agreement: true },
      orderBy: [{ agreement: 'desc' }, { evidence: 'desc' }],
      take: 5,
    }).catch(() => []),
    // Autonomy: actions handled without approval in last 24h
    prisma.agentAction.count({ where: { clientNumber, userId, status: 'done', requiresApproval: false, createdAt: { gte: today0 } } as any }).catch(() => 0),
    prisma.agentAction.count({ where: { clientNumber, userId, status: 'done', requiresApproval: true, createdAt: { gte: today0 } } as any }).catch(() => 0),
    // Tasks — open items typed as task, not closed/delegated
    prisma.openItem.count({ where: { clientNumber, userId, type: 'task', status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO'] as any } } as any }).catch(() => 0),
    // Tasks due today — open task items with dueDate = today
    prisma.openItem.count({ where: { clientNumber, userId, type: 'task', status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS'] as any }, dueDate: { gte: today0, lt: tomorrow0 } } as any }).catch(() => 0),
  ]);

  const total = handledAlone + neededUser;
  const autonomyPct = total > 0 ? Math.round((handledAlone / total) * 100) : 0;

  const out: BriefOutput = {
    clientNumber,
    userId,
    generatedAt: new Date().toISOString(),
    kpis: (kpis as any[]).map((k) => ({ key: k.kpiKey, value: k.value })),
    topOpenItems: items as any,
    riskItems: risks.map((r) => ({ actionId: r.id, actionType: r.actionType, riskTier: r.riskTier ?? 'HIGH' })),
    meetingsToday,
    volume: {
      // Headline now = Gmail feed_events Brain has ingested in the last 24h.
      // DB-first read (see comment on `gmailUnreadLive` above): always
      // consistent with what My Attention + Brief draw from. No more
      // silent-zero when an OAuth token blips.
      emailsHandled: gmailUnreadLive,
      emailsNeedYou,
      emailsUrgent: Math.min(emailsNeedYou, risks.length),
      emailsReceivedToday,
      whatsappHandled,
      whatsappNeedYou,
      meetingsToday,
      tasksOpen,
      tasksDueToday,
    },
    drafts: (drafts as any[]).map((d) => {
      const input = (d.input as Record<string, any>) ?? {};
      const channel = d.actionType?.includes('whatsapp') ? 'whatsapp' : d.actionType?.includes('chat') ? 'chat' : 'email';
      return {
        id: d.id,
        channel,
        to: input.to ?? input.recipient ?? input.phone ?? '',
        subject: input.subject ?? input.title,
        preview: (input.body ?? '').toString().slice(0, 160),
        body: input.body,
        confidence: typeof d.output?.confidence === 'number' ? d.output.confidence : undefined,
        reason: d.output?.reason ?? d.output?.held_reason,
        createdAt: d.createdAt.toISOString(),
      };
    }),
    rulePromotions: (promotions as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      evidence: Number(r.evidence ?? 0),
      agreement: Number(r.agreement ?? 0),
    })),
    patterns: await (async () => {
      try {
        const { listFreshInsights } = await import('../reflection/patternInsightService');
        const insights = await listFreshInsights(clientNumber, userId, 5);
        return insights.map((i) => ({ description: i.description, ruleDraftId: i.ruleDraftId ?? undefined }));
      } catch { return []; }
    })(),
    meetings: [], // Calendar adapter populates when wired
    autonomy: { autonomyPct, handledAlone, neededUser },
  };

  try {
    await publish(
      PUBSUB_TOPICS.STEERING_WHEEL_EVENTS,
      { event: 'morning_brief_composed', ...out },
      {
        tenantId: clientNumber,
        orderingKey: `${clientNumber}:brief:${userId}`,
        attributes: { event: 'morning_brief_composed', userId: String(userId) },
      },
    );
  } catch (err: any) {
    console.warn(`[morningBriefService] publish failed ${clientNumber}/${userId}: ${err.message}`);
  }

  return out;
}
