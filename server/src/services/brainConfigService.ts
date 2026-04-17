/**
 * MyOS Brain Configuration Service
 *
 * Per-user brain configuration: master context, delegation rules,
 * escalation rules, privacy rules, feed settings, briefing config,
 * alert thresholds, and automation level.
 */

import prisma from '../db/prisma';

// ─── Types ────────────────────────────────────────────────────────

export interface DelegationRule {
  itemType: string;       // email | task | erp | etc.
  route: string;          // delegate | escalate | self
  assigneeName: string;
  assigneeEmail?: string;
  assigneeId?: number;
  channel: string;        // email | chat | whatsapp
  ccSelf: boolean;
}

export interface EscalationRule {
  condition: string;      // "cxo_email" | "financial_above_threshold" | "client_sentiment_negative"
  action: string;         // "handle_personally" | "notify_immediately"
  priority: string;       // critical | high
}

export interface PrivacyRule {
  itemType: string;       // "hr" | "performance" | "salary"
  rule: string;           // "never_delegate" | "never_in_briefer"
}

export interface BriefingConfig {
  sections: string[];     // ["summary", "critical_items", "calendar", "feed_digest", "delegation_followup", "erp_snapshot", "intelligence", "thought_prompts"]
  deliveryTime?: string;  // cron expression
  format: string;         // "detailed" | "summary" | "bullets"
  channel: string;        // "chat" | "email" | "both"
}

export interface AlertThresholds {
  overdueHours: number;           // default 48
  followUpHours: number;          // default 72
  budgetVariancePct: number;      // default 10
  arOverdueDays: number;          // default 60
  revenueAlertPct: number;        // default 85
  cashRunwayDays: number;         // default 30
  okrCriticalPct: number;         // default 50
  okrAtRiskPct: number;           // default 70
  sentimentAlertDays: number;     // default 3
  poApprovalHours: number;        // default 72
}

export type AutomationLevel = 'observe_only' | 'drafts_only' | 'supervised' | 'full_auto';

// ─── Default values ───────────────────────────────────────────────

const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = {
  overdueHours: 48,
  followUpHours: 72,
  budgetVariancePct: 10,
  arOverdueDays: 60,
  revenueAlertPct: 85,
  cashRunwayDays: 30,
  okrCriticalPct: 50,
  okrAtRiskPct: 70,
  sentimentAlertDays: 3,
  poApprovalHours: 72,
};

const DEFAULT_BRIEFING_CONFIG: BriefingConfig = {
  sections: ['summary', 'critical_items', 'calendar', 'feed_digest', 'delegation_followup'],
  format: 'detailed',
  channel: 'chat',
};

// ─── CRUD ─────────────────────────────────────────────────────────

export async function getOrCreate(userId: number, clientNumber: string) {
  const existing = await prisma.brainConfig.findUnique({ where: { userId } });
  if (existing) return existing;

  return prisma.brainConfig.create({
    data: {
      userId,
      clientNumber,
      alertThresholds: DEFAULT_ALERT_THRESHOLDS as any,
      briefingConfig: DEFAULT_BRIEFING_CONFIG as any,
    },
  });
}

export async function get(userId: number) {
  return prisma.brainConfig.findUnique({ where: { userId } });
}

export async function update(userId: number, clientNumber: string, data: {
  masterContext?: string;
  delegationRules?: DelegationRule[];
  escalationRules?: EscalationRule[];
  privacyRules?: PrivacyRule[];
  feedSettings?: Record<string, unknown>;
  briefingConfig?: Partial<BriefingConfig>;
  alertThresholds?: Partial<AlertThresholds>;
  automationLevel?: AutomationLevel;
}) {
  // Merge partial updates into existing config
  const existing = await getOrCreate(userId, clientNumber);

  const mergedAlertThresholds = data.alertThresholds
    ? { ...(existing.alertThresholds as Record<string, unknown>), ...data.alertThresholds }
    : undefined;

  const mergedBriefingConfig = data.briefingConfig
    ? { ...(existing.briefingConfig as Record<string, unknown>), ...data.briefingConfig }
    : undefined;

  const mergedFeedSettings = data.feedSettings
    ? { ...(existing.feedSettings as Record<string, unknown>), ...data.feedSettings }
    : undefined;

  return prisma.brainConfig.update({
    where: { userId },
    data: {
      masterContext: data.masterContext ?? undefined,
      delegationRules: (data.delegationRules as any) ?? undefined,
      escalationRules: (data.escalationRules as any) ?? undefined,
      privacyRules: (data.privacyRules as any) ?? undefined,
      feedSettings: (mergedFeedSettings as any) ?? undefined,
      briefingConfig: (mergedBriefingConfig as any) ?? undefined,
      alertThresholds: (mergedAlertThresholds as any) ?? undefined,
      automationLevel: data.automationLevel ?? undefined,
    },
  });
}

// ─── Getters for specific config sections ─────────────────────────

export async function getDelegationRules(userId: number): Promise<DelegationRule[]> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } });
  return (config?.delegationRules as unknown as DelegationRule[]) || [];
}

export async function getEscalationRules(userId: number): Promise<EscalationRule[]> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } });
  return (config?.escalationRules as unknown as EscalationRule[]) || [];
}

export async function getPrivacyRules(userId: number): Promise<PrivacyRule[]> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } });
  return (config?.privacyRules as unknown as PrivacyRule[]) || [];
}

export async function getAlertThresholds(userId: number): Promise<AlertThresholds> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } });
  return { ...DEFAULT_ALERT_THRESHOLDS, ...(config?.alertThresholds as Partial<AlertThresholds>) };
}

export async function getBriefingConfig(userId: number): Promise<BriefingConfig> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } });
  return { ...DEFAULT_BRIEFING_CONFIG, ...(config?.briefingConfig as Partial<BriefingConfig>) };
}

export async function getAutomationLevel(userId: number): Promise<AutomationLevel> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } });
  return (config?.automationLevel as AutomationLevel) || 'drafts_only';
}

export async function getMasterContext(userId: number): Promise<string> {
  const config = await prisma.brainConfig.findUnique({ where: { userId } });
  return config?.masterContext || '';
}
