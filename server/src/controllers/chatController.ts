import { Request, Response } from 'express';
import createLogger from '../utils/logger';

const log = createLogger('chat');
import { ChatRequest } from '../types';
import { getDataLastUpdated } from '../services/indexCacheService';
import { classifyIntent } from '../services/intentService';
import { createConversation, addMessage, getRecentMessages } from '../services/chatHistoryService';
import { getUserProfile } from '../services/userProfileService';
import { buildMemoryPromptBlocks } from '../services/memoryService';
import prisma from '../db/prisma';
import { getUserLearnings } from '../services/learningService';
import { getAIConfig } from '../services/aiConfigService';
import { getUserTier } from '../services/tierService';
import { logError } from '../services/systemLogService';
import { isFeatureEnabled } from '../services/featureFlagService';
import { logQuery } from '../services/auditService';
import { sanitizeOutput } from '../pipeline/outputSanitizer';

import {
  setupSSEHeaders, sendStatus, sendChunkDirect, sendMeta,
  getDedupKey, getCachedResponse, setCachedResponse, setDedupTTL,
  classifyWidgetIntent, retrieveData, handleWidget,
  buildFullPrompt, routeToLLM, postProcess,
  handleMemoryRequest, handleMemoryClear, handleMemoryEdit,
  handleWidgetModify, handleConversational,
} from './chat';
import {
  buildCacheKey, normalizeQueryHash, getCachedResult,
  setCachedResultForClient, getConfiguredTTL,
} from '../services/smartCacheService';

export async function streamChat(req: Request, res: Response) {
  const abortController = new AbortController();
  let clientDisconnected = false;

  req.on('close', () => {
    clientDisconnected = true;
    abortController.abort();
  });

  try {
    // ── 1. Validate request + setup ──────────────────────────
    const { message, provider, conversationId: reqConversationId, sources } = req.body as ChatRequest;
    const aiConfig = await getAIConfig(req.user?.clientNumber);
    setDedupTTL(aiConfig.dedupCacheTtlMs);

    if (!message || !provider) {
      res.status(400).json({ error: 'message and provider are required' });
      return;
    }

    const userId = req.user?.id;
    const clientNumber = req.user?.clientNumber;
    let conversationId = reqConversationId;

    // Validate conversation ownership
    if (conversationId && userId) {
      const conv = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });
      if (!conv) conversationId = undefined;
    }

    const isUtilityQuery = /^(check my emails?|what'?s on my calendar|show my schedule|show my emails)/i.test(message.trim());

    // ── MyOS: Day Briefing shortcut ──────────────────────────
    const isBriefingQuery = /\b(day brief|daily brief|morning brief|my brief|give me.*(brief|briefing)|today'?s brief)/i.test(message.trim());
    if (isBriefingQuery && userId && clientNumber) {
      try {
        const { generateDayBriefing, formatBriefingAsMarkdown } = await import('../services/dayBriefingService');

        // Set up SSE (same format as normal chat)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Show status while loading
        res.write(`data: ${JSON.stringify({ type: 'status', content: 'Preparing your Day Brief...' })}\n\n`);

        const briefing = await generateDayBriefing(userId, clientNumber);
        const markdown = formatBriefingAsMarkdown(briefing);

        // Stream the briefing content
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: markdown })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'meta', elapsed: '0', outputTokens: 0, inputTokens: 0, totalTokens: 0 })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();

        // Save to conversation
        if (conversationId) {
          addMessage({ clientNumber, conversationId, role: 'assistant', content: markdown, provider: 'system' }).catch(() => {});
        }
        return;
      } catch (err: any) {
        console.error('[DayBriefing] Error:', err.message);
        // Fall through to normal chat pipeline
      }
    }

    if (userId && clientNumber && !conversationId && !isUtilityQuery) {
      const conv = await createConversation(clientNumber, userId, provider);
      conversationId = conv.id;
    }
    if (userId && clientNumber && conversationId && !isUtilityQuery) {
      addMessage({ clientNumber, conversationId, role: 'user', content: message }).catch(() => {});
    }

    // ── 2. Cache check (smart cache or legacy dedup) ──────
    const useSmartCache = clientNumber ? await isFeatureEnabled(clientNumber, 'ff_smart_cache', false) : false;

    let cacheKey: string;
    if (useSmartCache && clientNumber) {
      cacheKey = buildCacheKey({
        clientNumber,
        queryHash: normalizeQueryHash(message),
        sourceSelector: (sources || ['org']).sort().join(','),
        personalDataVersion: 'null', // Phase 4: will be hash of personal data timestamp
        provider,
      });
      const smartCached = getCachedResult(cacheKey);
      if (smartCached) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        for (const chunk of smartCached.chunks) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        }
        res.write(`data: ${JSON.stringify(smartCached.meta)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }
    } else {
      cacheKey = getDedupKey(userId, message, provider);
      const cached = getCachedResponse(cacheKey);
      if (cached) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        for (const chunk of cached.chunks) {
          res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
        }
        res.write(`data: ${JSON.stringify(cached.meta)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
        return;
      }
    }

    // SSE headers
    setupSSEHeaders(res);

    const startTime = Date.now();
    let totalChars = 0;
    const responseChunks: string[] = [];

    // ── 3. Intent + history + profile in PARALLEL ───────────
    sendStatus(res, clientDisconnected, 'Understanding your question...');
    const formatLearnings = userId ? await getUserLearnings(userId) : [];
    const formatHints = formatLearnings.length > 0
      ? formatLearnings.filter((l: any) => l.category === 'response_format').map((l: any) => `User ${l.score > 0 ? 'prefers' : 'dislikes'} ${l.key} (score: ${l.score})`).join('. ')
      : '';

    // Fetch last 3 turns first so the intent classifier has follow-up context
    const recentTurns = conversationId
      ? await getRecentMessages(conversationId, 6, userId) // 3 pairs = 6 messages
      : [];

    const [intent, chatHistory, userProfile, memoryBlocks, userLearnings, tierSettings] = await Promise.all([
      classifyIntent(message, formatHints || undefined, recentTurns.length > 0 ? recentTurns.reverse() : undefined),
      conversationId ? getRecentMessages(conversationId, 20, userId) : Promise.resolve([]),
      userId ? getUserProfile(userId) : Promise.resolve(null),
      userId ? buildMemoryPromptBlocks(userId) : Promise.resolve({ userMemoryBlock: '', aiMemoryBlock: '', contextBlock: '', aiName: '' }),
      userId ? getUserLearnings(userId) : Promise.resolve([]),
      (clientNumber && req.user?.userType) ? getUserTier(clientNumber, req.user.userType) : Promise.resolve(null),
    ]);

    if (clientDisconnected) return;

    // ── Apply tier-based format restrictions ─────────────────
    if (tierSettings) {
      if (!tierSettings.allowWidgets && (intent.format === 'widget' || intent.format === 'hierarchy')) {
        intent.format = 'text';
        if (intent.type === 'dashboard') intent.type = 'detailed_analysis';
        if (intent.type === 'export' && !tierSettings.allowExport) intent.type = 'detailed_analysis';
      }
      if (!tierSettings.allowCharts && intent.format === 'chart') {
        intent.format = 'text';
      }
      if (!tierSettings.allowExport && intent.type === 'export') {
        intent.format = 'text';
        intent.type = 'detailed_analysis';
      }
      intent.detail = tierSettings.responseStyle === 'brief' ? 'brief'
        : tierSettings.responseStyle === 'comprehensive' || tierSettings.responseStyle === 'detailed' ? 'comprehensive'
        : 'moderate';
    }

    const t1 = Date.now() - startTime;
    log.info('Step 1 (intent)', { elapsedMs: t1, type: intent.type, scope: intent.scope, ...(tierSettings && { tier: tierSettings.tierCode }) });

    // ── 4. Handle memory/conversational/email/calendar early exits ──
    const isClearConfirm = /\b(clear all memory|yes clear|confirm clear|delete all memory|wipe all)\b/i.test(message);
    const isMemoryRequest = !isClearConfirm && (
      /\b(forget|clear|reset|delete|erase|wipe|remove).*(memory|memories|know about me|what you know|learned|remember)/i.test(message)
      || /\b(show|see|review|edit|change|update).*(memory|memories|what you know|what you remember)/i.test(message)
    );

    if (isMemoryRequest && userId) {
      await handleMemoryRequest(res, clientDisconnected, message, userId, clientNumber, conversationId, startTime);
      return;
    }

    if (isClearConfirm && userId) {
      await handleMemoryClear(res, message, userId, clientNumber, conversationId, startTime);
      return;
    }

    const isMemoryEdit = /\b(update memory|here is my updated|updated memory|new memory|replace memory)\b/i.test(message)
      || (message.includes('How I Behave:') || message.includes('About You:') || message.includes('Active Concerns:'));
    if (isMemoryEdit && userId && clientNumber) {
      await handleMemoryEdit(res, message, userId, clientNumber, conversationId, startTime);
      return;
    }

    // Detect conversational vs data queries
    const hasDataKeywords = /\b(project|dashboard|sales|revenue|employee|org|risk|pipeline|client|deal|report|excel|list|show|compare|behind|ahead|overdue|status|portfolio|summary|analysis)\b/i.test(message);
    const isShortFollowUp = message.length < 20 && chatHistory.length > 0 && !hasDataKeywords;
    const prevWasConversational = chatHistory.length > 0 && chatHistory[0]?.content?.length < 300;
    const isEmailCalendarQuery = /\b(emails?|inbox|mails?|unread|send email|reply|compose|draft|my calendar|my schedule|my meetings?|my events?|appointments?|free time|free slot|check my|what'?s on my)\b/i.test(message)
      && !hasDataKeywords;
    const isAdminQuery = /\b(system log|logs?|token cost|token consumption|usage|billing|suggest fix|apply all fixes|apply.*fix)/i.test(message) && req.user?.isAdmin;
    const isPersonalQuery = /\b(think about me|know about me|how am i|who am i|my name|about me|my birthday|my hobby|my family|how do you feel|do you like me|your opinion|are you happy|are you sad|i am (sad|happy|tensed|stressed|worried|excited|angry|tired|bored|sick|lonely))\b/i.test(message);
    const isConversational = (intent.type === 'conversational' && !hasDataKeywords) || (isShortFollowUp && prevWasConversational) || isEmailCalendarQuery || isAdminQuery || isPersonalQuery;
    const isWidget = ['dashboard', 'list', 'export', 'comparison'].includes(intent.type) || intent.format === 'widget' || intent.format === 'hierarchy';

    // Widget modification detection
    const isModifyRequest = /\b(add|change|sort|filter|remove|hide|show|move|swap|switch|update|modify|make|convert)\b/i.test(message)
      && chatHistory.length > 0 && chatHistory[0]?.content?.includes('```widget');

    if (isModifyRequest && userId && clientNumber) {
      const handled = await handleWidgetModify(res, clientDisconnected, message, provider, userId, clientNumber, conversationId, startTime, responseChunks, chatHistory);
      if (handled) return;
    }

    if (isConversational) {
      await handleConversational({
        res, clientDisconnected, message, provider, userId, clientNumber,
        conversationId, startTime, totalChars, responseChunks, dedupKey: cacheKey,
        userName: req.user?.name, isAdmin: !!req.user?.isAdmin,
        userProfile, chatHistory, memoryBlocks, aiConfig, intent,
      });
      return;
    }

    // ── 5. Retrieve data ─────────────────────────────────────
    sendStatus(res, clientDisconnected, 'Searching data...');
    const { context: rawContext, topScore, piiMapping } = await retrieveData(
      message, intent, provider, aiConfig, startTime,
      (text) => sendStatus(res, clientDisconnected, text),
      () => clientDisconnected,
      userId,
      sources,
      chatHistory,
    );
    if (clientDisconnected) return;

    // ── 5b. Phase 3 — wiki pre-load ─────────────────────────
    // Before the LLM sees the system prompt, inject top wiki matches from this
    // user's own Memex. The user's compiled knowledge takes precedence over
    // raw RAG chunks. Fail-open: a wiki miss just leaves the normal context.
    let context = rawContext;
    let wikiCitations: Array<{ id: string; title: string; pageType: string }> = [];
    if (userId && clientNumber) {
      try {
        const { queryIndex, readPage } = await import('../services/wiki/wikiStorageService');
        const hits = await queryIndex(clientNumber, userId, message, 3);
        if (hits.length > 0) {
          sendStatus(res, clientDisconnected, 'Checking your personal wiki...');
          const pages = await Promise.all(
            hits.slice(0, 3).map(async (h) => ({ hit: h, page: await readPage(clientNumber, userId, h.id) })),
          );
          const wikiBlock = pages
            .filter((p) => p.page)
            .map((p) => {
              const pg = p.page!;
              const body = (pg.bodyMarkdown ?? '').slice(0, 1500);
              return `# [From your wiki] ${p.hit.title} (${p.hit.pageType})\n${body}`;
            })
            .join('\n\n---\n\n');
          if (wikiBlock) {
            context = `## User's personal wiki (authoritative for what is already known)\n${wikiBlock}\n\n## Additional retrieved context\n${rawContext}`;
            wikiCitations = hits.slice(0, 3).map((h) => ({ id: h.id, title: h.title, pageType: h.pageType }));
            log.info('[wiki] preloaded pages', { userId, count: wikiCitations.length });
          }
        }
      } catch (err: any) {
        log.warn('[wiki] preload skipped', { err: err.message });
      }
    }

    // ── 6. Classify + generate widget (if applicable) ────────
    const widgetClassification = await classifyWidgetIntent(message);
    const widgetType = widgetClassification.widget_type;
    if (widgetType && context) {
      const widgetGenerated = await handleWidget(
        widgetType, message, context, provider, res, clientDisconnected,
        responseChunks, startTime, userId, clientNumber, conversationId,
      );
      if (widgetGenerated) {
        res.end();
        return;
      }
    }

    // ── 7. Build system prompt ───────────────────────────────
    const isDashboardQuery = /dashboard|all projects|all risks|full list|overview|portfolio/i.test(message);
    const { systemPrompt, conversationTurns } = await buildFullPrompt({
      context, topScore, intent, tierSettings, userProfile, userLearnings,
      memoryBlocks, chatHistory, message, provider, clientNumber,
      userId, isWidget, isDashboardQuery, aiConfig,
    });

    const pipelineMs = Date.now() - startTime;
    log.info('Total pre-LLM pipeline', { elapsedMs: pipelineMs, contextChars: context.length, provider });

    // ── 8. Route to LLM ─────────────────────────────────────
    try {
      const llmResult = await routeToLLM({
        systemPrompt, message, provider, clientNumber, intent, tierSettings, aiConfig,
        conversationTurns, piiMapping, isWidget, isDashboardQuery,
        clientDisconnected, abortSignal: abortController.signal,
        onChunk: (text) => {
          const { text: safeText, blocked } = sanitizeOutput(text);
          if (blocked || !safeText) return;
          totalChars += safeText.length;
          responseChunks.push(safeText);
          if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'chunk', content: safeText })}\n\n`);
        },
        onStatus: (text) => sendStatus(res, clientDisconnected, text),
      });

      // ── 9. Post-process ───────────────────────────────────
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const estimatedTokens = Math.ceil(totalChars / 4);
      const contextTokens = Math.ceil((systemPrompt.length + message.length) / 4);

      const meta = {
        type: 'meta', elapsed,
        outputTokens: estimatedTokens, inputTokens: contextTokens,
        totalTokens: estimatedTokens + contextTokens,
        dataLastUpdated: getDataLastUpdated(),
        conversationId: conversationId || undefined,
        pipelineMs,
      };

      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify(meta)}\n\n`);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      }

      // Store in smart cache or legacy dedup
      if (useSmartCache && clientNumber) {
        const ttl = await getConfiguredTTL(clientNumber);
        setCachedResultForClient(cacheKey, clientNumber, { chunks: responseChunks, meta, cachedAt: Date.now() }, ttl);
      } else {
        setCachedResponse(cacheKey, { chunks: responseChunks, meta, timestamp: Date.now() });
      }

      postProcess({
        userId, clientNumber, conversationId, message, provider,
        responseChunks, systemPrompt, startTime, totalChars,
        piiMapping, topScore, intentType: intent.type,
      });

    } catch (error: any) {
      if (error.message === 'Client disconnected') {
        log.info('Aborted — client disconnected');
      } else {
        log.error('AI streaming error', { provider, error: error.message });
        if (!clientDisconnected) res.write(`data: ${JSON.stringify({ type: 'error', content: error.message })}\n\n`);
        logQuery({ clientNumber, userId, query: message, provider, responseTimeMs: Date.now() - startTime, intentType: intent?.type, error: error.message }).catch(() => {});
        logError('api_error', 'chatController', `AI streaming error (${provider}): ${error.message}`, `Prompt: ${message.slice(0, 100)}`).catch(() => {});
      }
    }

    if (!clientDisconnected) res.end();
  } catch (outerError: any) {
    log.error('Chat endpoint error', { error: outerError.message });
    if (!res.headersSent) res.status(500).json({ error: outerError.message });
    else if (!clientDisconnected) res.end();
  }
}
