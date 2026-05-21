# Tenant-Scoping Audit

Scanned 516 TypeScript files. Found 403 suspicious calls.

Each entry below shows a `prisma.<model>.find*` call whose surrounding 12 lines do NOT contain `userId` or `clientNumber` as a filter key. Review each:
- If the call is intentionally tenant-shared, add `// tenant-audit: exempt <reason>` on the line.
- If the model itself is tenant-shared by design, add it to EXEMPT_MODELS in the audit script.
- Otherwise, FIX by adding `userId` and/or `clientNumber` to the `where` clause.

## `prisma.actionDependency` — 2 findings

- `services/actions/dependencyGraphService.ts:39` (findMany)
  - const edges = await prisma.actionDependency.findMany({
- `services/actions/dependencyGraphService.ts:72` (findMany)
  - const edges = await prisma.actionDependency.findMany({

## `prisma.actionIdempotencyLog` — 1 finding

- `services/actionIdempotencyService.ts:58` (findUnique)
  - const row = await prisma.actionIdempotencyLog.findUnique({

## `prisma.actionUndoLog` — 1 finding

- `scripts/_smoke_undo.ts:17` (findFirst)
  - const log = await prisma.actionUndoLog.findFirst({ where: { actionId: r1.actionId } });

## `prisma.agent` — 1 finding

- `agents/agentFrameworkService.ts:127` (findUnique)
  - const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { errorCount: true } });

## `prisma.agentAction` — 19 findings

- `jobs/openItemFollowUpJob.ts:164` (findMany)
  - const rows = await prisma.agentAction.findMany({
- `routes/pushRoutes.ts:122` (findUnique)
  - const action = await prisma.agentAction.findUnique({
- `scripts/_smoke_undo.ts:19` (findUnique)
  - const act = await prisma.agentAction.findUnique({ where: { id: r1.actionId } });
- `scripts/chaosDrill.ts:165` (findUnique)
  - const after = await prisma.agentAction.findUnique({ where: { id: row.id } });
- `services/actions/cascadingUndoService.ts:25` (findFirst)
  - const root = await prisma.agentAction.findFirst({
- `services/entity/graphService.ts:83` (findMany)
  - ? await prisma.agentAction.findMany({
- `services/knowledge/feedbackService.ts:368` (findUnique)
  - const a = await prisma.agentAction.findUnique({
- `services/knowledge/organizationKnowledge.ts:104` (findMany)
  - prisma.agentAction.findMany({
- `services/knowledge/preferenceLearnerService.ts:99` (findMany)
  - const rows = await prisma.agentAction.findMany({
- `services/reflection/reflectionService.ts:106` (count)
  - const autoCount = await prisma.agentAction.count({
- `services/risk/riskGatingService.ts:86` (findMany)
  - out.relatedActions = await prisma.agentAction.findMany({
- `services/steering/morningBriefService.ts:98` (findMany)
  - prisma.agentAction.findMany({
- `services/steering/morningBriefService.ts:172` (findMany)
  - prisma.agentAction.findMany({
- `services/steering/morningBriefService.ts:195` (count)
  - prisma.agentAction.count({ where: { clientNumber, userId, status: 'done', requiresApproval: false, createdAt: { gte: today0 } } as any }).catch(() => 0),
- `services/steering/morningBriefService.ts:196` (count)
  - prisma.agentAction.count({ where: { clientNumber, userId, status: 'done', requiresApproval: true, createdAt: { gte: today0 } } as any }).catch(() => 0),
- `services/steering/steeringWheelService.ts:47` (count)
  - prisma.agentAction.count({ where: { clientNumber, updatedAt: { gte: periodStart, lt: periodEnd }, status: 'done' } }),
- `services/steering/steeringWheelService.ts:48` (count)
  - prisma.agentAction.count({ where: { clientNumber, updatedAt: { gte: periodStart, lt: periodEnd }, status: 'error' } }),
- `services/triage/triageSuggester.ts:1114` (findMany)
  - const brainHandledRows = await prisma.agentAction.findMany({
- `services/whatsapp/UserWebjsProvider.ts:230` (findFirst)
  - const pending = await prisma.agentAction.findFirst({

## `prisma.auditLog` — 1 finding

- `services/auditService.ts:46` (findMany)
  - return prisma.auditLog.findMany({

## `prisma.brainConfig` — 7 findings

- `services/brainConfigService.ts:80` (findUnique)
  - const existing = await prisma.brainConfig.findUnique({ where: { userId } });
- `services/brainConfigService.ts:170` (findUnique)
  - const config = await prisma.brainConfig.findUnique({ where: { userId } });
- `services/brainEngineService.ts:37` (findUnique)
  - const config = await prisma.brainConfig.findUnique({ where: { userId } }) as any;
- `services/brainEngineService.ts:248` (findUnique)
  - const config = await prisma.brainConfig.findUnique({ where: { userId } }) as any;
- `services/dayBriefingService.ts:34` (findUnique)
  - const brainConfig = await prisma.brainConfig.findUnique({ where: { userId } }) as any;
- `services/patternAnalysisService.ts:115` (findUnique)
  - const brain = await prisma.brainConfig.findUnique({ where: { userId } });
- `services/userContextService.ts:69` (findUnique)
  - prisma.brainConfig.findUnique({ where: { userId } }).then(bc => ({

## `prisma.brainPromptQueue` — 9 findings

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
- `services/knowledge/systemCapabilitiesService.ts:103` (findFirst)
  - prisma.brainPromptQueue.findFirst({
- `services/knowledge/systemCapabilitiesService.ts:142` (count)
  - (await prisma.brainPromptQueue.count({
- `services/triage/starCadenceService.ts:299` (findMany)
  - const rows = await prisma.brainPromptQueue.findMany({

## `prisma.brainUserMessage` — 2 findings

- `services/brainPrompts/brainPromptQueueService.ts:369` (findFirst)
  - const recent = await prisma.brainUserMessage.findFirst({
- `services/brainPrompts/negativeFeedbackHandler.ts:188` (findMany)
  - const rows = await prisma.brainUserMessage.findMany({

## `prisma.clientLicense` — 2 findings

- `services/licenseService.ts:23` (findUnique)
  - const license = await prisma.clientLicense.findUnique({
- `services/licenseService.ts:47` (findUnique)
  - const license = await prisma.clientLicense.findUnique({ where: { clientNumber } });

## `prisma.connectorType` — 19 findings

- `routes/admin/clientConnectorRoutes.ts:345` (findFirst)
  - const gmailType = await prisma.connectorType.findFirst({ where: { slug: 'gmail' }, select: { id: true } });
- `services/adapters/impl/msGraphHelper.ts:43` (findUnique)
  - const ct = await prisma.connectorType.findUnique({ where: { slug } });
- `services/adapters/impl/onedriveFeedAdapter.ts:130` (findUnique)
  - const ct = await prisma.connectorType.findUnique({ where: { slug: 'onedrive_personal' } });
- `services/adapters/impl/outlookFeedAdapter.ts:202` (findUnique)
  - const ct = await prisma.connectorType.findUnique({ where: { slug: 'outlook' } });
- `services/connectorRegistry.ts:647` (findUnique)
  - const existing = await prisma.connectorType.findUnique({ where: { slug: ct.slug } });
- `services/connectorService.ts:21` (findMany)
  - return prisma.connectorType.findMany({ where, orderBy: [{ category: 'asc' }, { name: 'asc' }] });
- `services/connectorService.ts:245` (findUnique)
  - const connectorType = await prisma.connectorType.findUnique({ where: { slug } });
- `services/connectorService.ts:261` (findUnique)
  - const connectorType = await prisma.connectorType.findUnique({ where: { slug } });
- `services/connectorService.ts:314` (findUnique)
  - const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
- `services/connectorService.ts:389` (findUnique)
  - const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
- `services/connectorService.ts:584` (findUnique)
  - const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
- `services/connectorService.ts:775` (findUnique)
  - const connectorType = await prisma.connectorType.findUnique({ where: { id: connectorTypeId } });
- `services/connectorSyncTracker.ts:42` (findMany)
  - const connectorTypes = await prisma.connectorType.findMany({
- `services/connectorSyncTracker.ts:98` (findMany)
  - const allGoogleTypes = await prisma.connectorType.findMany({
- `services/connectors/notionConnectorService.ts:143` (findFirst)
  - const notionType = await prisma.connectorType.findFirst({ where: { slug: 'notion' } });
- `services/integrationService.ts:106` (findMany)
  - const googleConnectorTypes = await prisma.connectorType.findMany({ where: { slug: { in: googleSlugs } } });
- `services/tenantBootstrap.ts:27` (findMany)
  - const types = await prisma.connectorType.findMany({
- `services/welcomeService.ts:200` (findUnique)
  - const gmailType = await prisma.connectorType.findUnique({ where: { slug: 'gmail' } });
- `services/whatsapp/UserWebjsProvider.ts:316` (findUnique)
  - const type = await prisma.connectorType.findUnique({ where: { slug: 'whatsapp_personal' } });

## `prisma.conversation` — 1 finding

- `controllers/chatController.ts:59` (findFirst)
  - const conv = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });

## `prisma.decisionLog` — 18 findings

- `routes/briefRoutes.ts:2884` (findMany)
  - const rows = await prisma.decisionLog.findMany({
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

## `prisma.delegationLog` — 2 findings

- `routes/briefRoutes.ts:2931` (findMany)
  - const rows = await prisma.delegationLog.findMany({
- `services/triage/triageSuggester.ts:251` (findMany)
  - prisma.delegationLog.findMany({

## `prisma.delegationMatrix` — 4 findings

- `services/knowledge/delegationMatrixService.ts:62` (findMany)
  - return prisma.delegationMatrix.findMany({
- `services/knowledge/delegationMatrixService.ts:83` (findUnique)
  - const existing = await prisma.delegationMatrix.findUnique({
- `services/knowledge/delegationMatrixService.ts:134` (findUnique)
  - const existing = await prisma.delegationMatrix.findUnique({
- `services/knowledge/entitySweepService.ts:828` (findMany)
  - const rows = await prisma.delegationMatrix.findMany({

## `prisma.entity` — 19 findings

- `routes/personalContactsRoutes.ts:101` (count)
  - const entityCount = await prisma.entity.count({
- `services/entity/graphService.ts:49` (findFirst)
  - const ent = await prisma.entity.findFirst({
- `services/knowledge/conceptSynthesizerService.ts:324` (findMany)
  - const people = entityIds.length > 0 ? await prisma.entity.findMany({
- `services/knowledge/contactResolver.ts:118` (findMany)
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

## `prisma.entityLink` — 6 findings

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

## `prisma.feedEvent` — 35 findings

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
- `routes/briefRoutes.ts:1272` (findUnique)
  - const fe = await prisma.feedEvent.findUnique({
- `routes/briefRoutes.ts:1402` (findUnique)
  - const sFe = await prisma.feedEvent.findUnique({
- `routes/healthRoutes.ts:343` (count)
  - const dlqCount = await prisma.feedEvent.count({
- `routes/personalContactsRoutes.ts:77` (count)
  - const feedCount = await prisma.feedEvent.count({
- `scripts/backfillFeedEventAt.ts:34` (findMany)
  - const rows = await (prisma.feedEvent.findMany({
- `scripts/loadTestFeed.ts:101` (count)
  - const inDb = await prisma.feedEvent.count({ where: { contentHash: { startsWith: 'chaos_loadtest_' } } });
- `services/instructions/instructionDispatcher.ts:121` (findFirst)
  - const fe = await prisma.feedEvent.findFirst({
- `services/instructions/instructionDispatcher.ts:237` (findFirst)
  - const fe = await prisma.feedEvent.findFirst({
- `services/instructions/instructionExtractor.ts:98` (findMany)
  - const rows = await prisma.feedEvent.findMany({
- `services/knowledge/brainComposer.ts:1880` (findUnique)
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
- `services/steering/steeringWheelService.ts:50` (count)
  - prisma.feedEvent.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd } } }),
- `services/triage/autonomousExecutor.ts:80` (findUnique)
  - const fe = await prisma.feedEvent.findUnique({ where: { id: event.id }, select: { sourceId: true } });
- `services/triage/triageSuggester.ts:1202` (findMany)
  - const repliedFeeds = await prisma.feedEvent.findMany({
- `services/triage/triageSuggester.ts:2175` (findMany)
  - const repliedFeeds = await prisma.feedEvent.findMany({
- `services/views/calendar.ts:96` (findMany)
  - const rows = await prisma.feedEvent.findMany({

## `prisma.gateRule` — 6 findings

- `routes/gateRulesRoutes.ts:128` (findUnique)
  - const existing = await prisma.gateRule.findUnique({ where: { id } });
- `routes/gateRulesRoutes.ts:163` (findUnique)
  - const existing = await prisma.gateRule.findUnique({ where: { id } });
- `routes/gateRulesRoutes.ts:299` (findUnique)
  - const existing = await prisma.gateRule.findUnique({ where: { id } });
- `routes/gateRulesRoutes.ts:334` (findUnique)
  - const existing = await prisma.gateRule.findUnique({ where: { id } });
- `scripts/smokeRiskRadarV2.ts:86` (count)
  - const sysGate = await prisma.gateRule.count({ where: { scope: 'system', enabled: true } });
- `services/triage/systemRuleSeeder.ts:174` (findFirst)
  - const existing = await prisma.gateRule.findFirst({

## `prisma.gateRuleOverride` — 1 finding

- `services/triage/ruleEngineService.ts:189` (findMany)
  - const overrides = await prisma.gateRuleOverride.findMany({

## `prisma.kpiValue` — 3 findings

- `services/steering/steeringWheelService.ts:108` (groupBy)
  - const latest = await prisma.kpiValue.groupBy({
- `services/steering/steeringWheelService.ts:117` (findFirst)
  - const current = await prisma.kpiValue.findFirst({
- `services/steering/steeringWheelService.ts:122` (findFirst)
  - const previous = await prisma.kpiValue.findFirst({

## `prisma.license` — 2 findings

- `services/licenseService.ts:111` (findMany)
  - const prices = await prisma.license.findMany({ where: { isActive: true } });
- `services/licenseService.ts:173` (findMany)
  - return prisma.license.findMany({ where: { isActive: true }, orderBy: { roleType: 'asc' } });

## `prisma.message` — 2 findings

- `services/chatHistoryService.ts:90` (findMany)
  - return prisma.message.findMany({
- `services/welcomeService.ts:176` (findMany)
  - prisma.message.findMany({

## `prisma.mutedSender` — 2 findings

- `services/triage/triageSuggester.ts:1138` (findMany)
  - const mutedRows = await prisma.mutedSender.findMany({
- `services/triage/triageSuggester.ts:2123` (findMany)
  - const mutedRows = await prisma.mutedSender.findMany({

## `prisma.notificationQueue` — 1 finding

- `services/notifications/notificationService.ts:54` (findMany)
  - const claimable = await prisma.notificationQueue.findMany({

## `prisma.openItem` — 58 findings

- `jobs/delegationFollowUpJob.ts:62` (findMany)
  - const items = await prisma.openItem.findMany({
- `routes/profileRoutes.ts:584` (count)
  - const count = await prisma.openItem.count({ where });
- `routes/profileRoutes.ts:597` (count)
  - const count = await prisma.openItem.count({ where });
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
- `scripts/smokeBrainPromptReplyFlow.ts:146` (findFirst)
  - const updated3 = await prisma.openItem.findFirst({ where: { id: item3 } });
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
- `services/entity/graphService.ts:75` (findMany)
  - const items = await prisma.openItem.findMany({
- `services/entityPropagationService.ts:128` (findMany)
  - const allItems = await prisma.openItem.findMany({
- `services/instructions/instructionDispatcher.ts:479` (findFirst)
  - const existing = await prisma.openItem.findFirst({
- `services/instructions/instructionDispatcher.ts:543` (findMany)
  - const candidates = await prisma.openItem.findMany({
- `services/knowledge/brainComposer.ts:1696` (findFirst)
  - const existing = await prisma.openItem.findFirst({
- `services/knowledge/contextEnricher.ts:240` (findMany)
  - const relatedOpenItems = await prisma.openItem.findMany({
- `services/knowledge/organizationKnowledge.ts:88` (findMany)
  - prisma.openItem.findMany({
- `services/knowledge/organizationKnowledge.ts:114` (count)
  - prisma.openItem.count({ where: { clientNumber, userId, status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO', 'DELEGATED'] as any } } as any }).catch(() => 0),
- `services/knowledge/organizationKnowledge.ts:115` (count)
  - prisma.openItem.count({ where: { clientNumber, userId, status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS'] as any }, priority: 'critical' } as any }).catch(() => 0),
- `services/knowledge/organizationKnowledge.ts:116` (count)
  - prisma.openItem.count({ where: { clientNumber, userId, status: 'DELEGATED' } as any }).catch(() => 0),
- `services/knowledge/organizationKnowledge.ts:117` (count)
  - prisma.openItem.count({ where: { clientNumber, userId, status: 'WAITING_INFO' } as any }).catch(() => 0),
- `services/openItemsService.ts:87` (count)
  - const wrongCount = await prisma.openItem.count({
- `services/openItemsService.ts:105` (findMany)
  - const recentWrongs = await prisma.openItem.findMany({
- `services/openItemsService.ts:152` (findFirst)
  - const existing = await prisma.openItem.findFirst({ where: dedupWhere }).catch(() => null);
- `services/openItemsService.ts:334` (findMany)
  - const rows = await prisma.openItem.findMany({
- `services/openItemsService.ts:388` (findFirst)
  - const item = await prisma.openItem.findFirst({ where: { id, clientNumber } });
- `services/openItemsService.ts:419` (findFirst)
  - const item = await prisma.openItem.findFirst({ where: { id, clientNumber } });
- `services/openItemsService.ts:445` (findFirst)
  - const item = await prisma.openItem.findFirst({ where: { id, clientNumber } });
- `services/openItemsService.ts:462` (findMany)
  - const items = await prisma.openItem.findMany({
- `services/openItemsService.ts:484` (findFirst)
  - return prisma.openItem.findFirst({
- `services/priorityScoreService.ts:34` (findFirst)
  - const item = await prisma.openItem.findFirst({ where: { id: itemId, clientNumber } });
- `services/reflection/reflectionService.ts:134` (count)
  - const staleCount = await prisma.openItem.count({
- `services/risk/riskGatingService.ts:74` (findMany)
  - out.relatedOpenItems = await prisma.openItem.findMany({
- `services/risk/riskGatingService.ts:98` (findFirst)
  - const item = await prisma.openItem.findFirst({
- `services/shadowScoringService.ts:48` (findMany)
  - const aiTopItems = await prisma.openItem.findMany({
- `services/situationService.ts:19` (groupBy)
  - const entityGroups = await prisma.openItem.groupBy({
- `services/situationService.ts:51` (findMany)
  - const items = await prisma.openItem.findMany({
- `services/steering/morningBriefService.ts:88` (findMany)
  - prisma.openItem.findMany({
- `services/steering/morningBriefService.ts:167` (count)
  - prisma.openItem.count({ where: { clientNumber, userId, type: 'email', status: { in: ['NEW', 'TRIAGED'] as any } } as any }).catch(() => 0),
- `services/steering/morningBriefService.ts:171` (count)
  - prisma.openItem.count({ where: { clientNumber, userId, sourceFeed: 'whatsapp', status: { in: ['NEW', 'TRIAGED'] as any } } as any }).catch(() => 0),
- `services/steering/steeringWheelService.ts:49` (count)
  - prisma.openItem.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd } } }),
- `services/thoughtPipelineService.ts:73` (groupBy)
  - prisma.openItem.groupBy({
- `services/userContextService.ts:57` (findMany)
  - prisma.openItem.findMany({

## `prisma.patternHidden` — 2 findings

- `services/triage/triageSuggester.ts:1286` (findMany)
  - const hidden = await prisma.patternHidden.findMany({
- `services/triage/triageSuggester.ts:2263` (findMany)
  - const hidden = await prisma.patternHidden.findMany({

## `prisma.patternInsight` — 1 finding

- `services/reflection/reflectionService.ts:48` (findMany)
  - const existing = await prisma.patternInsight.findMany({

## `prisma.pushSubscription` — 3 findings

- `services/notifications/pushService.ts:164` (findMany)
  - return prisma.pushSubscription.findMany({
- `services/notifications/pushService.ts:228` (findMany)
  - const subs = await prisma.pushSubscription.findMany({
- `services/notifications/pushService.ts:332` (aggregate)
  - const recent = await prisma.pushSubscription.aggregate({

## `prisma.retrievalFeedback` — 2 findings

- `services/knowledge/retrievalFeedbackService.ts:119` (findMany)
  - const rows = await prisma.retrievalFeedback.findMany({
- `services/knowledge/retrievalFeedbackService.ts:150` (findMany)
  - const rows = await prisma.retrievalFeedback.findMany({

## `prisma.riskFlagDoc` — 2 findings

- `routes/riskRadarRoutes.ts:90` (findUnique)
  - const doc = await prisma.riskFlagDoc.findUnique({ where: { id: req.params.docId as string } });
- `scripts/smokeRiskRadarV2.ts:227` (findUnique)
  - const doc = await prisma.riskFlagDoc.findUnique({ where: { id: result.docId } });

## `prisma.riskRule` — 6 findings

- `scripts/smokeRiskRadarV2.ts:84` (count)
  - const sysRisk = await prisma.riskRule.count({ where: { scope: 'system', enabled: true } });
- `scripts/smokeRiskRadarV2.ts:273` (findUnique)
  - const post = await prisma.riskRule.findUnique({ where: { id: created.id } });
- `services/brain/riskRulesSeeder.ts:160` (findFirst)
  - const existing = await prisma.riskRule.findFirst({
- `services/brain/riskRulesSeeder.ts:217` (findFirst)
  - const already = await prisma.riskRule.findFirst({
- `services/brain/riskRulesService.ts:111` (findMany)
  - const rules = await prisma.riskRule.findMany({ where, orderBy: [{ scope: 'asc' }, { name: 'asc' }] });
- `services/brain/riskRulesService.ts:151` (findUnique)
  - const existing = await prisma.riskRule.findUnique({ where: { id } });

## `prisma.riskRuleOverride` — 2 findings

- `services/brain/riskRulesService.ts:75` (findMany)
  - const overrides = await prisma.riskRuleOverride.findMany({
- `services/brain/riskRulesService.ts:112` (findMany)
  - const overrides = await prisma.riskRuleOverride.findMany({

## `prisma.ruleLifecycle` — 5 findings

- `services/actions/handlers/governance/freezeRule.ts:28` (findUnique)
  - const rule = await prisma.ruleLifecycle.findUnique({ where: { id: ctx.payload.ruleId as string } });
- `services/shadow/ruleLifecycleService.ts:50` (findFirst)
  - const rule = await prisma.ruleLifecycle.findFirst({ where: { id: ruleId, clientNumber } });
- `services/shadow/ruleLifecycleService.ts:83` (findFirst)
  - const rule = await prisma.ruleLifecycle.findFirst({ where: { id: ruleId, clientNumber } });
- `services/shadow/ruleLifecycleService.ts:199` (findMany)
  - return prisma.ruleLifecycle.findMany({
- `services/shadow/shadowEvaluator.ts:127` (findMany)
  - const rules = await prisma.ruleLifecycle.findMany({

## `prisma.scheduledTask` — 4 findings

- `services/schedulerService.ts:34` (findUnique)
  - const task = await prisma.scheduledTask.findUnique({
- `services/schedulerService.ts:138` (findMany)
  - const tasks = await prisma.scheduledTask.findMany({ where: { isActive: true } });
- `services/schedulerService.ts:481` (findFirst)
  - const task = await prisma.scheduledTask.findFirst({ where: { id: taskId, userId } });
- `services/userContextService.ts:87` (findMany)
  - prisma.scheduledTask.findMany({

## `prisma.shadowRule` — 4 findings

- `routes/briefRoutes.ts:1334` (findUnique)
  - const rule = await prisma.shadowRule.findUnique({ where: { id: ruleId } }).catch(() => null);
- `services/knowledge/organizationKnowledge.ts:98` (findMany)
  - prisma.shadowRule.findMany({
- `services/steering/morningBriefService.ts:179` (findMany)
  - prisma.shadowRule.findMany({
- `services/triage/ruleMiner.ts:157` (findUnique)
  - const existing = await prisma.shadowRule.findUnique({ where: { id: ruleId } }).catch(() => null);

## `prisma.shadowScore` — 1 finding

- `services/shadow/ruleLifecycleService.ts:142` (findMany)
  - const recent = await prisma.shadowScore.findMany({

## `prisma.systemConfig` — 16 findings

- `jobs/attachmentBackfillWorker.ts:45` (findUnique)
  - const row = await prisma.systemConfig.findUnique({
- `jobs/attachmentBackfillWorker.ts:61` (findUnique)
  - prisma.systemConfig.findUnique({
- `jobs/attachmentBackfillWorker.ts:293` (findUnique)
  - prisma.systemConfig.findUnique({
- `jobs/attachmentBackfillWorker.ts:296` (findUnique)
  - prisma.systemConfig.findUnique({
- `jobs/attachmentBackfillWorker.ts:299` (findUnique)
  - prisma.systemConfig.findUnique({
- `jobs/attachmentBackfillWorker.ts:325` (findUnique)
  - const activationIso = (await prisma.systemConfig.findUnique({
- `routes/healthRoutes.ts:14` (findFirst)
  - const config = await prisma.systemConfig.findFirst({ where: { key: 'app_name' } }).catch(() => null);
- `routes/healthRoutes.ts:41` (findFirst)
  - const row = await prisma.systemConfig.findFirst({ where: { key: 'client_logo' } }).catch(() => null);
- `routes/profileRoutes.ts:101` (findUnique)
  - const row = await prisma.systemConfig.findUnique({
- `services/aiConfigService.ts:46` (findMany)
  - const rows = await prisma.systemConfig.findMany({
- `services/knowledge/folderScribeService.ts:68` (findFirst)
  - const cfg = await prisma.systemConfig.findFirst({
- `services/knowledge/folderScribeService.ts:316` (findUnique)
  - const cfg = await prisma.systemConfig.findUnique({
- `services/knowledge/systemCapabilitiesService.ts:60` (findUnique)
  - prisma.systemConfig.findUnique({
- `services/llmSpendService.ts:90` (findUnique)
  - const existing = await prisma.systemConfig.findUnique({
- `services/llmSpendService.ts:285` (findUnique)
  - const cfg = await prisma.systemConfig.findUnique({
- `services/risk/riskEvaluator.ts:42` (findMany)
  - const rows = await prisma.systemConfig.findMany({

## `prisma.thoughtEntry` — 5 findings

- `jobs/notionReverseSync.ts:59` (findFirst)
  - const local = await prisma.thoughtEntry.findFirst({
- `services/dayBriefingService.ts:360` (findMany)
  - const drafts = await prisma.thoughtEntry.findMany({
- `services/patternAnalysisService.ts:76` (findFirst)
  - const existingInsight = await prisma.thoughtEntry.findFirst({
- `services/thoughtPipelineService.ts:141` (findFirst)
  - const entry = await prisma.thoughtEntry.findFirst({ where: { id: entryId, userId, clientNumber } });
- `services/thoughtPipelineService.ts:163` (findMany)
  - return prisma.thoughtEntry.findMany({

## `prisma.user` — 79 findings

- `jobs/gmailReadStateSyncJob.ts:73` (findUnique)
  - const userRow = await prisma.user.findUnique({
- `jobs/junkContactCleanupJob.ts:45` (findMany)
  - const allUsers = await prisma.user.findMany({
- `jobs/openItemFollowUpJob.ts:194` (findFirst)
  - const u = await prisma.user.findFirst({
- `jobs/openItemFollowUpJob.ts:375` (findMany)
  - ? await prisma.user.findMany({
- `middleware/agentAuthMiddleware.ts:54` (findFirst)
  - const sa = await prisma.user.findFirst({
- `routes/admin/clientConnectorRoutes.ts:292` (findFirst)
  - const adminRow = await prisma.user.findFirst({
- `routes/admin/clientConnectorRoutes.ts:437` (findFirst)
  - const admin = await prisma.user.findFirst({
- `routes/admin/clientDriveRoutes.ts:98` (findFirst)
  - const admin = await prisma.user.findFirst({
- `routes/briefRoutes.ts:437` (findUnique)
  - const userRow = await prisma.user.findUnique({
- `routes/entityCatalogRoutes.ts:820` (findUnique)
  - const me = await prisma.user.findUnique({
- `routes/entityCatalogRoutes.ts:881` (findUnique)
  - const me = await prisma.user.findUnique({
- `routes/healthRoutes.ts:393` (findUnique)
  - const me: any = await prisma.user.findUnique({
- `routes/personalContactsRoutes.ts:54` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:14` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:43` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:111` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:133` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:218` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:254` (findUnique)
  - const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
- `routes/profileRoutes.ts:345` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:358` (findUnique)
  - const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
- `routes/profileRoutes.ts:388` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:399` (findUnique)
  - const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
- `routes/profileRoutes.ts:457` (findUnique)
  - const u = await prisma.user.findUnique({
- `routes/profileRoutes.ts:469` (findUnique)
  - const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { notificationPreferences: true } });
- `routes/userAuthRoutes.ts:212` (findFirst)
  - const user = await prisma.user.findFirst({ where: { inviteToken: req.params.token as string } });
- `scripts/brainChatRegressionBattery.ts:564` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
- `scripts/seedOpsManual.ts:218` (findFirst)
  - const owner = await prisma.user.findFirst({
- `scripts/smokeBrainOutbound.ts:54` (findUnique)
  - const before = await prisma.user.findUnique({
- `scripts/smokeCriticality.ts:50` (findUnique)
  - const user = await prisma.user.findUnique({
- `services/actions/executeViaRegistry.ts:351` (findFirst)
  - const u = await prisma.user.findFirst({
- `services/authService.ts:87` (findFirst)
  - const user = await prisma.user.findFirst({
- `services/authService.ts:198` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId } });
- `services/brainPrompts/delegateeEmailProducer.ts:108` (findFirst)
  - const user = await prisma.user.findFirst({
- `services/briefingService.ts:20` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId } });
- `services/briefingService.ts:52` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId } });
- `services/connectorService.ts:778` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId } });
- `services/dayBriefingService.ts:31` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
- `services/delegation/smartChaseService.ts:324` (findUnique)
  - const u = await prisma.user.findUnique({
- `services/instructions/instructionDispatcher.ts:229` (findFirst)
  - const u = await prisma.user.findFirst({
- `services/instructions/instructionDispatcher.ts:248` (findFirst)
  - const userRow = await prisma.user.findFirst({ where: { id: userId }, select: { name: true } });
- `services/integrationService.ts:231` (findUnique)
  - const user = await prisma.user.findUnique({
- `services/integrationService.ts:347` (findUnique)
  - const user = await prisma.user.findUnique({
- `services/inviteService.ts:45` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId } });
- `services/inviteService.ts:123` (findFirst)
  - const user = await prisma.user.findFirst({ where: { inviteToken: token } });
- `services/inviteService.ts:165` (findFirst)
  - const user = await prisma.user.findFirst({ where: { inviteToken: token } });
- `services/inviteService.ts:178` (findFirst)
  - const user = await prisma.user.findFirst({ where: { email } });
- `services/inviteService.ts:235` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: userId } });
- `services/knowledge/brainComposer.ts:1722` (findFirst)
  - delegateeId: (await prisma.user.findFirst({
- `services/knowledge/brainPersonaService.ts:50` (findUnique)
  - prisma.user.findUnique({
- `services/knowledge/brainPersonaService.ts:177` (findUnique)
  - const user = await prisma.user.findUnique({
- `services/knowledge/conceptSynthesizerService.ts:505` (findFirst)
  - const user = await prisma.user.findFirst({
- `services/knowledge/conceptSynthesizerService.ts:522` (findFirst)
  - const u = await prisma.user.findFirst({
- `services/knowledge/contactResolver.ts:106` (findMany)
  - prisma.user.findMany({
- `services/knowledge/entitySweepService.ts:191` (findUnique)
  - const me = await prisma.user.findUnique({
- `services/knowledge/folderScribeService.ts:74` (findFirst)
  - const u = await prisma.user.findFirst({
- `services/knowledge/folderScribeService.ts:96` (findMany)
  - const users = await prisma.user.findMany({
- `services/knowledge/peopleIntelligenceService.ts:116` (findMany)
  - const rawUsers = await prisma.user.findMany({
- `services/knowledge/wikiScribeService.ts:324` (findUnique)
  - const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, integrationEmail: true } });
- `services/licenseService.ts:31` (count)
  - prisma.user.count({ where: { clientNumber, isActive: true, userType: 'AD' } }),
- `services/licenseService.ts:58` (count)
  - const currentCount = await prisma.user.count({
- `services/notifications/brainHumanComm.ts:79` (findUnique)
  - const u = await prisma.user.findUnique({
- `services/notifications/notificationService.ts:114` (findUnique)
  - const user = await prisma.user.findUnique({ where: { id: row.recipientId }, select: { email: true, name: true } });
- `services/notifications/notificationService.ts:127` (findUnique)
  - const recipient = await prisma.user.findUnique({
- `services/notifications/pushService.ts:283` (findMany)
  - const admins = await prisma.user.findMany({
- `services/openItems/openItemsSettings.ts:66` (findUnique)
  - const u = await prisma.user.findUnique({
- `services/patternAnalysisService.ts:28` (findMany)
  - const users = await prisma.user.findMany({
- `services/shadowScoringService.ts:29` (findMany)
  - const users = await prisma.user.findMany({
- `services/steering/morningBriefService.ts:109` (findUnique)
  - const userRow = await prisma.user.findUnique({
- `services/triage/ruleMiner.ts:52` (findUnique)
  - const u = await prisma.user.findUnique({
- `services/triage/starCadenceService.ts:245` (findUnique)
  - const u = await prisma.user.findUnique({
- `services/triage/triageSuggester.ts:437` (findUnique)
  - const userRow = await prisma.user.findUnique({
- `services/triage/triageSuggester.ts:749` (findUnique)
  - const userEmail = await prisma.user.findUnique({ where: { id: row.userId }, select: { email: true, integrationEmail: true } as any })
- `services/userPreferencesService.ts:40` (findFirst)
  - const user = await prisma.user.findFirst({
- `services/userPreferencesService.ts:62` (findFirst)
  - const user = await prisma.user.findFirst({
- `services/userProfileService.ts:23` (findUnique)
  - const user = await prisma.user.findUnique({
- `services/welcomeService.ts:166` (findUnique)
  - const user = await prisma.user.findUnique({
- `services/whatsapp/UserWebjsProvider.ts:97` (findUnique)
  - const u = await prisma.user.findUnique({ where: { id: userId }, select: { notificationPreferences: true } });
- `services/whatsapp/connectionSync.ts:87` (findMany)
  - const users = await prisma.user.findMany({

## `prisma.userConnector` — 36 findings

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
- `services/adapters/impl/msGraphHelper.ts:45` (findUnique)
  - const uc = await prisma.userConnector.findUnique({
- `services/adapters/impl/onedriveFeedAdapter.ts:135` (findUnique)
  - const uc = await prisma.userConnector.findUnique({
- `services/adapters/impl/outlookFeedAdapter.ts:204` (findUnique)
  - const uc = await prisma.userConnector.findUnique({
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

## `prisma.userPrompt` — 1 finding

- `services/knowledge/userPromptService.ts:26` (findMany)
  - const rows = await prisma.userPrompt.findMany({

## `prisma.userPromptOverlay` — 2 findings

- `services/knowledge/userPromptOverlayService.ts:154` (findMany)
  - const rows = await prisma.userPromptOverlay.findMany({
- `services/knowledge/userPromptOverlayService.ts:198` (findMany)
  - return prisma.userPromptOverlay.findMany({

## `prisma.whatsAppConnection` — 2 findings

- `services/whatsappService.ts:109` (findUnique)
  - const conn = await prisma.whatsAppConnection.findUnique({ where: { userId } });
- `services/whatsappService.ts:232` (findFirst)
  - const conn = await prisma.whatsAppConnection.findFirst({

## `prisma.whatsAppOutboundMessage` — 2 findings

- `jobs/waIngestHealthAudit.ts:124` (count)
  - prisma.whatsAppOutboundMessage.count({
- `jobs/waOutboundReconciliation.ts:99` (findUnique)
  - const before = await prisma.whatsAppOutboundMessage.findUnique({

## `prisma.whatsAppSession` — 2 findings

- `services/whatsappService.ts:306` (findFirst)
  - const existing = await prisma.whatsAppSession.findFirst({
- `services/whatsappService.ts:350` (findUnique)
  - const session = await prisma.whatsAppSession.findUnique({ where: { id: sessionId } });

## `prisma.wikiPageLink` — 1 finding

- `scripts/smokeFeedback.ts:40` (findFirst)
  - const link = await prisma.wikiPageLink.findFirst({

## `prisma.wikiPageSource` — 1 finding

- `services/knowledge/wikiScribeService.ts:208` (findFirst)
  - const alreadyCited = await prisma.wikiPageSource.findFirst({

