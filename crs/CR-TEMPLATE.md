# CR-XXXX: <title>

- **Status:** DRAFT | BUILD | TESTING | BUILD_DEPLOY | DEPLOY_WAIT | SIGNOFF | CLOSED | ESCALATED (FAST lane: FAST_BUILD | FAST_DEPLOY | FAST_CLOSE)
- **Risk class (proposed by Claude):** Low | Moderate | Material | Critical
- **Risk class (RULED by Codex's Security Clearance — higher class wins):**
- **Budgets:** cost $__ / wall-clock __ h (per workflow defaults for this class)
- **Counters:** build→test cycles: 0/2 · CR revisions: 0/3

## 1. Requirement
<what the user/owner asked for, verbatim if possible>

## 2. Scope
> Every claim in this CR about CURRENT code behavior must cite `file:line` (verified by
> reading, not memory) — uncited/contradicted claims fail Technical Clearance on their own.
- Files/components expected to change:
- Explicitly out of scope:

### Surface inventory (the shared checklist — builder builds it, reviewer sweeps it)
> **If the requirement is about a CLAIM** (delivery, permission, status, availability),
> inventory the surfaces that DISPLAY the claim — variables, persisted columns, event
> names, HTTP response messages, screen labels, tallies, exports — not just the functions
> that produce it. A caller-only inventory guarantees repeat review rounds (CR-0013 took
> four: each fix revealed the next display surface).
Every endpoint/route, state transition, job, and screen the acceptance criteria touch —
exhaustively. An AC like "all endpoints validate X" is only reviewable against this list;
Technical Clearance FAILs the CR if the inventory misses surface, and Test findings must be
swept class-complete across it. One list, two independent judgments.
- [ ] <METHOD /path or transition or screen>:

## 3. Acceptance criteria
- [ ] AC-1:
- [ ] AC-2:

## 4. Recovery strategy
- Method: rollback | feature-flag disable | roll-forward | traffic isolation | data restoration
- How it works:
- Validation performed (step 9): <staging proof for Material+ / simulation or documented verification for Low-Moderate>

## 5. Gate log (paste each verdict verbatim)
The nine steps the orchestrator actually runs. `[auto]` = the orchestrator does it.
| # | Gate | Owner | Verdict | Notes / link | Timestamp |
|---|---|---|---|---|---|
| 1 | Requirement → CR | Claude | | | |
| 2 | Classification (FAST/TEAM) | classify.cjs [auto] | | | |
| 3 | Technical Clearance | Codex | | | |
| 4 | Security Clearance (Material+) | Codex (security session) | | | |
| 5 | Building | Claude | | | |
| 6 | Machine validation (harness) | orchestrator [auto] | | | |
| 7 | Test | Codex | | | |
| 8 | Security Review (code) | Codex (security session) | | | |
| 9 | Deploy | Human | | | |
| 10 | Sign-off (close) | Claude — refused without deploy evidence | | | |

## 6. Artifact
- Commit SHA:
- Artifact hash (SHA256):
- Build command:

## 7. Defect log (learning hook)
| Defect | Caught by gate | Classification (code bug / spec bug / transient / environment) |
|---|---|---|

## 8. Final report
- Spend vs budget:
- Soak result:
- Final status: SUCCESS | ROLLED_BACK | ESCALATED | REJECTED
