# HaseebOS v15 Spec Alignment — Complete VS Code Prompt

Copy everything below this line and paste into VS Code AI (Copilot/Claude):

---

## CONTEXT

I am aligning MyOS (our implemented system) with the HaseebOS v15 original specification. The codebase is a multi-tenant AI executive operating system with:

- **Server**: Express/TypeScript at `server/` (API, handlers, services, Prisma ORM)
- **Agents**: Python/FastAPI at `agents/` (Gemini ADK agents)
- **Client**: React/Vite at `client/` (Steering Wheel UI)
- **Infra**: Terraform at `infra/` (GCP deployment)

There are **19 gaps** between spec and implementation. Complete ALL tasks below sequentially. After each task, run the existing tests to make sure nothing breaks. Do NOT delete any existing functionality — only add or modify.

---

## TASK 1: Open Items State Machine (R9) — Complete Transition Matrix

**Files to modify:**
- `server/src/services/openItemsService.ts`
- `server/prisma/schema.prisma`
- `server/src/types/index.ts`

**What to do:**

The spec defines 8 open item states with a complete transition matrix. Currently we have basic CRUD. Add formal state machine enforcement.

1. In `server/src/types/index.ts`, add this enum and transition matrix:

```typescript
export enum OpenItemStatus {
  NEW = 'NEW',
  TRIAGED = 'TRIAGED',
  IN_PROGRESS = 'IN_PROGRESS',
  DELEGATED = 'DELEGATED',
  WAITING_INFO = 'WAITING_INFO',
  SNOOZED = 'SNOOZED',
  INFORMED = 'INFORMED',
  CLOSED = 'CLOSED',
}

export const VALID_TRANSITIONS: Record<OpenItemStatus, OpenItemStatus[]> = {
  [OpenItemStatus.NEW]: [OpenItemStatus.TRIAGED, OpenItemStatus.CLOSED],
  [OpenItemStatus.TRIAGED]: [OpenItemStatus.IN_PROGRESS, OpenItemStatus.DELEGATED, OpenItemStatus.SNOOZED, OpenItemStatus.CLOSED],
  [OpenItemStatus.IN_PROGRESS]: [OpenItemStatus.WAITING_INFO, OpenItemStatus.DELEGATED, OpenItemStatus.SNOOZED, OpenItemStatus.INFORMED, OpenItemStatus.CLOSED],
  [OpenItemStatus.DELEGATED]: [OpenItemStatus.IN_PROGRESS, OpenItemStatus.WAITING_INFO, OpenItemStatus.CLOSED],
  [OpenItemStatus.WAITING_INFO]: [OpenItemStatus.IN_PROGRESS, OpenItemStatus.SNOOZED, OpenItemStatus.CLOSED],
  [OpenItemStatus.SNOOZED]: [OpenItemStatus.NEW, OpenItemStatus.TRIAGED, OpenItemStatus.CLOSED],
  [OpenItemStatus.INFORMED]: [OpenItemStatus.CLOSED],
  [OpenItemStatus.CLOSED]: [], // terminal state — use reopen handler to go back to NEW
};

export const TRANSITION_GUARDS: Record<string, string> = {
  'NEW->TRIAGED': 'requires archetype assignment',
  'TRIAGED->IN_PROGRESS': 'requires assignee',
  'TRIAGED->DELEGATED': 'requires delegatee and delegation_reason',
  'IN_PROGRESS->INFORMED': 'requires summary of actions taken',
  'IN_PROGRESS->CLOSED': 'requires resolution_note',
  'DELEGATED->IN_PROGRESS': 'requires acceptance from delegatee',
};
```

2. In `server/src/services/openItemsService.ts`, add a `transitionStatus()` method that:
   - Validates the transition is allowed per `VALID_TRANSITIONS`
   - Checks guard conditions per `TRANSITION_GUARDS`
   - Throws `InvalidTransitionError` if not allowed
   - Logs the transition to decision_log with `eventType: 'STATUS_TRANSITION'`
   - Publishes to Pub/Sub topic `tmcai-openitems-scored` with ordering key = `item_id`

3. In `server/prisma/schema.prisma`, ensure the `open_items` model has:
   - `status` field using `OpenItemStatus` enum
   - `archetype` field: `String?` (one of: task, decision, information, escalation, follow_up, recurring)
   - `delegatee` field: `String?`
   - `delegation_reason` field: `String?`
   - `resolution_note` field: `String?`
   - `snoozed_until` field: `DateTime?`

4. Create a new migration: `npx prisma migrate dev --name add_state_machine_fields`

---

## TASK 2: Handler Name Alignment with Spec

**Files to modify:**
- `server/src/services/actions/handlers/` (multiple files)
- `server/src/services/actions/handlerRegistry.ts`

**What to do:**

The spec defines specific handler names. Our implementation has different names for some handlers. Add spec-compatible aliases so both names work.

In `server/src/services/actions/handlerRegistry.ts`, after registering all handlers, add aliases:

```typescript
// Spec-compatible aliases (HaseebOS v15 names → MyOS names)
registry.alias('send_whatsapp', 'send_whatsapp_message');
registry.alias('send_slack', 'send_slack_message');
registry.alias('send_teams', 'send_teams_message');
registry.alias('reschedule', 'reschedule_event');
registry.alias('cancel', 'cancel_event');
registry.alias('update_odoo', 'update_odoo_crm');
registry.alias('create_opportunity', 'create_odoo_opportunity');
registry.alias('reopen', 'reopen_item');  // if reopen handler exists
registry.alias('prioritize', 'update_priority');
registry.alias('deprioritize', 'demote');
registry.alias('recall_memory', 'extract_insight');
registry.alias('summarize_thread', 'sync_thought_to_notion'); // closest match
registry.alias('classify_intent', 'tag_entity'); // closest match
registry.alias('unfreeze_rule', 'log_override'); // closest match
registry.alias('audit_action', 'request_approval'); // closest match
```

If the `handlerRegistry.ts` doesn't have an `alias()` method, add one:

```typescript
alias(specName: string, implName: string): void {
  const handler = this.handlers.get(implName);
  if (handler) {
    this.handlers.set(specName, handler);
  }
}
```

Also add the missing spec handlers that don't have equivalents yet. Create stub files:

- `server/src/services/actions/handlers/communication/sendSms.ts` — if not exists
- `server/src/services/actions/handlers/communication/sendSlackMessage.ts` — if not exists  
- `server/src/services/actions/handlers/communication/sendTeamsMessage.ts` — if not exists
- `server/src/services/actions/handlers/lifecycle/reopen.ts`
- `server/src/services/actions/handlers/lifecycle/prioritize.ts`
- `server/src/services/actions/handlers/lifecycle/deprioritize.ts`
- `server/src/services/actions/handlers/brain/recallMemory.ts`
- `server/src/services/actions/handlers/brain/summarizeThread.ts`
- `server/src/services/actions/handlers/brain/classifyIntent.ts`
- `server/src/services/actions/handlers/governance/unfreezeRule.ts`
- `server/src/services/actions/handlers/governance/auditAction.ts`

Each stub handler should:
- Extend `HandlerBase` from `../handlerBase.ts`
- Have correct `name`, `category`, `riskTier` properties
- Have an `execute()` method that calls the platform API or relevant service
- Have a `reverse()` method for undo support
- Register itself in `handlers/index.ts`

---

## TASK 3: External Knowledge Agent — Add Missing Tools

**Files to modify:**
- `agents/src/agents/external_knowledge.py`

**What to do:**

Spec defines 5 tools for External Knowledge Agent. We only have 3. Add the missing 2:

```python
# Add these tool functions to external_knowledge.py

async def cache_result(ctx, query: str, result: str, ttl_seconds: int = 900) -> dict:
    """Cache a knowledge query result in Redis with TTL (default 15 min).
    Used to avoid redundant LLM calls for repeated questions."""
    redis_key = f"knowledge_cache:{hashlib.sha256(query.encode()).hexdigest()}"
    await ctx.platform_client.post("/cache/set", {
        "key": redis_key,
        "value": result,
        "ttl": ttl_seconds
    })
    return {"cached": True, "key": redis_key, "ttl": ttl_seconds}

async def check_cache(ctx, query: str) -> dict:
    """Check Redis cache for a previous knowledge query result.
    Returns cached result if found, None if miss."""
    redis_key = f"knowledge_cache:{hashlib.sha256(query.encode()).hexdigest()}"
    result = await ctx.platform_client.get(f"/cache/get?key={redis_key}")
    if result and result.get("value"):
        return {"hit": True, "result": result["value"]}
    return {"hit": False, "result": None}
```

Register both tools in the agent's tool list. Also add the corresponding server-side cache endpoints:

In `server/src/routes/`, create `cacheRoutes.ts`:

```typescript
router.post('/cache/set', async (req, res) => {
  const { key, value, ttl } = req.body;
  await redisClient.set(key, JSON.stringify(value), 'EX', ttl || 900);
  res.json({ ok: true });
});

router.get('/cache/get', async (req, res) => {
  const { key } = req.query;
  const value = await redisClient.get(key as string);
  res.json({ value: value ? JSON.parse(value) : null });
});
```

Register this route in `server/src/app.ts`.

---

## TASK 4: Rule Engine / Shadow Scorer — Add Missing Tools

**Files to modify:**
- `agents/src/agents/shadow_scorer.py`

**What to do:**

Spec defines 7 tools for Rule Engine Agent. Our Shadow Scorer has ~4. Add:

```python
async def create_rule(ctx, name: str, description: str, condition: str, action_type: str, risk_tier: str = "LOW") -> dict:
    """Create a new rule in DRAFT status. Must go through 30-day SHADOW period before activation."""
    return await ctx.platform_client.post("/shadow/rules", {
        "name": name, "description": description,
        "condition": condition, "actionType": action_type,
        "riskTier": risk_tier, "status": "DRAFT"
    })

async def promote_rule(ctx, rule_id: str) -> dict:
    """Attempt to promote a rule from DRAFT→SHADOW or SHADOW→ACTIVE.
    Promotion to ACTIVE requires passing the Golden Dataset benchmark."""
    return await ctx.platform_client.post(f"/shadow/rules/{rule_id}/promote", {})

async def evaluate_rule(ctx, rule_id: str, event_data: dict) -> dict:
    """Evaluate a single rule against an event. Returns match score and confidence.
    Used during shadow period to compare against human decisions."""
    return await ctx.platform_client.post(f"/shadow/rules/{rule_id}/evaluate", {
        "eventData": event_data
    })
```

Also verify the existing `score_shadow` and `suggest_rule` tools exist. The total should be 7 tools.

---

## TASK 5: Pub/Sub Topic Naming — Add Spec Aliases

**Files to modify:**
- `server/src/config/pubsub.ts`

**What to do:**

Add spec-compatible topic name constants alongside our `tmcai-*` names:

```typescript
// Current MyOS names
export const TOPICS = {
  FEED_RAW: 'tmcai-feed-raw',
  OPENITEMS_SCORED: 'tmcai-openitems-scored',
  ACTIONS_APPROVED: 'tmcai-actions-approved',
  STEERING_SNAPSHOT: 'tmcai-steering-snapshot',
};

// HaseebOS v15 spec aliases (both resolve to the same topics)
export const SPEC_TOPIC_ALIASES: Record<string, string> = {
  'feed-events': TOPICS.FEED_RAW,
  'open-item-events': TOPICS.OPENITEMS_SCORED,
  'action-executed-events': TOPICS.ACTIONS_APPROVED,
  'steering-wheel-events': TOPICS.STEERING_SNAPSHOT,
};

// DLQ topics
export const DLQ_TOPICS = {
  FEED_DLQ: `${TOPICS.FEED_RAW}-dlq`,
  OPENITEMS_DLQ: `${TOPICS.OPENITEMS_SCORED}-dlq`,
  ACTIONS_DLQ: `${TOPICS.ACTIONS_APPROVED}-dlq`,
  STEERING_DLQ: `${TOPICS.STEERING_SNAPSHOT}-dlq`,
};

// DLQ retention per spec
export const DLQ_RETENTION_DAYS = {
  [DLQ_TOPICS.FEED_DLQ]: 7,
  [DLQ_TOPICS.OPENITEMS_DLQ]: 7,
  [DLQ_TOPICS.ACTIONS_DLQ]: 14,
  [DLQ_TOPICS.STEERING_DLQ]: 3,
};

// Resolve topic name (accepts both spec and impl names)
export function resolveTopic(name: string): string {
  return SPEC_TOPIC_ALIASES[name] || name;
}
```

Update `server/src/services/infra/pubsubPublisher.ts` to use `resolveTopic()` so agents can publish using either naming convention.

---

## TASK 6: Decision Log — Add BigQuery CDC Preparation Layer

**Files to modify:**
- `server/src/services/decisions/decisionLogService.ts`
- `server/src/connectors/BigQueryConnector.ts`
- `server/src/config/featureFlags.ts`

**What to do:**

The spec requires a three-layer Decision Log. We have PG triggers (layer 3 — operational). Add layer 1 (BigQuery immutable) behind a feature flag:

1. In `server/src/config/featureFlags.ts`, add:
```typescript
export const FEATURE_BIGQUERY_DECISION_LOG = process.env.FEATURE_BIGQUERY_DECISION_LOG === 'true';
```

2. In `server/src/services/decisions/decisionLogService.ts`, after every successful write to PG, add:
```typescript
import { FEATURE_BIGQUERY_DECISION_LOG } from '../../config/featureFlags';
import { bigQueryConnector } from '../../connectors/BigQueryConnector';

// After PG insert:
if (FEATURE_BIGQUERY_DECISION_LOG) {
  try {
    await bigQueryConnector.appendDecisionLog({
      ...decisionData,
      _ingested_at: new Date().toISOString(),
      _source: 'cdc_realtime',
      _immutable: true,
    });
  } catch (err) {
    logger.error('BigQuery CDC write failed (non-blocking)', { error: err, traceId });
    // Non-blocking: PG is source of truth, BQ is async copy
  }
}
```

3. In `server/src/connectors/BigQueryConnector.ts`, add the `appendDecisionLog` method:
```typescript
async appendDecisionLog(data: Record<string, any>): Promise<void> {
  const dataset = this.client.dataset('tmcai_audit');
  const table = dataset.table('decision_log_immutable');
  await table.insert([data]);
}
```

4. Update `infra/terraform/modules/bigquery/main.tf` to include the `decision_log_immutable` table with:
   - Partition by `_ingested_at` (DAY)
   - Require partition filter
   - No expiration (retention lock)

---

## TASK 7: Golden Dataset Seeder — Expand for Spec Compliance

**Files to modify:**
- `server/src/scripts/seedGoldenDataset.ts`

**What to do:**

The spec requires 1,000+ curated decisions for the Golden Dataset. Our seeder exists but needs expansion. Update `seedGoldenDataset.ts`:

1. Generate at least 1,000 decision records covering:
   - All 36 action handler types
   - All 3 risk tiers (LOW, MEDIUM, HIGH)
   - All 8 open item states
   - All 6 archetypes
   - Both approved and rejected decisions
   - Edge cases: $10k threshold boundary, external targets, cascading undo scenarios

2. Each golden decision should have:
```typescript
interface GoldenDecision {
  id: string;
  actionType: string;
  riskTier: 'LOW' | 'MEDIUM' | 'HIGH';
  inputContext: Record<string, any>;
  expectedOutcome: 'APPROVE' | 'REJECT' | 'MODIFY';
  expectedReason: string;
  humanDecision: 'APPROVE' | 'REJECT' | 'MODIFY';
  humanReason: string;
  entityType: string;
  archetype: string;
  createdAt: string;
}
```

3. Add a script to evaluate shadow rules against the Golden Dataset:
```typescript
async function evaluateGoldenDataset(ruleId: string): Promise<{
  totalDecisions: number;
  matchRate: number;
  matchRateByTier: { LOW: number; MEDIUM: number; HIGH: number };
  passesThreshold: boolean;
}> {
  // Load all golden decisions
  // Score each against the rule
  // Calculate match rates per tier
  // Check: LOW >= 0.95, MEDIUM >= 0.98, HIGH = manual only
}
```

---

## TASK 8: Open Item Archetypes — Add Classification

**Files to modify:**
- `server/src/services/openItemsService.ts`
- `agents/src/agents/triage_analyst.py`

**What to do:**

The spec defines 6 archetypes for classifying open items. Add:

1. In `server/src/types/index.ts`:
```typescript
export enum Archetype {
  TASK = 'task',
  DECISION = 'decision',
  INFORMATION = 'information',
  ESCALATION = 'escalation',
  FOLLOW_UP = 'follow_up',
  RECURRING = 'recurring',
}
```

2. In `openItemsService.ts`, when creating an open item, auto-classify archetype if not provided:
```typescript
async classifyArchetype(item: OpenItem): Promise<Archetype> {
  // Use existing intentService or call agent for classification
  const result = await this.intentService.classify(item.title + ' ' + item.description);
  return result.archetype || Archetype.TASK;
}
```

3. In `agents/src/agents/triage_analyst.py`, add an `assign_archetype` tool:
```python
async def assign_archetype(ctx, item_id: str, archetype: str) -> dict:
    """Assign one of 6 archetypes to an open item:
    task, decision, information, escalation, follow_up, recurring"""
    valid = ['task', 'decision', 'information', 'escalation', 'follow_up', 'recurring']
    if archetype not in valid:
        return {"error": f"Invalid archetype. Must be one of: {valid}"}
    return await ctx.platform_client.patch(f"/open-items/{item_id}", {
        "archetype": archetype
    })
```

---

## TASK 9: Entity Kinds — Enforce Spec Types

**Files to modify:**
- `server/src/services/entityService.ts`
- `server/src/types/index.ts`

**What to do:**

Spec defines 5 entity kinds: `person`, `company`, `project`, `deal`, `objective` (all lowercase, VARCHAR(32)). Ensure enforcement:

1. In `server/src/types/index.ts`:
```typescript
export const VALID_ENTITY_KINDS = ['person', 'company', 'project', 'deal', 'objective'] as const;
export type EntityKind = typeof VALID_ENTITY_KINDS[number];
```

2. In `entityService.ts`, add validation on create/update:
```typescript
if (!VALID_ENTITY_KINDS.includes(kind)) {
  throw new ValidationError(`Invalid entity kind: ${kind}. Must be one of: ${VALID_ENTITY_KINDS.join(', ')}`);
}
```

---

## TASK 10: Shadow Pipeline — Add Drift Guard & Boundary Rules

**Files to modify:**
- `server/src/services/shadow/shadowEvaluator.ts`
- `server/src/services/shadow/ruleLifecycleService.ts`

**What to do:**

The spec defines drift guard and boundary rules that we partially implement. Add:

1. **Drift Guard** in `shadowEvaluator.ts`:
```typescript
async checkDriftGuard(): Promise<{ drifted: boolean; sigma: number }> {
  // Get last 7 days of shadow scores
  const recentScores = await this.getRecentScores(7);
  const historicalScores = await this.getHistoricalScores(30);
  
  const recentMean = mean(recentScores);
  const historicalMean = mean(historicalScores);
  const historicalStdDev = stdDev(historicalScores);
  
  const sigma = Math.abs(recentMean - historicalMean) / (historicalStdDev || 0.01);
  
  if (sigma > 2) {
    // Freeze ALL promotions
    await this.freezeAllPromotions('drift_guard_triggered', `Sigma shift: ${sigma.toFixed(2)}`);
    // Alert via steering wheel
    await this.alertSteering('DRIFT_GUARD', `Confidence distribution shifted ${sigma.toFixed(1)}σ in 7 days. All promotions frozen.`);
    return { drifted: true, sigma };
  }
  return { drifted: false, sigma };
}
```

2. **Boundary Rules** in `ruleLifecycleService.ts`:
```typescript
async evaluatePromotion(ruleId: string, matchRate: number, riskTier: string, shadowDays: number): Promise<{
  promote: boolean;
  reason: string;
}> {
  if (riskTier === 'HIGH') {
    return { promote: false, reason: 'HIGH risk rules require manual certification. No automatic promotion.' };
  }
  
  const threshold = riskTier === 'LOW' ? 0.95 : 0.98;
  
  if (shadowDays < 30) {
    return { promote: false, reason: `Only ${shadowDays}/30 shadow days completed.` };
  }
  
  // Low-frequency check: need at least 10 samples
  const sampleCount = await this.getSampleCount(ruleId, 30);
  if (sampleCount < 10) {
    return { promote: false, reason: `Only ${sampleCount}/10 minimum samples. Extended observation required.` };
  }
  
  if (matchRate >= threshold) {
    return { promote: true, reason: `Match rate ${(matchRate * 100).toFixed(1)}% >= ${(threshold * 100).toFixed(0)}% threshold.` };
  }
  
  // Boundary rules: close but not passing
  if (riskTier === 'LOW' && matchRate >= 0.949) {
    return { promote: false, reason: `94.9% at day 30: extending 7 days. Alert sent.` };
  }
  if (riskTier === 'MEDIUM' && matchRate >= 0.979) {
    return { promote: false, reason: `97.9% at day 30: extending 14 days. Restricting to LOW-only.` };
  }
  
  return { promote: false, reason: `Match rate ${(matchRate * 100).toFixed(1)}% below ${(threshold * 100).toFixed(0)}% threshold.` };
}
```

---

## TASK 11: Kill Switch — Add Step-Up Re-arm per Spec

**Files to modify:**
- `server/src/services/safety/killSwitchService.ts`
- `server/src/routes/safetyRoutes.ts`

**What to do:**

Our kill switch is <50ms (exceeds spec). But spec requires "step-up auth to re-arm". Add:

1. In `killSwitchService.ts`:
```typescript
async rearm(tenantId: string, userId: string, mfaToken?: string): Promise<{ rearmed: boolean }> {
  // Step-up: require the user who activated kill switch OR an admin
  const killSwitchData = await this.getKillSwitchData(tenantId);
  
  if (!killSwitchData?.active) {
    return { rearmed: false };
  }
  
  // Log re-arm attempt
  await this.logAudit(tenantId, 'KILL_SWITCH_REARM_ATTEMPT', { userId });
  
  // In production, require MFA or additional auth factor
  // For now, require admin role
  const user = await this.getUser(userId);
  if (user.role !== 'AD-Admin' && user.id !== killSwitchData.activatedBy) {
    throw new ForbiddenError('Kill switch re-arm requires admin role or original activator');
  }
  
  // Clear kill switch
  await redisClient.del(`kill_switch:${tenantId}`);
  
  // Log successful re-arm
  await this.logAudit(tenantId, 'KILL_SWITCH_REARMED', { userId, previousActivator: killSwitchData.activatedBy });
  
  return { rearmed: true };
}
```

2. In `safetyRoutes.ts`, add the re-arm endpoint:
```typescript
router.post('/safety/kill-switch/rearm', authMiddleware, async (req, res) => {
  const { mfaToken } = req.body;
  const result = await killSwitchService.rearm(req.tenantId, req.user.id, mfaToken);
  res.json(result);
});
```

---

## TASK 12: GCS Cold Storage Config — Terraform Module

**Files to modify:**
- `infra/terraform/modules/storage/main.tf`
- `infra/terraform/main.tf`

**What to do:**

Add the spec's 3-tier retention policy to GCS:

```hcl
# In modules/storage/main.tf

resource "google_storage_bucket" "decision_log_archive" {
  name          = "${var.project_id}-decision-log-archive"
  location      = var.region
  storage_class = "COLDLINE"
  
  retention_policy {
    is_locked        = true
    retention_period = 94608000  # 3 years in seconds
  }
  
  lifecycle_rule {
    condition {
      age = 365  # Move to archive after 1 year
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }
  
  versioning {
    enabled = true
  }
  
  uniform_bucket_level_access = true
}

resource "google_storage_bucket" "feed_archive" {
  name          = "${var.project_id}-feed-archive"
  location      = var.region
  storage_class = "NEARLINE"
  
  lifecycle_rule {
    condition {
      age = 365  # 12 months hot → nearline
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }
  
  lifecycle_rule {
    condition {
      age = 1095  # 3 years → archive
    }
    action {
      type          = "SetStorageClass"
      storage_class = "ARCHIVE"
    }
  }
  
  uniform_bucket_level_access = true
}
```

---

## TASK 13: Cloud SQL HA Config — Terraform Module

**Files to modify:**
- `infra/terraform/main.tf`

**What to do:**

Ensure the Cloud SQL instance is configured for HA per spec:

```hcl
resource "google_sql_database_instance" "primary" {
  name             = "tmcai-primary"
  database_version = "POSTGRES_15"
  region           = var.region
  
  settings {
    tier = "db-custom-4-16384"
    
    availability_type = "REGIONAL"  # HA: primary + standby
    
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = 7
    }
    
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.vpc_self_link
    }
    
    database_flags {
      name  = "max_connections"
      value = "200"
    }
    
    insights_config {
      query_insights_enabled  = true
      record_application_tags = true
    }
  }
  
  deletion_protection = true
}

# Read replica for analytics
resource "google_sql_database_instance" "read_replica" {
  name                 = "tmcai-replica"
  master_instance_name = google_sql_database_instance.primary.name
  database_version     = "POSTGRES_15"
  region               = var.region
  
  replica_configuration {
    failover_target = false
  }
  
  settings {
    tier              = "db-custom-2-8192"
    availability_type = "ZONAL"
  }
}
```

---

## TASK 14: Agent Memory — Add Vertex AI Memory Bank Abstraction

**Files to modify:**
- `server/src/services/memoryService.ts`
- `server/src/config/featureFlags.ts`

**What to do:**

Add an abstraction layer so we can switch from PG to Vertex AI Memory Bank:

1. In `featureFlags.ts`:
```typescript
export const FEATURE_VERTEX_MEMORY_BANK = process.env.FEATURE_VERTEX_MEMORY_BANK === 'true';
```

2. In `memoryService.ts`, create an interface and two implementations:

```typescript
interface MemoryBackend {
  get(agentId: string, key: string): Promise<string | null>;
  set(agentId: string, key: string, value: string, previousValue?: string): Promise<void>;
  list(agentId: string): Promise<Array<{ key: string; value: string }>>;
  delete(agentId: string, key: string): Promise<void>;
}

class PgMemoryBackend implements MemoryBackend {
  // Current implementation using agent_memory table
}

class VertexMemoryBankBackend implements MemoryBackend {
  // Future: calls Vertex AI Memory Bank API
  // For now, stub that falls back to PG
  async get(agentId: string, key: string) {
    // TODO: Replace with Vertex AI Memory Bank API call
    // POST https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/memoryBanks/{bank}/memories:search
    return this.fallback.get(agentId, key);
  }
}

// Factory
export function createMemoryBackend(): MemoryBackend {
  if (FEATURE_VERTEX_MEMORY_BANK) {
    return new VertexMemoryBankBackend();
  }
  return new PgMemoryBackend();
}
```

---

## TASK 15: Structured Logging — Add Full Trace ID Propagation

**Files to modify:**
- `server/src/middleware/requestId.ts`
- `server/src/utils/logger.ts`
- `agents/src/config.py`

**What to do:**

Ensure Global Trace IDs propagate across all services per spec (R18):

1. In `server/src/middleware/requestId.ts`, ensure every request gets a `traceId`:
```typescript
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const traceId = req.headers['x-trace-id'] as string || `trace-${crypto.randomUUID()}`;
  req.traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);
  
  // Attach to async local storage so all downstream logs include it
  asyncLocalStorage.run({ traceId, tenantId: req.tenantId }, () => next());
}
```

2. In `server/src/utils/logger.ts`, ensure JSON format with trace context:
```typescript
function createLogEntry(level: string, message: string, meta?: any) {
  const store = asyncLocalStorage.getStore();
  return {
    timestamp: new Date().toISOString(),
    level,
    message,
    traceId: store?.traceId || 'no-trace',
    tenantId: store?.tenantId || 'no-tenant',
    service: 'platform-api',
    ...meta,
  };
}
```

3. In `agents/src/config.py`, ensure Python agents propagate traceId:
```python
# When calling platform API, always forward trace ID
async def call_platform(endpoint: str, data: dict, trace_id: str = None):
    headers = {"Content-Type": "application/json"}
    if trace_id:
        headers["X-Trace-Id"] = trace_id
    # ... rest of HTTP call
```

4. In Pub/Sub messages, always include `traceId` as an attribute:
```typescript
// In pubsubPublisher.ts
async publish(topic: string, data: any, attributes?: Record<string, string>) {
  const store = asyncLocalStorage.getStore();
  const enrichedAttributes = {
    ...attributes,
    traceId: store?.traceId || attributes?.traceId || `trace-${crypto.randomUUID()}`,
    tenantId: store?.tenantId || attributes?.tenantId || '',
    publishedAt: new Date().toISOString(),
  };
  // ... publish with enrichedAttributes
}
```

---

## TASK 16: PII Service Enhancement — Toward R13 Compliance

**Files to modify:**
- `server/src/pipeline/piiService.ts`

**What to do:**

We already have a `piiService.ts`. Enhance it for R13 (DLP/PII masking) per spec:

```typescript
// Add to piiService.ts

const PII_PATTERNS = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  phone: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  credit_card: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
  iban: /\b[A-Z]{2}\d{2}[A-Z0-9]{4,}\b/g,
};

export function maskPII(text: string, fieldsToMask: string[] = Object.keys(PII_PATTERNS)): string {
  let masked = text;
  for (const field of fieldsToMask) {
    const pattern = PII_PATTERNS[field];
    if (pattern) {
      masked = masked.replace(pattern, `[REDACTED_${field.toUpperCase()}]`);
    }
  }
  return masked;
}

export function detectPII(text: string): Array<{ type: string; count: number }> {
  const findings: Array<{ type: string; count: number }> = [];
  for (const [type, pattern] of Object.entries(PII_PATTERNS)) {
    const matches = text.match(pattern);
    if (matches && matches.length > 0) {
      findings.push({ type, count: matches.length });
    }
  }
  return findings;
}
```

Add a middleware that auto-scans Decision Log entries for PII before writing:
```typescript
// In decisionLogService.ts, before writing:
const piiFindings = detectPII(JSON.stringify(decisionData));
if (piiFindings.length > 0) {
  logger.warn('PII detected in decision log entry', { piiFindings, traceId });
  // Mask PII in the BigQuery copy (immutable store should not contain raw PII)
  decisionData._pii_masked = true;
  decisionData.context = maskPII(JSON.stringify(decisionData.context));
}
```

---

## TASK 17: Circuit Breaker — Verify All Adapters Are Wrapped

**Files to check:**
- `server/src/utils/circuitBreaker.ts`
- `server/src/services/adapters/*.ts` (all 8 adapters)

**What to do:**

Verify that ALL 8 adapters use the circuit breaker:

1. `gmailAdapter.ts` — must wrap all Gmail API calls
2. `calendarAdapter.ts` — must wrap all Calendar API calls
3. `whatsappAdapter.ts` — must wrap all WhatsApp API calls
4. `driveAdapter.ts` — must wrap all Drive API calls
5. `notionAdapter.ts` — must wrap all Notion API calls
6. `odooAdapter.ts` — must wrap all Odoo API calls
7. `googleChatAdapter.ts` — must wrap all Chat API calls
8. `googleTasksAdapter.ts` — must wrap all Tasks API calls

For each adapter, ensure:
```typescript
import { circuitBreaker } from '../../utils/circuitBreaker';

const cb = circuitBreaker.create({
  name: 'gmail_adapter',  // unique per adapter
  failureThreshold: 3,     // OPEN after 3 failures
  resetTimeout: 30000,     // Try HALF-OPEN after 30s
  monitorTimeout: 60000,   // Monitor window
});

// Wrap every external call:
async function sendEmail(params) {
  return cb.fire(async () => {
    // actual API call
  });
}
```

If any adapter is NOT wrapped, wrap it. Add a health check endpoint that reports circuit breaker states:

```typescript
// In healthRoutes.ts
router.get('/health/circuit-breakers', async (req, res) => {
  const states = circuitBreaker.getAllStates();
  res.json({ circuitBreakers: states });
});
```

---

## TASK 18: Morning Brief Schedule — Enforce PKT Timezone

**Files to modify:**
- `server/src/services/schedulerService.ts`
- `server/src/services/dayBriefingService.ts`

**What to do:**

Spec requires morning brief at 06:00 PKT (Asia/Karachi, UTC+5:00). Verify and enforce:

```typescript
// In schedulerService.ts
import { CronJob } from 'cron';

const morningBriefJob = new CronJob(
  '0 6 * * *',           // 06:00 every day
  () => dayBriefingService.generate(),
  null,
  false,
  'Asia/Karachi'          // PKT timezone — NOT IST per L3 fix R20
);
```

Also ensure all date displays in the UI use PKT:
```typescript
// Add to server response headers or config
export const SYSTEM_TIMEZONE = 'Asia/Karachi';  // UTC+5:00 PKT
```

---

## TASK 19: Idempotency Cleanup Job — Align with Spec

**Files to modify:**
- `server/src/services/actionIdempotencyService.ts`

**What to do:**

We have a 7-day SQL cleanup at 3 AM. Spec says Redis SETNX TTL = 300s for processing, 86400s for completed. Verify alignment:

```typescript
// Verify these constants exist:
const IDEMPOTENCY_PROCESSING_TTL = 300;    // 5 min for in-progress lock
const IDEMPOTENCY_COMPLETED_TTL = 86400;   // 24h for completed record
const IDEMPOTENCY_SQL_RETENTION_DAYS = 7;  // SQL cleanup after 7 days
const IDEMPOTENCY_CLEANUP_HOUR = 3;        // 3 AM cleanup

// Verify the 4-step pattern matches spec:
// 1. Redis SETNX(key, "processing", TTL=300s) → if exists: DUPLICATE
// 2. BEGIN SQL TRANSACTION → insert action + update status + write decision log
// 3. COMMIT → if fails: Redis DEL(key), retry
// 4. On success: Redis SET(key, "completed", TTL=86400s)
```

---

## FINAL VERIFICATION

After completing all 19 tasks:

1. Run `npx prisma migrate dev` to apply any schema changes
2. Run `npm test` in `server/` to verify no regressions
3. Run `npx tsc --noEmit` in `server/` to verify TypeScript compiles
4. Start the full stack (`docker-compose up`) and verify:
   - All API endpoints respond
   - Kill switch activates and re-arms
   - State machine rejects invalid transitions
   - Pub/Sub topics accept both naming conventions
   - Health check shows all circuit breakers as CLOSED
   - Decision log writes have traceId populated

5. Run the existing test plan (193 scenarios) and confirm pass rate stays >= 97%

---

## SUMMARY OF ALL CHANGES

| # | Area | Status Before | Status After |
|---|------|--------------|-------------|
| 1 | State Machine (R9) | Basic CRUD | 8-state + guards + transitions |
| 2 | Handler Names | Different names | Spec aliases + stubs |
| 3 | External Knowledge Tools | 3 tools | 5 tools |
| 4 | Rule Engine Tools | ~4 tools | 7 tools |
| 5 | Pub/Sub Names | tmcai-* only | Both conventions |
| 6 | Decision Log BQ | PG triggers only | + BigQuery CDC (flag) |
| 7 | Golden Dataset | Exists but small | 1,000+ decisions |
| 8 | Archetypes | Not enforced | 6 types classified |
| 9 | Entity Kinds | Loose | 5 validated types |
| 10 | Drift Guard | Missing | 2σ freeze logic |
| 11 | Kill Switch Re-arm | No step-up | Admin + step-up |
| 12 | GCS Cold Storage | Missing | Terraform config |
| 13 | Cloud SQL HA | Local PG | HA Terraform config |
| 14 | Memory Bank | PG only | Abstraction + Vertex stub |
| 15 | Trace IDs (R18) | Partial | Full propagation |
| 16 | PII/DLP (R13) | Basic encryption | Pattern detection + masking |
| 17 | Circuit Breakers (R16) | Most adapters | All 8 verified |
| 18 | PKT Timezone (R20) | Assumed | Explicit Asia/Karachi |
| 19 | Idempotency | Working | Verified 4-step pattern |
