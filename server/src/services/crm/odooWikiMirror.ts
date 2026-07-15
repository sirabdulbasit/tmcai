/**
 * CRM mirror — Odoo → MyOS wiki.
 *
 * The Brain's criticality engine reads "deal value at risk" from wiki pages
 * (cascade dimension, signal #6). Until now those pages were only populated
 * if a user manually wrote them — meaning the engine missed every signal
 * driven by an open opportunity that wasn't surfaced via email/chat. This
 * service mirrors the live Odoo state into wiki_pages on a nightly cron so
 * the engine always has fresh context.
 *
 * What we mirror:
 *   - Active opportunities (crm.lead with type='opportunity', stage not
 *     in ['Won','Lost']) → page_type='project', one page per opportunity.
 *   - Key partners (res.partner where is_company=True OR has open opps)
 *     → page_type='entity'.
 *
 * Idempotency:
 *   - Page id = `odoo:opportunity:<id>` / `odoo:partner:<id>`. Re-running
 *     overwrites in place; stable identifiers prevent dup creation.
 *   - We compare a signature (stage|expected_revenue|probability|write_date)
 *     before writing to skip unchanged rows.
 *
 * Tenant scoping: each tenant has its own Odoo connection (configured via
 * SystemConfig `odoo_*` keys). We mirror per-tenant only — we do NOT pull
 * other tenants' Odoo data. The wiki rows are written under a sentinel
 * "system" user whose pages are tenant-shared (page_type 'project' and
 * 'entity' are read by every user in the tenant per wikiEmbeddingService
 * tenant-shared rules).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import * as Odoo from '../connectors/OdooConnector';
import { embedWikiPage } from '../knowledge/wikiEmbeddingService';

const log = createLogger('odoo-wiki-mirror');

// Page IDs we control. Stable so re-runs are idempotent.
const opportunityPageId = (oppId: number) => `odoo:opportunity:${oppId}`;
const partnerPageId = (partnerId: number) => `odoo:partner:${partnerId}`;

interface OdooOpportunity {
  id: number;
  name?: string;
  partner_id?: [number, string] | false;
  contact_name?: string | false;
  email_from?: string | false;
  phone?: string | false;
  expected_revenue?: number;
  probability?: number;
  stage_id?: [number, string] | false;
  user_id?: [number, string] | false;
  description?: string | false;
  write_date?: string;
  date_deadline?: string | false;
}

interface OdooPartner {
  id: number;
  name?: string;
  is_company?: boolean;
  email?: string | false;
  phone?: string | false;
  city?: string | false;
  country_id?: [number, string] | false;
  category_id?: number[];
  write_date?: string;
}

export interface MirrorResult {
  opportunitiesScanned: number;
  opportunitiesWritten: number;
  partnersScanned: number;
  partnersWritten: number;
  errors: number;
}

/**
 * Mirror one tenant. Pulls active opportunities + their related partners
 * and writes/updates wiki pages.
 */
export async function mirrorOdooForTenant(clientNumber: string): Promise<MirrorResult> {
  const result: MirrorResult = {
    opportunitiesScanned: 0,
    opportunitiesWritten: 0,
    partnersScanned: 0,
    partnersWritten: 0,
    errors: 0,
  };

  // Pick the system actor: the first active user in this tenant. This is
  // who the wiki page lists as `user_id` so multi-tenant isolation works
  // — page_type='project'/'entity' are tenant-shared so all users still
  // read them. If the tenant has zero users we skip.
  const sysRows = await prisma.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE ORDER BY id ASC LIMIT 1`,
    clientNumber,
  );
  const systemUserId = sysRows[0]?.id;
  if (!systemUserId) {
    log.warn('No active users — skipping mirror', { clientNumber });
    return result;
  }

  // ── Opportunities ─────────────────────────────────────────────
  let opps: OdooOpportunity[] = [];
  try {
    opps = await Odoo.searchRead<OdooOpportunity>(
      clientNumber,
      'crm.lead',
      [['type', '=', 'opportunity'], ['probability', '<', 100], ['active', '=', true]],
      ['id', 'name', 'partner_id', 'contact_name', 'email_from', 'phone',
        'expected_revenue', 'probability', 'stage_id', 'user_id',
        'description', 'write_date', 'date_deadline'],
      { limit: 500, order: 'write_date desc' },
    );
  } catch (err: any) {
    log.error('Odoo opportunities fetch failed', { clientNumber, error: err.message });
    result.errors += 1;
    return result;
  }

  for (const o of opps) {
    result.opportunitiesScanned += 1;
    try {
      const wrote = await mirrorOpportunity(clientNumber, systemUserId, o);
      if (wrote) result.opportunitiesWritten += 1;
    } catch (err: any) {
      log.warn('opportunity mirror failed', { clientNumber, oppId: o.id, error: err.message });
      result.errors += 1;
    }
  }

  // ── Partners (companies attached to active opps) ─────────────
  const partnerIds = Array.from(new Set(
    opps.map((o) => Array.isArray(o.partner_id) ? o.partner_id[0] : null).filter((v): v is number => v != null),
  ));

  if (partnerIds.length > 0) {
    let partners: OdooPartner[] = [];
    try {
      partners = await Odoo.searchRead<OdooPartner>(
        clientNumber,
        'res.partner',
        [['id', 'in', partnerIds]],
        ['id', 'name', 'is_company', 'email', 'phone', 'city', 'country_id', 'category_id', 'write_date'],
        { limit: partnerIds.length },
      );
    } catch (err: any) {
      log.warn('Odoo partners fetch failed', { clientNumber, error: err.message });
      result.errors += 1;
    }

    for (const p of partners) {
      result.partnersScanned += 1;
      try {
        const wrote = await mirrorPartner(clientNumber, systemUserId, p);
        if (wrote) result.partnersWritten += 1;
      } catch (err: any) {
        log.warn('partner mirror failed', { clientNumber, partnerId: p.id, error: err.message });
        result.errors += 1;
      }
    }
  }

  log.info('odoo wiki mirror', { clientNumber, ...result });
  return result;
}

/**
 * Mirror all tenants that have an Odoo connector configured.
 * Called from the nightly cron in schedulerService.
 */
export async function mirrorOdooForAllTenants(): Promise<{ tenants: number; result: MirrorResult }> {
  const agg: MirrorResult = { opportunitiesScanned: 0, opportunitiesWritten: 0, partnersScanned: 0, partnersWritten: 0, errors: 0 };
  const tenants = await prisma.$queryRawUnsafe<Array<{ client_number: string }>>(
    `SELECT DISTINCT client_number FROM system_config WHERE config_key = 'odoo_url' AND config_value IS NOT NULL AND config_value <> ''`,
  );
  for (const t of tenants) {
    try {
      const r = await mirrorOdooForTenant(t.client_number);
      agg.opportunitiesScanned += r.opportunitiesScanned;
      agg.opportunitiesWritten += r.opportunitiesWritten;
      agg.partnersScanned += r.partnersScanned;
      agg.partnersWritten += r.partnersWritten;
      agg.errors += r.errors;
    } catch (err: any) {
      log.error('tenant mirror failed', { clientNumber: t.client_number, error: err.message });
      agg.errors += 1;
    }
  }
  return { tenants: tenants.length, result: agg };
}

// ─── helpers ──────────────────────────────────────────────────────

/** Stable hash of the fields that drive criticality so we can skip noop writes. */
function opportunitySignature(o: OdooOpportunity): string {
  const stage = Array.isArray(o.stage_id) ? o.stage_id[1] : '';
  return `${stage}|${o.expected_revenue ?? 0}|${o.probability ?? 0}|${o.date_deadline || ''}|${o.write_date || ''}`;
}

function partnerSignature(p: OdooPartner): string {
  return `${p.is_company ? '1' : '0'}|${p.email || ''}|${p.phone || ''}|${p.write_date || ''}`;
}

async function mirrorOpportunity(
  clientNumber: string,
  systemUserId: number,
  o: OdooOpportunity,
): Promise<boolean> {
  const id = opportunityPageId(o.id);
  const stageName = Array.isArray(o.stage_id) ? o.stage_id[1] : 'Unknown';
  const partnerName = Array.isArray(o.partner_id) ? o.partner_id[1] : (o.contact_name || 'Unknown');
  const ownerName = Array.isArray(o.user_id) ? o.user_id[1] : 'Unassigned';
  const sig = opportunitySignature(o);

  // Skip if signature unchanged
  const existing = await prisma.$queryRawUnsafe<Array<{ metadata: any }>>(
    `SELECT metadata FROM wiki_pages WHERE id = $1`,
    id,
  );
  const prevSig = existing[0]?.metadata?.odoo_signature;
  if (prevSig === sig) return false;

  const title = o.name || `Opportunity #${o.id}`;
  const body = [
    `# ${title}`,
    '',
    `**Source:** Odoo CRM (mirrored)`,
    `**Stage:** ${stageName}`,
    `**Owner:** ${ownerName}`,
    `**Partner:** ${partnerName}`,
    o.expected_revenue ? `**Expected revenue:** ${o.expected_revenue}` : null,
    o.probability != null ? `**Probability:** ${o.probability}%` : null,
    o.date_deadline ? `**Deadline:** ${o.date_deadline}` : null,
    o.email_from ? `**Email:** ${o.email_from}` : null,
    o.phone ? `**Phone:** ${o.phone}` : null,
    '',
    o.description ? `## Notes\n\n${stripHtml(o.description)}` : '',
  ].filter(Boolean).join('\n');

  await prisma.$executeRawUnsafe(
    `INSERT INTO wiki_pages
       (id, client_number, user_id, page_type, title, storage, body_markdown,
        status, confidence, metadata, last_updated_by, last_updated_at, created_at)
     VALUES ($1, $2, $3, 'project', $4, 'postgres', $5, 'active', 0.95, $6::jsonb, 'odoo_mirror', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title,
           body_markdown = EXCLUDED.body_markdown,
           metadata = EXCLUDED.metadata,
           last_updated_by = 'odoo_mirror',
           last_updated_at = NOW()`,
    id, clientNumber, systemUserId, title, body,
    JSON.stringify({
      odoo_model: 'crm.lead',
      odoo_id: o.id,
      odoo_stage: stageName,
      odoo_signature: sig,
      expected_revenue: o.expected_revenue ?? 0,
      probability: o.probability ?? 0,
      partner_id: Array.isArray(o.partner_id) ? o.partner_id[0] : null,
      partner_name: partnerName,
      deadline: o.date_deadline || null,
    }),
  );

  // Re-embed so vector retrieval picks up the change.
  embedWikiPage(id).catch(() => {});
  return true;
}

async function mirrorPartner(
  clientNumber: string,
  systemUserId: number,
  p: OdooPartner,
): Promise<boolean> {
  const id = partnerPageId(p.id);
  const sig = partnerSignature(p);
  const existing = await prisma.$queryRawUnsafe<Array<{ metadata: any }>>(
    `SELECT metadata FROM wiki_pages WHERE id = $1`,
    id,
  );
  const prevSig = existing[0]?.metadata?.odoo_signature;
  if (prevSig === sig) return false;

  const title = p.name || `Partner #${p.id}`;
  const country = Array.isArray(p.country_id) ? p.country_id[1] : '';
  const body = [
    `# ${title}`,
    '',
    `**Source:** Odoo CRM (mirrored)`,
    p.is_company ? `**Type:** Company` : `**Type:** Contact`,
    p.email ? `**Email:** ${p.email}` : null,
    p.phone ? `**Phone:** ${p.phone}` : null,
    p.city || country ? `**Location:** ${[p.city, country].filter(Boolean).join(', ')}` : null,
  ].filter(Boolean).join('\n');

  await prisma.$executeRawUnsafe(
    `INSERT INTO wiki_pages
       (id, client_number, user_id, page_type, title, storage, body_markdown,
        status, confidence, metadata, last_updated_by, last_updated_at, created_at)
     VALUES ($1, $2, $3, 'entity', $4, 'postgres', $5, 'active', 0.95, $6::jsonb, 'odoo_mirror', NOW(), NOW())
     ON CONFLICT (id) DO UPDATE
       SET title = EXCLUDED.title,
           body_markdown = EXCLUDED.body_markdown,
           metadata = EXCLUDED.metadata,
           last_updated_by = 'odoo_mirror',
           last_updated_at = NOW()`,
    id, clientNumber, systemUserId, title, body,
    JSON.stringify({
      odoo_model: 'res.partner',
      odoo_id: p.id,
      is_company: !!p.is_company,
      odoo_signature: sig,
    }),
  );

  embedWikiPage(id).catch(() => {});
  return true;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
