# HaseebOS v15 Spec Alignment — Corrected Prompt v2

**Context**: This is the corrected version after VS Code review. The original prompt had 19 tasks — 5 were already done, 3 had bugs/regressions, 2 were infra-only. This version contains only validated, safe-to-ship work.

Copy everything below this line into VS Code:

---

## CONTEXT

I am aligning MyOS with the HaseebOS v15 specification. Codebase:
- **Server**: Express/TypeScript at `server/` (Prisma ORM, Redis, Pub/Sub)
- **Agents**: Python/FastAPI at `agents/` (Gemini ADK)
- **Client**: React/Vite at `client/`
- **Infra**: Terraform at `infra/`

There are **4 priority tasks** to ship now, then **5 deferred tasks** for later. Do NOT touch anything outside these tasks. Run tests after each task. Do NOT delete existing functionality.

---

## PRIORITY 1: Open Items State Machine (R9)

**Estimated effort**: 1 day

**Files to modify:**
- `server/src/types/index.ts`
- `server/src/services/openItemsService.ts`
- `server/prisma/schema.prisma`

**IMPORTANT — Before you start:**
1. `grep -rn "status.*=.*'open'" server/src/` — find ALL places that write status as string literals like 'open', 'done', 'in_progress', etc.
2. `grep -rn "status.*=.*'done'" server/src/` — same for 'done'
3. `grep -rn "status.*=.*'closed'" server/src/` — same for 'closed'
4. List every file that hard-codes status strings. These ALL need updating.

### Step 1: Add enum and transition matrix

In `server/src/types/index.ts`, add:

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
  [OpenItemStatus.CLOSED]: [OpenItemStatus.NEW],  // reopen path: CLOSED → NEW
};

export const TRANSITION_GUARDS: Record<string, string> = {
  'NEW->TRIAGED': 'requires archetype assignment',
  'TRIAGED->IN_PROGRESS': 'requires assignee',
  'TRIAGED->DELEGATED': 'requires delegatee and delegation_reason',
  'IN_PROGRESS->INFORMED': 'requires summary of actions taken',
  'IN_PROGRESS->CLOSED': 'requires resolution_note',
  'CLOSED->NEW': 'reopen: requires reopen_reason',
};
```

### Step 2: Add transition enforcement

In `server/src/services/openItemsService.ts`, add a `transitionStatus()` method:

```typescript
import { OpenItemStatus, VALID_TRANSITIONS, TRANSITION_GUARDS } from '../types';

async transitionStatus(
  itemId: string,
  newStatus: OpenItemStatus,
  metadata: Record<string, any> = {},
  tenantId: string
): Promise<OpenItem> {
  const item = await prisma.open_items.findFirst({
    where: { id: itemId, clientNumber: tenantId }
  });
  
  if (!item) throw new NotFoundError(`Open item ${itemId} not found`);
  
  const currentStatus = item.status as OpenItemStatus;
  const allowed = VALID_TRANSITIONS[currentStatus];
  
  if (!allowed || !allowed.includes(newStatus)) {
    throw new InvalidTransitionError(
      `Cannot transition from ${currentStatus} to ${newStatus}. ` +
      `Allowed: ${allowed?.join(', ') || 'none (terminal state)'}`
    );
  }
  
  // Check guard conditions
  const guardKey = `${currentStatus}->${newStatus}`;
  const guard = TRANSITION_GUARDS[guardKey];
  if (guard) {
    // Validate required fields based on guard
    if (guardKey === 'NEW->TRIAGED' && !metadata.archetype) {
      throw new ValidationError(`Transition ${guardKey}: ${guard}`);
    }
    if (guardKey === 'TRIAGED->IN_PROGRESS' && !metadata.assignee) {
      throw new ValidationError(`Transition ${guardKey}: ${guard}`);
    }
    if (guardKey === 'TRIAGED->DELEGATED' && (!metadata.delegatee || !metadata.delegation_reason)) {
      throw new ValidationError(`Transition ${guardKey}: ${guard}`);
    }
    if (guardKey === 'IN_PROGRESS->INFORMED' && !metadata.summary) {
      throw new ValidationError(`Transition ${guardKey}: ${guard}`);
    }
    if (guardKey === 'IN_PROGRESS->CLOSED' && !metadata.resolution_note) {
      throw new ValidationError(`Transition ${guardKey}: ${guard}`);
    }
    if (guardKey === 'CLOSED->NEW' && !metadata.reopen_reason) {
      throw new ValidationError(`Transition ${guardKey}: ${guard}`);
    }
  }
  
  // Perform transition
  const updated = await prisma.open_items.update({
    where: { id: itemId },
    data: {
      status: newStatus,
      delegatee: metadata.delegatee || item.delegatee,
      delegation_reason: metadata.delegation_reason || item.delegation_reason,
      resolution_note: metadata.resolution_note || item.resolution_note,
      snoozed_until: metadata.snoozed_until || item.snoozed_until,
      updatedAt: new Date(),
    }
  });
  
  // Log to decision log
  await decisionLogService.log({
    eventType: 'STATUS_TRANSITION',
    entityId: itemId,
    entityType: 'open_item',
    previousValue: currentStatus,
    newValue: newStatus,
    metadata,
    tenantId,
  });
  
  return updated;
}
```

### Step 3: Add schema fields if missing

Check `server/prisma/schema.prisma` — ensure `open_items` model has these fields. Only add what's missing:

```prisma
  delegatee         String?
  delegation_reason String?
  resolution_note   String?
  snoozed_until     DateTime?
  reopen_reason     String?
```

### Step 4: Backfill migration

Create migration: `npx prisma migrate dev --name state_machine_enforcement`

Then create a backfill script (`server/src/scripts/backfillStatuses.ts`):

```typescript
// Map old string statuses to new enum values
const STATUS_MAP: Record<string, string> = {
  'open': 'NEW',
  'new': 'NEW',
  'triaged': 'TRIAGED',
  'in_progress': 'IN_PROGRESS',
  'in-progress': 'IN_PROGRESS',
  'delegated': 'DELEGATED',
  'waiting': 'WAITING_INFO',
  'waiting_info': 'WAITING_INFO',
  'snoozed': 'SNOOZED',
  'informed': 'INFORMED',
  'done': 'CLOSED',
  'closed': 'CLOSED',
  'resolved': 'CLOSED',
};

async function backfill() {
  const items = await prisma.open_items.findMany();
  let updated = 0;
  for (const item of items) {
    const mapped = STATUS_MAP[item.status.toLowerCase()];
    if (mapped && mapped !== item.status) {
      await prisma.open_items.update({
        where: { id: item.id },
        data: { status: mapped }
      });
      updated++;
      console.log(`${item.id}: ${item.status} → ${mapped}`);
    }
  }
  console.log(`Backfilled ${updated}/${items.length} items`);
}
```

### Step 5: Update all callers

Every file found in the grep (Step 0) that writes `status = 'open'` etc. must be updated to use `OpenItemStatus.NEW` etc. Also update the `openItemsRoutes.ts` PATCH endpoint to call `transitionStatus()` instead of raw update.

---

## PRIORITY 2: Trace ID Propagation in Python Agents (R18)

**Estimated effort**: Half day

**Files to modify:**
- `agents/src/platform_client.py`
- `agents/src/pubsub_handlers.py`
- `agents/src/config.py`

**IMPORTANT**: The Express platform server already propagates traceId via AsyncLocalStorage + `requestId.ts` middleware. The Pub/Sub publisher already adds traceId to message attributes. This task is ONLY about closing the gap on the **Python agent side**.

### Step 1: Forward traceId in platform_client.py

In `agents/src/platform_client.py`, ensure every HTTP call to the platform includes the trace ID:

```python
import uuid

class PlatformClient:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url
        self.token = token
        self._trace_id = None  # Set per-request from Pub/Sub message
    
    def set_trace_id(self, trace_id: str):
        """Called by pubsub_handlers when processing a message."""
        self._trace_id = trace_id
    
    def _headers(self) -> dict:
        h = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.token}",
        }
        if self._trace_id:
            h["X-Trace-Id"] = self._trace_id
        return h
    
    async def post(self, endpoint: str, data: dict) -> dict:
        # Use self._headers() in the HTTP call
        ...
    
    async def get(self, endpoint: str) -> dict:
        # Use self._headers() in the HTTP call
        ...
    
    async def patch(self, endpoint: str, data: dict) -> dict:
        # Use self._headers() in the HTTP call
        ...
```

### Step 2: Extract traceId from Pub/Sub messages

In `agents/src/pubsub_handlers.py`, when receiving a Pub/Sub push message:

```python
async def handle_pubsub_message(request):
    envelope = await request.json()
    message = envelope.get("message", {})
    attributes = message.get("attributes", {})
    
    # Extract trace ID from message attributes (set by platform publisher)
    trace_id = attributes.get("traceId") or f"trace-{uuid.uuid4()}"
    
    # Set on platform client so all downstream calls propagate it
    platform_client.set_trace_id(trace_id)
    
    # Also include in all log entries
    logger.info("Processing message", extra={"traceId": trace_id, "topic": attributes.get("topic")})
    
    # ... rest of message processing
```

### Step 3: Structured JSON logging in Python

In `agents/src/config.py` or wherever the Python logger is configured, ensure JSON format with traceId:

```python
import logging
import json

class JsonFormatter(logging.Formatter):
    def format(self, record):
        log_entry = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "message": record.getMessage(),
            "service": "agent-worker",
            "traceId": getattr(record, "traceId", "no-trace"),
            "agent": getattr(record, "agent", "unknown"),
        }
        if record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(log_entry)

# Apply to root logger
handler = logging.StreamHandler()
handler.setFormatter(JsonFormatter())
logging.getLogger().addHandler(handler)
```

### Step 4: Verify platform side (DON'T modify, just verify)

Run these checks to confirm the platform side is already done:
```bash
grep -n "traceId" server/src/services/infra/pubsubPublisher.ts
grep -n "X-Trace-Id" server/src/middleware/requestId.ts
grep -n "asyncLocalStorage" server/src/utils/logger.ts
```

If any of these return nothing, THEN fix the platform side. Otherwise leave it alone.

---

## PRIORITY 3: Circuit Breaker Verification (R16)

**Estimated effort**: Half day

**Files to check:**
- `server/src/utils/circuitBreaker.ts`
- `server/src/services/adapters/gmailAdapter.ts`
- `server/src/services/adapters/calendarAdapter.ts`
- `server/src/services/adapters/whatsappAdapter.ts`
- `server/src/services/adapters/driveAdapter.ts`
- `server/src/services/adapters/notionAdapter.ts`
- `server/src/services/adapters/odooAdapter.ts`
- `server/src/services/adapters/googleChatAdapter.ts`
- `server/src/services/adapters/googleTasksAdapter.ts`

### Step 1: Grep for circuit breaker usage

```bash
grep -l "circuitBreaker\|circuit_breaker\|CircuitBreaker\|cb\.fire\|cb\.exec\|withBreaker" server/src/services/adapters/*.ts
```

This tells us which adapters ARE wrapped. Any adapter NOT in the output needs wrapping.

### Step 2: For each unwrapped adapter, add circuit breaker

Pattern to follow (check existing wrapped adapters for the exact import/usage):

```typescript
import { circuitBreaker } from '../../utils/circuitBreaker';

// At module level:
const cb = circuitBreaker.create({
  name: 'ADAPTER_NAME',      // e.g., 'notion_adapter'
  failureThreshold: 3,        // OPEN after 3 consecutive failures
  resetTimeout: 30000,        // Try HALF-OPEN after 30 seconds
});

// Wrap every external API call:
async function someExternalCall(params: any) {
  return cb.fire(async () => {
    // ... actual HTTP/SDK call to external service
  });
}
```

**Do NOT change any adapter that is already wrapped.** Only add wrapping to unwrapped ones.

### Step 3: Add circuit breaker health endpoint

In `server/src/routes/healthRoutes.ts`, add:

```typescript
router.get('/health/circuit-breakers', async (req, res) => {
  // Get the state of all circuit breakers
  const states = circuitBreaker.getAllStates();  // Check if this method exists
  // If getAllStates() doesn't exist, check the circuitBreaker implementation
  // and list states manually for each adapter
  res.json({
    circuitBreakers: states,
    timestamp: new Date().toISOString(),
  });
});
```

If `getAllStates()` doesn't exist on the circuit breaker utility, check how states are tracked and add a way to list them. The Health Check tab in the UI already monitors "Circuit Breakers" — make sure this endpoint feeds it.

### Step 4: Verify results

```bash
# Count: should be 8 adapters with circuit breaker
grep -c "circuitBreaker\|cb\.fire\|withBreaker" server/src/services/adapters/*.ts
```

---

## PRIORITY 4: Handler Name Aliases (CORRECT 4 ONLY)

**Estimated effort**: Half day

**Files to modify:**
- `server/src/services/actions/handlerRegistry.ts`
- `server/src/services/actions/handlers/index.ts`

**IMPORTANT**: The original prompt had 14 aliases. VS Code review found 5 of them map to WRONG handlers (different behavior entirely). Only ship these **4 correct aliases**:

### Step 1: Add alias method to handlerRegistry.ts

```typescript
// In HandlerRegistry class:
alias(specName: string, implName: string): void {
  const handler = this.handlers.get(implName);
  if (handler) {
    this.handlers.set(specName, handler);
  }
}
```

### Step 2: Add ONLY these 4 correct aliases

```typescript
// After all handlers are registered, add spec-compatible aliases:

// These 4 are confirmed correct — spec name maps to same behavior:
registry.alias('reschedule', 'reschedule_event');
registry.alias('cancel', 'cancel_event');
registry.alias('prioritize', 'update_priority');
registry.alias('deprioritize', 'demote');
```

### DO NOT ADD these — they map to wrong handlers:

```
// ❌ unfreeze_rule → log_override      (opposite actions!)
// ❌ audit_action → request_approval    (different operations)
// ❌ recall_memory → extract_insight    (recall vs create)
// ❌ summarize_thread → sync_thought_to_notion  (different behaviors)
// ❌ classify_intent → tag_entity       (classification vs attachment)
```

If these 5 spec handlers are genuinely needed in the future, create real handler implementations — do not alias them to different operations.

### Step 3: Verify aliases work

```typescript
// Quick test: both names should resolve to the same handler
const h1 = registry.get('reschedule');
const h2 = registry.get('reschedule_event');
console.assert(h1 === h2, 'Alias reschedule should resolve to reschedule_event');
```

---

## DEFERRED TASKS (Do NOT ship now — do later when needed)

These are documented for future reference. Do NOT implement them in this session.

### D1: Shadow Scorer — Add 3 Missing Tools (was T4)

Already have: `evaluate_rule`, `evaluate_all_shadow`, `promote_rule` in `shadow_scorer.py`.
Actually missing: `score_shadow`, `suggest_rule`, `create_rule`.
**When**: Next shadow pipeline sprint.

### D2: Pub/Sub Spec Name Aliases (was T5)

Add `resolveTopic()` helper that maps spec names (feed-events) to impl names (tmcai-feed-raw). Low priority since no external system uses spec names.
**When**: Before any external integration that uses spec topic names.

### D3: Drift Guard Boundary Rules (was T10)

Drift guard ALREADY EXISTS in `ruleLifecycleService.driftGuard()`. What's missing is the boundary rules: "94.9% at day 30 → extend 7 days" and "97.9% at day 30 → extend 14 days, restrict to LOW-only".
**When**: Phase 4 hardening.

### D4: PII Detection Enhancement (was T16)

Existing PII masking uses Gemini NER (11 entity types). Add regex pre-filter as cheap first pass: email, phone, SSN, credit card, IBAN patterns. Use as complement, NOT replacement for NER.
**When**: R13 compliance push.

### D5: PKT Timezone Cleanup (was T18)

Current: scheduler runs every 5 min, fires once in 06:00 PKT hour. Spec wants explicit cron with `Asia/Karachi` timezone. Would need `cron` npm package.
**When**: Scheduler refactor.

---

## BLOCKED TASKS (Do NOT implement — would cause regressions)

### B1: Golden Dataset Synthesis (was T7) — BLOCKED

The Golden Dataset MUST be real decisions Abdul made, manually labeled. Synthesizing 1,000 fake decisions creates a self-validating loop where rules "pass" the gate because the same model labeled the test data. Keep existing `seedGoldenDataset.ts` which pulls from real `decision_logs`. Abdul curates labels over time.

### B2: Entity Kind Enforcement (was T9) — BLOCKED

Current system has 6 kinds: `contact, account, project, opportunity, risk, okr`. Spec has 5: `person, company, project, deal, objective`. Blind enforcement via validation would break ALL existing entities. Requires:
1. A migration mapping old → new values
2. Update every SQL query/filter referencing old names
3. Update all UI labels
This is a 1-2 day refactor, not a 3-line validation change.

### B3: Vertex Memory Bank Abstraction (was T14) — BLOCKED

Premature abstraction. The Vertex backend stub "falls back to PG" which means it does nothing useful. Ship when someone actually needs the Vertex backend.

---

## ALREADY DONE (verified by VS Code review)

These are already in the codebase — do NOT duplicate:

- **T6 BigQuery CDC**: `tmcai-bq-export` Cloud Function is live. Decision events publish to `tmcai-steering-snapshot` and export to BQ.
- **T8 Archetypes**: Schema migration M12 added `archetype` column. Triage Analyst has `assign_archetype` tool.
  - **NOTE**: Verify archetype values match spec §3.3. Current values in code may differ from spec values. Check before closing.
- **T10a Drift Guard**: Already exists in `ruleLifecycleService.driftGuard()`.
- **T15 partial — Pub/Sub attributes**: `pubsubPublisher.ts::publish()` already adds traceId to Pub/Sub message attributes.

---

## INFRA TASKS (Terraform only — ship when moving to GCP managed services)

### I1: Cloud SQL HA (was T13)
- Primary + standby (REGIONAL availability)
- PgBouncer connection pooling
- Read replica for analytics
- See `infra/terraform/main.tf`

### I2: GCS Cold Storage (was T12)
- 3-tier retention: Hot (12mo) → Warm (3yr) → Cold (indefinite)
- Retention lock on archive bucket
- See `infra/terraform/modules/storage/main.tf`

---

## EXECUTION ORDER

```
1. T1  State Machine        → 1 day   → grep + backfill + transitionStatus()
2. T15 Trace IDs (Python)   → ½ day   → platform_client.py + pubsub_handlers.py
3. T17 Circuit Breaker Check → ½ day   → grep + wrap missing + health endpoint
4. T2  Handler Aliases (4)   → ½ day   → registry.alias() + 4 correct mappings
                               -------
                               2.5 days total
```

After all 4: run `npm test`, `npx tsc --noEmit`, start full stack, verify 193 test scenarios still pass >= 97%.

---

## ARCHETYPE VALUE CHECK (action item from VS Code review)

Before closing T8 as "already done", verify the archetype enum values in the code match HaseebOS v15 Master Spec §3.3.

VS Code noted two possible sets:
- **Set A** (what cowork proposed): task, decision, information, escalation, follow_up, recurring
- **Set B** (what VS Code encoded from spec): reply_needed, delegate, inform_only, schedule_meeting, review_risk, acknowledge

Check `server/prisma/schema.prisma` and `agents/src/agents/triage_analyst.py` for current values, then cross-reference against the actual spec document at `Required Architect/HaseebOS_v15_Master_Specification_v2.docx` section 3.3.

If values don't match spec: create a migration to fix. If they do match: close the item.
