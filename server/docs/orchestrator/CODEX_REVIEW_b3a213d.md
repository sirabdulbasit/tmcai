# Codex review — `b3a213d` (remediation of the c572ccf WRONG)

| | |
|---|---|
| `BASE_SHA` | `ff57f19` |
| `REVIEW_SHA` | `b3a213d71c95e2e4ec12996f7adf4f02afc473d9` |
| Range reviewed | `ff57f19..b3a213d` (code); docs commits `2c47e31`, `54548a6` outside it |
| Submitted | 2026-08-16, `codex exec --json --sandbox read-only` (codex-cli 0.147.0) |
| Terminal event | `turn.completed` — thread `01a00b92-6157-74e2-b1b3-bb2989a69a31` |

**First submission was `REVIEW_INCOMPLETE`** — codex blocked on stdin, produced
`thread.started`/`turn.started`: none, and was killed. No verdict existed. Resubmitted
with stdin closed; this record is the completed run.

**This verdict is bound to the range above and does not travel.**

---

### Canonical capability scorecard

Configuration/test-only build `b3a213d`; no Brain behavior changed or was production-verified.

| Capability | Nexeo | Professional | Gap | Δ | Paired 20-character bars |
|---|---:|---:|---:|---:|---|
| Simple & Smart | 33 | 92 | 59 | 0 | `███████░░░░░░░░░░░░░` / `██████████████████░░` |
| Thinking | 36 | 94 | 58 | 0 | `███████░░░░░░░░░░░░░` / `███████████████████░` |
| Memory | 60 | 92 | 32 | 0 | `████████████░░░░░░░░` / `██████████████████░░` |
| Accurate Communication | 72 | 94 | 22 | 0 | `██████████████░░░░░░` / `███████████████████░` |
| Authorized Action | 52 | 91 | 39 | 0 | `██████████░░░░░░░░░░` / `██████████████████░░` |
| Self Follow-Up | 43 | 96 | 53 | 0 | `█████████░░░░░░░░░░░` / `███████████████████░` |
| Learn | 42 | 90 | 48 | 0 | `████████░░░░░░░░░░░░` / `██████████████████░░` |
| Self-Healing | 55 | 89 | 34 | 0 | `███████████░░░░░░░░░` / `██████████████████░░` |
| Self-Pruning | 33 | 89 | 56 | 0 | `███████░░░░░░░░░░░░░` / `██████████████████░░` |

Overall: Nexeo **47.3**, professional benchmark **91.9**, gap **44.6**, movement **0.0 — NEUTRAL**.

```text
ITERATION_VERDICT: WEAK
RELEASE_STATUS:    BLOCKED
```

The original HIGH finding is closed in the current configuration. Independently resolved TypeScript programs show:

- Default typecheck program: all **79** `src/scripts/*.ts` files, including the classified 41.
- Build program: **38** scripts; none of the classified 41.
- The five inherited exclusions in `tsconfig.build.json` exactly match the pre-change base exclusions.
- `deploy.sh:154` runs `npx tsc --noEmit` from `server/`, therefore uses the restored typecheck configuration.

### Findings

1. **MEDIUM — parity test does not bind actual TypeScript program membership.**  
   [operatorScriptParity.test.ts:121](/var/www/tmcai/server/tests/operatorScriptParity.test.ts:121)

   Guard 5 checks only that `tsconfig.json.exclude` has no `src/scripts/` entry. It still passes if `include`, `files`, inheritance, or another configuration change removes all 41 scripts from the resolved program. Likewise guard 3 compares two handwritten lists rather than proving the 41 are absent from the resolved build program.

   This leaves a different route to the same safety-gate regression. The current programs are correct, but the claimed standing protection is incomplete.

2. **MEDIUM — guard 6 is not a runtime entry-graph check.**  
   [operatorScriptParity.test.ts:135](/var/www/tmcai/server/tests/operatorScriptParity.test.ts:135)

   It searches literal `scripts/<name>` substrings only in `server.ts` and files under `src/jobs`. It misses imports through routes, controllers, services, startup helpers, package entry points, alias imports, and nonliteral imports. TypeScript can re-include an excluded source when reachable through an import, so this test cannot support the assertion that none of the 41 can return to the emitted runtime graph.

3. **LOW — Tier 5’s “No writes observed” classification is false.**  
   [tsconfig.build.json:80](/var/www/tmcai/server/tsconfig.build.json:80)

   At least these Tier 5 scripts write:

   - `loadTestFeed.ts`: `$executeRaw DELETE`
   - `smokeInstructionVeto.ts`: `$executeRawUnsafe`
   - `smokeMeetingDigest.ts`: two `$executeRawUnsafe` calls
   - `smokeWaDailyLimit.ts`: multiple `$executeRawUnsafe` calls

   They remain correctly excluded, so this does not reopen artifact exposure, but it shows the tiers are post-hoc/inaccurate evidence rather than a reliable production-surface classification.

4. **SCOPE NOTE — the remaining 38 scripts are not harmless runtime scripts.**

   Several are plainly operator-facing and production-capable: migrations, numerous backfills, cleanup/purge jobs, token provisioning, seeders, one-off WhatsApp sending, and Brain replay/check scripts. Because this is explicitly “Chunk 1” and the exact remediation range concerns the prior 41, their continued emission is not independently a finding against this four-file diff. However, `b3a213d` must not be represented as completing removal of operator tooling from production artifacts.

### Next-turn directive

Do not deploy. Amend the parity test to:

1. Resolve both configs with the TypeScript configuration API and assert every inventory file is present in the typecheck program and absent from the build program.
2. Validate the emitted/runtime dependency graph using TypeScript module resolution or an emitted-file manifest, not substring searches in two source locations.
3. Correct the four Tier 5 classifications and rationale.
4. Keep the other 38 scripts as an explicitly bounded follow-up inventory; do not silently classify them as safe runtime artifact content.