# Per-Model Tenant-Scope Audit

Scanned 529 TypeScript files.
Findings: **225 NEEDS_USERID** (P0), **143 REVIEW** (mixed-scope), **0 UNKNOWN_MODEL**.

Models exempt from this audit (system tables, no user data):
  Session, ApprovalToken, SystemConfig, License, ClientLicense, Tenant,
  ConnectorType, IndexEvent, ActionIdempotencyLog, LlmSpend, User.

Models user-owned (NEEDS_USERID if missing):
  agentMemory, brainActionArtifact, brainPendingAction, brainPromptQueue, brainUserMessage, chunk, conversation, decisionLog, delegationLog, document, feedEvent, message, mutedSender, openItem, patternHidden, person, personFacet, personalChunk, personalDocument, pushSubscription, retrievalFeedback, scheduledTask, thoughtEntry, userConnector, userMemory, userPrompt, userPromptOverlay, userResolutionAlias, whatsAppConnection, whatsAppMessage, whatsAppOutboundMessage, whatsAppSession

Models tenant-shared (TENANT_OK by default):
  actionDependency, actionUndoLog, agent, agentAction, approvalToken, brainConfig, brainDoc, clientLicense, connectorType, delegationMatrix, delegationMatrixHistory, domainKnowledge, gateRule, gateRuleFiring, gateRuleOverride, goldenDataset, knowledgeItem, kpiValue, license, notificationQueue, okr, patternInsight, proactiveAlert, riskFlagDoc, riskRule, riskRuleOverride, ruleLifecycle, session, shadowRule, shadowScore, systemConfig, tenant, tenantConnectorConfig, tenantWhatsappNotifier

Models mixed-scope (REVIEW per-call):
  auditLog, entity, entityLink, wikiPage, wikiPageLink, wikiPageSource

---

## `prisma.agentMemory` — 1 ⚠️ P0 fix

- `services/actions/handlers/brain/updateMemory.ts:39` (findUnique)
  - const existing = await prisma.agentMemory.findUnique({

## `prisma.auditLog` — 2 📋 review

- `services/auditService.ts:46` (findMany)
  - return prisma.auditLog.findMany({
- `services/safety/killSwitchService.ts:127` (findMany)
  - const rows = await prisma.auditLog.findMany({

## `prisma.brainPromptQueue` — 10 ⚠️ P0 fix

- `scripts/smokeBrainPromptProducer.ts:248` (findFirst)
  - const refreshed = await prisma.brainPromptQueue.findFirst({ where: { id: awaiting.id } });
- `scripts/smokeBrainPromptQueue.ts:153` (findFirst)
  - const after = await prisma.brainPromptQueue.findFirst({
- `scripts/smokeBrainPromptQueue.ts:178` (findFirst)
  - const expiredRow = await prisma.brainPromptQueue.findFirst({
- `scripts/smokeWhatsappVoiceCall.ts:104` (findMany)
  - return prisma.brainPromptQueue.findMany({
- `scripts/smokeWhatsappVoiceCall.ts:116` (findUnique)
  - const row = await prisma.brainPromptQueue.findUnique({ where: { id: promptId as any } });
- `services/brainPrompts/brainPromptQueueService.ts:192` (findFirst)
  - const inFlight = await prisma.brainPromptQueue.findFirst({
- `services/brainPrompts/brainPromptQueueService.ts:204` (findMany)
  - const candidates = await prisma.brainPromptQueue.findMany({
- `services/knowledge/systemCapabilitiesService.ts:103` (findFirst)
  - prisma.brainPromptQueue.findFirst({
- `services/knowledge/systemCapabilitiesService.ts:142` (count)
  - (await prisma.brainPromptQueue.count({
- `services/triage/starCadenceService.ts:299` (findMany)
  - const rows = await prisma.brainPromptQueue.findMany({

## `prisma.brainUserMessage` — 3 ⚠️ P0 fix

- `routes/admin/whatsappNotifierRoutes.ts:154` (findMany)
  - const rows = await prisma.brainUserMessage.findMany({
- `services/brainPrompts/brainPromptQueueService.ts:369` (findFirst)
  - const recent = await prisma.brainUserMessage.findFirst({
- `services/brainPrompts/negativeFeedbackHandler.ts:188` (findMany)
  - const rows = await prisma.brainUserMessage.findMany({

## `prisma.conversation` — 1 ⚠️ P0 fix

- `controllers/chatController.ts:59` (findFirst)
  - const conv = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });

## `prisma.decisionLog` — 19 ⚠️ P0 fix

- `routes/briefRoutes.ts:2884` (findMany)
  - const rows = await prisma.decisionLog.findMany({
- `scripts/seedGoldenDataset.ts:58` (findMany)
  - const decisions = await prisma.decisionLog.findMany({
- `services/actionSuggestionService.ts:68` (findMany)
  - const recentDecisions = await prisma.decisionLog.findMany({
- `services/decisions/decisionLogService.ts:98` (findFirst)
  - return prisma.decisionLog.findFirst({ where: { id, clientNumber } });
- `services/decisions/decisionLogService.ts:132` (groupBy)
  - const rows = await prisma.decisionLog.groupBy({
- `services/decisionsLogService.ts:74` (findMany)
  - return prisma.decisionLog.findMany({
- `services/decisionsLogService.ts:85` (findMany)
  - const pending = await prisma.decisionLog.findMany({
- `services/maintenance/queueArchiveMaintenanceService.ts:189` (findMany)
  - const decided = await prisma.decisionLog.findMany({
- `services/patternAnalysisService.ts:43` (findMany)
  - const decisions = await prisma.decisionLog.findMany({
- `services/shadowScoringService.ts:58` (findMany)
  - const userActions = await prisma.decisionLog.findMany({
- `services/steering/steeringWheelService.ts:44` (count)
  - prisma.decisionLog.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd } } }),
- `services/steering/steeringWheelService.ts:45` (count)
  - prisma.decisionLog.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd }, userDecision: 'approved' } }),
- `services/steering/steeringWheelService.ts:46` (count)
  - prisma.decisionLog.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd }, userDecision: 'overrode' } }),
- `services/thoughtPipelineService.ts:70` (findMany)
  - prisma.decisionLog.findMany({
- `services/triage/triageSuggester.ts:245` (findMany)
  - prisma.decisionLog.findMany({
- `services/triage/triageSuggester.ts:1081` (findMany)
  - const decidedIds = await prisma.decisionLog.findMany({
- `services/triage/triageSuggester.ts:1190` (findMany)
  - const repliedRows = await prisma.decisionLog.findMany({
- `services/triage/triageSuggester.ts:2103` (findMany)
  - const decisionRows = await prisma.decisionLog.findMany({
- `services/triage/triageSuggester.ts:2163` (findMany)
  - const repliedRows = await prisma.decisionLog.findMany({

## `prisma.delegationLog` — 2 ⚠️ P0 fix

- `routes/briefRoutes.ts:2931` (findMany)
  - const rows = await prisma.delegationLog.findMany({
- `services/triage/triageSuggester.ts:251` (findMany)
  - prisma.delegationLog.findMany({

## `prisma.entity` — 28 📋 review

- `routes/brainAskRoutes.ts:854` (findMany)
  - const rows = await prisma.entity.findMany({
- `routes/personalContactsRoutes.ts:101` (count)
  - const entityCount = await prisma.entity.count({
- `scripts/backfillPersons.ts:114` (findMany)
  - const entities = await prisma.entity.findMany({
- `services/entity/graphService.ts:49` (findFirst)
  - const ent = await prisma.entity.findFirst({
- `services/entityService.ts:44` (findFirst)
  - return prisma.entity.findFirst({
- `services/entityService.ts:79` (findMany)
  - return prisma.entity.findMany({
- `services/entityService.ts:89` (findFirst)
  - return prisma.entity.findFirst({
- `services/entityService.ts:101` (findMany)
  - return prisma.entity.findMany({
- `services/knowledge/conceptSynthesizerService.ts:81` (findUnique)
  - const entity = await prisma.entity.findUnique({
- `services/knowledge/conceptSynthesizerService.ts:324` (findMany)
  - const people = entityIds.length > 0 ? await prisma.entity.findMany({
- `services/knowledge/contactResolver.ts:122` (findMany)
  - prisma.entity.findMany({
- `services/knowledge/contextEnricher.ts:195` (findFirst)
  - const entity = await prisma.entity.findFirst({
- `services/knowledge/organizationKnowledge.ts:70` (findMany)
  - prisma.entity.findMany({
- `services/knowledge/organizationKnowledge.ts:76` (findMany)
  - prisma.entity.findMany({
- `services/knowledge/organizationKnowledge.ts:82` (findMany)
  - prisma.entity.findMany({
- `services/knowledge/organizationKnowledge.ts:118` (count)
  - prisma.entity.count({ where: { clientNumber } as any }).catch(() => 0),
- `services/knowledge/personIdentityService.ts:55` (findFirst)
  - const direct = await prisma.entity.findFirst({
- `services/knowledge/personIdentityService.ts:107` (findFirst)
  - const direct = await prisma.entity.findFirst({
- `services/knowledge/personIdentityService.ts:168` (findFirst)
  - const hit = await prisma.entity.findFirst({
- `services/knowledge/personIdentityService.ts:175` (findFirst)
  - const hit = await prisma.entity.findFirst({
- `services/knowledge/senderWikiService.ts:165` (findUnique)
  - ? await prisma.entity.findUnique({
- `services/knowledge/wikiScribeService.ts:76` (findUnique)
  - const existing = await prisma.entity.findUnique({
- `services/knowledge/wikiScribeService.ts:115` (findUnique)
  - const existing = await prisma.entity.findUnique({
- `services/knowledge/wikiScribeService.ts:226` (findUnique)
  - const contact = await prisma.entity.findUnique({
- `services/knowledge/wikiScribeService.ts:267` (findUnique)
  - const company = await prisma.entity.findUnique({
- `services/knowledge/wikiScribeService.ts:420` (count)
  - prisma.entity.count({ where: { clientNumber, entityType: 'contact' } }),
- `services/knowledge/wikiScribeService.ts:421` (count)
  - prisma.entity.count({ where: { clientNumber, entityType: 'account' } }),
- `services/situationService.ts:102` (findMany)
  - const entities = await prisma.entity.findMany({

## `prisma.entityLink` — 6 📋 review

- `services/entity/graphService.ts:58` (findMany)
  - const links = await prisma.entityLink.findMany({
- `services/entityPropagationService.ts:46` (findMany)
  - const links = await prisma.entityLink.findMany({
- `services/entityService.ts:122` (findMany)
  - prisma.entityLink.findMany({
- `services/entityService.ts:126` (findMany)
  - prisma.entityLink.findMany({
- `services/knowledge/wikiScribeService.ts:147` (findFirst)
  - const existing = await prisma.entityLink.findFirst({
- `services/knowledge/wikiScribeService.ts:274` (count)
  - const contacts = await prisma.entityLink.count({

## `prisma.feedEvent` — 45 ⚠️ P0 fix

- `jobs/attachmentBackfillWorker.ts:238` (count)
  - const totalEvents = await prisma.feedEvent.count({
- `jobs/feedPublishRetry.ts:28` (findMany)
  - const rows = (await prisma.feedEvent.findMany({
- `jobs/gmailReadStateSyncJob.ts:147` (findMany)
  - const events = await prisma.feedEvent.findMany({
- `jobs/waIngestHealthAudit.ts:116` (count)
  - prisma.feedEvent.count({
- `routes/briefRoutes.ts:274` (findMany)
  - prisma.feedEvent.findMany({
- `routes/briefRoutes.ts:280` (count)
  - prisma.feedEvent.count({ where }),
- `routes/briefRoutes.ts:414` (findFirst)
  - const fe = await prisma.feedEvent.findFirst({
- `routes/briefRoutes.ts:486` (findFirst)
  - const fe = await prisma.feedEvent.findFirst({
- `routes/briefRoutes.ts:1272` (findUnique)
  - const fe = await prisma.feedEvent.findUnique({
- `routes/briefRoutes.ts:1402` (findUnique)
  - const sFe = await prisma.feedEvent.findUnique({
- `routes/briefRoutes.ts:2583` (findFirst)
  - const fe = await prisma.feedEvent.findFirst({
- `routes/feedRoutes.ts:130` (findFirst)
  - const row = await prisma.feedEvent.findFirst({
- `routes/feedRoutes.ts:158` (groupBy)
  - const rows = await prisma.feedEvent.groupBy({
- `routes/healthRoutes.ts:343` (count)
  - const dlqCount = await prisma.feedEvent.count({
- `routes/personalContactsRoutes.ts:77` (count)
  - const feedCount = await prisma.feedEvent.count({
- `scripts/backfillEmailBodies.ts:22` (findMany)
  - const events = await prisma.feedEvent.findMany({
- `scripts/backfillFeedEventAt.ts:34` (findMany)
  - const rows = await (prisma.feedEvent.findMany({
- `scripts/backfillTodayGmail.ts:59` (groupBy)
  - const rows = await prisma.feedEvent.groupBy({
- `scripts/loadTestFeed.ts:101` (count)
  - const inDb = await prisma.feedEvent.count({ where: { contentHash: { startsWith: 'chaos_loadtest_' } } });
- `scripts/purgeNonMessageWaEvents.ts:53` (findMany)
  - const rows = await prisma.feedEvent.findMany({
- `services/feed/feedIngestionService.ts:98` (findUnique)
  - const existing = await prisma.feedEvent.findUnique({
- `services/feed/feedIngestionService.ts:509` (findFirst)
  - const existing = await prisma.feedEvent.findFirst({
- `services/instructions/instructionDispatcher.ts:121` (findFirst)
  - const fe = await prisma.feedEvent.findFirst({
- `services/instructions/instructionDispatcher.ts:237` (findFirst)
  - const fe = await prisma.feedEvent.findFirst({
- `services/instructions/instructionExtractor.ts:98` (findMany)
  - const rows = await prisma.feedEvent.findMany({
- `services/knowledge/brainComposer.ts:2043` (findUnique)
  - const fe = await prisma.feedEvent.findUnique({
- `services/knowledge/contextEnricher.ts:285` (findMany)
  - const senderHistory = await prisma.feedEvent.findMany({
- `services/knowledge/senderWikiBackfill.ts:76` (count)
  - const totalEvents = await prisma.feedEvent.count({
- `services/knowledge/senderWikiBackfill.ts:90` (findMany)
  - const batch: any[] = await prisma.feedEvent.findMany({
- `services/knowledge/senderWikiService.ts:464` (findMany)
  - const events = await prisma.feedEvent.findMany({
- `services/knowledge/wikiScribeService.ts:233` (findMany)
  - const recent = await prisma.feedEvent.findMany({
- `services/maintenance/queueArchiveMaintenanceService.ts:64` (findMany)
  - const events = await prisma.feedEvent.findMany({
- `services/maintenance/queueArchiveMaintenanceService.ts:202` (findMany)
  - const events = await prisma.feedEvent.findMany({
- `services/openItems/openItemGate.ts:104` (findUnique)
  - const event = await prisma.feedEvent.findUnique({
- `services/openItems/openItemGate.ts:141` (findUnique)
  - const event = await prisma.feedEvent.findUnique({
- `services/risk/riskGatingService.ts:103` (findFirst)
  - const feedEvent = await prisma.feedEvent.findFirst({
- `services/risk/riskGatingService.ts:108` (findMany)
  - out.recentFeedEvents = await prisma.feedEvent.findMany({
- `services/steering/morningBriefService.ts:165` (count)
  - ? prisma.feedEvent.count({ where: { clientNumber, userId, sourceType: 'gmail', createdAt: { gte: today0 } } as any }).catch(() => 0)
- `services/steering/morningBriefService.ts:169` (count)
  - ? prisma.feedEvent.count({ where: { clientNumber, userId, sourceType: 'whatsapp', createdAt: { gte: today0 } } as any }).catch(() => 0)
- `services/steering/morningBriefService.ts:202` (count)
  - prisma.feedEvent.count({ where: { clientNumber, userId, sourceType: 'gtasks' } as any }).catch(() => 0),
  - ... +5 more

## `prisma.message` — 2 ⚠️ P0 fix

- `services/chatHistoryService.ts:90` (findMany)
  - return prisma.message.findMany({
- `services/welcomeService.ts:176` (findMany)
  - prisma.message.findMany({

## `prisma.mutedSender` — 2 ⚠️ P0 fix

- `services/triage/triageSuggester.ts:1138` (findMany)
  - const mutedRows = await prisma.mutedSender.findMany({
- `services/triage/triageSuggester.ts:2123` (findMany)
  - const mutedRows = await prisma.mutedSender.findMany({

## `prisma.openItem` — 75 ⚠️ P0 fix

- `jobs/delegationFollowUpJob.ts:62` (findMany)
  - const items = await prisma.openItem.findMany({
- `jobs/snoozeUnblocker.ts:23` (findMany)
  - const due = await prisma.openItem.findMany({
- `routes/openItemsRoutes.ts:183` (findMany)
  - ? await prisma.openItem.findMany({
- `routes/openItemsRoutes.ts:217` (findFirst)
  - const item = await prisma.openItem.findFirst({
- `routes/openItemsRoutes.ts:245` (groupBy)
  - prisma.openItem.groupBy({ by: ['status'] as any, where: { clientNumber: user.clientNumber } as any, _count: { _all: true } as any }),
- `routes/openItemsRoutes.ts:246` (groupBy)
  - prisma.openItem.groupBy({ by: ['priority'] as any, where: { clientNumber: user.clientNumber } as any, _count: { _all: true } as any }),
- `routes/openItemsRoutes.ts:247` (groupBy)
  - prisma.openItem.groupBy({ by: ['archetype'] as any, where: { clientNumber: user.clientNumber } as any, _count: { _all: true } as any }),
- `routes/openItemsRoutes.ts:248` (count)
  - prisma.openItem.count({ where: { clientNumber: user.clientNumber, createdAt: { gte: day } } }),
- `routes/openItemsRoutes.ts:249` (count)
  - prisma.openItem.count({ where: { clientNumber: user.clientNumber, createdAt: { gte: week } } }),
- `routes/profileRoutes.ts:584` (count)
  - const count = await prisma.openItem.count({ where });
- `routes/profileRoutes.ts:597` (count)
  - const count = await prisma.openItem.count({ where });
- `scripts/backfillOpenItemDelegationStatus.ts:55` (findMany)
  - const rows = await prisma.openItem.findMany({
- `scripts/brainChatRegressionBattery.ts:571` (count)
  - const startCount = await prisma.openItem.count({ where: { clientNumber, userId } });
- `scripts/brainChatRegressionBattery.ts:586` (count)
  - openItemsAtStart: await prisma.openItem.count({ where: { clientNumber, userId } }),
- `scripts/brainChatRegressionBattery.ts:638` (count)
  - const endCount = await prisma.openItem.count({ where: { clientNumber, userId } });
- `scripts/cleanupBatterySeeds.ts:34` (count)
  - const byTitleCount = await prisma.openItem.count({
- `scripts/cleanupBatterySeeds.ts:40` (count)
  - const byMetadataCount = await prisma.openItem.count({
- `scripts/cleanupBatterySeeds.ts:50` (findMany)
  - const sample = await prisma.openItem.findMany({
- `scripts/cleanupDuplicateOpenItems.ts:77` (findMany)
  - const items = await prisma.openItem.findMany({
- `scripts/smokeBrainPromptDelegateeEmail.ts:171` (findFirst)
  - const stamped = await prisma.openItem.findFirst({ where: { id: eligibleItem } });
- `scripts/smokeBrainPromptDelegateeEmail.ts:186` (findFirst)
  - const it = await prisma.openItem.findFirst({ where: { id } });
- `scripts/smokeBrainPromptDelegateeEmail.ts:193` (findFirst)
  - const aiAfter = await prisma.openItem.findFirst({ where: { id: alreadyInquired } });
- `scripts/smokeBrainPromptDelegateeEmail.ts:237` (findFirst)
  - const it2 = await prisma.openItem.findFirst({ where: { id: item2 } });
- `scripts/smokeBrainPromptDelegateeEmail.ts:264` (findFirst)
  - const it3 = await prisma.openItem.findFirst({ where: { id: item3 } });
- `scripts/smokeBrainPromptDelegateeEmail.ts:275` (findFirst)
  - const it3After = await prisma.openItem.findFirst({ where: { id: item3 } });
- `scripts/smokeCommitments.ts:37` (findUnique)
  - const item = await prisma.openItem.findUnique({
- `scripts/smokeMeetingDigest.ts:73` (findUnique)
  - const item = await prisma.openItem.findUnique({
- `scripts/smokeMeetingDigest.ts:94` (findUnique)
  - const item = await prisma.openItem.findUnique({ where: { id: oid }, select: { sourceFeed: true, sourceRef: true } });
- `services/actionSuggestionService.ts:16` (findMany)
  - const items = await prisma.openItem.findMany({
- `services/actionSuggestionService.ts:60` (count)
  - const linkedItems = await prisma.openItem.count({ where: { clientNumber, entityId: item.entityId, status: { not: 'done' } } });
- `services/brainEngineService.ts:82` (findMany)
  - const openItems = await prisma.openItem.findMany({
- `services/brainPrompts/promptReplyHandler.ts:170` (findFirst)
  - const item = await prisma.openItem.findFirst({ where: { id: openItemId } });
- `services/dayBriefingService.ts:92` (findMany)
  - prisma.openItem.findMany({
- `services/dayBriefingService.ts:115` (findMany)
  - const items = await prisma.openItem.findMany({
- `services/dayBriefingService.ts:280` (findMany)
  - const classifiedItems = await prisma.openItem.findMany({
- `services/dayBriefingService.ts:319` (findMany)
  - const staleItems = await prisma.openItem.findMany({
- `services/decisionsLogService.ts:91` (findUnique)
  - const item = await prisma.openItem.findUnique({
- `services/delegation/delegationTrackerService.ts:185` (findFirst)
  - const delegateeOpenItem = await prisma.openItem.findFirst({
- `services/entity/graphService.ts:75` (findMany)
  - const items = await prisma.openItem.findMany({
- `services/entityPropagationService.ts:128` (findMany)
  - const allItems = await prisma.openItem.findMany({
  - ... +35 more

## `prisma.patternHidden` — 2 ⚠️ P0 fix

- `services/triage/triageSuggester.ts:1286` (findMany)
  - const hidden = await prisma.patternHidden.findMany({
- `services/triage/triageSuggester.ts:2263` (findMany)
  - const hidden = await prisma.patternHidden.findMany({

## `prisma.pushSubscription` — 3 ⚠️ P0 fix

- `services/notifications/pushService.ts:164` (findMany)
  - return prisma.pushSubscription.findMany({
- `services/notifications/pushService.ts:228` (findMany)
  - const subs = await prisma.pushSubscription.findMany({
- `services/notifications/pushService.ts:332` (aggregate)
  - const recent = await prisma.pushSubscription.aggregate({

## `prisma.retrievalFeedback` — 2 ⚠️ P0 fix

- `services/knowledge/retrievalFeedbackService.ts:119` (findMany)
  - const rows = await prisma.retrievalFeedback.findMany({
- `services/knowledge/retrievalFeedbackService.ts:150` (findMany)
  - const rows = await prisma.retrievalFeedback.findMany({

## `prisma.scheduledTask` — 4 ⚠️ P0 fix

- `services/schedulerService.ts:34` (findUnique)
  - const task = await prisma.scheduledTask.findUnique({
- `services/schedulerService.ts:138` (findMany)
  - const tasks = await prisma.scheduledTask.findMany({ where: { isActive: true } });
- `services/schedulerService.ts:481` (findFirst)
  - const task = await prisma.scheduledTask.findFirst({ where: { id: taskId, userId } });
- `services/userContextService.ts:87` (findMany)
  - prisma.scheduledTask.findMany({

## `prisma.thoughtEntry` — 7 ⚠️ P0 fix

- `jobs/notionReverseSync.ts:59` (findFirst)
  - const local = await prisma.thoughtEntry.findFirst({
- `services/actions/handlers/brain/syncThoughtToNotion.ts:26` (findFirst)
  - const thought = await prisma.thoughtEntry.findFirst({
- `services/actions/handlers/brain/syncThoughtToNotion.ts:33` (findFirst)
  - const thought = await prisma.thoughtEntry.findFirst({
- `services/actions/handlers/brain/syncThoughtToNotion.ts:43` (findFirst)
  - const thought = await prisma.thoughtEntry.findFirst({
- `services/dayBriefingService.ts:360` (findMany)
  - const drafts = await prisma.thoughtEntry.findMany({
- `services/patternAnalysisService.ts:76` (findFirst)
  - const existingInsight = await prisma.thoughtEntry.findFirst({
- `services/thoughtPipelineService.ts:163` (findMany)
  - return prisma.thoughtEntry.findMany({

## `prisma.userConnector` — 40 ⚠️ P0 fix

- `routes/connectorRoutes.ts:317` (findUnique)
  - const cur = await prisma.userConnector.findUnique({ where: { id: ucId }, select: { metadata: true } });
- `routes/connectorRoutes.ts:344` (findUnique)
  - const current = await prisma.userConnector.findUnique({ where: { id: ucId }, select: { metadata: true } });
- `routes/connectorRoutes.ts:361` (findUnique)
  - const current = await prisma.userConnector.findUnique({ where: { id: ucId }, select: { metadata: true } });
- `routes/connectorRoutes.ts:439` (findUnique)
  - const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
- `routes/connectorRoutes.ts:453` (findUnique)
  - const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
- `routes/connectorRoutes.ts:511` (findUnique)
  - const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
- `routes/connectorRoutes.ts:525` (findUnique)
  - const current = await prisma.userConnector.findUnique({ where: { id: uc.id }, select: { metadata: true } });
- `services/actions/handlers/communication/sendSlackMessage.ts:115` (findFirst)
  - const row = await prisma.userConnector.findFirst({
- `services/adapters/impl/crmFeedAdapter.ts:56` (findFirst)
  - const connector = await prisma.userConnector.findFirst({
- `services/adapters/impl/msGraphHelper.ts:45` (findUnique)
  - const uc = await prisma.userConnector.findUnique({
- `services/adapters/impl/onedriveFeedAdapter.ts:135` (findUnique)
  - const uc = await prisma.userConnector.findUnique({
- `services/adapters/impl/outlookFeedAdapter.ts:204` (findUnique)
  - const uc = await prisma.userConnector.findUnique({
- `services/adapters/impl/slackFeedAdapter.ts:165` (findFirst)
  - const row = await prisma.userConnector.findFirst({
- `services/brainEngineService.ts:58` (findMany)
  - const connectedConnectors = await prisma.userConnector.findMany({
- `services/connectorHealthService.ts:85` (findUnique)
  - const existing = await prisma.userConnector.findUnique({
- `services/connectorHealthService.ts:111` (findFirst)
  - const row = await prisma.userConnector.findFirst({
- `services/connectorHealthService.ts:133` (findMany)
  - const rows = await prisma.userConnector.findMany({
- `services/connectorHealthService.ts:427` (findMany)
  - const rows = await prisma.userConnector.findMany({
- `services/connectorService.ts:123` (findMany)
  - const userConnectors = await prisma.userConnector.findMany({
- `services/connectorService.ts:175` (findUnique)
  - const existing = await prisma.userConnector.findUnique({
- `services/connectorService.ts:248` (findUnique)
  - const userConnector = await prisma.userConnector.findUnique({
- `services/connectorService.ts:317` (findUnique)
  - const userConnector = await prisma.userConnector.findUnique({
- `services/connectorService.ts:672` (findUnique)
  - const existing = await prisma.userConnector.findUnique({
- `services/connectorService.ts:743` (findUnique)
  - const existing = await prisma.userConnector.findUnique({
- `services/connectorService.ts:822` (findUnique)
  - const existing = await prisma.userConnector.findUnique({
- `services/connectorSyncTracker.ts:53` (findMany)
  - const degraded = await prisma.userConnector.findMany({
- `services/connectorSyncTracker.ts:103` (findMany)
  - const stuckSiblings = await prisma.userConnector.findMany({
- `services/connectors/notionConnectorService.ts:184` (findFirst)
  - return prisma.userConnector.findFirst({
- `services/integrationService.ts:109` (findUnique)
  - const uc = await prisma.userConnector.findUnique({
- `services/integrationService.ts:184` (findMany)
  - const allRows = await prisma.userConnector.findMany({
- `services/knowledge/historicalFeedPull.ts:255` (findMany)
  - const connectors = await prisma.userConnector.findMany({
- `services/knowledge/historicalPullService.ts:39` (findMany)
  - const connectors = await prisma.userConnector.findMany({
- `services/knowledge/systemCapabilitiesService.ts:53` (findMany)
  - prisma.userConnector.findMany({
- `services/steering/morningBriefService.ts:113` (findMany)
  - const myConnectors = await prisma.userConnector.findMany({
- `services/userContextService.ts:46` (findMany)
  - prisma.userConnector.findMany({
- `services/welcomeService.ts:202` (findUnique)
  - const uc = await prisma.userConnector.findUnique({ where: { userId_connectorTypeId: { userId, connectorTypeId: gmailType.id } } });
- `services/whatsapp/UserWebjsProvider.ts:118` (findFirst)
  - return prisma.userConnector.findFirst({
- `services/whatsapp/UserWebjsProvider.ts:1390` (findMany)
  - const rows = await prisma.userConnector.findMany({
- `services/wiki/wikiNotionService.ts:27` (findFirst)
  - const row = await prisma.userConnector.findFirst({
- `services/wiki/wikiStorageService.ts:69` (findFirst)
  - const row = await prisma.userConnector.findFirst({

## `prisma.userPrompt` — 1 ⚠️ P0 fix

- `services/knowledge/userPromptService.ts:26` (findMany)
  - const rows = await prisma.userPrompt.findMany({

## `prisma.userPromptOverlay` — 1 ⚠️ P0 fix

- `services/knowledge/userPromptOverlayService.ts:154` (findMany)
  - const rows = await prisma.userPromptOverlay.findMany({

## `prisma.whatsAppConnection` — 1 ⚠️ P0 fix

- `services/whatsappService.ts:109` (findUnique)
  - const conn = await prisma.whatsAppConnection.findUnique({ where: { userId } });

## `prisma.whatsAppOutboundMessage` — 2 ⚠️ P0 fix

- `jobs/waIngestHealthAudit.ts:124` (count)
  - prisma.whatsAppOutboundMessage.count({
- `jobs/waOutboundReconciliation.ts:99` (findUnique)
  - const before = await prisma.whatsAppOutboundMessage.findUnique({

## `prisma.whatsAppSession` — 2 ⚠️ P0 fix

- `services/whatsappService.ts:306` (findFirst)
  - const existing = await prisma.whatsAppSession.findFirst({
- `services/whatsappService.ts:350` (findUnique)
  - const session = await prisma.whatsAppSession.findUnique({ where: { id: sessionId } });

## `prisma.wikiPage` — 105 📋 review

- `jobs/notionMirrorSync.ts:55` (findMany)
  - const pages = await prisma.wikiPage.findMany({
- `jobs/wikiLintWorker.ts:53` (count)
  - prisma.wikiPage.count({
- `jobs/wikiLintWorker.ts:131` (findFirst)
  - const existing = await prisma.wikiPage.findFirst({
- `routes/admin/clientConnectorRoutes.ts:183` (count)
  - ? await prisma.wikiPage.count({ where: { clientNumber, pageType: 'org_doc' } as any }).catch(() => 0)
- `routes/admin/clientDriveRoutes.ts:40` (count)
  - prisma.wikiPage.count({ where: { clientNumber, pageType: 'org_doc' } as any }).catch(() => 0),
- `routes/brainAskRoutes.ts:941` (findFirst)
  - const page = await prisma.wikiPage.findFirst({
- `routes/briefRoutes.ts:147` (findMany)
  - prisma.wikiPage.findMany({
- `routes/briefRoutes.ts:153` (count)
  - prisma.wikiPage.count({ where }),
- `routes/connectorRoutes.ts:476` (count)
  - const count = await prisma.wikiPage.count({
- `routes/entityCatalogRoutes.ts:115` (findUnique)
  - const page = await prisma.wikiPage.findUnique({
- `routes/entityCatalogRoutes.ts:148` (findUnique)
  - const page = await prisma.wikiPage.findUnique({
- `routes/entityCatalogRoutes.ts:186` (findUnique)
  - const page = await prisma.wikiPage.findUnique({
- `routes/entityCatalogRoutes.ts:239` (findUnique)
  - const page = await prisma.wikiPage.findUnique({
- `routes/entityCatalogRoutes.ts:281` (findUnique)
  - const page = await prisma.wikiPage.findUnique({
- `routes/entityCatalogRoutes.ts:343` (findUnique)
  - const page = await prisma.wikiPage.findUnique({
- `routes/entityCatalogRoutes.ts:411` (findUnique)
  - const page = await prisma.wikiPage.findUnique({ where: { id }, select: { clientNumber: true, pageType: true } });
- `routes/entityCatalogRoutes.ts:423` (findUnique)
  - const page = await prisma.wikiPage.findUnique({ where: { id } });
- `routes/entityCatalogRoutes.ts:447` (findUnique)
  - const page = await prisma.wikiPage.findUnique({ where: { id } });
- `routes/entityCatalogRoutes.ts:696` (findMany)
  - const rows = await prisma.wikiPage.findMany({
- `routes/entityCatalogRoutes.ts:758` (findUnique)
  - const page = await prisma.wikiPage.findUnique({
- `routes/entityCatalogRoutes.ts:1032` (findMany)
  - const rows = await prisma.wikiPage.findMany({
- `routes/entityCatalogRoutes.ts:1178` (findUnique)
  - const row = await prisma.wikiPage.findUnique({
- `routes/healthRoutes.ts:437` (count)
  - prisma.wikiPage.count({ where: visibilityWhere }),
- `routes/healthRoutes.ts:438` (count)
  - prisma.wikiPage.count({ where: { ...visibilityWhere, status: 'contradicted' } as any }),
- `routes/healthRoutes.ts:439` (count)
  - prisma.wikiPage.count({ where: { ...visibilityWhere, status: 'stale' } as any }),
- `routes/healthRoutes.ts:440` (count)
  - prisma.wikiPage.count({ where: { ...visibilityWhere, inboundLinks: 0, outboundLinks: 0 } as any }),
- `routes/personalContactsRoutes.ts:90` (count)
  - const wikiCount = await prisma.wikiPage.count({
- `routes/wikiRoutes.ts:62` (findFirst)
  - const target = await prisma.wikiPage.findFirst({
- `routes/wikiRoutes.ts:125` (findMany)
  - const rows = await prisma.wikiPage.findMany({
- `routes/wikiRoutes.ts:199` (groupBy)
  - prisma.wikiPage.groupBy({
- `routes/wikiRoutes.ts:204` (groupBy)
  - prisma.wikiPage.groupBy({
- `scripts/backfillConceptPages.ts:42` (findMany)
  - const projects = await prisma.wikiPage.findMany({
- `scripts/seedOpsManual.ts:229` (findFirst)
  - const existing = await prisma.wikiPage.findFirst({
- `scripts/smokeBatch2.ts:31` (findFirst)
  - const project = await prisma.wikiPage.findFirst({
- `scripts/smokeBatch2.ts:36` (findFirst)
  - const policy = await prisma.wikiPage.findFirst({
- `scripts/smokeBatch2.ts:51` (findFirst)
  - const filed = await prisma.wikiPage.findFirst({
- `scripts/smokeBatch2.ts:83` (findFirst)
  - const report = await prisma.wikiPage.findFirst({
- `scripts/smokeBrainIntelligence.ts:124` (findFirst)
  - const latest = await prisma.wikiPage.findFirst({
- `scripts/smokeFeedback.ts:50` (findUnique)
  - const d = await prisma.wikiPage.findUnique({
- `scripts/smokeMeetingDigest.ts:53` (findUnique)
  - const mm = await prisma.wikiPage.findUnique({
  - ... +65 more

## `prisma.wikiPageLink` — 1 📋 review

- `scripts/smokeFeedback.ts:40` (findFirst)
  - const link = await prisma.wikiPageLink.findFirst({

## `prisma.wikiPageSource` — 1 📋 review

- `services/knowledge/wikiScribeService.ts:208` (findFirst)
  - const alreadyCited = await prisma.wikiPageSource.findFirst({

