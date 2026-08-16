# CMP-2026-08-16 · Chunk 1 · evidence package

**Artifact under review**

| | |
|---|---|
| `BASE_SHA` | `e356d42cf63814f08eba8ab5ab6066135b9cf106` |
| `REVIEW_SHA` | `c572ccf3b9d89156b35d9caa63ff7f8748b03d34` |
| Branch | `release/cmp-2026-08-16` |
| Range | `e356d42..c572ccf` — one commit, one file, `server/tsconfig.json` |
| Verdict | **UNREVIEWED** — no `ITERATION_VERDICT` exists for this SHA |
| Deployed | **NO.** `deployed-sha` remains `e356d42`; production `dist` untouched |

`UNREVIEWED` is used deliberately. It is not a status in the
`SOUND | WEAK | WRONG | NO_BUILD | UNREVIEWABLE` enum — it is the absence of
one, and it is weaker evidence than a bad verdict, not stronger.

## 1 · What the change is

`server/tsconfig.json` gains 14 `exclude` entries removing **41** hand-run
operator scripts from the TypeScript program. They are no longer type-checked by
the standing matrix and no longer emitted into `server/dist`.

```
src/scripts/smoke*.ts        →  28 files   (glob)
13 named scripts             →  _smoke_undo, nexeoCapabilityBenchmark,
                                brainChatRegressionBattery, brainChatBattery,
                                cleanupBatterySeeds, seedGoldenDataset,
                                verifyGuruFix, chaosDrill, loadTestFeed,
                                draftTestWaToBasit, probeTasks,
                                diagnoseAttention, scribeBackfillEmails
```

`_smoke_undo.ts` is named rather than globbed: the leading underscore means
`smoke*.ts` does not match it. This is the one entry a reviewer would expect the
glob to cover and it does not.

## 2 · Count reconciliation — SCOPE said 40, the tree says 41

SCOPE's figures were *27 smoke scripts* and *40 total*. Both numbers describe
something real; neither is the count of excluded files.

| claim | measured | class |
|---|---|---|
| smoke scripts inheriting the prisma singleton | **27** — `smokeVectorRetrieval.ts` does not import `../db/prisma` | `INDEPENDENTLY_REPRODUCED` |
| files matching `src/scripts/smoke*.ts` | **28** | `INDEPENDENTLY_REPRODUCED` |
| named additions, all existing, none overlapping the glob | **13** | `INDEPENDENTLY_REPRODUCED` |
| **total excluded** | **41** = 28 + 13 | `INDEPENDENTLY_REPRODUCED` |

The 40 comes from `27 + 13`, which uses the singleton-inheritance figure as
though it were the file count. The exclusion is by filename, so the singleton
figure does not govern it.

The artifact arithmetic confirms 41 independently, without reference to either
count: **637 `.js` at `e356d42` → 596 `.js` here — a difference of exactly 41.**

## 3 · SCOPE's rationale, checked rather than relayed

**"None is referenced by server.ts, jobs/, or any npm script — zero runtime
breakage."** — **CONFIRMED**, `REPOSITORY_VERIFIED`. grep for all 41 basenames
across `src/server.ts`, `src/jobs/` and `package.json` returns **0** references.
`tsc --listFiles` confirms no transitive pull-in: 41 targeted, 41 absent from the
program, 38 scripts remain. `package.json`'s `smoke` script points at
`test/brain-scenarios/smoke.ts`, a different path, unaffected.

Invocation is unaffected: these are `ts-node` entry points, and `ts-node`
compiles the entry point it is given without consulting tsconfig `exclude`.

**"Four of them dispatch real Brain actions against production."** — **CONFIRMED
in substance, with a distinction worth recording.** Only two reach the action
registry directly; the other two act on production by different routes:

| script | production surface | class |
|---|---|---|
| `chaosDrill.ts` | `executeViaRegistry` + `fetch(` | `REPOSITORY_VERIFIED` |
| `_smoke_undo.ts` | `executeViaRegistry` + `cascadingUndoService` | `REPOSITORY_VERIFIED` |
| `draftTestWaToBasit.ts` | `prisma.agentAction.create` — plants a one-click WhatsApp draft addressed to the owner's live number `+923226288256` | `REPOSITORY_VERIFIED` |
| `nexeoCapabilityBenchmark.ts` | `answerAsBrain` from `routes/brainAskRoutes` via the prisma singleton against the live tenant — the C1-D1 live-backlog writes | `REPOSITORY_VERIFIED` |

So the count of four holds; "dispatch" is exact for two of them and "acts against
production" is the accurate phrasing for the other two.

## 4 · The cost, stated rather than buried

**41 files lose compile-time type checking.** A later edit that breaks types in
any of them no longer fails `npx tsc --noEmit`, and the standing matrix will not
catch it. That is the trade this commit makes deliberately: type coverage on 41
hand-run scripts, in exchange for removing them — including four
production-acting ones — from the deployed artifact.

Baseline note: `npx tsc --noEmit` was **clean with all 41 still included**, so
this exclusion removes scope. It is not suppressing existing errors.

## 5 · Verification — all after the final edit, bound to `c572ccf`

| check | result | mode |
|---|---|---|
| `npx tsc --noEmit` | **clean, exit 0** | working tree |
| `npx vitest run` | 190 passed / 1 skipped (191 files); **2318 passed, 0 failed**, 7 expected fail, 21 skipped, 1 todo (2347) | **UNISOLATED** — reaches production Redis |
| `npx vitest run` | 188 passed / 2 failed / 1 skipped (191); 2312 passed, **6 failed**, 7 expected fail, 21 skipped, 1 todo (2347) | **ISOLATED** — `unshare -n`, `env -i` |
| `npm run build` | **passes, exit 0** | **isolated clone — NOT run in place** |
| `git diff --check` | clean | working tree |

**The 6 isolated failures are pre-existing and not attributable to this change**,
proven by A/B rather than asserted: the identical 6 tests in the identical 2
files fail at **unmodified `e356d42`** under the same isolation, with identical
totals (2347). They are 10s timeouts in `def144ReceiptDoesNotReplaceAnswer` and
`def147VerifiedProseToken` — the documented Redis-dependency class, where
`src/config/redis.ts` defaults to `127.0.0.1:6379` and is unreachable inside the
network namespace.

The isolated and unisolated figures are different measurements and are not
quoted interchangeably.

## 6 · Artifact manifest

Built from a clean `git clone --no-local` at `e356d42` with this tsconfig
applied. Production's `server/dist` was **deliberately not rebuilt**.

```
dist manifest  59d6cde85ca91bf472fd235c73f87502ffa4f29ffae5ac913b63ad55b8e2099a
js file count  596      (e356d42 production dist: 637 — difference exactly 41)
reproducible   YES — two consecutive builds produced the identical manifest
```

Algorithm, published so it can be recomputed — content-bearing, relative paths,
so the output directory name never enters the hash:

```bash
cd server/dist && find . -type f -name '*.js' -printf '%P\n' | LC_ALL=C sort \
  | while IFS= read -r f; do printf '%s  %s\n' "$(sha256sum "$f"|cut -d' ' -f1)" "$f"; done \
  | sha256sum
```

`prisma generate` ran as part of `npm run build`; it writes into `node_modules`,
not `dist`, so it does not enter the manifest.

**Equivalence class.** The manifest identifies a class, not a single commit: any
commit sharing `server/src` tree `8b116cdef00f72e3d210afd53b75666572db060f`
*and* this tsconfig produces it.

## 7 · Why the build did not run in place — R-1

`pm2 describe tmcai-server` gives script path `/var/www/tmcai/server/dist/server.js`,
pid 1239772, cwd `/var/www/tmcai/server`. **`server/dist` is the live artifact.**
Running `npm run build` in the production tree would have rewritten it — removing
41 files from the artifact a `pm2 restart`, crash or reboot would activate, with
no authorization and no record. That is precisely the R-1 hazard
(`orc_arch.md` §38), whose operational correction is **approval #6, not
authorized**.

The build therefore ran in an isolated clone outside `/var/www/tmcai`, with its
own `node_modules` and writable `TMPDIR`.

**Production `dist` is provably untouched** — manifest identical across the whole
window:

```
before  b9b1f4aab4dbcd9994d373d779a678f8e5f9511c997923710725b6d251dd6a8d   637 .js
after   b9b1f4aab4dbcd9994d373d779a678f8e5f9511c997923710725b6d251dd6a8d   637 .js
```

**R-1 src-parity HELD.** The change is outside `server/src`, so:

```
c572ccf:server/src  =  e356d42:server/src  =  8b116cdef00f72e3d210afd53b75666572db060f
```

The deployed SHA's source tree is byte-identical to the release commit's. This
commit cannot alter what a restart would run.

## 8 · Bracketed invariant window

Sampled before and after, UTC.

| invariant | 13:35:46Z | 13:50:59Z |
|---|---|---|
| pid | 1239772 | 1239772 |
| `/proc/<pid>/stat` starttime | 140855493 | 140855493 |
| pm2 restart count | 8 | 8 |
| `deployed-sha` | `e356d42` | `e356d42` |
| production dist manifest | `b9b1f4aa…` | `b9b1f4aa…` |
| `.git/config` mtime | 1786878370 | 1786878370 |
| `.git/HEAD` mtime | 1786878366 | 1786878366 |
| `.git/packed-refs` mtime | 1786528858 | 1786528858 |
| worktree entries | 5 | 5 |
| `refs/heads` count | 8 | 8 |

`.git/index` and `.git/logs/HEAD` moved (1786878547 → 1786888230). That is this
commit and nothing else. Every production git read used
`git --no-optional-locks`.

## 9 · Out of range — declared, not swept in

`scripts/orchestrator/deploy.sh` is **dirty in the working tree and deliberately
not staged** (+76/−59, the supervisor's SD-001 rails replacing the regex-over-prose
gate). It is orchestrator-owned, unrelated to this chunk, and outside
`e356d42..c572ccf`. Only `server/tsconfig.json` was staged; no directory add.

Untracked `server/dist.*` backups and `server/docs/orchestrator/state/*` are
loop-owned state, likewise outside the range.

## 10 · What a reviewer should attack

1. **The count.** 41, not the 40 in the directive. If 40 was deliberate, one
   named file should not be there — say which.
2. **The type-coverage loss** on four production-acting scripts. They keep the
   power to act on production while losing the check that they still compile. Is
   removing them from `dist` worth that, or should they instead be moved out of
   `src/` entirely so they are neither compiled nor silently untyped?
3. **`smokeVectorRetrieval.ts`** — excluded by the glob though it does not
   inherit the singleton, so it is out on filename, not on the stated rationale.
4. **Whether exclusion is the right mechanism at all** versus a separate
   `tsconfig.scripts.json`, which would keep type checking while keeping the
   scripts out of the shipped artifact.

## 11 · Status — reviewed 2026-08-16

```
ITERATION_VERDICT: WRONG
RELEASE_STATUS:    BLOCKED
DEPLOYED:          NO
```

Full review: `CODEX_REVIEW_c572ccf.md`. Bound to `e356d42..c572ccf`; it does not
travel to any other base.

**Why WRONG:** the mechanism is wrong for the objective, not the analysis. One
tsconfig serves both `npm run build` and the standing `npx tsc --noEmit` gate, so
excluding the 41 scripts from the artifact also removed them from the mandatory
type check — including the four that can act on production. Codex's phrasing:
the change *"weakens a standing safety gate without replacing it"*, and because
all 41 type-checked clean beforehand the loss is **unnecessary rather than
remedial**. This is the cost §4 disclosed; the reviewer ruled it not worth
paying when a split configuration avoids it entirely.

| # | severity | finding |
|---|---|---|
| 1 | **HIGH** | Artifact exclusion also silently removes type coverage. Split the concerns: keep a typecheck config covering all source scripts, add a build-only config excluding the 41, point `npm run build` at the build config. Prove it by planting a deliberate type error in an excluded script and showing it fails typecheck while staying absent from `dist`. |
| 2 | LOW | The glob encodes filename classification, not a safety inventory: every future `smoke*.ts` silently loses emission *and* type checking regardless of its actual class. Retain the glob with an explicit stated rule, or use an inventory plus a parity test. |

**Correction to §10 of this package, from the reviewer.** I offered
`smokeVectorRetrieval.ts` as excluded on filename rather than on the stated
rationale. Codex checked further: it invokes `answerAsBrain` against the live
tenant, so it is production-acting and **should stay excluded** from the
artifact. Its absence of a direct prisma-singleton import is not grounds to
restore it to `dist`. The finding it does support is the maintainability one
above.

**Confirmed by the reviewer**, independently:

- The exclusion count is **41, not 40**; no file should be dropped from the set.
- 28 files match `smoke*.ts`; 27 import the prisma singleton.
- All 13 named files exist, none overlaps the glob.
- Zero runtime references across `src/server.ts`, `src/jobs/`, `package.json`.
- `e356d42:server/src` == `c572ccf:server/src` == `8b116cdef00f72e3d210afd53b75666572db060f`.
- Dirty `deploy.sh` and loop state are outside the reviewed range.
- Nothing is authorized for deployment.

Capability movement **0.0 — NEUTRAL**: a configuration-only, undeployed change
alters no Brain behaviour.

**Next turn** (not started in this session): replace the single-config exclusion
with split typecheck/build configurations, keeping all 41 under compile-time
checking and all 41 out of `dist`; rerun the full matrix; publish the resulting
one-commit range with updated evidence.

`WRONG` never advances. Deploy is approval #7 and is **not authorized**.
