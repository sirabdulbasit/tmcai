# Nexeo Brain Vision

**Simple & Smart - Thinking - Memory - Communicates (Accurately & Meaningfully) - Action (Authorized to Do Everything) - Self Follow-Up - Learn - Self-Healing - Self-Pruning**

## How the nine are governed (owner ruling, 2026-08-19)

**Every capability is governed by the model. Code holds guardrails only.**

The owner's words: *"we will govern all capabilities through LLM where we will have some
guardrail (like tenant and user scope etc will decide later in detail)."*

This was decided against measured evidence, not preference. Across 167 recorded defects,
**70 (42%) were code blocking or breaking a good answer** and **50 (30%) were the model
fabricating**. The guard layer has cost more than the model it was protecting against.

### What this means in practice

**The model decides.** Intent, action, parameters, wording. A capability the model can
express is a capability Brain has.

**A guardrail is an invariant about ANY action — never a list of which actions are allowed.**
That distinction is the whole ruling. An enumeration must be updated for every new capability
and is silent when someone forgets: `DISPATCHABLE_PLAN_STEP_KINDS` had 15 of 19 declared
capabilities, so `remove_open_item` died *after* the owner confirmed it (DEF-232, ~14 hits),
and `mark_contact_inactive` and `set_contact_scope` are in the same trap today. An invariant
covers capability #20 the day it is written.

The guardrails (details to be settled with the owner):

1. **Tenant and user scope** — never model-decided, ever.
2. **Target grounding** — a recipient, attendee, delegatee or item must resolve to a real
   record owned by this user, or the turn asks instead of guessing.
3. **Irreversible needs confirmation** — keyed on the *property* of the action, not on a list
   of verbs.
4. **No claim without a receipt** — the model may never say a thing was done without dispatch
   evidence. This is the one that keeps the 50 fabrication rows closed.

**Wording is the model's, facts are the system's.** A curated sentence may supply the FACT of
what happened; the phrasing must come from the model. A canned string is correct in exactly
one circumstance — the model is unreachable. (Owner, 2026-08-19: *"don't use any template
string, always respond through model."* It was echoing the template back byte-for-byte 19
times out of 21.)

### This binds the orchestrator too

Both crons — the 10-minute **conversational** pulse and the **nightly** evaluation — follow
this ruling when they choose a fix (owner, 2026-08-19: *"conversational cron and night cron
will also follow it"*). Concretely, for any defect where the model wanted to act and code
refused:

- **Adding the capability to an allow-list is NOT an accepted fix.** It repairs the instance
  and leaves the generator, which is how DEF-232's class reached ~14 occurrences.
- The accepted fix **removes the enumeration** or makes the two sides unable to disagree.
- A fix that moves authority from the model to code must state which of the four guardrails it
  is enforcing. If it is none of them, it is not a guardrail — it is the 42%.
