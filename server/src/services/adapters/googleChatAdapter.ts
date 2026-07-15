import * as gchat from '../connectors/GoogleChatConnector';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 15_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 60_000,
};

export const sendMessage = wrap(gchat.sendMessage, { ...BREAKER_OPTS, name: 'gchat.sendMessage' });
export const getSpaceInfo = wrap(gchat.getSpaceInfo, { ...BREAKER_OPTS, name: 'gchat.getSpaceInfo' });
export const handleInboundEvent = gchat.handleInboundEvent;
export const healthCheck = gchat.healthCheck;
