# Codex review — DEF-185 contract `58c4e66` · SOUND / RELEASABLE

| | |
|---|---|
| `BASE_SHA` | `abe7ec3` |
| `REVIEW_SHA` | `58c4e66ae0867999263bdc219e4b6866b8130dc8` |
| Range | `abe7ec3..58c4e66` — one file, the contract |
| Verdict | **SOUND** · **RELEASABLE** |
| Terminal event | `turn.completed` |

**Bound to this range.** The contract is v9; any further edit — including the
cosmetic one below — produces an unreviewed artifact.

**RELEASABLE is not build authorization and not deployment authorization.** It
means the contract is buildable *against*. No implementation exists. Deploy is
approval #7 and remains absent.

## Contract verdict history — nine versions

| ver | SHA | verdict | what closed it |
|---|---|---|---|
| v1 | `92077f7` | WRONG | AC-3 internally impossible; live acceptance vs evidence policy |
| v2 | `cfa8d29` | WRONG | §10 still contradicted the corrected AC-3; §4.2 unfalsified; AC-1 grep-shaped |
| v3 | `b3b75aa` | WRONG | AC-1 promised more than fixtures showed; B-case execution levels wrong |
| v4 | `23fa274` | WRONG | §6.1/§6.2 contradicted; "statically resolvable" ungrammared; B-8 mislevelled |
| v5 | `74d921d` | WRONG | AC-1 unachievable at DEF-185's scope — 16 other accessors |
| v6 | `e9257b0` | WRONG | narrowing left four contradicting restatements + a broken table |
| v7 | `7ba1fdf` | WRONG | Prisma import undecidable and contradicting AC-2; "cannot reacquire" unbounded |
| v8 | `abe7ec3` | WRONG | tracked-root model incomplete for E-9/E-10; §18 cited but never written |
| **v9** | **`58c4e66`** | **SOUND** | ROOT-1..3 normative and decidable; propagation rule explicit; E-10/E-11 split; §18/§19 written |

## What the reviewer confirmed

- ROOT-1..ROOT-3 are **normative and decidable**.
- The propagation rule applies every supported access form from every root.
- Other acquisition mechanisms are **bounded as R-1..R-5** rather than silently
  omitted.
- E-10 and E-11 are distinct executable fixtures for `require()` and dynamic
  `import()`.
- E-1..E-11 and R-1..R-5 are internally aligned.
- **"The contract is buildable: an implementer can determine what the guard must
  detect, what remains review-only, and which execution level proves every
  behavioral case."**
- §18 and §19 exist at the review SHA.

Capability movement **0.0 — NEUTRAL**: contract-only, no Brain behaviour changed,
nothing production-verified.

## Carried forward — not fixed, deliberately

**Editorial only.** §6.2 contains a duplicated Markdown separator row. Codex:
*"It does not alter the normative matrix or create implementation ambiguity."*

Not corrected, because a verdict binds its SHA and editing the contract now would
trade a SOUND for an unreviewed document over a cosmetic defect. It should be
folded into the first commit that touches this file for a substantive reason.

---

### Canonical capability scorecard

Contract-only change; no Brain behavior changed or was production-verified.

| Capability | Nexeo | Professional | Gap | Δ | Paired bars |
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

Overall: **47.3 vs 91.9**, gap **44.6**, movement **0.0 — NEUTRAL**.

§18 and §19 both exist at the review SHA.

The v8 blockers are resolved:

- ROOT-1 through ROOT-3 are normative and decidable.
- The propagation rule explicitly applies every supported access form from every root.
- Other acquisition mechanisms are bounded as R-1 through R-5 rather than silently omitted.
- E-10 and E-11 are distinct executable fixtures for `require()` and dynamic `import()`.
- E-1..E-11 and R-1..R-5 are internally aligned.
- The contract is buildable: an implementer can determine what the guard must detect, what remains review-only, and which execution level proves every behavioral case.

One non-blocking editorial defect remains: §6.2 contains a duplicated Markdown separator row (`|---|---|`). It does not alter the normative matrix or create implementation ambiguity.

No implementation or deployment is approved by this verdict.

```text
ITERATION_VERDICT: SOUND
RELEASE_STATUS:    RELEASABLE
```