# Codex review — `a5ca591` · SOUND / RELEASABLE

| | |
|---|---|
| `BASE_SHA` | `7fe41c0` |
| `REVIEW_SHA` | `a5ca591630bf9c94c47d4793f336a281ddc89bb4` |
| Range reviewed | `7fe41c0..a5ca591` — 3 files |
| Submitted | 2026-08-16, `codex exec --json --sandbox read-only` (codex-cli 0.147.0) |
| Terminal event | `turn.completed` |
| Verdict | **SOUND** · **RELEASABLE** |

**Bound to this range. It does not travel.** Any later commit — including a fix
for the residual LOW below — produces an unreviewed artifact needing its own
verdict.

**RELEASABLE is not deployment authorization.** Deploy is approval #7 in
`orc_arch.md` §38.1 and remains absent. `deployed-sha` is still `e356d42`.

## Chunk 1 verdict history

| SHA | verdict | what closed it |
|---|---|---|
| `c572ccf` | **WRONG / BLOCKED** | one config served build + typecheck; excluding 41 scripts from the artifact silently removed them from the standing gate |
| `b3a213d` | **WEAK / BLOCKED** | split correct, HIGH closed; guards asserted on `exclude` array text and substring search |
| `7fe41c0` | **WEAK / BLOCKED** | guards bound resolved membership; missed triple-slash edges, compared basenames only, tiers still hand-labelled, cited a §21 that did not exist |
| `a5ca591` | **SOUND / RELEASABLE** | triple-slash edges walked, full `fileNames` compared both directions, tiers computed from the import closure, evidence present at the review SHA |

## Residual — carried forward, NOT fixed in this range

**LOW — guard 9 measures recognized write syntax, not write reachability.** The
regex covers `prisma.<model>.<seven methods>` and `$executeRaw`. It misses
transaction-client writes (`tx.openItem.update`, a shape already present in
`itemLifecycle/lifecycleService.ts`), `$queryRawUnsafe` carrying DML/DDL, aliased
Prisma clients, raw pools, and newer write methods. So "no write reachable
anywhere" in `tsconfig.build.json` and "measurement" in the evidence package are
**stronger than the mechanism proves** — my overstatement, and the same class of
error this chunk kept producing.

Not release-blocking: all 41 stay excluded regardless of tier, the tier is
operational documentation rather than the exclusion boundary, and Codex
independently inspected `smokeTenantIsolation`'s four-file closure and found
reads only.

Next turn, either: rename Tier 5 to **"no recognized write signature reachable"**,
or replace the regex with an AST detector covering transaction receivers, all
mutating model methods, raw DML/DDL and non-Prisma clients — with mutations for
`tx.model.update(...)` and `$queryRawUnsafe('DELETE … RETURNING …')`.

## Confirmed by the reviewer, independently

- Guard 7's `join(file,'..',ref.fileName)` correctly normalizes relative paths and
  `..`; triple-slash paths are exact file references, and extensionless
  nonexistent references fail compilation rather than resolving like imports.
- Guard 5's slash normalization suffices — both programs resolve through the same
  TypeScript host and working directory.
- Whole-closure Tier 4 is intentionally conservative; it can over-classify through
  broad or type-only imports, but that does not weaken safety. "Reachable" is not
  "executed".
- §21–24 accurately report the artifact split, verification, unchanged source and
  untriaged scope, apart from the write-measurement overstatement.
- The two prior MEDIUMs and the missing-§21 LOW are **closed**.
- Capability movement **0.0 — NEUTRAL**: configuration/test-only, no Brain
  behaviour changed, nothing production-verified.

---

I’ll perform this as a read-only post-build audit, beginning with the mandated capability scorecard, then inspect the exact range, evidence §§21–24, and independently probe the guards against the attack points.
The diff confirms the two prior MEDIUM defects are materially changed and the missing evidence section now exists at the review SHA. I’m now testing whether guard 9’s “measured” label is sound enough to support Tier 5, and whether triple-slash/reference and path normalization semantics match the compiler rather than only the supplied mutations.
### Canonical capability scorecard

Configuration/test-only build `a5ca591`; no Brain behavior changed or was production-verified.

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
ITERATION_VERDICT: SOUND
RELEASE_STATUS:    RELEASABLE
```

### Finding

- **LOW — Guard 9 measures recognized write syntax, not production-write reachability.** [operatorScriptParity.test.ts](/var/www/tmcai/server/tests/operatorScriptParity.test.ts:268) recognizes only `prisma.<model>.<seven methods>` and `$executeRaw`. It misses transaction-client writes such as `tx.openItem.update`, `$queryRawUnsafe` carrying DML/DDL, aliased Prisma clients, raw database pools, and newer write methods. The repository already contains the transaction-client shape, for example `tx.openItem.update` in `itemLifecycle/lifecycleService.ts`. A future script reaching only that path could be declared Tier 5 and guard 9 would remain green. Consequently, “no write reachable anywhere” at [tsconfig.build.json](/var/www/tmcai/server/tsconfig.build.json:100) and “measurement” at [CMP-2026-08-16-CHUNK1-EVIDENCE.md](/var/www/tmcai/server/docs/orchestrator/CMP-2026-08-16-CHUNK1-EVIDENCE.md:511) are stronger than the mechanism proves.

This is not release-blocking: all 41 scripts remain excluded regardless of tier, and independent inspection of `smokeTenantIsolation`’s four-file closure found reads only. The tier is operational documentation, not the artifact-exclusion boundary.

No additional findings:

- Guard 7’s `join(file, '..', ref.fileName)` correctly normalizes relative paths and `..` on the production Linux filesystem. TypeScript triple-slash paths are exact file references; extensionless nonexistent references fail compilation rather than resolving like imports.
- Guard 5’s slash normalization is sufficient for this Ubuntu-bound invariant because both programs are resolved by the same TypeScript host and working directory.
- Whole-closure Tier 4 classification is intentionally conservative. It can over-classify through broad or type-only imports, but that does not weaken safety; “reachable” should not be interpreted as “executed.”
- Sections 21–24 accurately report the artifact split, verification, unchanged source, and untriaged scope, apart from the write-measurement overstatement above.
- The prior two MEDIUMs and missing-§21 LOW are closed.

Next turn: either rename Tier 5 to **“no recognized write signature reachable”**, or replace the regex with an AST-based conservative detector covering Prisma transaction receivers, all mutating model methods, raw-query DML/DDL, and registered non-Prisma database clients. Add mutations for `tx.model.update(...)` and `$queryRawUnsafe('DELETE … RETURNING …')`. Do not deploy; approval #7 remains absent.