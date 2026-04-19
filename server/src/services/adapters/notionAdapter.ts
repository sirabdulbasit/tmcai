import * as notion from '../connectors/NotionConnector';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 20_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 2 * 60_000,
};

export const pushThought = wrap(notion.pushThought, { ...BREAKER_OPTS, name: 'notion.pushThought' });
export const healthCheck = notion.healthCheck;
