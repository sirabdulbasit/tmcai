import { PubSub, Topic } from '@google-cloud/pubsub';
import { PUBSUB_CONFIG, TopicName, PubSubMessageAttributes } from '../../config/pubsub';
import crypto from 'crypto';

let pubsub: PubSub | null = null;
let pubsubDisabled = false;
const topics = new Map<string, Topic>();

function credsAvailable(): boolean {
  if (process.env.PUBSUB_EMULATOR_HOST) return true;
  const path = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) return true; // fall back to default ADC; let the SDK decide
  try {
    return require('fs').existsSync(path);
  } catch {
    return false;
  }
}

function getPubSub(): PubSub {
  if (pubsub) return pubsub;
  if (pubsubDisabled) throw new Error('pubsub disabled — no credentials available');
  if (!credsAvailable()) {
    pubsubDisabled = true;
    throw new Error(`pubsub disabled — GOOGLE_APPLICATION_CREDENTIALS file not found (${process.env.GOOGLE_APPLICATION_CREDENTIALS ?? 'unset'})`);
  }
  pubsub = new PubSub({ projectId: PUBSUB_CONFIG.projectId });
  return pubsub;
}

function getTopic(name: TopicName): Topic {
  const cached = topics.get(name);
  if (cached) return cached;
  const t = getPubSub().topic(name, {
    messageOrdering: true,
  });
  topics.set(name, t);
  return t;
}

export interface PublishOptions {
  tenantId: string;
  traceId?: string;
  orderingKey?: string;
  attributes?: Record<string, string | undefined>;
}

export async function publish<T>(
  topic: TopicName,
  payload: T,
  opts: PublishOptions,
): Promise<string> {
  const traceId = opts.traceId ?? crypto.randomUUID();
  const orderingKey = opts.orderingKey ?? opts.tenantId;

  const attributes: Record<string, string> = {
    tenantId: opts.tenantId,
    traceId,
    publishedAt: new Date().toISOString(),
  };
  if (opts.attributes) {
    for (const [k, v] of Object.entries(opts.attributes)) {
      if (v !== undefined) attributes[k] = v;
    }
  }

  const messageId = await getTopic(topic).publishMessage({
    data: Buffer.from(JSON.stringify(payload)),
    attributes,
    orderingKey,
  });
  return messageId;
}

export function buildAttributes(base: Partial<PubSubMessageAttributes>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = String(v);
  }
  return out;
}

export async function closePubSub(): Promise<void> {
  for (const t of topics.values()) {
    await t.flush();
  }
  topics.clear();
  if (pubsub) {
    await pubsub.close();
    pubsub = null;
  }
}
