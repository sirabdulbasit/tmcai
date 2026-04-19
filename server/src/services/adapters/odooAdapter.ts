import * as odoo from '../connectors/OdooConnector';
import { wrap } from '../../utils/circuitBreaker';

const BREAKER_OPTS = {
  timeout: 30_000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  resetTimeout: 2 * 60_000, // Odoo on-prem can be slow to recover
};

export const createLead = wrap(odoo.createLead, { ...BREAKER_OPTS, name: 'odoo.createLead' });
export const createOpportunity = wrap(odoo.createOpportunity, { ...BREAKER_OPTS, name: 'odoo.createOpportunity' });
export const updateOpportunity = wrap(odoo.updateOpportunity, { ...BREAKER_OPTS, name: 'odoo.updateOpportunity' });
export const updatePartner = wrap(odoo.updatePartner, { ...BREAKER_OPTS, name: 'odoo.updatePartner' });
export const readRecord = wrap(odoo.readRecord, { ...BREAKER_OPTS, name: 'odoo.readRecord' });
export const healthCheck = odoo.healthCheck; // already handles errors internally
