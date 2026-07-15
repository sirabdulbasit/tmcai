import * as whatsappService from '../whatsappService';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 30_000, // Meta API can be slow under load
  errorThresholdPercentage: 50,
  volumeThreshold: 3, // spec: 3 failures → OPEN 10 min
  resetTimeout: 10 * 60_000,
};

export const sendWhatsAppMessage = wrap(whatsappService.sendWhatsAppMessage, { ...BREAKER_OPTS, name: 'whatsapp.send' });
export const sendWhatsAppToPhone = wrap(whatsappService.sendWhatsAppToPhone, { ...BREAKER_OPTS, name: 'whatsapp.sendToPhone' });
export const getWhatsAppStatus = wrap(whatsappService.getWhatsAppStatus, { ...BREAKER_OPTS, name: 'whatsapp.status' });
export const processInboundMessage = wrap(whatsappService.processInboundMessage, { ...BREAKER_OPTS, name: 'whatsapp.inbound' });
