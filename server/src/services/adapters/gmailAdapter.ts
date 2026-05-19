import * as gmailService from '../gmailService';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 15_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 60_000, // 1 min — Gmail transient failures usually clear fast
};

// getInbox can pull up to 500 messages in one call with N parallel
// metadata fetches; 15s is too tight even with chunked Promise.all
// (token refresh + messages.list latency + per-message gets stack up).
// Observed 2026-05-20: every 2-min poll tripped the 15s timeout,
// genericPoll reported ingested=0/errors=1 for hours. 30s gives the
// poller real headroom while still failing fast enough that an actually-
// hung call doesn't block the breaker forever (resetTimeout=60s).
const GET_INBOX_OPTS = { ...BREAKER_OPTS, timeout: 30_000 };

export const getInbox = wrap(gmailService.getInbox, { ...GET_INBOX_OPTS, name: 'gmail.getInbox' });
export const readEmail = wrap(gmailService.readEmail, { ...BREAKER_OPTS, name: 'gmail.readEmail' });
export const sendUserEmail = wrap(gmailService.sendUserEmail, { ...BREAKER_OPTS, name: 'gmail.sendUserEmail' });
export const searchEmails = wrap(gmailService.searchEmails, { ...BREAKER_OPTS, name: 'gmail.searchEmails' });
export const getUnreadCount = wrap(gmailService.getUnreadCount, { ...BREAKER_OPTS, name: 'gmail.getUnreadCount' });
