import { Request, Response, NextFunction } from 'express';

interface PubSubPushBody {
  message: {
    data: string;
    attributes: Record<string, string>;
    messageId: string;
    publishTime: string;
    orderingKey?: string;
  };
  subscription: string;
}

export interface DecodedPubSubMessage<T = unknown> {
  messageId: string;
  publishTime: string;
  orderingKey?: string;
  tenantId: string;
  traceId: string;
  attributes: Record<string, string>;
  payload: T;
}

export function decodePubSubPush<T = unknown>(req: Request): DecodedPubSubMessage<T> | null {
  const body = req.body as PubSubPushBody | undefined;
  if (!body?.message?.data) return null;

  const raw = Buffer.from(body.message.data, 'base64').toString('utf8');
  let payload: T;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  const attrs = body.message.attributes ?? {};
  const tenantId = attrs.tenantId;
  const traceId = attrs.traceId;
  if (!tenantId || !traceId) return null;

  return {
    messageId: body.message.messageId,
    publishTime: body.message.publishTime,
    orderingKey: body.message.orderingKey,
    tenantId,
    traceId,
    attributes: attrs,
    payload,
  };
}

export type PubSubHandler<T> = (msg: DecodedPubSubMessage<T>) => Promise<void>;

export function pubsubSubscriber<T>(handler: PubSubHandler<T>) {
  return async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const decoded = decodePubSubPush<T>(req);
    if (!decoded) {
      res.status(400).json({ error: 'invalid pubsub push message' });
      return;
    }
    try {
      await handler(decoded);
      res.status(204).send();
    } catch (err: any) {
      console.error(
        `[pubsub] handler failed messageId=${decoded.messageId} tenantId=${decoded.tenantId} traceId=${decoded.traceId}:`,
        err.message,
      );
      res.status(500).json({ error: err.message });
    }
  };
}
