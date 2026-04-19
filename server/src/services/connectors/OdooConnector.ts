import xmlrpc from 'xmlrpc';
import { getConfig } from '../configService';

/**
 * HaseebOS v15 INT-1 — Odoo CRM connector via XML-RPC.
 *
 * Per-tenant credentials are stored in SystemConfig rows:
 *   odoo_url, odoo_db, odoo_username, odoo_password
 *
 * Methods exposed:
 *   - createLead / updateLead
 *   - createOpportunity / updateOpportunity
 *   - updateRecord (generic partner/lead/opportunity)
 *   - readRecord (for undo — fetch current field values before mutating)
 */

interface OdooConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

async function loadConfig(clientNumber: string): Promise<OdooConfig> {
  const [url, db, username, password] = await Promise.all([
    getConfig(clientNumber, 'odoo_url'),
    getConfig(clientNumber, 'odoo_db'),
    getConfig(clientNumber, 'odoo_username'),
    getConfig(clientNumber, 'odoo_password'),
  ]);
  if (!url || !db || !username || !password) {
    throw new Error('Odoo connector not configured — set odoo_url, odoo_db, odoo_username, odoo_password in tenant config');
  }
  return { url, db, username, password };
}

function callMethod<T>(client: any, method: string, params: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err: Error | null, value: T) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

async function authenticate(config: OdooConfig): Promise<number> {
  const common = xmlrpc.createSecureClient({ url: `${config.url}/xmlrpc/2/common` });
  const uid = await callMethod<number>(common, 'authenticate', [config.db, config.username, config.password, {}]);
  if (!uid) throw new Error('Odoo authentication failed — check credentials');
  return uid;
}

async function executeKw<T>(
  config: OdooConfig,
  uid: number,
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {},
): Promise<T> {
  const object = xmlrpc.createSecureClient({ url: `${config.url}/xmlrpc/2/object` });
  return callMethod<T>(object, 'execute_kw', [
    config.db,
    uid,
    config.password,
    model,
    method,
    args,
    kwargs,
  ]);
}

// ─── High-level operations ─────────────────────────────────────────

export interface LeadInput {
  name: string;
  contactName?: string;
  email?: string;
  phone?: string;
  description?: string;
  partnerId?: number;
  expectedRevenue?: number;
  tags?: string[];
}

export async function createLead(clientNumber: string, input: LeadInput): Promise<number> {
  const config = await loadConfig(clientNumber);
  const uid = await authenticate(config);
  const values: Record<string, unknown> = {
    name: input.name,
    type: 'lead',
    contact_name: input.contactName,
    email_from: input.email,
    phone: input.phone,
    description: input.description,
    partner_id: input.partnerId,
    expected_revenue: input.expectedRevenue,
  };
  return executeKw<number>(config, uid, 'crm.lead', 'create', [values]);
}

export interface OpportunityInput extends LeadInput {
  stage?: string; // 'New' | 'Qualified' | 'Proposition' | 'Won' | 'Lost' (tenant-configurable in Odoo)
  probability?: number; // 0-100
}

export async function createOpportunity(clientNumber: string, input: OpportunityInput): Promise<number> {
  const config = await loadConfig(clientNumber);
  const uid = await authenticate(config);
  const values: Record<string, unknown> = {
    name: input.name,
    type: 'opportunity',
    contact_name: input.contactName,
    email_from: input.email,
    phone: input.phone,
    description: input.description,
    partner_id: input.partnerId,
    expected_revenue: input.expectedRevenue,
    probability: input.probability,
  };
  return executeKw<number>(config, uid, 'crm.lead', 'create', [values]);
}

export async function updateOpportunity(
  clientNumber: string,
  opportunityId: number,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const config = await loadConfig(clientNumber);
  const uid = await authenticate(config);
  return executeKw<boolean>(config, uid, 'crm.lead', 'write', [[opportunityId], fields]);
}

export async function updatePartner(
  clientNumber: string,
  partnerId: number,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const config = await loadConfig(clientNumber);
  const uid = await authenticate(config);
  return executeKw<boolean>(config, uid, 'res.partner', 'write', [[partnerId], fields]);
}

export async function readRecord<T = Record<string, unknown>>(
  clientNumber: string,
  model: string,
  recordId: number,
  fields: string[],
): Promise<T | null> {
  const config = await loadConfig(clientNumber);
  const uid = await authenticate(config);
  const rows = await executeKw<T[]>(config, uid, model, 'read', [[recordId], fields]);
  return rows[0] ?? null;
}

export async function healthCheck(clientNumber: string): Promise<{ ok: boolean; error?: string; uid?: number }> {
  try {
    const config = await loadConfig(clientNumber);
    const uid = await authenticate(config);
    return { ok: true, uid };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
