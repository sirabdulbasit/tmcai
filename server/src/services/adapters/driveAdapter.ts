import * as driveService from '../driveService';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 30_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 5 * 60_000,
};

export const fetchIndexFileContent = wrap(driveService.fetchIndexFileContent, { ...BREAKER_OPTS, name: 'drive.fetchIndex' });
export const handleAuthCallback = wrap(driveService.handleAuthCallback, { ...BREAKER_OPTS, name: 'drive.authCallback' });
