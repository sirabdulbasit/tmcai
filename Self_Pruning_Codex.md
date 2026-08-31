# Nexeo Self-Pruning Audit — Codex

**Date:** 2026-08-31  
**Audited build:** `d144edfcf6fae4a74da16c58012804ffa9bbba90` (`d144edf`)  
**Audit type:** Read-only repository, Brain architecture, runtime-storage, dependency, Prisma, and live PostgreSQL catalog review  
**Status:** Recommendations only — nothing was deleted, migrated, committed, pushed, or deployed

## 1. Canonical capability scorecard

This audit follows the capability order in `BRAIN_VISION.md`. Scores come from the current canonical capability scorecard at `server/docs/orchestrator/state/capability_scorecard.json`; they are capability judgments, not test-pass percentages.

| Capability | Nexeo | Professional assistant | Gap | Change since prior verified build | Nexeo / professional (20 characters) |
|---|---:|---:|---:|---:|---|
| Simple & Smart | 36 | 92 | 56 | 0 | `███████░░░░░░░░░░░░░` / `██████████████████░░` |
| Thinking | 42 | 94 | 52 | 0 | `████████░░░░░░░░░░░░` / `███████████████████░` |
| Memory | 60 | 92 | 32 | 0 | `████████████░░░░░░░░` / `██████████████████░░` |
| Accurate Communication | 91 | 94 | 3 | 0 | `██████████████████░░` / `███████████████████░` |
| Authorized Action | 61 | 91 | 30 | 0 | `████████████░░░░░░░░` / `██████████████████░░` |
| Self Follow-Up | 58 | 96 | 38 | 0 | `████████████░░░░░░░░` / `███████████████████░` |
| Learn | 42 | 90 | 48 | 0 | `████████░░░░░░░░░░░░` / `██████████████████░░` |
| Self-Healing | 38 | 89 | 51 | 0 | `████████░░░░░░░░░░░░` / `██████████████████░░` |
| Self-Pruning | 61 | 89 | 28 | 0 | `████████████░░░░░░░░` / `██████████████████░░` |
| **Overall** | **54.3** | **91.9** | **37.6** | **0.0** | `███████████░░░░░░░░░` / `██████████████████░░` |

**Verdict: NEUTRAL.** The audit identifies meaningful simplification opportunities, but no capability moved because no behavior was changed or verified in production.

## 2. Executive conclusion

Nexeo contains significant redundancy, but it is not one uniform cleanup problem. The findings fall into three classes:

1. **Disposable artifacts:** dated backups, retired raw logs, old snapshots, and generated builds.
2. **Removal candidates needing controlled verification:** unreferenced source files, unused dependencies, duplicate indexes, old compatibility endpoints, and database snapshot tables.
3. **Architectural duplication requiring consolidation before deletion:** the dual Brain composition paths and overlapping people, document, memory, messaging, and action-ledger models.

Only the first two classes should enter an initial pruning release. The third class contains active capability boundaries; deleting either side before migration could remove user-visible behavior or audit evidence.

## 3. Repository and runtime inventory

The inspected workspace contained approximately:

| Area | Observed size/count | Interpretation |
|---|---:|---|
| Server TypeScript source | 662 files | Large active backend surface |
| Server tests | 247 files | Broad regression coverage, including dynamically loaded paths |
| Prisma models | 107 | All declared models exist in the live DB |
| Prisma migration directories | 94 | Long-lived schema evolution history; do not rewrite |
| Live public DB tables | 140 | 33 are not modeled by Prisma |
| `server/docs/orchestrator` | ~64 MB | Mostly raw/retired operational evidence |
| `server/whatsapp-sessions` | ~967 MB | Includes active state and a dated backup |
| Active tenant WhatsApp session | ~803 MB | Protected runtime state; do not prune piecemeal |
| `session-TMC-0001.bak-20260717` | ~163 MB | Strong archival candidate after recovery confirmation |
| `server/dist` | ~20 MB | Generated; must be clean-built to avoid stale emitted files |
| `client/dist` | ~1.7 MB | Generated |
| `agents` | ~728 MB | Mostly Python environment/dependencies; evaluate independently |

The working tree was already dirty, including uncommitted changes in core Brain and WhatsApp files. Those changes belong to the user or another active workflow and must not be overwritten, reset, staged, or mixed into pruning work.

## 4. Brain structural redundancy

### 4.1 Dual composition systems

`server/src/services/knowledge/brainComposer.ts` is approximately 8,012 lines and 453 KB. It contains both:

- the newer `reasoningCompose` path;
- a large legacy composition tail;
- multiple explicit fallbacks from reasoning to legacy;
- duplicated dispatch-ledger and push-history context assembly;
- output validation, action interpretation, interception, and finalization behavior spanning both paths.

Related surfaces include:

| File | Approximate lines | Responsibility |
|---|---:|---|
| `brainComposer.ts` | 8,012 | Main orchestration plus legacy tail |
| `reasoningCompose.ts` | 537 | New model-directed reasoning |
| `responseValidator.ts` | 940 | Output/claim validation |
| `answerSanitizer.ts` | 643 | Marker and rendered-answer sanitation |

This is the highest-value structural pruning target, but it is **not immediately deletable**. The correct sequence is:

1. Record every reason a real turn falls from reasoning into legacy.
2. Classify each reason as a guardrail, missing capability, provider failure, or obsolete fallback.
3. Close the fallthrough reasons at their class boundary.
4. Prove zero legacy fallthrough across representative text, voice, image, confirmation, action, and failure turns.
5. Remove the legacy tail and its duplicate context/validation assembly.

Expected benefit: fewer contradictory protections, fewer double LLM calls, less output replacement, and a smaller surface for fabricated-completion defects.

### 4.2 Overlapping data domains

The schema has several families that may represent multiple generations of the same product concept:

- People: `persons`, `person_facets`, `entities`, `entity_links`.
- Documents: `documents`, `chunks`, `personal_documents`, `personal_chunks`, wiki tables.
- Memory: `user_memories`, `governed_brain_memories`, `clarification_memory`, `user_profile_memory`.
- Actions: `agent_actions`, `brain_pending_actions`, `brain_action_artifacts`, `action_idempotency_logs`.
- Messages: `messages`, `brain_user_messages`, `whatsapp_messages`, `whatsapp_outbound_messages`.

These tables cannot be declared redundant from names or row counts alone. Each may represent a distinct lifecycle or evidence boundary. Before consolidation, document for every family:

- canonical writer;
- canonical reader;
- tenant/user ownership key;
- retention policy;
- receipt/audit responsibility;
- whether the data is product state, cache, projection, or immutable evidence.

Then migrate readers and writers to one canonical owner before retiring the older model.

## 5. High-confidence source removal candidates

A repository-wide TypeScript import graph found 185 files with zero static inbound imports. That number is **not** a deletion list: Nexeo uses dynamic imports, CommonJS `require`, scheduled registries, and standalone scripts.

After following exported symbols and dynamic references, these files remained high-confidence candidates:

| File | Evidence | Proposed action |
|---|---|---|
| `server/src/pipeline/hybridSearch.ts` | `hybridSearch()` has no caller | Remove after emitted-artifact check |
| `server/src/pipeline/queryRewriter.ts` | `rewriteQuery()` has no caller | Remove after emitted-artifact check |
| `server/src/pipeline/reranker.ts` | `rerankResults()` has no caller | Remove after emitted-artifact check |
| `server/src/services/slaMonitorService.ts` | Both exported report functions are unreferenced | Remove unless an external operator imports emitted JS |
| `server/src/middleware/pubsubHandler.ts` | Middleware factory is never mounted | Remove |
| `server/src/services/artifactService.ts` | Nine exported functions have no runtime caller | Retire with the dormant artifact subsystem |

Examples that appeared unreferenced statically but are actually active and must be kept include `actionSuggestionService`, `aiProviderConfig`, `imageService`, `situationService`, `shadowScoringService`, `briefingService`, `welcomeService`, and most job modules.

## 6. Dormant artifact subsystem

The legacy widget-artifact subsystem includes:

- `server/src/services/artifactService.ts`;
- `general_artifacts`;
- `user_artifacts`;
- seeding behavior in `server/src/seeds/seedArtifacts.ts`;
- tenant-isolation exemptions that exist for its raw queries.

Observed live state:

- both tables contain zero rows;
- the service's exported functions have no runtime callers;
- neither table is represented by a current Prisma model.

This is the strongest complete subsystem-removal candidate. A controlled retirement should remove the service, obsolete seeding, associated test exemptions, and the two empty tables through an exact idempotent migration.

## 7. Prisma and live-database drift

The comparison produced:

- 107 modeled tables;
- 140 live public tables;
- zero Prisma models missing from the database;
- 33 database tables not modeled by Prisma.

### 7.1 Dated snapshot tables

Nineteen empty tables are explicitly named as repair or wipe snapshots:

- three `brain_action_artifacts_wipe_*` tables;
- two `brain_pending_actions_wipe_*` tables;
- three `clarification_memory_wipe_*` tables;
- three `entities_emptycontact_wipe_*` tables;
- three `reasoning_traces_wipe_*` tables;
- four dated `wiki_pages_*` tables;
- `entities_overpromoted_2026_05_23`.

They occupy roughly 1.3 MB. Their storage cost is small, but they obscure the authoritative schema. They are candidates for exact-name removal after confirming external backup and recovery requirements.

### 7.2 Dormant or transitional unmodeled tables

These require individual ownership review:

- `agent_runs`;
- `feedback`;
- `general_artifacts`;
- `user_artifacts`;
- `user_learning`;
- `user_profile_memory`;
- `user_tiers`.

The artifact pair is the strongest removal candidate. The remaining tables still have code or migration references even when they contain no rows.

### 7.3 Active unmodeled tables

These must remain until deliberately modeled or declared raw-SQL-owned:

- `criticality_calibration`;
- `system_logs`;
- `token_query_log`;
- `token_usage`;
- `user_action_rules`;
- `whatsapp_config`.

`_prisma_migrations` is Prisma infrastructure and must remain.

## 8. Duplicate and unused indexes

PostgreSQL reported identical index definitions on:

- `personal_chunks` — three duplicate pairs;
- `personal_documents` — three duplicate pairs;
- `agent_actions` — duplicated tenant/user and status indexes;
- `chunks` — content-hash unique and redundant ordinary index;
- `whatsapp_config` — unique tenant key and duplicate tenant index;
- `risk_flag_docs` — overlapping identical-key definitions;
- `brain_maturity_snapshots` — overlapping identical-key definitions.

For every pair, preserve the index that owns a unique constraint or supports a foreign key. Remove only the redundant ordinary copy, using an idempotent migration.

The `llm_spend_client_user_created_idx` index is approximately 106 MB and reports zero scans. This is the largest single candidate, but zero scans do not prove it unnecessary. Representative production query shapes must be examined with `EXPLAIN (ANALYZE, BUFFERS)` before removal.

## 9. Dependency pruning

The following production dependencies had zero TypeScript references in `server/src` and `server/tests`:

- `@google-cloud/vertexai`;
- `@google/generative-ai`.

They are removal candidates after checking JavaScript, scripts, emitted code, and configuration-driven loading.

Active provider dependencies include `@google/genai`, `@google-cloud/aiplatform`, `openai`, `@anthropic-ai/sdk`, `groq-sdk`, `googleapis`, `opossum`, and `pgvector`.

Multiple `@types/*` packages are installed as production dependencies. They are normally development-only, but Nexeo builds on the production box. Move them only if the deployment install mode is guaranteed to retain development dependencies for `tsc` and Prisma generation.

## 10. Compatibility and naming residue

### 10.1 Expired endpoint alias

`POST /entity-catalog/cleanup-junk` remains as an alias for `/smart-cleanup`. Its source comment says it should have been removed after 2026-07-01, while the current client calls `/smart-cleanup`.

Check bounded access logs for external consumers, then remove the alias.

### 10.2 Legacy Gmail poller

`gmailFeedPoller` is described as superseded by `genericFeedPoller`. Its remaining direct consumer is primarily the manual `kickGmailPoll` script. Confirm no cron, systemd, PM2, or operator workflow calls it before retiring both.

### 10.3 MyOS identifiers

The standalone CLI remains `server/src/cli/myos.ts`, and browser-local keys/channels still contain `myos`. These internal identifiers are not necessarily user-facing, but they are obsolete product residue. Rename browser identifiers with backward-compatible migration so existing client state is not silently lost.

## 11. Operational and generated storage

### 11.1 Orchestrator residue

`AGENTS.md` states that the orchestration pipeline was removed, yet the workspace contains executable orchestrator scripts plus current and retired logs/state. Some files are newly generated or untracked, so the pipeline may still be running despite the documented ruling.

Before removal:

1. Inspect cron, systemd, PM2, and active processes.
2. Identify the authoritative scorecard, deployment ledger, and capability evidence.
3. Preserve canonical evidence.
4. Compress/archive raw historical logs outside the repository.
5. Stop generated runtime state from being written under `server/docs`.
6. Remove executable machinery only after proving it has no live caller.

Approximately 55–60 MB appears to be raw or retired evidence rather than canonical documentation.

### 11.2 WhatsApp session storage

The dated `session-TMC-0001.bak-20260717` directory is approximately 163 MB and is a strong archive/removal candidate after confirming:

- the current session is healthy;
- the backup is not named in the current recovery procedure;
- an external recoverable copy exists if retention is required.

Do not selectively delete cache files inside the active 803 MB session. Chromium state and WhatsApp authentication are fragile and interdependent.

### 11.3 Generated builds

`server/dist` and `client/dist` are generated. They may be cleared as part of a controlled build process, but TypeScript does not automatically remove outputs for deleted sources. A clean build must ensure stale JavaScript, maps, and declarations cannot survive source deletion.

## 12. Credential hygiene

`tmcai-key.json` exists at the repository root. It is ignored by Git, not tracked, owned by root, and mode `0600`. It appears to be a Google service-account credential.

Recommended state: store the credential outside the repository workspace and reference it through `GOOGLE_APPLICATION_CREDENTIALS`. Do not delete or relocate it until every active Google integration and process environment has been verified.

## 13. Protected areas — do not prune directly

- The dirty working tree and all uncommitted user/agent changes.
- Active WhatsApp session directories.
- `server/docs/nexeo_self_learning&development.md`.
- `tenant-scope-audit-2026-05-22.md`.
- Migration history already applied to production.
- Audit/receipt tables merely because they are small or presently empty.
- Unique indexes, foreign-key-supporting indexes, and tenant-scope indexes.
- The legacy Brain path until real fallthrough reaches zero.
- Empty capability tables without confirming whether they are contractual future surfaces.

## 14. Recommended pruning sequence

### Phase 0 — evidence and ownership

- Freeze the intended cleanup scope against the current dirty tree.
- Resolve whether the retired orchestrator is still operational.
- Inventory external scripts and emitted-JavaScript consumers.
- Capture table/index definitions and bounded query evidence.

### Phase 1 — low-risk source and dependency cleanup

- Remove the three unused pipeline files.
- Remove unused SLA and Pub/Sub middleware files.
- Remove the two unused Google SDK dependencies.
- Remove the expired cleanup endpoint alias after log confirmation.
- Keep Brain behavior, schema, and messaging paths unchanged.

### Phase 2 — database hygiene

- Drop exact dated empty snapshot tables after retention approval.
- Drop exact redundant non-constraint indexes.
- Retire the empty artifact subsystem.
- Either model active legacy tables in Prisma or document their raw-SQL ownership.

### Phase 3 — operational residue

- Archive raw/retired orchestrator logs.
- Remove the dated WhatsApp backup after recovery confirmation.
- Establish bounded retention and rotation policies for logs and generated evaluation artifacts.

### Phase 4 — architectural consolidation

- Define canonical ownership for people, documents, memory, messages, and actions.
- Migrate readers and writers one domain at a time.
- Instrument reasoning-to-legacy fallthrough.
- Remove the legacy Brain composition tail only after representative production acceptance proves the replacement complete.

## 15. Verification requirements for every pruning release

From `server/`:

```bash
npx tsc --noEmit
npx vitest run
npm run build
git diff --check
```

Additionally:

- Run the client build when client files change.
- For schema/index changes, use the project-local Prisma version, verify schema/migration parity and idempotency, and apply migrations before code that depends on them.
- Compare clean-build emitted files against source files to prevent stale output.
- Verify production HEAD and every intervening commit.
- Run live acceptance for any messaging-path change; deployment alone is not verification.
- Record predicted and observed capability impact in `server/docs/brain_evaluation_chart.md` for any deployed change.

## 16. Suggested first change proposal

The smallest smart first batch is:

1. Remove `hybridSearch.ts`, `queryRewriter.ts`, and `reranker.ts`.
2. Remove `slaMonitorService.ts` and `pubsubHandler.ts` after external-consumer checks.
3. Remove `@google-cloud/vertexai` and `@google/generative-ai` after complete runtime-reference checks.
4. Remove the expired `/cleanup-junk` alias after access-log confirmation.
5. Add tests that fail if retired modules or aliases are reintroduced.

This batch removes proven dead surface without altering Brain decisions, tenant scoping, database data, action dispatch, or WhatsApp behavior.

## 17. Final assessment

Nexeo's largest waste is not disk usage. It is **parallel ownership**: two Brain composition paths, several generations of domain tables, unmodeled active schema, and multiple operational histories living beside canonical evidence.

The right form of self-pruning is therefore:

> identify the canonical owner, migrate all readers and writers to it, prove the alternative has no live use, preserve audit evidence, and only then remove the redundant surface.

Done in that order, pruning should improve simplicity and reliability without weakening memory, authorization, tenant isolation, receipts, or recovery.
