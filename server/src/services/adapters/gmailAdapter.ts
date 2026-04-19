import * as gmailService from '../gmailService';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 15_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 60_000, // 1 min — Gmail transient failures usually clear fast
};

export const getInbox = wrap(gmailService.getInbox, { ...BREAKER_OPTS, name: 'gmail.getInbox' });
export const readEmail = wrap(gmailService.readEmail, { ...BREAKER_OPTS, name: 'gmail.readEmail' });
export const sendUserEmail = wrap(gmailService.sendUserEmail, { ...BREAKER_OPTS, name: 'gmail.sendUserEmail' });
export const searchEmails = wrap(gmailService.searchEmails, { ...BREAKER_OPTS, name: 'gmail.searchEmails' });
export const getUnreadCount = wrap(gmailService.getUnreadCount, { ...BREAKER_OPTS, name: 'gmail.getUnreadCount' });
