# Nexeo product size — measured 2026-09-02

**Supersedes `product_size_codex.md` and `product_size_grok.md` (both 2026-08-31).** Their
architecture analysis still holds and is summarised in §4. Their headline numbers do not: the
database they measured at **811 MB is now 286 MB**, and the table both named as *the* problem —
`llm_spend`, 561 MB and 69% of the database — is **50 MB**. Re-measuring rather than acting on
those numbers is what surfaced the two live growth defects in §2, neither of which either audit
found.

Measured on the running box, `release/cmp-2026-08-16`. Sizes are point-in-time.

---

## 1. Current state

| Area | 2026-08-31 audits | Now | Note |
|---|---:|---:|---|
| Workspace | 3.1 GB | **3.0 GB** | Dominated by dependencies and session state, not source |
| Database | 811 MB | **286 MB** | −65% |
| `server/docs` | 66 MB | **46 MB** | Orchestrator logs compressed (§2b) |
| Tracked git content | 14.7 MB | 14.7 MB | ~0.5% of the workspace |
| `.git` | 118 MB | **36 MB** | Already gc'd |
| Host disk | 79% used | 79% used, 20 GB free | Shared with other pm2 apps; not this repo alone |

**Largest workspace components**

| Path | Size | Verdict |
|---|---:|---|
| `server/whatsapp-sessions` | **1016 MB** | 853 MB live + **163 MB stale backup** — see §3 |
| `server/node_modules` | 1008 MB | Required to run |
| `agents/.venv` | 728 MB | Required by `tmcai-agents` |
| `server/docs` | **46 MB** | Was 73 MB; orchestrator logs compressed (§2b) |
| `server/.wwebjs_cache` | 68 MB | Chromium runtime cache |
| `client/node_modules` | 68 MB | Required to build the UI |
| `server/dist` | 20 MB | Deployed artifact (immutable, `chattr +i`) |

**Largest tables**

| Table | Total | Heap | Indexes | TOAST | Rows |
|---|---:|---:|---:|---:|---:|
| `wiki_pages` | **124 MB** | 29 MB | 5.8 MB | **84 MB** | 12,909 |
| `llm_spend` | 50 MB | 26 MB | 24 MB | — | 217,480 |
| `gate_rule_firings` | 19 MB | 17 MB | 2.4 MB | — | 52,535 |
| `feed_events` | 16 MB | 10 MB | 5.3 MB | — | 5,805 |
| `brain_user_messages` | 15 MB | 9.5 MB | 6.1 MB | — | 26,992 |
| `notification_queue` | **376 kB** | 24 kB | 64 kB | — | 29 |

`wiki_pages` is now the largest object in the database, and two thirds of it is TOAST.

---

## 2. Two growth defects found by re-measuring, and fixed

### The nightly notification that stored 1.65 MB to deliver 225 bytes

`server.ts` spread the entire `mineWikiHealth` result into a `wiki_lint` notification payload —
including the per-page arrays for every stale page of 7,415. Each nightly row was **1.65 MB of
JSON (655 kB stored)** carrying a **225-byte** human-readable body.

29 such rows held **18 MB**, in a table where every row was already `status = sent`. Growth was
**~655 kB/day, ≈240 MB/year, unbounded.** Neither audit caught it: Codex flagged
`notification_queue`'s TOAST as worth inspecting (rec #10) without diagnosing it, and Grok listed
it as a "suggested next measurement".

Nothing reads `payload.findings` — verified across both server and client — and the findings are
recomputed nightly regardless, so storing them was pure accumulation. The payload now carries
counts (`pageCount`, `suggestions`, `orphans`, `stale`, …).

**`notification_queue`: 18 MB → 376 kB.**

### An append-only audit log of a hot path with no retention

`gate_rule_firings` held **107,542 rows** spanning 2026-05-03 → today, 19 MB, and had **never
once been vacuumed**. Every gate decision appends a row; nothing ever removed one.

The retention window is not a preference. Its only reader — `gateRulesRoutes` `/metrics` —
computes `Math.min(parseInt(days ?? '30'), 90)`, a hard cap it cannot be asked to exceed, so
rows older than 90 days are **unreachable by any code path in the product**. 55,008 rows were
beyond that cap. A test asserts the constant can never drop below the reader's cap, because a
retention window shorter than what an endpoint can request would make it silently under-report —
a wrong number being worse than a large table.

Both sweeps now run in the existing hourly `heal()` loop beside `sweepLlmSpendRetention`, in
bounded batches: this table is written synchronously on the triage path, and a long delete
transaction there would stall inbound message handling.

### Also done

`llm_spend` carried **23,538 dead tuples** and had not been vacuumed since 08-31 17:32 — left by
this session's earlier retention delete. Now zero; the space is reusable for future inserts.

**Net: 304 MB → 286 MB returned to disk, with nothing reachable discarded.** 7 tests, three
mutants each killed by exactly the named test.

---

## 2b. Reclaimed on the filesystem — 27 MB, nothing lost

`server/docs/orchestrator/` **72 MB → 45 MB** (`server/docs` overall 73 MB → 46 MB) by
**compressing, not deleting**: 34 `iter-*-build.jsonl` older than two days plus the 13 `.jsonl`
in `pre-reset-001/` and `retired-*/`. 47 archives, every one verified with `gzip -t`, all
recoverable with `gunzip`.

Compression rather than deletion because these logs are what made DEF-258 diagnosable — a
reviewer dead since 08-25, found by reading exactly these files — and they cost 3.1× less at
rest than they did as evidence.

The selection was constrained by a real dependency, not by age alone. `pulse.py` globs
`iter-*-build.jsonl` and `iter-*-review.jsonl` and takes **the newest of each**, and it renders
the capability deck. The newest of every kind is from today (`iter-63-build`, `iter-63-chat`,
`iter-62-review`), so the two-day cut cannot reach one — and `pulse.py` was run afterwards to
prove it: full deck, iteration #63, review present. `iter-*-chat` and `iter-*-review` were left
uncompressed regardless: 0.5 MB combined, and review is the file `pulse.py` depends on.

Nothing else on disk is reclaimable without a decision below. A sweep for files over 10 MB
outside `node_modules`, `.venv`, `whatsapp-sessions`, `.git` and `.wwebjs_cache` returns
**nothing**, and there are no stray `dist.*` or backup directories. The workspace stays at
3.0 GB because its three largest components — `node_modules` (1008 MB), `whatsapp-sessions`
(1016 MB) and `agents/.venv` (728 MB) — are 2.75 GB of required or protected content.

---

## 3. Three things that need your decision, not mine

**`wiki_pages`, 124 MB — the largest remaining item.** **6,741 of 12,909 pages are already marked
`stale` or `orphan` by the product's own lint worker** (3,671 orphan, 3,070 stale); only ~1,171
are `active`. 7,145 pages have not been updated in 90 days. Every one of the 12,909 carries an
embedding, totalling **38 MB**, plus ~15 MB of bodies. Pruning would reclaim most of the 84 MB
TOAST — but it deletes knowledge, and both audits independently said the same thing: this needs
an authoritative staleness owner and a reversible retention window first. Retrieval quality is
the real argument for it; disk is the lesser one.

**`VACUUM FULL` on `gate_rule_firings` and `llm_spend` — ~30 MB.** Plain `VACUUM` marked the
freed space reusable but does not return bytes to the OS. `gate_rule_firings` would drop from
19 MB to roughly 9 MB. It takes an **exclusive lock**; both tables are small enough now that it
would be seconds rather than minutes, but `gate_rule_firings` sits on the synchronous triage
write path, so it is a planned change, not an unattended one. Codex's rec #3 says the same.

**`session-TMC-0001.bak-20260717`, 163 MB.** The single largest easy reclaim on disk, and
`AGENTS.md` forbids me from touching `whatsapp-sessions/`. The live session is
`session-TMC-0001` (853 MB) and is healthy. Your call whether the July backup is still wanted.

*(The orchestrator logs are no longer on this list — compressed rather than deleted, §2b.)*

---

## 4. Architecture, unchanged from both audits

Both audits agreed and both were right: **disk is not a source-code problem.** ~226,000 lines of
first-party code occupy under 15 MB. The 3.0 GB is `node_modules`, a Chromium session store and
a Python venv.

The real maintainability risk is concentration, not volume. `brainComposer.ts` at ~8,000 lines is
the architectural hotspot; over 100,000 lines sit in `server/src/services`, with
`services/{knowledge,whatsapp,triage}` holding most of the complexity. Both audits recommended
decomposing the composer around authoritative stages, separating brief routing from generation,
and splitting the largest client pages. That work is untouched and remains the highest-value
structural item — it is a correctness and change-cost argument, not a size one.

Codex's rec #8 is worth restating because this session proved it twice: **collapse parallel
implementations before deleting code, and prove every reader, writer, registry and timer has
migrated first.** `protection-with-two-implementations` stands at 10 occurrences.

Also still open from Codex: classify the ~32 tables present in the database but absent from
Prisma (rec #9), and reconcile the eight-capability vision against `AGENTS.md`'s older
nine-capability wording (rec #12).

---

## 5. What was not touched

- No `VACUUM FULL`, no `REINDEX` — both take exclusive locks and are listed in §3 as decisions.
- No wiki page deleted, no embedding dropped.
- Nothing under `whatsapp-sessions/`, `.env`, or any file `AGENTS.md` protects.
- The capability scorecard (53.5% vs a professional assistant's 92.25%) is a product-capability
  judgement and is unrelated to size. Disk cleanup does not move it, and neither audit claimed
  otherwise.
