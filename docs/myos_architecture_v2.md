# MyOS — 7-Layer Architecture (v2 proposal)

MyOS v1 is a 6-layer stack: Feed → Knowledge → Brain → Action → Open Items → Instructions. Instructions at the top, reality at the bottom, with human intent overriding everything below.

v2 adds one layer — **Trust / Calibration** — between Open Items and Instructions. It is the layer that measures how often Brain was right, converts that measurement into behaviour, and closes the loop so Brain becomes a living advisor rather than a static engine.

This document keeps v1 intact; it only introduces what's new, why, and how it reshapes the neighbouring layers.

---

## 1. The 7 layers at a glance

```
                ┌──────────────────────────────────────┐
        Top  →  │  7.  Instructions                    │   Non-negotiable human orders
                ├──────────────────────────────────────┤
                │  6.  Trust / Calibration  (NEW)      │   Brain's credibility ledger + gate
                ├──────────────────────────────────────┤
                │  5.  Open Items                      │   Accountability trail
                ├──────────────────────────────────────┤
                │  4.  Action                          │   What Brain does / proposes
                ├──────────────────────────────────────┤
                │  3.  Brain                           │   Living reasoning engine
                ├──────────────────────────────────────┤
                │  2.  Knowledge (Wiki)                │   Compounding memory
                ├──────────────────────────────────────┤
       Base →   │  1.  Feed                            │   Connectors: reality in
                └──────────────────────────────────────┘
```

Reading the stack: **Feed** pulls reality in, **Knowledge** turns it into lasting memory, **Brain** reasons, **Action** decides what to do, **Open Items** tracks the work, **Trust** measures how well Brain did and gates how much autonomy it earns, and **Instructions** is the human's standing voice that still overrides everything.

The new layer is load-bearing because every other layer is currently blind to its own track record. Brain predicts. Action executes. Open Items tracks. But nothing reads the outcomes *back* and uses them to recalibrate. That's the job of layer 6.

---

## 2. Layer 6 — Trust / Calibration

Trust is the system's memory of its own performance. Three kinds of objects live here:

| Object | Lives as | Shape |
|---|---|---|
| **Prediction** | `predictions` table | Brain commits to a claim with a confidence |
| **Outcome** | `prediction_outcomes` table | Reality resolves the claim |
| **CalibrationScore** | `calibration_scores` table | Rolled-up hit rate per (axis, window) |

Together they form a loop: Brain makes a prediction, reality eventually settles it, the score updates, and the next prediction in the same category is gated by that score.

### 2.1 Prediction

A Prediction is an auditable commitment Brain makes at the moment of reasoning. Not every compose turn makes one — only the turns where Brain's output is a verifiable future claim.

```
type Prediction = {
  id: string
  clientNumber: string
  userId: number

  // What was claimed
  category: 'reply_time' | 'deal_close' | 'meeting_attend'
          | 'instruction_match' | 'open_loop_slip'
          | 'rule_accuracy' | 'observation_relevance'
  subject: string               // 'Marcus' | 'Project 846' | shadow_rule.id
  claim: string                 // "will reply by Thursday"
  confidence: number            // 0.0 - 1.0
  horizonHours: number          // when should this resolve by

  // Audit
  authoredBy: 'brain_composer' | 'cognitive_engine' | 'triage_suggester'
            | 'rule_miner' | 'user'
  sourcePageIds: string[]       // wiki pages consulted
  traceId: string               // correlates to compose call / tick

  status: 'open' | 'resolved' | 'expired' | 'invalidated'
  createdAt: DateTime
  resolveBy: DateTime
}
```

Predictions are made at four specific sites:

1. **Cognitive engine analyzers** — when `analyzeStaleThreads` fires on Marcus (5 days quiet, 3+ interactions), the analyzer *also* writes a prediction "Marcus will reply within the next 48h given historical rhythm: 0.62 confidence."
2. **Triage suggester** — when `archetypeClassifier` labels an event as `reply_needed`, it predicts whether the user will actually reply vs. delegate vs. ignore, and commits that prediction.
3. **Shadow rules** — every time a shadow rule fires autonomously, it predicts "the user will not override this action in the next 24h."
4. **Brain compose** — when the user asks a forward-looking question ("will this deal close this quarter?"), the answer itself is a prediction.

Every prediction carries a `resolveBy` so the ledger self-grooms.

### 2.2 Outcome

An Outcome is the reality check. It arrives via five channels:

| Channel | Signal |
|---|---|
| Open Items lifecycle | `CLOSED` / `DROPPED` / long stall on an item tied to a prediction |
| User action | approve / edit / discard / undo / override of a Brain-authored draft or autonomous action |
| Feed event | new inbound matching a predicted interaction (e.g. Marcus did reply) |
| Horizon expiry | `resolveBy` passed with no settling signal → prediction expires as "no" |
| Explicit correction | user hits `/brain/correct` and tells Brain directly |

```
type PredictionOutcome = {
  id: string
  predictionId: string
  verdict: 'hit' | 'miss' | 'partial' | 'unresolved'
  observedAt: DateTime
  evidence: {
    source: 'open_item' | 'feed_event' | 'user_action' | 'expiry' | 'correction'
    refId: string              // open_item.id, feed_event.id, action.id
    details?: string           // "Marcus replied at 2026-04-19 11:04"
  }
  latencyHours: number         // actual vs. predicted horizon
}
```

Outcomes are derived automatically where possible and accepted manually where needed. The spec invariant (below) is that **no prediction sits in `open` past `resolveBy + 6h` without a verdict** — a background worker resolves stragglers as `expired/miss`.

### 2.3 CalibrationScore

A rolling window summary of Brain's performance along an axis. Recomputed every 6h (lightweight aggregate).

```
type CalibrationScore = {
  clientNumber: string
  userId: number
  axis: {                       // composite key
    category: PredictionCategory
    scope: 'global' | 'subject'
    subject?: string            // e.g. 'Marcus', 'shadow_rule:abc'
  }
  window: '7d' | '30d' | '90d'

  sampleSize: number
  hitRate: number               // observed hits / resolved
  brier: number                 // mean (confidence - outcome)^2 — calibration quality
  coverage: number              // resolved / total — how often we actually learn

  // Derived thresholds (used by the trust gate)
  autonomyThreshold: number     // confidence needed to auto-execute in this axis
  lastComputedAt: DateTime
}
```

The three signals together — `hitRate`, `brier`, `coverage` — matter independently. High hit rate with low coverage is not trustworthy (you haven't tested Brain enough). Good Brier score with low hit rate means Brain is honestly uncertain (acceptable). The goal isn't to maximise hit rate; it's to minimise Brier: *predict at the confidence that matches how often you're actually right*.

### 2.4 Services

Three services, each small, each with one job:

```
predictionTracker    — write/resolve Predictions, emit Outcomes
calibrationService   — recompute CalibrationScores on a schedule
trustGate            — at action/compose time, check scores and return
                       { allowAutonomous, requireConfirm, forceDraft,
                         preambleForBrain }
```

`trustGate.evaluate(ctx)` is called from two places:
- **Before an autonomous action** — `autonomousExecutor` consults it instead of just checking `shadowRule.mode === 'ACTIVE'`.
- **During brainComposer** — the compose prompt gets a Trust block injected that tells Brain how confident it should speak in this subject area.

---

## 3. How Trust reshapes the neighbouring layers

### 3a. Layer 3 (Brain) — compose gets a Trust block

The current prompt envelope has 8 blocks (persona, schema, capabilities, instructions, preferences, tenant log, opened pages, honesty rules). v2 adds a 9th block between *learned preferences* and *tenant log*:

```
# My calibration on this subject (how often I've been right)
- On "deal close by Friday" predictions about projects in your CRM,
  I've been 54% accurate over 90 days (n=22). Speak with hedging.
- On "Marcus reply within 48h", I've been 71% accurate (n=7).
  You can lean on this slightly.
- I have no history on predictions about Raazia's response time.
```

And a ninth honesty rule joins H1–H8:

> **H9. Speak at the confidence your calibration supports.** If the opened pages justify a claim but your calibration block says you've been unreliable in this subject, flag the uncertainty in the answer ("I'd guess X — fair warning, I've been wrong about deals this quarter more often than I've been right").

This is the single change that most makes Brain feel alive. An LLM asked to hedge abstractly hedges everything; an LLM told "you've been 54% right about deal predictions this quarter" can hedge specifically and accurately.

### 3b. Layer 4 (Action) — gate, not mode

Today Action has three paths based on shadow-rule mode: Autonomous (`ACTIVE`), Suggested (triage), Drafted. v2 unifies them behind the Trust Gate:

```
type ActionRequest = {
  intent: SuggestedAction
  confidence: number            // composer's or analyzer's self-score
  blastRadius: 'low' | 'medium' | 'high'  // outbound email > open-item creation
  axis: { category, scope, subject? }
}

trustGate.evaluate(req) →
  { mode: 'autonomous' | 'autonomous_with_undo' | 'suggest' | 'draft_only',
    explain: string            // human-readable reason for the mode chosen
  }
```

Decision logic (executable, not aspirational):
```
score = calibrationScores.lookup(req.axis, '30d')
autonomousOK = req.confidence ≥ score.autonomyThreshold
             AND score.sampleSize ≥ 20
             AND score.brier ≤ 0.12
             AND req.blastRadius ≠ 'high'

if autonomousOK AND req.blastRadius = 'low'  → autonomous
if autonomousOK AND req.blastRadius = 'med'  → autonomous_with_undo (2-min window)
if NOT autonomousOK AND score.coverage > 0.4 → suggest
else                                           → draft_only
```

Three consequences fall out:

1. A shadow rule that used to execute autonomously after 14 days in SHADOW now has to *also* earn the autonomy threshold in its own axis — no more earning your trust on rule-accuracy and cashing it in on a high-blast-radius action like auto-send-email.
2. A brand-new axis (sampleSize < 20) defaults to `suggest` mode even with high confidence. Trust is earned, not granted.
3. The `explain` string bubbles up to the user surface ("I'm only drafting this because I've been wrong about Marcus's reply rhythm lately"). The user can see *why* Brain chose the mode, which is what makes them trust the system.

### 3c. Layer 5 (Open Items) — emits outcomes

Every status transition on an Open Item emits an Outcome candidate. Services listen: `predictionTracker.onOpenItemTransition(item, from, to)` matches the item to any open Prediction with the same subject+category and resolves it.

Concretely: a DELEGATED → CLOSED transition within a predicted 48h window resolves the `open_loop_slip` prediction as a hit. A WAITING_INFO → SNOOZED for 5 days resolves it as a miss.

No schema change needed; we add a worker that reads the existing `OpenItem` timestamps.

### 3d. Layer 7 (Instructions) — bi-directional via Trust

Instructions today flow user → Brain. v2 adds the reverse path, gated by Trust:

```
Rule miner finds a pattern
     │
     ▼
Create shadow_rule (mode=DRAFT)
     │ …after N observations…
     ▼
Promote to SHADOW (mode=SHADOW) — runs in shadow, logs predictions
     │ …after trustGate passes on rule_accuracy axis…
     ▼
Propose as instruction to user
     │
     ▼
POST /brain/instructions/proposed  (visible on Day Brief)
     │
     ▼
User approves → instruction created + shadow_rule → ACTIVE
User rejects  → shadow_rule → ARCHIVED + Outcome ('miss') on rule_accuracy
User ignores 7 days → lapse → predictionTracker records 'unresolved'
```

The critical change: the jump from SHADOW to ACTIVE is no longer a time-based promotion ("14 days in shadow with ≥20 consistent firings"). It's now gated by the user's explicit consent *and* by Trust's calibration on the rule-accuracy axis. Brain earns the right to act by being visibly right, not by outlasting a timer.

---

## 4. Walkthroughs

### 4a. Walkthrough — Brain predicts, reality resolves

```
1. 14:30 Tuesday      analyzeStaleThreads sees Marcus: 5 days quiet,
                      3 prior interactions, historical median reply in
                      36h. Emits an observation AND a Prediction:
                        category = 'reply_time'
                        subject  = 'Marcus'
                        claim    = 'will reply in ≤48h'
                        confidence = 0.62
                        resolveBy = Thursday 14:30

                      Observation surfaces on Day Brief with a small
                      confidence pill: "I'd bet — 62%".

2. Wed 09:15           Gmail poller ingests a reply from Marcus. The
                      scribe pipeline creates an email_message and
                      updates the sender_topic. predictionTracker
                      sees the feed_event matches an open Prediction
                      (same entityId + category) and resolves it:
                        verdict = 'hit'
                        latencyHours = 19

3. 00:00 Sunday       calibrationService recomputes scores.
                      Marcus reply_time 30d score:
                        sampleSize = 8, hitRate = 0.75,
                        brier = 0.09, coverage = 0.88
                      autonomyThreshold for this axis rises to 0.58.

4. Next similar tick  analyzeStaleThreads runs again on another user
                      with similar profile; the Trust block injected
                      into Brain's compose call reads:
                        "On reply_time predictions for close
                         collaborators, I've been 75% right (n=8).
                         Lean on these — but my sample is small."
```

### 4b. Walkthrough — an instruction is proposed, not inferred

```
1. over 3 weeks      MD forwards 11 emails from Raazia to Asad. Each
                     forward is captured as a decision_log row with
                     user_decision='delegate', delegatee='Asad'.

2. rule miner tick   Finds the pattern — 11 consistent delegations
                     above the DRAFT threshold. Creates a shadow_rule
                     { mode: 'DRAFT', dedupHash, user_decision: 'delegate' }.

                     Also emits a Prediction on the rule_accuracy axis:
                       claim: "the next time an email from Raazia
                              lands, MD will delegate to Asad"
                       confidence: 0.82
                       horizonHours: 336 (14 days)

3. shadow window     Two more Raazia emails land. Shadow rule logs
                     what it *would* have done. Both match the user's
                     actual choice. Two hits on rule_accuracy.

4. trust gate reads  rule_accuracy axis for this shadow_rule:
                       sampleSize = 2, hitRate = 1.0, coverage = 1.0
                     Not enough to auto-promote. Still below the
                     min-samples threshold of 5.

5. two more weeks    Three more matches, all hits. sampleSize = 5.
                     calibrationService bumps score:
                       hitRate = 1.0, brier = 0.03, coverage = 1.0
                     autonomyThreshold crosses.

6. proposal          trustGate raises an event.
                     POST /brain/instructions/proposed creates:
                       "I think I've spotted a pattern. Every Raazia
                        email in the last month you've forwarded to
                        Asad. Want me to make that a standing rule?
                        (11 of 11 times; I'm quite confident.)"

7. user approves     Instruction row created (kind=standing_rule).
                     shadow_rule mode → ACTIVE. All future Raazia
                     emails auto-delegate.

8. first ACTIVE fire Prediction written:
                       claim: "MD will not override this action in 24h"
                       confidence: 0.95
                     24h later, no override → resolved 'hit'.
                     calibration deepens.
```

The promotion is not time-based. It is evidence-based and user-consented. That is the change.

### 4c. Walkthrough — trust shrinks

```
1. over 30 days      autonomous_executor fires on a drift in Marcus's
                     archetype. The user overrides twice and undoes
                     once. predictionTracker resolves those Predictions
                     as 'miss'. Outcomes emitted.

2. calibrationService recomputes the Marcus-subject rule_accuracy:
                       hitRate drops 0.95 → 0.70
                       brier rises 0.04 → 0.18

3. next tick         trustGate.evaluate returns mode='suggest' instead
                     of 'autonomous'. The Day Brief now shows:
                       "I was going to forward this automatically,
                        but I've been wrong twice this month about
                        Marcus — want to confirm?"

4. rule status       shadow_rule stays ACTIVE in storage but trust
                     gates it down to suggest. No config change. No
                     human intervention. Trust acts as a continuous
                     circuit breaker.
```

---

## 5. New invariants (join §10 of v1)

8. **Every Brain-authored future claim is a Prediction.** If a compose turn, analyzer, or triage call emits a future-tense assertion the system will later be able to verify, it must write a `predictions` row with a confidence and a `resolveBy`. Claims without tracking are banned.
9. **No Prediction stays open past `resolveBy + 6h`.** A worker resolves stragglers as expired. Coverage must stay observable.
10. **Autonomy is conditional, not static.** No action is autonomous by virtue of config alone. `trustGate.evaluate` must return a permissive verdict at call time.
11. **Trust explanations are user-visible.** Whenever the gate downgrades a mode (e.g. autonomous → suggest), the reason must be stringified and rendered to the user. No silent mode changes.
12. **Human intent still wins.** An Instruction explicitly granting autonomy ("always forward Raazia's emails to Asad, don't confirm") overrides a low Trust score. The gate reports the override but does not block the action. Instructions is layer 7 for a reason.

---

## 6. Implementation sketch

### New tables

```prisma
model Prediction {
  id             String    @id @default(cuid())
  clientNumber   String    @map("client_number") @db.VarChar(20)
  userId         Int       @map("user_id")
  category       String    @db.VarChar(40)
  subjectKey     String    @map("subject_key") @db.VarChar(200) // normalized
  subjectLabel   String?   @map("subject_label") @db.VarChar(200)
  claim          String    @db.Text
  confidence     Float
  horizonHours   Int       @map("horizon_hours")
  authoredBy     String    @map("authored_by") @db.VarChar(30)
  sourcePageIds  String[]  @map("source_page_ids")
  traceId        String?   @map("trace_id") @db.VarChar(64)
  status         String    @default("open") @db.VarChar(20)
  createdAt      DateTime  @default(now()) @map("created_at")
  resolveBy      DateTime  @map("resolve_by")

  outcomes       PredictionOutcome[]

  @@index([clientNumber, userId, status, resolveBy])
  @@index([clientNumber, userId, category, subjectKey])
  @@map("predictions")
}

model PredictionOutcome {
  id              String     @id @default(cuid())
  predictionId    String     @map("prediction_id")
  verdict         String     @db.VarChar(20)       // hit | miss | partial | unresolved
  observedAt      DateTime   @map("observed_at")
  evidenceSource  String     @map("evidence_source") @db.VarChar(30)
  evidenceRefId   String?    @map("evidence_ref_id") @db.VarChar(200)
  evidenceDetails String?    @map("evidence_details") @db.Text
  latencyHours    Float?     @map("latency_hours")
  createdAt       DateTime   @default(now()) @map("created_at")

  prediction      Prediction @relation(fields: [predictionId], references: [id], onDelete: Cascade)

  @@index([predictionId])
  @@map("prediction_outcomes")
}

model CalibrationScore {
  clientNumber   String    @map("client_number") @db.VarChar(20)
  userId         Int       @map("user_id")
  category       String    @db.VarChar(40)
  subjectKey     String?   @map("subject_key") @db.VarChar(200)
  window         String    @db.VarChar(10)        // 7d | 30d | 90d
  sampleSize     Int       @map("sample_size")
  hitRate        Float     @map("hit_rate")
  brier          Float
  coverage       Float
  autonomyThreshold Float  @map("autonomy_threshold")
  lastComputedAt DateTime  @map("last_computed_at")

  @@id([clientNumber, userId, category, subjectKey, window])
  @@index([clientNumber, userId, category])
  @@map("calibration_scores")
}
```

### New services

- `server/src/services/trust/predictionTracker.ts` — `writePrediction`, `resolveByRef`, `expireStragglers` (worker)
- `server/src/services/trust/calibrationService.ts` — `recomputeAll` (every 6h), `lookup(axis, window)`
- `server/src/services/trust/trustGate.ts` — `evaluate(ActionRequest) → GateVerdict`

### New endpoints

- `GET  /brain/trust/summary` — the user-visible "how Brain has been doing" panel
- `GET  /brain/trust/predictions?status=open` — pending predictions (fuel for Day Brief)
- `POST /brain/instructions/proposed` — internal; emits a proposed instruction card
- `POST /brain/correct` — user directly tells Brain its model is wrong; writes an Outcome ('miss') plus a correctedBeliefs entry on mind_state

### Wiring

- `brainComposer` — call `calibrationService.lookup` for relevant axes, render into the prompt between "Learned preferences" and "Recent tenant activity"
- `autonomousExecutor` — replace the `mode === 'ACTIVE'` branch with `trustGate.evaluate(...)`
- `brainCognitiveEngine` — every analyzer that fires an observation also writes a Prediction via `predictionTracker`
- `ruleMiner` — emit Predictions on `rule_accuracy` axis when shadow rules fire
- A new worker `jobs/predictionResolver.ts` — resolves open Predictions from OpenItem transitions, feed events, and expiry

---

## 7. Why 7, and why this order (update to v1 §9)

- **Feed without Knowledge** is noise.
- **Knowledge without Brain** is a searchable library.
- **Brain without Action** is a chatbot.
- **Action without Open Items** loses track of in-flight work.
- **Open Items without Trust** means the system never learns — it takes actions, records them, and then asks every morning "how should I act today?" as if the past didn't happen.
- **Trust without Instructions** is a self-teaching advisor the user can't override.
- **Instructions remains at the top** because even a perfectly-calibrated Brain must still obey the human.

Trust sits *above* Open Items because it reads outcomes from there, and *below* Instructions because an explicit human order beats any calibration score. That ordering is load-bearing: it means Brain can grow its own autonomy but never past what the human has sanctioned, and it can *lose* autonomy automatically when outcomes disagree — without human intervention.

---

## 8. Why not make Trust a cross-cutting concern instead of a layer?

Two reasons.

1. **Layers in this stack are about authority, not implementation.** Instructions doesn't do more work than Trust; it just has a bigger vote. The layer number encodes override precedence. A cross-cutting "sidecar" would mean Trust could suggest but couldn't block, and that defeats the gate.
2. **Visibility.** A layer has its own UI surface (`Trust summary` on Day Brief, `Proposed instructions` section, per-axis calibration page). A sidecar hides in config. If the goal is for Brain to feel like a living advisor whose trust you can see growing, Trust needs to be something the user looks at — not plumbing.

---

## 9. Rollout order

If v2 is adopted, I'd ship in this order:

1. **Predictions table + `predictionTracker`** — start writing Predictions from `brainCognitiveEngine` analyzers only. No gating yet. Accumulate data.
2. **`predictionResolver` worker + Outcomes** — close the loop so data can be verified. Still no gating.
3. **`calibrationService`** — compute and expose scores. Read-only.
4. **Trust block in compose** — inject calibration into Brain's prompt. Honesty rule H9. This is the single highest-impact shipping milestone: Brain starts speaking at calibrated confidence with existing rule logic untouched.
5. **`trustGate` in `autonomousExecutor`** — replace the hard `mode === 'ACTIVE'` check. Conservative defaults so nothing that used to be autonomous stops being autonomous; just adds the downgrade path.
6. **Bi-directional Instructions — `/brain/instructions/proposed`** — rule miner proposes, user approves.
7. **UI surfaces** — Trust summary panel, proposed-instruction cards, Predictions inbox.

Items 1–4 are invisible to users and safe to roll behind a feature flag. Items 5–7 are the ones that change UX and should ship behind explicit tenant opt-in until they've been exercised.

---

## 10. Files to add / touch

### New
- `prisma/migrations/<date>_trust_layer/migration.sql`
- `server/src/services/trust/predictionTracker.ts`
- `server/src/services/trust/calibrationService.ts`
- `server/src/services/trust/trustGate.ts`
- `server/src/jobs/predictionResolver.ts`
- `server/src/routes/trustRoutes.ts`
- `client/src/pages/TrustPage.jsx` (or a Day Brief tile + detail drawer)

### Touch
- `server/src/services/knowledge/brainComposer.ts` — inject Trust block, add H9
- `server/src/services/knowledge/brainCognitiveEngine.ts` — each analyzer writes a Prediction
- `server/src/services/triage/autonomousExecutor.ts` — consult `trustGate`
- `server/src/services/triage/ruleMiner.ts` — emit rule_accuracy Predictions
- `server/src/routes/briefRoutes.ts` — Day Brief returns Trust summary
- `docs/myos_architecture.md` — update to v2

---

## 11. What this changes about the feel of the product

Today MyOS is a correct system. It ingests, remembers, reasons, acts, tracks. It obeys instructions. But it does not have a sense of its own track record, and the user has to infer its reliability from pattern-matching their own experience.

With layer 6, the user sees — literally, on a page — how often Brain's predictions come true, how often its autonomous actions go unreverted, how often its analyzers surface things that turned out to matter. Brain says "I've been 54% right about deals this quarter" out of its own mouth. Shadow rules graduate to autonomous not by timer but by evidence the user can read. An autonomous action that would have fired yesterday sometimes gets downgraded to a suggestion today, because Brain itself noticed it was losing accuracy in that subject. Nothing in the UX becomes more complicated; a confidence pill and an explanation string are all that show up.

That is the difference between a tool and an advisor. The advisor does not become more capable; it becomes legible.
