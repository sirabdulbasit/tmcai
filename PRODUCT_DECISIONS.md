# Product decisions log (the anti-drift anchor)

Every product-shaping ruling from the owner — decided in a CR escalation, a dialog, or
chat — is appended here by the agent that received it. Future CRs must be consistent with
this log and your product spec; contradicting an entry requires surfacing the conflict
to the owner, never silently re-deciding.

Format per entry: date · CR · question · ruling · **decided** (owner conviction) or
**deferred** (owner said "you decide" → recommendation applied, revisit-by noted).

---

- *(append entries here as they occur)*

## 2026-08-04 — Universal counterpart conversation (owner ruling)
**Question:** Who may talk to Suzi on WhatsApp?
**Ruling (Basit):** Everyone who is *concerned* — derived from evidence (in emails,
delegated to, previously messaged by Brain, in contacts), never a manual whitelist.
Unknown senders: Suzi asks the owner ONCE ("reply or ignore?"); "ignore" persists until
countermanded. Owner can give durable conditional instructions ("during office hours
reply this contact with …") stated once and remembered.
**Spec:** server/docs/section35_living_assistant.md (3 phases).
**Reversibility:** [reversible later] — door policy is data (wa_sender_policy rows),
scoped conversation is flag-gateable per tenant.
