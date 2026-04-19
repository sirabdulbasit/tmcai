export const V15_FLAGS = {
  ADK_AGENTS: 'feature_adk_agents',
  KILL_SWITCH: 'feature_kill_switch',
  SHADOW_SCORING: 'feature_shadow_scoring',
  STEERING_WHEEL: 'feature_steering_wheel',
  PUBSUB: 'feature_pubsub',
  BQ_ARCHIVE: 'feature_bq_archive',
  RISK_GATING: 'feature_risk_gating',
  REDIS_IDEMPOTENCY: 'feature_redis_idempotency',
  CASCADING_UNDO: 'feature_cascading_undo',
  FEED_INGESTION_PUBSUB: 'feature_feed_ingestion_pubsub',
} as const;

export type V15Flag = typeof V15_FLAGS[keyof typeof V15_FLAGS];
