import { Intent, buildIntentDirective } from '../../services/intentService';
import { TierSettings } from '../../services/tierService';
import { buildSystemPrompt } from '../../services/promptService';
import { getDataSummary, getDataLastUpdated } from '../../services/indexCacheService';
import { getDataSummaryFromBQ } from '../../connectors/BigQueryConnector';
import { getConfig } from '../../services/configService';
import { buildContextBlock } from '../../services/userContextService';

// ── Confidence Thresholds ──────────────────────────────────────
const LOW_CONFIDENCE_THRESHOLD = 0.4;

/**
 * Build the full system prompt for the main LLM call.
 * Assembles: profile, memory, learning, history, intent directive, data summary, tier restrictions, brevity.
 */
export async function buildFullPrompt(params: {
  context: string;
  topScore: number;
  intent: Intent;
  tierSettings: TierSettings | null;
  userProfile: any;
  userLearnings: any[];
  memoryBlocks: { userMemoryBlock: string; aiMemoryBlock: string; contextBlock: string; aiName: string };
  chatHistory: any[];
  message: string;
  provider: string;
  clientNumber: string | undefined;
  userId?: number;
  isWidget: boolean;
  isDashboardQuery: boolean;
  aiConfig: { contextLimitFast: number; contextLimitFull: number; maxOutputTokensWidget: number; maxOutputTokensQuick: number; maxOutputTokensText: number };
}): Promise<{ systemPrompt: string; conversationTurns: { role: 'user' | 'assistant'; content: string }[] }> {
  const {
    context, topScore, intent, tierSettings, userProfile, userLearnings,
    memoryBlocks, chatHistory, message, provider, clientNumber,
    isWidget, isDashboardQuery, aiConfig,
  } = params;
  const { userMemoryBlock, aiMemoryBlock, contextBlock } = memoryBlocks;

  // ── Build user profile directive ───────────────────────
  let profileDirective = '';
  if (userProfile) {
    const parts: string[] = [];
    if (userProfile.jobDescription) parts.push(`The user's JD: ${userProfile.jobDescription}.`);
    if (userProfile.aboutMe) parts.push(`About the user: ${userProfile.aboutMe}.`);
    if (userProfile.instructions) parts.push(`User's custom instructions: ${userProfile.instructions}`);
    if (parts.length > 0) {
      profileDirective = '── USER PROFILE ──\n' + parts.join('\n') +
        '\nUse this profile to prioritize relevant data and insights. ' +
        'Do NOT address the user by name or title. Do NOT reference their JD text.\n' +
        'ADAPTIVE TONE: Mirror the user\'s communication style. If they write formally, respond formally. ' +
        'If they write casually ("yo", "whats up", slang), respond casually. ' +
        'If they mix languages (Urdu/English), you can too. Match their energy and style naturally.\n\n';
    }
  }

  // ── Learned patterns from behavior ───────────────────
  let learningBlock = '';
  if (userLearnings.length > 0) {
    learningBlock = '── LEARNED PATTERNS ──\n' +
      userLearnings.join('\n') +
      '\nUse these silently.\n── END PATTERNS ──\n\n';
  }

  // ── Build conversation history as multi-turn array ──
  const conversationTurns: { role: 'user' | 'assistant'; content: string }[] = [];
  if (chatHistory.length > 0) {
    chatHistory.slice().reverse().forEach(m => {
      conversationTurns.push({ role: m.role as 'user' | 'assistant', content: m.content });
    });
  }
  const historyBlock = ''; // history now sent as multi-turn contents, not text block

  // Build intent directive
  const intentDirective = buildIntentDirective(intent);

  // Data Summary: use BigQuery live counts when DATA_SOURCE=bigquery, else Drive index
  const dataSource = process.env.DATA_SOURCE || 'drive';
  const dataSummary = dataSource === 'bigquery'
    ? await getDataSummaryFromBQ().catch(() => getDataSummary())
    : getDataSummary();

  // Response length control — tier settings take priority, then system_config fallback
  const tierStyle = tierSettings?.responseStyle || 'moderate';
  const tierMaxWords = tierSettings?.maxResponseWords || 500;

  // Fallback to system_config only if no tier is configured
  const configLength = !tierSettings ? await getConfig(clientNumber || 'TMC-0001', 'response_length').catch(() => 'moderate') : tierStyle;
  const effectiveMaxWords = tierSettings ? tierMaxWords : Number(await getConfig(clientNumber || 'TMC-0001', 'max_response_words').catch(() => '500'));
  const userLength = userProfile?.tonePreference || configLength || 'moderate';

  const lengthRules: Record<string, string> = {
    brief: `Keep response under 150 words. 2-3 sentences max. No headers. Just answer directly.`,
    moderate: `Keep response under ${effectiveMaxWords} words. Use short paragraphs, bullets. Max 2-3 sections.`,
    detailed: `Provide detailed analysis up to ${effectiveMaxWords} words. Include relevant data points and recommendations.`,
    comprehensive: `Provide thorough analysis up to ${effectiveMaxWords} words. Include all relevant data points, sections, and recommendations.`,
  };

  // Tier format restrictions directive
  let tierFormatDirective = '';
  if (tierSettings) {
    const restrictions: string[] = [];
    if (!tierSettings.allowWidgets) restrictions.push('Do NOT generate ```widget or interactive HTML. Use only markdown text and tables.');
    if (!tierSettings.allowCharts) restrictions.push('Do NOT generate ```chart blocks. Describe data in text instead.');
    if (!tierSettings.allowTables) restrictions.push('Do NOT use markdown tables. Present data as bullet lists.');
    if (!tierSettings.allowExport) restrictions.push('Do NOT offer download/export options.');
    if (restrictions.length > 0) {
      tierFormatDirective = '── TIER FORMAT RESTRICTIONS ──\n' + restrictions.join('\n') + '\n── END ──\n\n';
    }
  }

  // Calculate output token budget so AI can self-adjust scope
  const outputBudget = (isDashboardQuery || isWidget) ? aiConfig.maxOutputTokensWidget : intent.type === 'quick_answer' ? aiConfig.maxOutputTokensQuick : aiConfig.maxOutputTokensText;

  let brevityDirective = '';
  if (isDashboardQuery && tierSettings?.allowWidgets !== false) {
    brevityDirective = `── RESPONSE LENGTH ──\nYour output token budget is ~${outputBudget} tokens. Plan accordingly:\n` +
      `- At ${outputBudget} tokens you can render ~10 table rows with stat cards and 2 charts.\n` +
      `- If the data has more rows than you can fit, show TOP 10 by default with a Show filter (Top 5/10/20/All).\n` +
      `- NEVER start rendering HTML you cannot finish. If data is too large, reduce scope BEFORE generating.\n` +
      `- If you cannot populate a stat card with a real number, DO NOT render it. Give a text answer instead.\n── END ──\n\n`;
  } else {
    brevityDirective = `── RESPONSE LENGTH ──\n${lengthRules[userLength as string] || lengthRules.moderate}\n── END ──\n\n`;
  }

  // ── Confidence / Abstention ──────────────────────────────
  let confidenceDirective = '';
  if (topScore > 0 && topScore < LOW_CONFIDENCE_THRESHOLD) {
    confidenceDirective =
      'IMPORTANT: The retrieved data has LOW relevance (confidence: ' + topScore.toFixed(2) + '). ' +
      'Do NOT guess. If data is insufficient, say so clearly.\n\n';
  }

  // ── MyOS User Setup Context (connectors, open items, agents, etc.) ──
  let userSetupBlock = '';
  if (params.userId && params.clientNumber) {
    try {
      userSetupBlock = await buildContextBlock(params.userId, params.clientNumber) + '\n\n';
    } catch {}
  }

  const systemPrompt = profileDirective + aiMemoryBlock + userMemoryBlock + contextBlock + userSetupBlock + learningBlock + historyBlock + confidenceDirective + brevityDirective + tierFormatDirective + dataSummary + intentDirective + buildSystemPrompt(context, getDataLastUpdated());

  return { systemPrompt, conversationTurns };
}
