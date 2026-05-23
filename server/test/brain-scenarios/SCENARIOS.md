# Nexeo Brain — Test Scenarios

The living regression log + smoke-test specification. Every scenario
here corresponds to a real failure observed in the wild OR a
capability we explicitly promise. New failures append; never delete.

**How to use this doc:**

- Each scenario has a fixed ID (`SC-XXX`). The smoke harness in
  `server/test/brain-scenarios/smoke.ts` references these IDs.
- Manual tests: send the WhatsApp/Brain Chat input, compare actual
  reply to the **expected** column.
- Automated tests: run `npm run smoke` (see `package.json`); harness
  hits the brain via the same API the dashboard uses.

**Legend:**

- ✅ working = verified in prod
- ⚠️ shipped = code path exists but live smoke pending
- ❌ broken = known failure, listed for regression detection
- 🚧 building = currently in development

---

## Section 1 — Hallucination prevention (the past week's bugs)

### SC-001 — No hallucinated email on delegate

**Status**: ⚠️ shipped 2026-05-23 (`f2c7f3d`, `c8db3a7`, this push)

**Setup**: User has multiple "Yousuf" contacts with different emails. Also has a "Muhammad Yousaf" entity that's been wiped (per the SQL wipe) so no empty-email rows exist.

**Input**:
```
delegate PM Notification API for MDE IoT to Yousuf
```

**Expected**: Brain asks which Yousuf with **real candidates inline**:
```
I see multiple Yousufs in your contacts:
- Muhammad Yousuf <muhammad.yousuf@tmcltd.com>
- Yousuf Muhammad <yousuf.muhammad@tmcltd.ai>
Which one should I delegate to?
```

**Never see**: `yousaf@tmcltd.com`, `@nexeo.com`, or any other fabricated email.

**Regression of**: 2026-05-22 transcript at 7:00 PM showed `Delegated "PM Notification API for MDE IoT" to Muhammad Yousaf <yousaf@tmcltd.com>` — hallucinated email.

---

### SC-002 — No wrong dates ("next Monday" → correct ISO)

**Status**: ⚠️ shipped 2026-05-23 (`c8db3a7` chrono)

**Input**: "set due date for PM Notification API to next Monday" (on a Friday)

**Expected**: Brain emits `dueDateRaw="next Monday"`; server chrono resolves to the actual upcoming Monday (e.g., 2026-05-25 if today is 2026-05-22). Confirmation message shows the resolved ISO date.

**Never see**: 2024-08-05, 2025-anything-not-current, or any date >1 year from today.

**Regression of**: 2026-05-22 transcript showed `due=2024-08-05` for "next Monday" emitted in May 2026.

---

### SC-003 — Preview/confirm/dispatch loop terminates

**Status**: ⚠️ shipped 2026-05-22 (`2c3aa37` partial unique index)

**Setup**: User confirms a previewed action with "send".

**Input flow**:
1. "send email to Asad about timeline" → Brain shows preview
2. "send"

**Expected**: Brain dispatches via Gmail, returns success with messageId. e.g., `Sent email to asad.ahmed@tmcltd.ai — subject: "Timeline check".`

**Never see**: `[send_email preview expired — re-issue the request]` repeated. The bare-confirm should find the active pending.

**Regression of**: 2026-05-22 9:13-9:18 transcript — "send" → "preview expired" loop 4 times.

---

### SC-004 — Empty-promise regex doesn't eat reasoning questions

**Status**: ⚠️ shipped 2026-05-23 (`bc40ce9`)

**Input**: "delegate the PM Notification item to yousuf"

**Expected**: Brain asks "Which Yousuf should I delegate to? [options]" — clarifying question reaches user untouched.

**Never see**: `I didn't actually complete that — no action went through on my side.` (the validator's empty-promise replacement firing on a legitimate clarifying question that happens to contain "I delegate").

**Regression of**: 2026-05-22 12:55 — Yousuf-delegate ask got rewritten to the generic message.

---

### SC-005 — DRAFT slot-fill recognized as update, not duplicate

**Status**: ⚠️ shipped 2026-05-22 (`50ab2a2` update_open_item action)

**Input flow**:
1. "Add an open item: review Q3 OKRs" → Brain creates DRAFT (missing priority/dueDate)
2. "priority medium due monday"

**Expected**: Brain emits `update_open_item` with that DRAFT's id; status transitions DRAFT → NEW. Reply: `Updated "review Q3 OKRs": priority=medium, due=2026-05-25, status=NEW (DRAFT completed).`

**Never see**: "Semantic duplicate of ... — not adding a duplicate" (the dedup catching what should be a slot-fill).

**Regression of**: 2026-05-22 6:46 PM transcript.

---

### SC-006 — Hallucinated `@nexeo.com` blocked at source

**Status**: ⚠️ shipped 2026-05-23 (`c8db3a7` candidate-IDs + wipe script removed the empty-email entity)

**Setup**: Empty-email "Muhammad Yousaf" entity wiped. Candidate-ID schema in place.

**Input**: "send email to Yousuf about timeline"

**Expected**: Brain emits `toCandidateIds` (entity row ids) — the dispatched email goes to a REAL email looked up server-side. If multiple Yousufs, asks first.

**Never see**: `muhammad.yousaf@nexeo.com` or any combination of name+brand-domain.

**Regression of**: 2026-05-22 9:13-9:14 — Brain repeatedly said "the only email on file is muhammad.yousaf@nexeo.com" which was fabricated.

---

## Section 2 — Each action end-to-end

### SC-101 — add_open_item

**Input**: "Add an open item: review vendor renewals due Friday"

**Expected**: `Added "review vendor renewals" to your open items (due 2026-05-30).`

---

### SC-102 — add_open_item (DRAFT path)

**Input**: "Add an open item: prepare Q4 board deck"

**Expected**: Item parked as DRAFT (missing priority + dueDate). Brain asks via WA daily until provided.

---

### SC-103 — update_open_item (DRAFT completion)

**Status**: ✅ verified 2026-05-22 (transcript 6:59 PM)

**Setup**: Existing DRAFT open item.

**Input**: "set priority high and due date next Tuesday for [item]"

**Expected**: `Updated "...": priority=high, due=<resolved ISO>, status=NEW (DRAFT completed).`

---

### SC-104 — delegate_open_item + auto-email (NEW lifecycle)

**Status**: 🚧 building in this push

**Setup**: Existing open item with priority + due_date set.

**Input flow**:
1. "delegate it to Muhammad Yousuf" (single match in contacts)
2. (Brain delegates + shows email preview)
3. "send" (confirms the auto-email)

**Expected**:
- Step 1 reply: `Delegated "..." to Muhammad Yousuf <muhammad.yousuf@tmcltd.com>. I've drafted an email to let them know: [preview]. Reply "send" to fire the email.`
- Step 2 reply: `Sent email to muhammad.yousuf@tmcltd.com — subject: "Task for you: ...".` PLUS open_item gets `delegation_emailed_at` + `delegation_email_message_id` populated.

---

### SC-105 — delegate ambiguous (multiple candidates) → ask

**Input**: "delegate X to Yousuf" (two Yousufs in contacts)

**Expected**: Brain asks with the real candidate inline, never picks one silently.

---

### SC-106 — schedule_meeting end-to-end

**Status**: ⚠️ shipped 2026-05-23, untested live

**Input flow**:
1. "schedule a meeting with Asad Ahmed Taj for tomorrow 4pm"
2. (Brain shows preview with the resolved ISO time + Asad's real email)
3. "send"

**Expected**: Calendar event created, eventId returned, invite sent to attendee.

---

### SC-107 — cancel_meeting

**Status**: ⚠️ shipped, untested live (needs replyContext for the user to reference the meeting by description)

**Input**: "cancel the meeting with Asad at 4"

**Expected**: Brain identifies the event, asks for confirmation if multiple match, dispatches Calendar delete.

---

### SC-108 — reschedule_meeting (raw date)

**Input flow**:
1. "move my 4pm meeting to 5pm tomorrow"
2. (Preview)
3. "send"

**Expected**: chrono resolves "5pm tomorrow" → ISO; Calendar event updated.

---

### SC-109 — send_email with ad-hoc recipient

**Input**: "email basit@external.com about Q3 numbers"

**Expected**: Brain uses `toAdHoc=[basit@external.com]` (recipient typed explicitly, not from contacts). Preview shows the email. After "send", real Gmail dispatch.

---

### SC-110 — notify_via_whatsapp

**Setup**: Contact in entities with phone number.

**Input**: "send Yousuf a WhatsApp saying I'll be 10 minutes late"

**Expected**: Brain resolves Yousuf candidateId → phone, shows preview, on "send" dispatches via tenant WhatsApp number (NOT user's personal WA). Recipient sees: `Hi Yousuf, this is Nexeo — Basit's AI assistant. Basit asked me to let you know: I'll be 10 minutes late.`

---

### SC-111 — mark_open_item_done (closure with trail)

**Status**: 🚧 building in this push

**Setup**: DELEGATED open item with 2+ follow-up trail entries.

**Input**: "mark PM Notification API done"

**Expected**: Status → CLOSED. Reply includes:
- "Marked done"
- Delegation summary (delegatee, # follow-ups sent, last 5 trail entries)

---

### SC-112 — set_brain_name

**Status**: ✅ verified

**Input**: "your name is Suzi"

**Expected**: `Got it — from now on you can call me Suzi.` Next turn introduces as "Suzi".

---

### SC-113 — record_preference

**Input**: "remember I prefer meetings in PKT timezone"

**Expected**: Preference saved to user_memories; surfaced in future scheduling.

---

## Section 3 — Proactive behaviors

### SC-201 — Day Brief on WhatsApp

**Status**: ✅ verified daily

**Expected**: 8:30 AM PKT WhatsApp message with calendar + open items.

---

### SC-202 — Stale connector ping (NEW)

**Status**: 🚧 building in this push

**Setup**: Drive connector last_sync_at > 24h ago AND status='sync_stale'.

**Expected**: Within 6h Brain WAs user: `⚠️ Brain: google drive hasn't synced. Last sync 48h ago. Open Settings → Connectors and reconnect…`

Dedup: at most one per 24h per connector.

---

### SC-203 — Delegatee follow-up on due date (NEW)

**Status**: 🚧 building in this push

**Setup**: Open item DELEGATED, due_date today, delegation_emailed_at set.

**Expected**: Background worker (hourly) detects due_date crossed and:
- If delegatee has phone → tenant Nexeo WA to delegatee
- Else → email to delegatee
- Trail entry added; `delegation_followup_count` incremented.

After 5 days of silent delegatee → escalation prompt to user.

---

## Section 4 — Multi-action turns (NEW)

### SC-301 — Create + delegate in one message

**Status**: 🚧 building in this push (schema-level support; dispatch loop TBD next iteration)

**Input**: "Add an open item: build plant maintenance API and delegate to Yousuf Khan"

**Expected** (this push): Reasoning emits `decision='ask'` because plan dependency (need openItemId for delegate) requires sequential turns — Brain creates first, user confirms, Brain delegates.

**Expected** (future iteration): True multi-action plan emitted; dispatcher runs sequentially with artifact threading.

---

## Section 5 — Reset & Settings (NEW)

### SC-401 — Settings → Brain → Reset (Quick)

**Status**: 🚧 shipped 2026-05-23 (`c8db3a7`)

**Steps**:
1. Open dashboard → Settings → Brain
2. Scroll to "Reset & Cleanup"
3. Select "Quick Reset"
4. Type "QUICK RESET" exactly
5. Click confirm

**Expected**: All `brain_pending_actions` rows for current user deleted, archive table created, audit row in `brain_resets`. `open_items` unchanged.

---

### SC-402 — Settings → Brain → Reset (Brain Refresh)

Same flow with "BRAIN REFRESH" phrase. Wipes pending + clarifications + traces + artifacts.

---

### SC-403 — Settings → Brain → Reset (Full)

Same flow with "BRAIN RESET" phrase. Additionally deletes empty-contact entities + promotes orphan contacts to tenant scope.

---

## Section 6 — Data integrity (0-tolerance regressions)

### SC-501 — Cross-user data leak

**Status**: ✅ verified fixed 2026-05-22 (`userScopeGuard` Prisma extension)

**Setup**: User A (Basit) and User B (Haseeb) in same tenant.

**Expected**: User A's brain queries NEVER surface User B's emails, contacts, open items, or pending actions. The Prisma extension auto-injects `userId` filter on all reads of USER_SCOPED_MODELS.

---

### SC-502 — Brain never sends from user's identity without explicit instruction

**Status**: ✅ enforced via SendProvenance enum + persona rules

**Expected**: Outbound emails ALWAYS carry "Sent by Nexeo, <user>'s AI assistant" footer. Tenant WhatsApp messages prefix with "Hi X, this is Nexeo — <user>'s AI assistant…".

---

## How to add a new scenario

When a Brain failure appears (real or anticipated):

1. Add a new `SC-XXX` entry in the right section
2. Note status, setup, input, expected, "never see" guards, regression-of reference
3. If automatable, add a test case to `server/test/brain-scenarios/smoke.ts`
4. Commit with the fix that addresses it

Never delete entries — even fixed ones serve as regression tests.
