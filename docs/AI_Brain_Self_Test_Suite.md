# AI Brain — Self Test Suite

**Version:** 2026-04-29 (post Risk Radar v2 + Contacts + Sentiment + Mobile prep)
**Owner:** TMC / MyOS engineering
**Last automated run:** see `npm run smoke` from `tmcai/server`

> Comprehensive test scenarios across every major functionality. Minimum
> 20 scenarios per functionality. Used for pre-launch verification, regression
> checks, and as a contract for future feature work.

## Status legend

- ✅ **Pass** — verified working in latest run
- ❌ **Fail** — known broken
- ⚠️ **Partial** — works with caveats
- ⊘ **Skip** — not applicable in current data state
- 📝 **Manual** — must be tested by clicking through UI

## How to run automated portions

```bash
cd tmcai/server
# Full 20-scenario backend smoke
npx ts-node src/scripts/smokeRiskRadarV2.ts
# Tenant isolation smoke
npx ts-node src/scripts/smokeTenantIsolation.ts
# Criticality engine smoke
npx ts-node src/scripts/smokeCriticality.ts
# Vector retrieval smoke
npx ts-node src/scripts/smokeVectorRetrieval.ts
# Instructions / commitments / feedback smokes
npx ts-node src/scripts/smokeInstructions.ts
npx ts-node src/scripts/smokeCommitments.ts
npx ts-node src/scripts/smokeFeedback.ts
```

For UI walkthroughs (📝), use `localhost:5174` against a logged-in tenant.

---

## Functionality 1 — Risk Radar (rules-driven)

| # | Scenario | Expected | Status |
|---|---|---|---|
| RR-01 | `runForUser({ force: true })` completes in < 30s | Returns docId, flagCount, sourceSignals; doc persisted | ✅ |
| RR-02 | Re-running same day produces same docId (UPSERT) | `risk_flag_docs` has 1 row per (tenant, user, runDate) | ✅ |
| RR-03 | Doc shape integrity | flags array, flagCount matches, highSeverityCount = count of high | ✅ |
| RR-04 | All flags have valid severity | severity ∈ {low, medium, high} | ✅ |
| RR-05 | All flag ids are unique within a doc | `Set(ids).size === flags.length` | ✅ |
| RR-06 | Flags ranked descending by `rank` | top of array has highest rank | ✅ |
| RR-07 | Trim to `max_flags` | flags.length ≤ config.max_flags (default 12) | ✅ |
| RR-08 | Self-emails excluded from rule-driven hits | No flag where `sender_email == current_user.email` | ✅ |
| RR-09 | No-reply / bot domains excluded | predicate engine skips google.com, sendgrid, atlassian, etc. | ✅ |
| RR-10 | Untitled meetings excluded from imminence | "(untitled)", "busy", "block", "hold" titles dropped | ✅ |
| RR-11 | Imminence still emits real meetings + due dates | source_signals has `imminence` key | ✅ |
| RR-12 | Stale-doc detection (> 18h) shows warning in UI | sub-text reads "last run >18h ago" | 📝 |
| RR-13 | Empty radar shows "Nothing flagged today." | section renders with empty state | ✅ |
| RR-14 | Disabled radar (config.enabled=false) skips run | Returns empty result with reason "radar disabled" | ✅ |
| RR-15 | Force=true bypasses disabled flag | runs even when config.enabled=false | ✅ |
| RR-16 | LLM narration runs only when narrate=true and flags > 0 | narrative populated when both true | ✅ |
| RR-17 | Narration failure leaves flags intact | flags emitted even if LLM fails | ✅ |
| RR-18 | Star-rating boost — 4★+ tone shifts always severity=high | ★4 sender's negative tone bumps to high | ✅ |
| RR-19 | Mirror to brain_docs with doc_type='risk_radar' | brain_docs row created with input_summary | ✅ |
| RR-20 | Per-user cron fires at user's schedule + timezone | scheduler boot logs per-user registrations | ✅ |
| RR-21 | "Re-run" button on Day Brief panel works | POST /risk-radar/run-now → flags refresh in UI | 📝 |
| RR-22 | "Tune radar" panel saves + auto-reruns | PATCH /config + POST /run-now in single click | 📝 |

---

## Functionality 2 — Risk Rules (CRUD + System + Overrides)

| # | Scenario | Expected | Status |
|---|---|---|---|
| RU-01 | Seed installs all 8 system rules | risk_rules count(scope=system) ≥ 8 | ✅ |
| RU-02 | All expected rule_keys present | system:escalation_email, vip_negative_sentiment, high_priority_unresolved, project_deadline_overrun, opportunity_stale, hostile_tone, urgent_request_high, vip_inbound | ✅ |
| RU-03 | Re-seeding is idempotent | created=0 / updated=8 on second boot | ✅ |
| RU-04 | createUserRule returns id > 0 | new row in risk_rules with scope=user | ✅ |
| RU-05 | listRulesFor returns system + tenant + user | union of three scopes for the requesting user | ✅ |
| RU-06 | updateRule disables a user rule | rule.enabled = false; excluded from active list | ✅ |
| RU-07 | deleteRule removes user rule | row gone from DB | ✅ |
| RU-08 | System rule cannot be deleted via deleteRule | throws "system rules cannot be deleted" | ✅ |
| RU-09 | System rule cannot be edited via updateRule | throws "system rules are immutable" | ✅ |
| RU-10 | toggleSystemRule(disable) creates override row | risk_rule_overrides row with disabled=true | ✅ |
| RU-11 | Disabled system rule excluded from listRulesFor | active list shrinks by 1 | ✅ |
| RU-12 | toggleSystemRule(enable) removes override | active list returns to original size | ✅ |
| RU-13 | Tenant rule edit requires admin | non-admin updateRule on tenant scope → 403 "admin required" | ✅ |
| RU-14 | Tenant rule visible to all users in tenant | listRulesFor for any tenant user includes tenant rules | ✅ |
| RU-15 | User rule invisible to other users in tenant | A's user rule absent from B's listRulesFor | ✅ |
| RU-16 | Predicate validation — rejects non-object | POST /risk-rules with predicate:"foo" → 400 | ✅ |
| RU-17 | Severity validation — must be low/medium/high | severity:"critical" → 400 | ✅ |
| RU-18 | Source validation — must be one of 3 | source:"random" → 400 | ✅ |
| RU-19 | Predicate too deep (> 6 levels) rejected | nested all/all/all/... → 400 | ✅ |
| RU-20 | Dry-run via /risk-rules/test returns matched: bool | POST {predicate, ctx} → 200 with matched | ✅ |
| RU-21 | Cross-tenant rule write blocked | POST as user X for tenant Y → 403 | ✅ |
| RU-22 | Fire count + last_fired_at increment on hits | system rule that matched today has fire_count > 0 | ⊘ |

---

## Functionality 3 — Contacts / Entity Discipline

| # | Scenario | Expected | Status |
|---|---|---|---|
| EN-01 | Auto-discovery on inbound feed event | entity_person row created with id `person:<email>` | ✅ |
| EN-02 | metadata.imported_from = 'auto_discovered' | matches source pill rendering rules | ✅ |
| EN-03 | metadata.channels[] populated from sourceType | "gmail", "whatsapp", "gcal", etc. | ✅ |
| EN-04 | Multi-channel sender shows multiple channel chips | sender appearing in gmail + whatsapp shows both | ✅ |
| EN-05 | discovered_by_users[] tracks every receiving user | A and B both see same person if both received | ✅ |
| EN-06 | Self-email skipped from discovery | user's own outbound doesn't create a self-entity | ✅ |
| EN-07 | Default scope = user-private | metadata.scope = 'user' for non-tenant domains | ✅ |
| EN-08 | Personal domain → user-scoped | gmail.com / yahoo.com / outlook.com / icloud.com | ✅ |
| EN-09 | Tenant allowlist promotes to scope=tenant | system_config.entity_tenant_domains opt-in | ✅ |
| EN-10 | Cross-user visibility check | A sees A's contacts only (+ tenant-shared) | ✅ |
| EN-11 | A-only contact invisible to B | direct ACL test on a known-only-A entity | ✅ |
| EN-12 | Manual contact entry creates row | createManualContact returns valid id | ✅ |
| EN-13 | Manual contact default scope = user | not tenant-shared by default | ✅ |
| EN-14 | Admin forceTenantShared promotes to tenant | scope flips to 'tenant' when admin checks the box | ✅ |
| EN-15 | Non-admin can't force tenant share | 403 forbidden | ✅ |
| EN-16 | Stable id deduplication | importing same email twice updates, not duplicates | ✅ |
| EN-17 | Google Contacts import populates entries | syncAllContactsFromGoogle returns counts | 📝 |
| EN-18 | Microsoft Outlook import populates entries | syncAllContactsFromMicrosoft returns counts | 📝 |
| EN-19 | Nightly entity sweep updates last_contact + frequency | enrichEntityPage updates metadata.stats | ✅ |
| EN-20 | Wiki page body re-rendered with current signals | composeEntityBody rerun on signature change | ✅ |
| EN-21 | Contact catalog list paginates correctly | total > limit shows "Showing X of Y" | 📝 |
| EN-22 | Search filter narrows by name/email | ?q=faisal returns only matching | 📝 |

---

## Functionality 4 — Star Rating (per-user importance)

| # | Scenario | Expected | Status |
|---|---|---|---|
| ST-01 | setStars(id, userId, n) returns clamped n | n=4 → returns 4; n=10 → returns 5 | ✅ |
| ST-02 | getStars returns prior set value | round-trip via setStars then getStars | ✅ |
| ST-03 | setStars(0) clears the rating | metadata.user_stars[userId] removed | ✅ |
| ST-04 | Per-user isolation | A rates 4★, B sees 0 on same entity | ✅ |
| ST-05 | getStarsForEntities bulk read | returns Map<id, stars> for many entities | ✅ |
| ST-06 | getStarsForSender by email | matches sender → returns stars | ✅ |
| ST-07 | Stars influence criticality engine | relationshipRisk floor bumped per star table | ✅ |
| ST-08 | 5★ sender → criticality band floored at 'critical' | even neutral message reaches critical | ✅ |
| ST-09 | 4★ sender → band floored at 'high' | naturalBand=low gets bumped to high | ✅ |
| ST-10 | 3★ sender → band floored at 'medium' | low gets bumped to medium | ✅ |
| ST-11 | 0-2 stars → no band floor | natural composite stands | ✅ |
| ST-12 | Stars block gate auto_handle for ★4-5 | rule match drops; flag falls through to user | ✅ |
| ST-13 | Stars bump tone_shift severity in radar | 4★ tone shift = high severity | ✅ |
| ST-14 | Stars rank silence flags higher | 4★ outranks 1★ at same ratio | ✅ |
| ST-15 | UI star widget click sets value | PATCH /entity-catalog/:id/stars | 📝 |
| ST-16 | UI star widget click same star → clears | toggle behavior | 📝 |
| ST-17 | Filter `?minStars=4` returns only 4-5★ | API + UI filter work | 📝 |
| ST-18 | Sort `?sort=stars` orders high-first | stars desc with last-updated tiebreak | 📝 |
| ST-19 | Star count chips show distribution | ★5: N · ★4: N · … · Unrated: N | 📝 |
| ST-20 | Optimistic UI on star click | shows new value before API confirms; reverts on error | 📝 |

---

## Functionality 5 — Sentiment + Urgency Analyzer

| # | Scenario | Expected | Status |
|---|---|---|---|
| SE-01 | analyzeMessage returns valid SentimentResult | { sentiment, urgency, tone, rationale } | ✅ |
| SE-02 | sentiment_score clamped to [-1, 1] | LLM out-of-range gets clamped | ✅ |
| SE-03 | urgency_score clamped to [0, 1] | same clamping | ✅ |
| SE-04 | tone bucketed to known set | invalid bucket → 'neutral' | ✅ |
| SE-05 | Hostile keyword → tone='hostile', sentiment ≤ -0.85 | "lawsuit / threaten / sue / fraud" pattern | ✅ |
| SE-06 | "ASAP / urgent / blocker" → urgency ≥ 0.85 | high-urgency pattern | ✅ |
| SE-07 | Polite "could you confirm by EOD" | sentiment ≥ 0, urgency 0.5-0.7 | ✅ |
| SE-08 | "FYI / when you have time" → urgency ≤ 0.2 | low-urgency pattern | ✅ |
| SE-09 | Deterministic fallback runs on LLM failure | result still populated, rationale notes "deterministic" | ✅ |
| SE-10 | enrichFeedEvent idempotent | second call detects sentiment_analyzed_at and skips | ✅ |
| SE-11 | Empty subject + body → mark analyzed-with-defaults | sentiment=0, urgency=0, tone='neutral' | ✅ |
| SE-12 | feed_events row updated in place | sentiment_score, urgency_score, tone, sentiment_rationale, sentiment_analyzed_at all set | ✅ |
| SE-13 | On-event hook fires async after ingest | non-blocking; ingest completes before LLM | ✅ |
| SE-14 | Hourly backfill cron picks unanalyzed events | leader-locked, batches of 25 | ✅ |
| SE-15 | Backfill respects per-tenant scope | doesn't cross tenants | ✅ |
| SE-16 | Sentiment surfaces in criticality engine | gatherSentiment returns rows; fusion prompt sees them | ✅ |
| SE-17 | sentiment ≤ -0.5 → relationshipRisk floor 0.7 | deterministic fallback bump | ✅ |
| SE-18 | Hostile tone → patternAnomaly ≥ 0.75 | direct anomaly bump | ✅ |
| SE-19 | urgency drives timePressure | ≥ 0.7 → critical-band time pressure | ✅ |
| SE-20 | Available as gate engine predicate field | rule like `urgency_score gt 0.7` matches | ✅ |
| SE-21 | Available as risk rule predicate field | rule on `sentiment_score lt -0.3` works | ✅ |

---

## Functionality 6 — Brain Composer (system-prompt assembly)

| # | Scenario | Expected | Status |
|---|---|---|---|
| BC-01 | renderMatrixBlock returns valid markdown | string with `## Delegation matrix…` header | ✅ |
| BC-02 | Empty matrix returns empty string | no header, no padding | ✅ |
| BC-03 | Cache hit on second call within 60s | Redis getOrCompute reuses | ✅ |
| BC-04 | Cache invalidation on matrix update | upsertEntry busts the cache | ✅ |
| BC-05 | Standing instructions block injects | renderInstructionsBlock returns rules | ✅ |
| BC-06 | RiskFlagDoc block injects when fresh | < 36h old radar doc renders top flags | ✅ |
| BC-07 | RiskFlagDoc block omitted when stale | ≥ 36h old radar suppressed | ✅ |
| BC-08 | Persona block always present | getBrainPersona never empty | ✅ |
| BC-09 | Recent tenant log block (last 15 entries) | last activities tail | ✅ |
| BC-10 | System capabilities block reflects connectors | gmail/whatsapp/etc visible | ✅ |
| BC-11 | Learned preferences block (when not empty) | getLearnedPreferences populates | ✅ |
| BC-12 | Honesty rules H1-H10 in every prompt | full rule set appended | ✅ |
| BC-13 | H9 references delegation matrix | "look up the area before inferring" | ✅ |
| BC-14 | H10 references Risk Radar | "lead with flags above" when present | ✅ |
| BC-15 | Block ordering: schema → caps → matrix → radar → instructions → prefs → log → opened pages | matches code order | ✅ |
| BC-16 | composer parallel-fetches all blocks (Promise.all) | <500ms total typical | ✅ |
| BC-17 | Failed sub-fetch returns empty, doesn't crash compose | each .catch(() => '') | ✅ |
| BC-18 | Tenant isolation — only this tenant's matrix | clientNumber filter applied | ✅ |
| BC-19 | Tenant isolation — only this user's radar | userId filter applied | ✅ |
| BC-20 | Cross-tenant tenant_log impossible | recentTenantLog scoped | ✅ |

---

## Functionality 7 — Day Brief layout (zones + sections + help)

| # | Scenario | Expected | Status |
|---|---|---|---|
| DB-01 | Three zone headers visible | TODAY · BRAIN'S ACTIVITY · SETUP & REFLECTION | 📝 |
| DB-02 | Volume strip at top, no collapsibility | always visible | 📝 |
| DB-03 | Connector gap banner appears when applicable | only when `gaps` non-null | 📝 |
| DB-04 | Risk Radar in Zone 1 | between volume strip and My Attention | 📝 |
| DB-05 | My Attention default open | other sections collapsed | 📝 |
| DB-06 | All sections except My Attention default closed | localStorage v2 prefix reset | 📝 |
| DB-07 | Click chevron toggles section | open/close persists per user | 📝 |
| DB-08 | Click title row also toggles | same as chevron | 📝 |
| DB-09 | Keyboard: Tab focuses, Enter/Space toggles | aria-expanded reflects state | 📝 |
| DB-10 | Hover highlights the entire header card | bg + border change | 📝 |
| DB-11 | "?" button opens inline help | not a popup; collapses below header | 📝 |
| DB-12 | Help has 4 sections: What / How / Helps / Make-it-better | structured per section | 📝 |
| DB-13 | "?" toggles open/closed | second click closes | 📝 |
| DB-14 | Empty sections hide entirely | Other drafts / Rule promotions / Noticed | 📝 |
| DB-15 | "Other drafts" appears only when orphans exist | conditional render | 📝 |
| DB-16 | Rule promotions appears only when ≥ 1 promotion | conditional render | 📝 |
| DB-17 | "Noticed overnight" appears only when patterns exist | conditional render | 📝 |
| DB-18 | localStorage key `daybrief.section.v2.<id>` | prevents stale-state collision | 📝 |
| DB-19 | "Sync" button refreshes data | calls `load(true)` | 📝 |
| DB-20 | "Re-think now" on Brain Cognitive triggers refresh | manual cognitive cycle | 📝 |

---

## Functionality 8 — Gate Rules (pre-LLM filter)

| # | Scenario | Expected | Status |
|---|---|---|---|
| GR-01 | 10 system rules seeded | mailer_daemon, ooo_autoreply, github, jira, linear, slack_digest, calendar_self_ack, newsletter, calendar_invite_already_handled, cc_only_low_priority | ✅ |
| GR-02 | OOO auto-reply matches → auto_ack | "out of office" subject → ack + skip | ✅ |
| GR-03 | Mailer-daemon → auto_ack | "delivery failure" subject → ack | ✅ |
| GR-04 | GitHub notification → auto_handle tag_and_close | "[GitHub]" subject + @github.com sender | ✅ |
| GR-05 | Newsletter pattern → auto_handle | unsubscribe / view-in-browser | ✅ |
| GR-06 | Cc-only mass mail → tag fyi | recipient_count > 10 + is_cc_only | ✅ |
| GR-07 | User rule scope = self only | other users don't see it | ✅ |
| GR-08 | Tenant rule scope = all users in tenant | listRulesFor includes for every tenant member | ✅ |
| GR-09 | System rule disable via overrides | `gate_rule_overrides` row → rule excluded | ✅ |
| GR-10 | Predicate eval matches() reusable | exported, same DSL as risk rules | ✅ |
| GR-11 | gate decision = auto_handle | flag returns AttentionItem with handledByRule:true | ✅ |
| GR-12 | gate decision = auto_ack → no Open Item created | log only | ✅ |
| GR-13 | gate decision = block → entity dropped silently | not in attention queue | ✅ |
| GR-14 | gate decision = defer → snoozeHours respected | item re-evaluates after window | ✅ |
| GR-15 | gate decision = escalate → priority bumped | passes through to Brain with elevated rank | ✅ |
| GR-16 | Star ≥ 4 senders bypass auto_handle/auto_ack/block | hard override even on rule match | ✅ |
| GR-17 | Firing logged in gate_rule_firings | row per match for audit | ✅ |
| GR-18 | fire_count + last_fired_at increment | per-rule counters | ✅ |
| GR-19 | Cache (60s) on loadRulesFor | bust on write | ✅ |
| GR-20 | Cost-savings metric available | total fires × ~$0.0008 | ✅ |
| GR-21 | Tenant admin disable system rule for tenant | scope=tenant override | ✅ |
| GR-22 | Predicate dry-run endpoint | POST /test → matched: bool | ✅ |

---

## Functionality 9 — Push Notifications + Approval Tokens

| # | Scenario | Expected | Status |
|---|---|---|---|
| PN-01 | VAPID public key endpoint returns key | when env vars set | 📝 |
| PN-02 | VAPID missing → 503 push_not_configured | dev-friendly degradation | ✅ |
| PN-03 | subscribe() upserts on (userId, endpoint) | re-registering same browser updates | ✅ |
| PN-04 | unsubscribe soft-deletes | is_active=false; row preserved | ✅ |
| PN-05 | listDevices returns active only | is_active=true filter | ✅ |
| PN-06 | sendToUser fans out to all active devices | per-device send + fail tracking | 📝 |
| PN-07 | 410/404 from push service → device deactivated | auto-cleanup on dead endpoint | ✅ |
| PN-08 | Quiet hours respected | 22:00-07:00 default suppresses non-critical | ✅ |
| PN-09 | Critical severity bypasses quiet hours | when allowCritical=true | ✅ |
| PN-10 | Rate limit (20/hr default) enforced | over-limit → result.reason='rate_limited' | ✅ |
| PN-11 | Per-event-type toggle | events.morning_brief=false → no morning push | ✅ |
| PN-12 | sendToTenantAdmins fans across all admins | for kill-switch + cost anomaly | ✅ |
| PN-13 | issueTokens creates 3 tokens (approve/reject/view) | distinct b64url, all 32 bytes | ✅ |
| PN-14 | Only SHA-256 hash stored | DB cannot recover raw token | ✅ |
| PN-15 | verify(rawToken, intent) — not_found → throws | wrong token | ✅ |
| PN-16 | verify — expired → throws | past expires_at | ✅ |
| PN-17 | verify — already_consumed → throws | replay protection | ✅ |
| PN-18 | verify — wrong_intent → throws | approve token used as reject | ✅ |
| PN-19 | consume atomic — second call returns false | UPDATE WHERE consumed_at IS NULL | ✅ |
| PN-20 | createPendingApproval auto-fires push | fire-and-forget; non-blocking | ✅ |
| PN-21 | Daily cron sweeps expired tokens | 7-day audit grace, then delete | ✅ |
| PN-22 | Approve via /approval/:token/approve calls workflow.approve | action.status flips to 'approved' | ✅ |

---

## Functionality 10 — Kill Switch

| # | Scenario | Expected | Status |
|---|---|---|---|
| KS-01 | trigger() writes to Redis + system_config | dual-write for durability | ✅ |
| KS-02 | release() deletes from both stores | Redis del + config delete | ✅ |
| KS-03 | isActive() returns true after trigger | both stores agree | ✅ |
| KS-04 | Redis miss falls back to system_config | survives Redis flush | ✅ |
| KS-05 | Both stores down → fail open | non-blocking on infra outage | ✅ |
| KS-06 | HTTP middleware blocks POST/PATCH/PUT/DELETE | mutating routes | ✅ |
| KS-07 | HTTP middleware allows GET | reads still work | ✅ |
| KS-08 | Bypass paths work | /auth/, /health/, /safety/kill-switch | ✅ |
| KS-09 | executeViaRegistry boundary enforces | autonomous cron paths blocked | ✅ |
| KS-10 | Held actions get status='blocked_by_kill_switch' | preserved as drafts | ✅ |
| KS-11 | Held actions appear in /safety/kill-switch/withheld | admin-only list | ✅ |
| KS-12 | History endpoint returns audit trail | /safety/kill-switch/history | ✅ |
| KS-13 | Trigger requires admin (SA/AD) | non-admin → 403 | ✅ |
| KS-14 | Release requires admin | non-admin → 403 | ✅ |
| KS-15 | Reason required on trigger | empty reason → 400 | ✅ |
| KS-16 | Audit logged on every flip | source='kill_switch' in audit_logs | ✅ |
| KS-17 | Per-tenant isolation | trigger on TMC-A doesn't affect TMC-B | ✅ |
| KS-18 | Server restart preserves engaged state | system_config persistence | ✅ |
| KS-19 | UI shows engaged state to all users in tenant | visible warning banner | 📝 |
| KS-20 | Admin can release from header badge | one-click release with reason | 📝 |

---

## Functionality 11 — Cost Dashboard

| # | Scenario | Expected | Status |
|---|---|---|---|
| CD-01 | LLM call records to llm_spend table | dual-write on every callLLM | ✅ |
| CD-02 | Provider, model, purpose all stamped | columns populated | ✅ |
| CD-03 | est_usd computed from PRICE_PER_M | accurate to 6 decimal places | ✅ |
| CD-04 | Per-tenant scoping in queries | clientNumber filter on every read | ✅ |
| CD-05 | getTimeline returns N days | grouped by date_trunc('day') | ✅ |
| CD-06 | getByUser top-N | join with users.name for display | ✅ |
| CD-07 | getByPurpose top-N | groups by purpose | ✅ |
| CD-08 | getByProvider | groups by provider | ✅ |
| CD-09 | getAnomaly today vs trailing 7d | multiple > 2.5 = anomaly | ✅ |
| CD-10 | getPerTenant SuperAdmin only | requireSuperAdmin gate | ✅ |
| CD-11 | HTML dashboard at /admin/cost/dashboard | self-contained Chart.js page | 📝 |
| CD-12 | Window selector (7/14/30/60/90 days) | refetches on change | 📝 |
| CD-13 | Daily timeline chart renders | bar chart with USD on Y-axis | 📝 |
| CD-14 | By-purpose doughnut chart | top 10 with legend | 📝 |
| CD-15 | By-provider doughnut chart | provider breakdown | 📝 |
| CD-16 | Top users table | name, calls, tokens, USD | 📝 |
| CD-17 | Cross-tenant rollup (SA only) | only renders for SuperAdmin | 📝 |
| CD-18 | Anomaly banner (green/yellow/red) | based on multiple value | 📝 |
| CD-19 | Refresh button reloads all panels | parallel fetch on click | 📝 |
| CD-20 | Empty state when no spend in window | "No spend recorded" | 📝 |

---

## Functionality 12 — Brain Docs (typed audit/replay)

| # | Scenario | Expected | Status |
|---|---|---|---|
| BD-01 | brain_docs table exists | migration applied | ✅ |
| BD-02 | writeDoc creates new row | version=1 on first call | ✅ |
| BD-03 | Cache hit returns existing doc | same inputs_hash → no new row | ✅ |
| BD-04 | Different inputs → version+1 | superseded chain links via supersededById | ✅ |
| BD-05 | Stable id format `<docType>:<client>:<user>:<scopeKey>:v<n>` | deterministic | ✅ |
| BD-06 | inputsHash is sha256 over canonical JSON | order-independent | ✅ |
| BD-07 | source_event_ids[] indexed (GIN) | findBySourceEvent works | ✅ |
| BD-08 | RiskFlagDoc mirrors to brain_docs | doc_type='risk_radar' on every radar run | ✅ |
| BD-09 | projectionId cross-link | brain_docs.projectionId = risk_flag_docs.id | ✅ |
| BD-10 | getLatest filters status='active' | superseded excluded | ✅ |
| BD-11 | getHistory returns all versions | including superseded, ordered desc | ✅ |
| BD-12 | getById tenant + user ACL | foreign tenant returns null | ✅ |
| BD-13 | findBySourceEvent uses GIN index | fast even for large feed_events | ✅ |
| BD-14 | markFailed sets status='failed' + error | preserves inputs for diagnostics | ✅ |
| BD-15 | Replay endpoint at POST /:id/replay | risk_radar supported, others 400 | ✅ |
| BD-16 | List endpoint returns latest 30 | per user, all types | ✅ |
| BD-17 | Per-doc-type history endpoint | /brain/docs/:docType/history | ✅ |
| BD-18 | by-event endpoint returns matching docs | drill-down for audit | ✅ |
| BD-19 | All Brain reasoning passes write a doc | radar runs for now; brief/ask future | ⚠️ |
| BD-20 | Tokens + duration captured | telemetry per doc | ✅ |

---

## Functionality 13 — Delegation Matrix

| # | Scenario | Expected | Status |
|---|---|---|---|
| DM-01 | Schema + Prisma model in place | delegation_matrix + delegation_matrix_history | ✅ |
| DM-02 | listActiveEntries returns rows | scoped by clientNumber | ✅ |
| DM-03 | upsertEntry creates on missing area | INSERT path | ✅ |
| DM-04 | upsertEntry updates existing area | per (clientNumber, area) UNIQUE | ✅ |
| DM-05 | Every mutation writes history snapshot | append-only audit trail | ✅ |
| DM-06 | deactivateEntry soft-deletes | isActive=false; preserved | ✅ |
| DM-07 | findOwnerForArea case-insensitive | lookup works | ✅ |
| DM-08 | renderMatrixBlock returns markdown | injected into Brain prompt | ✅ |
| DM-09 | 60s Redis cache | getOrCompute warms read | ✅ |
| DM-10 | Cache busts on write | invalidateMatrixCache called | ✅ |
| DM-11 | Cross-tenant invisibility | tenant A's matrix invisible to tenant B | ✅ |
| DM-12 | Admin-only mutations | non-admin POST → 403 | ✅ |
| DM-13 | Read accessible to all users in tenant | not admin-gated for GET | ✅ |
| DM-14 | gatherDelegationOwners in criticality | matched areas surface in fusion prompt | ✅ |
| DM-15 | Sender domain match | sender's domain matches owner_email domain | ✅ |
| DM-16 | Subject keyword match | area string in subject text | ✅ |
| DM-17 | Limited to 5 matches per event | doesn't flood the prompt | ✅ |
| DM-18 | Deterministic relationship_risk bump (0.5) | when area match present | ✅ |
| DM-19 | History route returns audit trail | /admin/delegation-matrix/history/:area | ✅ |
| DM-20 | All-active endpoint distinct from all-incl-inactive | `/active` vs `/` | ✅ |

---

## Functionality 14 — Criticality Engine

| # | Scenario | Expected | Status |
|---|---|---|---|
| CR-01 | scoreCriticality returns full result | composite, band, dimensions, superpowers, reasons | ✅ |
| CR-02 | 5 dimensions all in [0,1] | timePressure, impact, relationshipRisk, cascade, patternAnomaly | ✅ |
| CR-03 | Composite weighted sum + superpower bonus | within [0,1] | ✅ |
| CR-04 | Band derived from composite ≥ threshold | critical / high / medium / low | ✅ |
| CR-05 | LLM fusion path | fuseAndScore returns dimensions | ✅ |
| CR-06 | Deterministic fallback path | works when LLM unavailable | ✅ |
| CR-07 | Per-user calibration applied | weights from criticalityCalibrationService | ✅ |
| CR-08 | Calibrated threshold per-user | not all users use 0.8 | ✅ |
| CR-09 | Star bumps relationshipRisk | +0.05 to +0.50 across 1-5 stars | ✅ |
| CR-10 | Star bumps band floor | 5★ → critical floor | ✅ |
| CR-11 | Sentiment ≤ -0.5 → relRisk floor 0.7 | hostile sender treated as risk | ✅ |
| CR-12 | Hostile tone → patternAnomaly 0.75+ | anomaly bump | ✅ |
| CR-13 | Urgency ≥ 0.7 → timePressure same | direct mapping | ✅ |
| CR-14 | Delegation match → relRisk 0.5+ floor | matrix area owner | ✅ |
| CR-15 | Watchpoint instruction match → anomaly 0.8 | explicit user-flagged pattern | ✅ |
| CR-16 | Sender tempo: silence > 3× window → anomaly 0.7 | absence superpower | ✅ |
| CR-17 | Open-item priority critical → impact 0.6+ | downstream commitments | ✅ |
| CR-18 | CRM value ≥ 100K → impact 0.8+ | revenue at risk | ✅ |
| CR-19 | Persists score with reasons | reasons array max 8 entries | ✅ |
| CR-20 | Brain composer uses scored items | sortable in attention queue | ✅ |

---

## Functionality 15 — Multi-tenant Isolation

| # | Scenario | Expected | Status |
|---|---|---|---|
| MT-01 | Prisma `$extends` injects clientNumber on all reads | TENANT_SCOPED_MODELS list | ✅ |
| MT-02 | Foreign-tenant findUnique returns null | post-filter check | ✅ |
| MT-03 | findUnique cross-tenant raises in OrThrow variant | tenant scope mismatch | ✅ |
| MT-04 | Bypass scope via runWithoutTenant | smoke scripts can read all | ✅ |
| MT-05 | Sessions explicitly NOT scoped | transitive via userId → user | ✅ |
| MT-06 | Auth login validates user.clientNumber | sets tenantContext for request | ✅ |
| MT-07 | Risk rules — foreign tenant sees only system | listRulesFor for unknown tenant | ✅ |
| MT-08 | Gate rules — foreign tenant sees only system | same | ✅ |
| MT-09 | Wiki pages — foreign tenant sees nothing | pageType + clientNumber filter | ✅ |
| MT-10 | Open items — foreign tenant sees nothing | clientNumber required | ✅ |
| MT-11 | Feed events — foreign tenant sees nothing | clientNumber required | ✅ |
| MT-12 | Risk Radar runs only on this tenant's data | every gather function scoped | ✅ |
| MT-13 | Sentiment backfill scoped per tenant | backfillTenant pattern | ✅ |
| MT-14 | LLM spend per tenant | clientNumber on every row | ✅ |
| MT-15 | Cost dashboard renders only own tenant | unless SA, then all | ✅ |
| MT-16 | Push subscriptions scoped per tenant | clientNumber + userId | ✅ |
| MT-17 | Approval tokens scoped per (action, user) | invariant on consume | ✅ |
| MT-18 | Cron registrations per-user | engine + radar both scoped | ✅ |
| MT-19 | Leader-lock per-user keys | `radar:<client>:<user>` | ✅ |
| MT-20 | smokeTenantIsolation passes 31 red tests | full regression suite | ⚠️ |

---

## Functionality 16 — Multi-user (within tenant)

| # | Scenario | Expected | Status |
|---|---|---|---|
| MU-01 | Different users see different My Attention | per-user feed_events | ✅ |
| MU-02 | Different users get different Risk Radar | per-user runForUser | ✅ |
| MU-03 | Stars are per-user (not tenant-shared) | metadata.user_stars[userId] | ✅ |
| MU-04 | A's user-rule invisible to B | risk_rules + gate_rules | ✅ |
| MU-05 | Tenant rules visible to all users | listRulesFor includes tenant scope | ✅ |
| MU-06 | Brain Engine cron is per-user | brainEngineService.runForUser | ✅ |
| MU-07 | Risk Radar cron is per-user | per user_id schedule | ✅ |
| MU-08 | Standing instructions: client vs user scope | scope field on wiki_page | ✅ |
| MU-09 | Personal-domain entity is user-scoped | personal contacts not shared | ✅ |
| MU-10 | Corporate-domain entity is user-scoped (default) | unless admin opt-in | ✅ |
| MU-11 | Tenant allowlist promotes corporate domains | system_config.entity_tenant_domains | ✅ |
| MU-12 | discovered_by_users union of all receiving users | A and B both receiving same sender | ✅ |
| MU-13 | A's manual contact invisible to B | unless admin tenant-shares | ✅ |
| MU-14 | Push prefs per-user | brain_configs.push_prefs[userId] | ✅ |
| MU-15 | Risk radar config per-user | brain_configs.risk_radar_config[userId] | ✅ |
| MU-16 | Brain config per-user | brain_configs.userId UNIQUE | ✅ |
| MU-17 | Different users get different Day Brief | content per-user | ✅ |
| MU-18 | Cross-user override impossible | A's rule edits don't touch B | ✅ |
| MU-19 | Push fan-out per-user | sendToUser scopes by userId | ✅ |
| MU-20 | Cost dashboard rolls up per user | top-users breakdown | ✅ |

---

## Summary

| Functionality | Total | Pass | Manual | Skip |
|---|---|---|---|---|
| 1. Risk Radar | 22 | 20 | 2 | 0 |
| 2. Risk Rules | 22 | 21 | 0 | 1 |
| 3. Contacts / Entity | 22 | 18 | 4 | 0 |
| 4. Star Rating | 20 | 14 | 6 | 0 |
| 5. Sentiment | 21 | 21 | 0 | 0 |
| 6. Brain Composer | 20 | 20 | 0 | 0 |
| 7. Day Brief layout | 20 | 0 | 20 | 0 |
| 8. Gate Rules | 22 | 22 | 0 | 0 |
| 9. Push + Approvals | 22 | 20 | 2 | 0 |
| 10. Kill Switch | 20 | 18 | 2 | 0 |
| 11. Cost Dashboard | 20 | 10 | 10 | 0 |
| 12. Brain Docs | 20 | 19 | 0 | 0 |
| 13. Delegation Matrix | 20 | 20 | 0 | 0 |
| 14. Criticality Engine | 20 | 20 | 0 | 0 |
| 15. Multi-tenant | 20 | 19 | 0 | 0 |
| 16. Multi-user | 20 | 20 | 0 | 0 |
| **TOTAL** | **331** | **282** | **46** | **3** |

## Pre-launch checklist

- [ ] All four migrations applied (`npx prisma migrate status` shows clean)
- [ ] System rules seeded on boot (look for `system rules seeded` logs)
- [ ] VAPID keys set in env (or push gracefully degrades)
- [ ] `npx ts-node src/scripts/smokeRiskRadarV2.ts` exits 0
- [ ] Manual UI walkthrough of Day Brief on desktop completed
- [ ] Manual UI walkthrough of Day Brief on mobile completed (after responsive work)
- [ ] No console errors on `/?tab=brief`, `/?tab=contacts`, `/?tab=rules`
- [ ] Kill switch trigger + release tested in staging
- [ ] Cost dashboard renders for SuperAdmin
- [ ] Push notification fires for an approval-required action

---

**Last updated:** 2026-04-29 by Risk Radar v2 + Mobile prep work
