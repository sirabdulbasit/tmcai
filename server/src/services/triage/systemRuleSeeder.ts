/**
 * System rule seeder — installs/updates the canonical system rules
 * that ship with MyOS. Runs once at boot (idempotent on rule_key).
 *
 * These cover the boring high-volume patterns every tenant deals with:
 * out-of-office auto-replies, mailer-daemon bounces, GitHub/Jira
 * notification floods, calendar acks, etc. Each one saves an LLM call
 * per matching event — typically 30-60% of inbound volume.
 *
 * Tenants and individual users can DISABLE any system rule via the
 * gate_rule_overrides table, but cannot edit the predicate (otherwise
 * a tenant could silently weaken a global behaviour). To override
 * behaviour, create a higher-priority tenant or user rule.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import type { Predicate } from './ruleEngineService';

const log = createLogger('system-rule-seeder');

interface SeedRule {
  ruleKey: string;
  name: string;
  description: string;
  priority: number;
  predicate: Predicate;
  action: Record<string, unknown>;
}

const SYSTEM_RULES: SeedRule[] = [
  {
    ruleKey: 'system:mailer_daemon',
    name: 'Mailer-Daemon bounces',
    description: 'Automated delivery failure notifications — log & skip, never surface to user.',
    priority: 10,
    predicate: {
      any: [
        { field: 'sender_email', op: 'startsWith', value: 'mailer-daemon@' },
        { field: 'sender_email', op: 'startsWith', value: 'postmaster@' },
        { field: 'subject',      op: 'matches',    value: '(undeliverable|delivery (status notification|failure)|mail delivery failed)' },
      ],
    },
    action: { decision: 'auto_ack', ackNote: 'Email bounce — logged.' },
  },
  {
    ruleKey: 'system:ooo_autoreply',
    name: 'Out-of-office auto-replies',
    description: 'Vacation/OOO bots — log & skip; the user already knows the human is away.',
    priority: 20,
    predicate: {
      any: [
        { field: 'subject', op: 'matches', value: '(out of office|out-of-office|on vacation|on leave|away from (the |my )?desk|automatic reply|auto-?reply)' },
        { field: 'subject', op: 'startsWith', value: 'auto:' },
      ],
    },
    action: { decision: 'auto_ack', ackNote: 'OOO auto-reply — logged.' },
  },
  {
    ruleKey: 'system:github_notification',
    name: 'GitHub notifications',
    description: 'Tag and batch GitHub notification floods so they don\'t overwhelm Open Items.',
    priority: 50,
    predicate: {
      all: [
        { field: 'sender_email', op: 'endsWith', value: '@github.com' },
        { field: 'subject',      op: 'matches',  value: '^(Re: )?\\[' },
      ],
    },
    action: { decision: 'auto_handle', openItemAction: 'tag_and_close', tags: ['github', 'notification'] },
  },
  {
    ruleKey: 'system:jira_notification',
    name: 'Jira/Atlassian notifications',
    description: 'Batch Jira/Atlassian ticket emails.',
    priority: 50,
    predicate: {
      any: [
        { field: 'sender_email', op: 'endsWith', value: '@atlassian.com' },
        { field: 'sender_email', op: 'endsWith', value: '@atlassian.net' },
        { field: 'sender_email', op: 'contains', value: 'noreply@jira' },
      ],
    },
    action: { decision: 'auto_handle', openItemAction: 'tag_and_close', tags: ['jira', 'notification'] },
  },
  {
    ruleKey: 'system:linear_notification',
    name: 'Linear notifications',
    description: 'Batch Linear ticket activity.',
    priority: 50,
    predicate: { all: [{ field: 'sender_email', op: 'endsWith', value: '@linear.app' }] },
    action: { decision: 'auto_handle', openItemAction: 'tag_and_close', tags: ['linear', 'notification'] },
  },
  {
    ruleKey: 'system:slack_digest',
    name: 'Slack digest emails',
    description: 'Slack daily/weekly digest emails — informational, no action needed.',
    priority: 60,
    predicate: {
      all: [
        { field: 'sender_email', op: 'endsWith', value: '@slack.com' },
        { field: 'subject',      op: 'matches',  value: '(daily digest|weekly digest|highlights)' },
      ],
    },
    action: { decision: 'auto_ack', ackNote: 'Slack digest — logged.' },
  },
  {
    ruleKey: 'system:calendar_self_ack',
    name: 'Calendar acceptance acks',
    description: 'Notifications that someone accepted/declined an event you organized — informational.',
    priority: 60,
    predicate: {
      all: [
        { field: 'source_type', op: 'equals',   value: 'gmail' },
        { field: 'subject',     op: 'matches',  value: '^(accepted|declined|tentative): ' },
      ],
    },
    action: { decision: 'auto_ack', ackNote: 'Calendar response logged.' },
  },
  {
    ruleKey: 'system:newsletter_marker',
    name: 'Newsletter / list-unsubscribe',
    description: 'Mass-mailed newsletters detected by common patterns. Tag & close so the inbox stays clean.',
    priority: 80,
    predicate: {
      any: [
        { field: 'sender_email', op: 'startsWith', value: 'newsletter@' },
        { field: 'sender_email', op: 'startsWith', value: 'no-reply@' },
        { field: 'sender_email', op: 'startsWith', value: 'noreply@' },
        { field: 'sender_email', op: 'startsWith', value: 'donotreply@' },
        { field: 'subject',      op: 'matches',    value: '(unsubscribe|view in browser|read online)' },
      ],
    },
    action: { decision: 'auto_handle', openItemAction: 'tag_and_close', tags: ['newsletter'] },
  },
  {
    ruleKey: 'system:calendar_invite_already_handled',
    name: 'Calendar — repeated invite',
    description: 'When the same calendar event arrives twice (re-invite/update), no need to re-triage.',
    priority: 70,
    predicate: {
      all: [
        { field: 'source_type', op: 'in',       value: ['gcal', 'outlook_calendar'] },
        { field: 'event_type',  op: 'equals',   value: 'meeting_updated' },
      ],
    },
    action: { decision: 'auto_ack', ackNote: 'Calendar update — already tracked.' },
  },
  {
    ruleKey: 'system:cc_only_low_priority',
    name: 'CC-only mass mail',
    description: 'You were CC\'d on a mail to many recipients — usually informational. Tag low-priority but still surface.',
    priority: 200,
    predicate: {
      all: [
        { field: 'is_cc_only',     op: 'equals', value: true },
        { field: 'recipient_count', op: 'gt',    value: 10 },
      ],
    },
    action: { decision: 'auto_handle', openItemAction: 'tag', tags: ['fyi', 'cc-only'] },
  },
];

let seeded = false;

/**
 * Idempotently install/update the system rules. Safe to call on every
 * boot. Updates name/description/predicate/action when the rule_key
 * already exists (so rule changes ship with deploys).
 */
export async function seedSystemRules(): Promise<void> {
  if (seeded) return;
  let created = 0, updated = 0;
  for (const r of SYSTEM_RULES) {
    const existing = await prisma.gateRule.findFirst({
      where: { ruleKey: r.ruleKey, scope: 'system' },
      select: { id: true },
    });
    const data = {
      scope: 'system',
      ruleKey: r.ruleKey,
      name: r.name,
      description: r.description,
      predicate: r.predicate as unknown as object,
      action: r.action,
      priority: r.priority,
      enabled: true,
    };
    if (existing) {
      await prisma.gateRule.update({ where: { id: existing.id }, data });
      updated += 1;
    } else {
      await prisma.gateRule.create({ data });
      created += 1;
    }
  }
  seeded = true;
  log.info('system rules seeded', { created, updated, total: SYSTEM_RULES.length });
}
