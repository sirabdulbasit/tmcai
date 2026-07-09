// ═════════════════════════════════════════════════════════════════════════════
// domainKnowledgeService.ts — Phase 6: Domain Expert Knowledge Base
//
// PostgreSQL-backed knowledge graph for regulatory and vertical domain knowledge.
// Regions: Pakistan (FBR, SECP, SBP, Labour) + GCC (UAE, KSA, Qatar)
// Verticals: Manufacturing, Petroleum/Energy, Financial Services, Public Sector
//
// Uses recursive CTEs for knowledge graph traversal — no Neo4j needed.
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../db/prisma';
import { embedText } from '../pipeline/embedder';
import { isFeatureEnabled } from './featureFlagService';
import createLogger from '../utils/logger';

const log = createLogger('domainKnowledge');

export type DomainRegion = 'pk' | 'ae' | 'ksa' | 'qa' | 'global';
export type DomainVertical = 'manufacturing' | 'petroleum' | 'financial' | 'public_sector' | 'general';
export type DomainCategory = 'regulatory' | 'industry' | 'procedure' | 'definition';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DomainNode {
  id: number;
  region: DomainRegion;
  vertical: DomainVertical;
  category: DomainCategory;
  title: string;
  content: string;
  parentId: number | null;
  tags: string[];
  source: string | null;
  sourceRef: string | null;
}

// ─── Search domain knowledge ──────────────────────────────────────────────────

export async function searchDomainKnowledge(
  query: string,
  opts: {
    region?: DomainRegion;
    vertical?: DomainVertical;
    topK?: number;
    /** E3/E5 tenant defense-in-depth: the caller's tenant. Rows with
     *  client_number IS NULL are the seeded GLOBAL corpus and always
     *  match; a non-NULL row only matches its own tenant. Pass null
     *  ONLY when the caller genuinely has no tenant context (and say
     *  why at the call site) — that keeps legacy unfiltered behavior. */
    clientNumber?: string | null;
  } = {},
): Promise<Array<{ title: string; content: string; region: string; vertical: string; score: number }>> {
  const enabled = await isFeatureEnabled('GLOBAL', 'feature_knowledge_base', false).catch(() => false);
  if (!enabled) return [];

  const queryEmbedding = await embedText(query).catch(() => null);
  if (!queryEmbedding) return [];

  // Build filters
  const conditions: string[] = [];
  const params: any[] = [query]; // $1 = query text for fallback keyword match
  let pIdx = 2;

  if (opts.region) {
    conditions.push(`region = $${pIdx++}`);
    params.push(opts.region);
  }
  if (opts.vertical) {
    conditions.push(`vertical = $${pIdx++}`);
    params.push(opts.vertical);
  }
  if (opts.clientNumber) {
    // NULL-or-mine, never someone else's. IS NULL comes first so the
    // global seeds survive even if a tenant value is malformed.
    conditions.push(`(client_number IS NULL OR client_number = $${pIdx++})`);
    params.push(opts.clientNumber);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows: any[] = await prisma.$queryRawUnsafe(
    `SELECT id, title, content, region, vertical, embedding FROM domain_knowledge ${whereClause}`,
    ...params.slice(1),
  );

  if (rows.length === 0) return [];

  const topK = opts.topK ?? 5;
  const scored = rows.map(r => {
    const emb: number[] = Array.isArray(r.embedding) ? r.embedding : JSON.parse(r.embedding || '[]');
    return { title: r.title, content: r.content, region: r.region, vertical: r.vertical, score: cosineSim(queryEmbedding, emb) };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, topK).filter(r => r.score > 0.4);
}

function cosineSim(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return magA && magB ? dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 0;
}

// ─── Seed domain knowledge (called once during setup) ─────────────────────────

export async function seedDomainKnowledge(): Promise<void> {
  const enabled = await isFeatureEnabled('GLOBAL', 'feature_knowledge_base', false).catch(() => false);
  if (!enabled) return;

  const existing = await prisma.$queryRawUnsafe(
    'SELECT COUNT(*) as cnt FROM domain_knowledge',
  ).catch(() => [{ cnt: 0 }]) as any[];

  if (Number(existing[0]?.cnt || 0) > 0) {
    log.info('Domain knowledge already seeded');
    return;
  }

  log.info('Seeding domain knowledge...');

  const seeds = [
    // Pakistan regulatory
    {
      region: 'pk', vertical: 'financial', category: 'regulatory',
      title: 'FBR Tax Filing Requirements (Pakistan)',
      content: `Pakistan Federal Board of Revenue (FBR) requires companies to file:
- Monthly Sales Tax Returns (by 18th of each month)
- Income Tax Returns annually (by September 30 for companies)
- Withholding Tax Statements quarterly
- Super Tax applies to large companies with income over PKR 300M
The National Tax Number (NTN) is mandatory for all registered businesses.
Corporate tax rate: 29% for 2025 tax year.`,
      source: 'FBR', tags: ['tax', 'fbr', 'pakistan', 'compliance'],
    },
    {
      region: 'pk', vertical: 'general', category: 'regulatory',
      title: 'SECP Corporate Compliance (Pakistan)',
      content: `Securities and Exchange Commission of Pakistan (SECP) requires:
- Annual filing of Form A (Statement of Assets & Liabilities) within 30 days of AGM
- Audited financial statements filed within 30 days of AGM
- Change in directors notified within 14 days (Form 29)
- Registered companies must maintain 4 statutory registers
Companies Ordinance 1984 governs corporate law in Pakistan.`,
      source: 'SECP', tags: ['secp', 'corporate', 'pakistan', 'compliance'],
    },
    // UAE regulatory
    {
      region: 'ae', vertical: 'general', category: 'regulatory',
      title: 'UAE Corporate Tax (2023)',
      content: `UAE introduced federal corporate tax from June 1, 2023:
- Standard rate: 9% on taxable income above AED 375,000
- 0% on taxable income up to AED 375,000 (SME relief)
- Free Zone businesses may qualify for 0% if meeting substance requirements
- VAT rate: 5% (introduced January 2018)
The Federal Tax Authority (FTA) oversees corporate tax compliance.`,
      source: 'UAE FTA', tags: ['tax', 'uae', 'corporate_tax', 'compliance'],
    },
    {
      region: 'ae', vertical: 'general', category: 'regulatory',
      title: 'UAE Labour Law Key Points',
      content: `UAE Federal Labour Law (Federal Decree-Law No. 33 of 2021):
- End of Service Gratuity: 21 days per year for first 5 years, 30 days/year after
- Annual leave: 30 calendar days after 1 year of service
- Notice period: 30-90 days depending on contract type
- Non-compete clauses: maximum 2 years and must be geographically/industrially limited
- Unlimited contracts abolished — all contracts are limited term (max 3 years, renewable)`,
      source: 'UAE MOHRE', tags: ['labour', 'uae', 'hr', 'compliance'],
    },
    // KSA regulatory
    {
      region: 'ksa', vertical: 'general', category: 'regulatory',
      title: 'Saudi Arabia Vision 2030 Key Programs',
      content: `Saudi Vision 2030 targets:
- Non-oil GDP contribution increase to 65% (from 40%)
- Private sector contribution to GDP: 65% (from 40%)
- Key programs: NEOM, Red Sea Project, Qiddiya, Diriyah Gate
- Saudization (Nitaqat) requirements vary by sector: 10-35% Saudi nationals
- VAT: 15% (increased from 5% in 2020)
- Zakat: 2.5% of net worth for Saudi-owned companies (replaces income tax)`,
      source: 'Vision 2030 Office', tags: ['ksa', 'vision2030', 'compliance', 'saudization'],
    },
    // Qatar regulatory
    {
      region: 'qa', vertical: 'general', category: 'regulatory',
      title: 'Qatar Business Registration & Tax',
      content: `Qatar financial & regulatory overview:
- Corporate tax: 10% on taxable income for foreign-owned companies
- No personal income tax in Qatar
- QFC (Qatar Financial Centre) entities have separate regulations (10% CIT)
- Value Added Tax: Not yet implemented (as of 2025)
- Commercial Registration mandatory from Ministry of Commerce
- Foreign companies typically require a Qatari sponsor (49% local ownership) unless in QFC/QEZ`,
      source: 'MOCI Qatar', tags: ['qatar', 'tax', 'business', 'compliance'],
    },
  ];

  for (const seed of seeds) {
    const embedding = await embedText(`${seed.title}\n\n${seed.content}`).catch(() => []);
    // E3/E5: client_number is deliberately OMITTED (stays NULL). This
    // seeder is the only writer to domain_knowledge today and its rows
    // are global regulatory/vertical knowledge shared by every tenant —
    // NULL = global is the intended tag, not missing tenant context.
    // Any FUTURE tenant-specific knowledge writer must set client_number
    // explicitly to the owning tenant.
    await prisma.$executeRawUnsafe(
      `INSERT INTO domain_knowledge (region, vertical, category, title, content, tags, source, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT DO NOTHING`,
      seed.region, seed.vertical, seed.category, seed.title, seed.content,
      seed.tags, seed.source, JSON.stringify(embedding),
    );
  }

  log.info('Domain knowledge seeded', { count: seeds.length });
}
