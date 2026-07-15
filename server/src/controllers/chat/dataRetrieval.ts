import createLogger from '../../utils/logger';
import { env } from '../../config/env';
import { Intent } from '../../services/intentService';
import { getCachedSections, getDataLastUpdated } from '../../services/indexCacheService';
import { searchIndex } from '../../services/searchService';
import { retrieveFullSections } from '../../pipeline/sectionRetriever';
import { sanitizeRetrievedContent } from '../../pipeline/contentSanitizer';
import { isPIIEnabled } from '../../pipeline/piiService';
import { retrieveContext as retrieveFromGCP } from '../../pipeline/gcpRetrieval';

// Domain keywords for extracting topic from conversation history
const DOMAIN_KEYWORDS: Record<string, string[]> = {
  employees: ['employee', 'staff', 'headcount', 'team', 'department', 'grade', 'hr', 'people', 'workforce'],
  projects: ['project', 'delivery', 'milestone', 'schedule', 'progress', 'behind schedule'],
  deals: ['revenue', 'sales', 'deal', 'invoice', 'billing', 'client revenue'],
  pipeline: ['pipeline', 'opportunit', 'lead', 'prospect'],
  accounts: ['client', 'account', 'customer'],
  competency: ['competenc', 'skill', 'training', 'assessment'],
};

function extractDomainFromHistory(messages: { role: string; content: string }[]): string | null {
  // Scan recent user messages for domain keywords (most recent first)
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const lower = msg.content.toLowerCase();
    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      if (keywords.some(k => lower.includes(k))) return domain;
    }
  }
  return null;
}
import { embedText } from '../../pipeline/embedder';
import { searchPersonalChunks } from '../../services/personalDriveService';
import { isFeatureEnabled } from '../../services/featureFlagService';
import { searchDomainKnowledge } from '../../services/domainKnowledgeService';
import { resolveClientNumberForUser } from '../../services/tenantScope';
import { maskPIICached } from './piiCache';
import { DataRetrievalResult } from './types';
import type { DataSource } from '../../types';

const log = createLogger('chat:data');

// ── Context limits — read from system_config, these are fallbacks ─────────
const FAST_CONTEXT_LIMITS: Record<string, number> = {
  gemini: 60000,
  'gemini-flash': 50000,
  groq: 25000,
  claude: 80000,
  openai: 60000,
  openrouter: 25000,
};
const FULL_CONTEXT_LIMITS: Record<string, number> = {
  gemini: 120000,
  'gemini-flash': 120000,
  groq: 30000,
  claude: 150000,
  openai: 120000,
  openrouter: 20000,
};

/**
 * Retrieve data context from either BigQuery or Drive based on config.
 * Optionally merges personal data (GDrive folder + uploads) when enabled.
 * Returns { context, topScore, piiMapping }.
 */
export async function retrieveData(
  message: string,
  intent: Intent,
  provider: string,
  aiConfig: { contextLimitFast: number; contextLimitFull: number },
  startTime: number,
  onStatus: (text: string) => void,
  isClientDisconnected: () => boolean,
  userId?: number,
  sources?: DataSource[],
  chatHistory?: { role: string; content: string }[],
): Promise<DataRetrievalResult> {
  let context = '';
  let piiMapping: Record<string, string> = {};
  let topScore = 0;

  const dataSource = process.env.DATA_SOURCE || 'drive';

  if (dataSource === 'bigquery') {
    // ── GCP PATH: BigQuery + Vertex AI retrieval ──────────
    onStatus('Querying BigQuery...');
    try {
      // Use intent scope for retrieval — it includes conversation context from the classifier
      // e.g., follow-up "key statistics" after employee query → scope: "employee key statistics"
      const retrievalQuery = intent.scope && intent.scope !== message ? `${intent.scope} ${message}` : message;
      // Extract domain from conversation history for follow-up context
      const domainHint = chatHistory?.length ? extractDomainFromHistory(chatHistory.slice().reverse()) : null;
      log.info('Retrieval query', { original: message, scope: intent.scope, retrievalQuery, domainHint });
      const gcpResult = await retrieveFromGCP(retrievalQuery, domainHint);
      context = gcpResult.context || '';
      topScore = gcpResult.chunkCount > 0 ? 0.9 : 0;
      const t2 = Date.now() - startTime;
      log.info('GCP retrieval', { elapsedMs: t2, chunks: gcpResult.chunkCount, chars: context.length, filters: gcpResult.filters });
    } catch (gcpErr: any) {
      log.error('GCP retrieval failed, falling back to Drive', { error: gcpErr.message });
      context = '';
    }
  }

  if (dataSource === 'drive' || !context) {
    // ── DRIVE PATH: Local section retrieval (original) ────
    if (env.ragEnabled) {
      const sections = getCachedSections();
      const scope = intent.scope || message;
      const isBroad = ['dashboard', 'list', 'export', 'comparison'].includes(intent.type);
      const maxSections = isBroad ? 2 : intent.type === 'quick_answer' ? 1 : 2;
      const maxChars = isBroad
        ? (FULL_CONTEXT_LIMITS[provider] || aiConfig.contextLimitFull)
        : (FAST_CONTEXT_LIMITS[provider] || aiConfig.contextLimitFast);

      onStatus('Loading data...');
      context = await retrieveFullSections(scope, sections, maxSections, maxChars);
      if (isClientDisconnected()) return { context: '', topScore: 0, piiMapping: {} };
      topScore = context.length > 0 ? 0.9 : 0;

      const t2 = Date.now() - startTime;
      log.info('Step 2 (sections)', { elapsedMs: t2, maxSections, chars: context.length, intentType: intent.type });

      // Fallback to TF-IDF if no sections matched
      if (!context) {
        log.info('No sections matched, falling back to TF-IDF');
        context = searchIndex(message, sections);
      }

      // Sanitize
      context = sanitizeRetrievedContent(context);

      // PII masking — disabled for internal company data (all users are authenticated employees)
      if (false && isPIIEnabled()) {
        onStatus('Applying privacy filters...');
        const piiResult = await maskPIICached(context);
        if (isClientDisconnected()) return { context: '', topScore: 0, piiMapping: {} };
        context = piiResult.maskedText;
        piiMapping = piiResult.mapping;

        const t4 = Date.now() - startTime;
        log.info('Step 3 (PII)', { elapsedMs: t4, entities: piiResult.entities.length });
      }
    } else {
      const sections = getCachedSections();
      context = searchIndex(message, sections);
      context = sanitizeRetrievedContent(context);
    }
  }

  // ── E3/E5 tenant defense-in-depth ───────────────────────────
  // retrieveData only receives userId (aiConfig carries context limits,
  // not tenant), so resolve the tenant from the users table ONCE here
  // and thread it into both tenant-aware retrieval layers below. null
  // when there is no userId at all (some agent paths call retrieveData
  // without a user) — those callers genuinely have no tenant context
  // and fall back to the legacy unfiltered behavior.
  const tenantClientNumber = userId
    ? await resolveClientNumberForUser(userId).catch(() => null)
    : null;

  // ── Phase 4: Personal data retrieval (layer weights) ────────
  const personalWeight = intent.layerWeights?.personal ?? 0;
  const includePersonal = personalWeight > 0 ||
    (sources && (sources.includes('personal_drive') || sources.includes('uploads')));
  const personalEnabled = await isFeatureEnabled('GLOBAL', 'ff_personal_gdrive', false)
    .catch(() => false);

  if (includePersonal && personalEnabled && userId) {
    try {
      const queryEmbedding = await embedText(message).catch(() => null);
      if (queryEmbedding) {
        // More personal chunks when personal weight is high
        const personalTopK = personalWeight >= 0.5 ? 5 : 3;
        // Tenant filter (E3/E5): user_id alone is no longer the last
        // line of defense — chunks tagged to another tenant are excluded
        // even if this userId were wrong/stale.
        const personalChunks = await searchPersonalChunks(userId, queryEmbedding, personalTopK, tenantClientNumber);
        if (personalChunks.length > 0) {
          const personalContext = personalChunks
            .map((c, i) => `[Personal File ${i + 1}: ${c.fileName}]\n${c.content}`)
            .join('\n\n---\n\n');
          // When personal weight is dominant, put it first
          if (personalWeight >= 0.5) {
            context = context
              ? `── YOUR PERSONAL FILES ──\n${personalContext}\n\n── COMPANY DATA ──\n${context}`
              : `── YOUR PERSONAL FILES ──\n${personalContext}`;
          } else {
            context = context
              ? `${context}\n\n── YOUR PERSONAL FILES ──\n${personalContext}`
              : `── YOUR PERSONAL FILES ──\n${personalContext}`;
          }
          log.info('Personal chunks merged', { count: personalChunks.length, userId, personalWeight });
        }
      }
    } catch (e: any) {
      log.warn('Personal retrieval failed (non-fatal)', { error: e.message });
    }
  }

  // ── Phase 6: Domain knowledge (regulatory/vertical expertise) ──
  const domainWeight = intent.layerWeights?.domain ?? 0;
  if (domainWeight > 0) {
    try {
      // Tenant filter (E3/E5): global seeds (client_number NULL) always
      // match; tenant-specific knowledge stays inside its tenant.
      const domainResults = await searchDomainKnowledge(message, { topK: 3, clientNumber: tenantClientNumber });
      if (domainResults.length > 0) {
        const domainContext = domainResults
          .map((d, i) => `[Domain Knowledge ${i + 1}: ${d.title} (${d.region}/${d.vertical})]\n${d.content}`)
          .join('\n\n---\n\n');
        context = context
          ? `${context}\n\n── DOMAIN EXPERT KNOWLEDGE ──\n${domainContext}`
          : `── DOMAIN EXPERT KNOWLEDGE ──\n${domainContext}`;
        log.info('Domain knowledge merged', { count: domainResults.length, domainWeight });
      }
    } catch (e: any) {
      log.warn('Domain knowledge retrieval failed (non-fatal)', { error: e.message });
    }
  }

  return { context, topScore, piiMapping };
}
