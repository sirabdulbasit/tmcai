# Codex review — `c572ccf`

| | |
|---|---|
| `BASE_SHA` | `e356d42cf63814f08eba8ab5ab6066135b9cf106` |
| `REVIEW_SHA` | `c572ccf3b9d89156b35d9caa63ff7f8748b03d34` |
| Range reviewed | `e356d42..c572ccf` (code); docs commit `5025024` outside it |
| Submitted | 2026-08-16, `codex exec --sandbox read-only` (codex-cli 0.147.0) |
| Evidence package | `CMP-2026-08-16-CHUNK1-EVIDENCE.md` |

**This verdict is bound to the range above and does not travel.** Rebasing this
change onto another base produces an unreviewed artifact.

Final review block, verbatim.

---

ITERATION_VERDICT: WRONG
RELEASE_STATUS:    BLOCKED

### Canonical capability scorecard

Build `c572ccf`; compared with the latest verified scorecard, 47.3/100. This configuration-only change earns no capability movement because it is undeployed and changes no Brain behavior.

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

Overall: Nexeo **47.3**, professional benchmark **91.9**, gap **44.6**, movement **0.0 — NEUTRAL**. The release verdict is nevertheless WRONG because it weakens a standing safety gate without replacing it.

### Findings

1. **HIGH — [server/tsconfig.json:23](/var/www/tmcai/server/tsconfig.json:23): artifact exclusion also silently removes type coverage.**

   The mechanism is wrong for the stated objective. The production build should omit operator scripts, but the standing `npx tsc --noEmit` gate should continue checking them—particularly the four scripts capable of touching production.

   Because both build and verification use the same configuration, lines 23–36 make future type breakage in all 41 scripts invisible to the mandatory matrix. The fact that all 41 type-checked clean before this change makes the loss unnecessary rather than remedial.

   Directive: separate the two concerns:

   - Keep the normal/typecheck configuration covering all source scripts.
   - Add a build-specific configuration excluding the 41 operator scripts.
   - Change `npm run build` to compile with the build-specific configuration.
   - Add an explicit script/typecheck command to the standing rails if necessary.
   - Prove a deliberately invalid type in one excluded-from-build operator script fails the typecheck configuration while remaining absent from the build artifact.

2. **LOW — [server/tsconfig.json:23](/var/www/tmcai/server/tsconfig.json:23): the glob encodes filename classification rather than an explicit operator-script inventory.**

   `smokeVectorRetrieval.ts` does not import the Prisma singleton, but this is not a reason to leave it in `dist`: it invokes `answerAsBrain` with the live tenant and is itself production-acting. Therefore it should remain excluded from the shipped artifact.

   The defect is explanatory and maintainability-related: `smoke*.ts` means every future file with that prefix will silently lose both emission and type checking under the current mechanism, irrespective of its actual safety class.

   Directive: in the build-only configuration, either retain the glob with a clear rule that every `smoke*.ts` file is an operator-only entry point, or use an explicit inventory plus a parity test. Do not restore `smokeVectorRetrieval.ts` to the production artifact merely because it lacks the direct Prisma import.

### Verified judgments

- The correct exclusion count is **41**, not 40. No file should be removed from the exclusion set on the evidence presented.
- There are **28** `smoke*.ts` files; **27** directly import the Prisma singleton.
- All 13 named files exist and do not overlap the glob.
- Runtime-reference search across `src/server.ts`, `src/jobs/`, and `package.json` returned zero.
- The source trees at `e356d42` and `c572ccf` are identical: `8b116cdef00f72e3d210afd53b75666572db060f`.
- The dirty `scripts/orchestrator/deploy.sh` and loop-state artifacts are outside the reviewed range.
- Nothing is authorized for deployment.

### Next-turn directive

Replace the single-config exclusion with split typecheck/build configurations, preserve all 41 files under compile-time checking, keep all 41 out of `dist`, rerun the complete verification matrix, and publish the resulting one-commit review range plus updated evidence.
