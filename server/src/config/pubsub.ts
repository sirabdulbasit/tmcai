export const PUBSUB_TOPICS = {
  FEED_RAW: 'tmcai-feed-raw',
  OPENITEMS_SCORED: 'tmcai-openitems-scored',
  ACTIONS_APPROVED: 'tmcai-actions-approved',
  STEERING_SNAPSHOT: 'tmcai-steering-snapshot',
  // HaseebOS v15 4-layer bus contract additions
  OPEN_ITEM_EVENTS: 'tmcai-open-item-events',
  ACTION_EXECUTED_EVENTS: 'tmcai-action-executed-events',
  STEERING_WHEEL_EVENTS: 'tmcai-steering-wheel-events',
  DECISION_RECORDED: 'tmcai-decision-recorded',
} as const;

export const PUBSUB_DLQS = {
  FEED_RAW: 'tmcai-feed-raw-dlq',
  OPENITEMS_SCORED: 'tmcai-openitems-scored-dlq',
  ACTIONS_APPROVED: 'tmcai-actions-approved-dlq',
  STEERING_SNAPSHOT: 'tmcai-steering-snapshot-dlq',
  OPEN_ITEM_EVENTS: 'tmcai-open-item-events-dlq',
  ACTION_EXECUTED_EVENTS: 'tmcai-action-executed-events-dlq',
  STEERING_WHEEL_EVENTS: 'tmcai-steering-wheel-events-dlq',
  DECISION_RECORDED: 'tmcai-decision-recorded-dlq',
} as const;

export const PUBSUB_CONFIG = {
  projectId: process.env.GCP_PROJECT_ID || 'tmcai-491811',
  maxRetries: 5,
  retryBackoffSeconds: [1, 10, 60, 300, 300] as const,
  ackDeadlineSeconds: 60,
  messageRetentionDays: 7,
  dlqRetentionDays: 14,
} as const;

export type TopicName = typeof PUBSUB_TOPICS[keyof typeof PUBSUB_TOPICS];

export interface PubSubMessageAttributes {
  tenantId: string;
  traceId: string;
  sourceType?: string;
  eventType?: string;
  riskTier?: 'LOW' | 'MEDIUM' | 'HIGH';
  [key: string]: string | undefined;
}
