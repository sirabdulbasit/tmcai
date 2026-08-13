# Brain capability targets — OWNER-EDITABLE

**Overwrite any number or reorder the priority list. This file wins.** The
orchestrator reads it when opening a campaign; the Builder, Reviewer and Scorer
read it through `capability_contract.md`.

`Now` = Grok's last scorecard. `Target` = 95% of professional (your objective).

| # | Capability | Now | Target | Professional |
|---|---|-----|--------|--------------|
| 1 | Simple & Smart | 33 | 87 | 92 |
| 2 | Thinking | 36 | 89 | 94 |
| 3 | Memory | 60 | 87 | 92 |
| 4 | Accurate Communication | 74 | 89 | 94 |
| 5 | Authorized Action | 52 | 87 | 91 |
| 6 | Self Follow-Up | 43 | 91 | 96 |
| 7 | Learn | 42 | 86 | 90 |
| 8 | Self-Healing | 54 | 85 | 89 |
| 9 | Self-Pruning | 33 | 85 | 89 |
| | **Overall** | **47.4** | **87.3** | 91.9 |

## Priority order — the loop works down this list

Edit the order to re-aim the loop. One capability at a time, per campaign.

1. **Self Follow-Up** (43 → 65 this campaign) — C-2, active
2. **Self-Pruning** (33) — largest gap, nothing implemented
3. **Simple & Smart** (33)
4. **Thinking** (36)
5. **Learn** (42)
6. **Authorized Action** (52)
7. **Self-Healing** (54)
8. **Memory** (60)
9. **Accurate Communication** (74) — smallest gap; 20 iterations already spent here

## Why the numbers moved in decimals, and what changes it

Owner, 2026-08-13: *"i have very serious concern with such progress in decimals"*.

22 iterations produced +0.7 overall. The cause is not effort — it is that every one
of those iterations **repaired a capability that already existed** (Accurate
Communication, 74 of 89, the smallest remaining gap) instead of **building one that
does not**.

**Capability scores are step functions.** Grok scores Simple & Smart, Thinking and
Self-Pruning with `basis: absent` — nothing implements them. Repair moves such a
score by 0.2; making a capability EXIST moves it 20-30 points at once:

| | points on that capability | overall effect |
|---|---|---|
| repairing an existing capability | +1 to +2 | **+0.1 to +0.2** |
| making an absent capability exist | +20 to +30 | **+2.2 to +3.3** |

The three absent ones are **44.3% of the remaining journey** and have had **zero
iterations**. That is the whole explanation, and it is why the priority list above
now leads with them after the active campaign.

## Rules that survive any edit you make

- A target moves only when **what you receive** changes, and only when it is
  **deployed** (`capability_contract.md`).
- The benchmark (`min(C1..C8)`) is a **regression guard**, not the objective —
  measured 2026-08-13: C4 awards ≥95 in 4% of scorings, so the old gate was
  unreachable.
- Nobody edits Grok's `Now` numbers, including you and me. Change `Target` freely;
  `Now` is evidence.
