import type { ActionContext, RiskTier } from './riskGatingService';
import prisma from '../../db/prisma';

const HIGH_RISK_ACTIONS = new Set([
  'create_odoo_opportunity',
  'update_odoo_opportunity',
  'freeze_rule',
  'send_email_to_board',
]);

const ALWAYS_LOW_ACTIONS = new Set([
  'snooze',
  'tag_entity',
  'update_memory',
  'update_priority',
  'extract_insight',
  'log_override',
  'close',
  'archive',
  'split_item',
  'merge_items',
  'demote',
  'propose_times',
  'add_attendee',
  'create_task',
  'complete_task',
  'reassign_task',
  'add_subtask',
  'transfer_to_agent',
  'wait_for_approval',
  'parallel_fan_out',
  'request_approval',
]);

interface TenantRiskConfig {
  lowThresholdUsd: number;
  mediumThresholdUsd: number;
  vipEmails: string[];
}

async function loadTenantConfig(clientNumber: string): Promise<TenantRiskConfig> {
  const rows = await prisma.systemConfig.findMany({
    where: {
      clientNumber,
      key: { in: ['risk_low_threshold_usd', 'risk_medium_threshold_usd', 'risk_vip_emails'] },
    },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    lowThresholdUsd: Number(map.risk_low_threshold_usd ?? '1000'),
    mediumThresholdUsd: Number(map.risk_medium_threshold_usd ?? '10000'),
    vipEmails: (map.risk_vip_emails ?? '').split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean),
  };
}

export async function evaluate(ctx: ActionContext): Promise<{ tier: RiskTier; reasons: string[] }> {
  const reasons: string[] = [];

  if (HIGH_RISK_ACTIONS.has(ctx.actionType)) {
    reasons.push(`action type "${ctx.actionType}" is always HIGH risk`);
    return { tier: 'HIGH', reasons };
  }

  if (ALWAYS_LOW_ACTIONS.has(ctx.actionType)) {
    reasons.push(`action type "${ctx.actionType}" is always LOW risk`);
    return { tier: 'LOW', reasons };
  }

  const cfg = await loadTenantConfig(ctx.clientNumber);

  if (typeof ctx.financialValueUsd === 'number') {
    if (ctx.financialValueUsd > cfg.mediumThresholdUsd) {
      reasons.push(`financial value $${ctx.financialValueUsd} exceeds MEDIUM threshold $${cfg.mediumThresholdUsd}`);
      return { tier: 'HIGH', reasons };
    }
    if (ctx.financialValueUsd > cfg.lowThresholdUsd) {
      reasons.push(`financial value $${ctx.financialValueUsd} exceeds LOW threshold $${cfg.lowThresholdUsd}`);
      return { tier: 'MEDIUM', reasons };
    }
  }

  if (ctx.targetIsVip) {
    reasons.push('target is a VIP / key contact');
    return { tier: 'HIGH', reasons };
  }

  if (ctx.targetIsExternal) {
    reasons.push('target is external to the tenant');
    return { tier: 'MEDIUM', reasons };
  }

  reasons.push('default for unclassified action — treat as MEDIUM until rule promoted');
  return { tier: 'MEDIUM', reasons };
}
