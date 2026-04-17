# TMC AI — Sub-Agent (My Team) Test Scenarios

**Last Updated**: 2026-04-02
**Purpose**: 5 scenarios per process for agent framework validation
**Test via**: Web UI (localhost:5174/agents) + WhatsApp

---

## 1. HIRING (Create Agent)

| # | Action | Expected |
|---|--------|----------|
| 1.1 | Hire agent "Atlas" with task "Monitor project risks daily" schedule "daily at 9am" notify: email | Agent created, appears in Active tab |
| 1.2 | Hire agent "Scout" with task "Track new pipeline opportunities weekly" schedule "weekly" notify: WhatsApp | Agent created with WhatsApp notification |
| 1.3 | Hire 4th agent (Standard tier limit = 3) | Error: "Maximum 3 agents allowed" |
| 1.4 | Hire with empty name | Next button disabled on Step 1 |
| 1.5 | Hire with empty instructions | Next button disabled on Step 2 |

---

## 2. FIRING (Deactivate Agent)

| # | Action | Expected |
|---|--------|----------|
| 2.1 | Click Fire on active agent → confirm | Agent moves to Archive tab, schedule stopped |
| 2.2 | Fire while agent is running | "Stop & Fire" button stops run + deactivates |
| 2.3 | Re-Hire from archive | Agent returns to Active tab, schedule resumes |
| 2.4 | Fire Permanently from archive | Agent deleted from DB + all run history |
| 2.5 | Check scheduler after fire | No cron job running for fired agent |

---

## 3. MANUAL EXECUTION (Run Now)

| # | Action | Expected |
|---|--------|----------|
| 3.1 | Click "Run Now" on agent | Button shows "Running...", Stop button appears, Edit disabled |
| 3.2 | Check run result | Last finding updated with specific data per instructions |
| 3.3 | Click "History" after run | New run entry with status: completed, trigger: manual |
| 3.4 | Run agent with errors (bad instructions) | Run status: failed, error logged, error_count incremented |
| 3.5 | 3 consecutive failures | Circuit breaker opens, agent shows "PAUSED (errors)" |

---

## 4. SCHEDULED EXECUTION (Background)

| # | Setup | Expected |
|---|-------|----------|
| 4.1 | Set schedule "every minute" → wait 2 min | At least 2 scheduled runs in history |
| 4.2 | Set schedule "daily at 9am" | next_run_at shows tomorrow 9 AM |
| 4.3 | Set schedule "hourly" | Runs at top of next hour |
| 4.4 | Fire agent → check no more runs | No new scheduled runs after firing |
| 4.5 | Re-hire agent → schedule resumes | Cron job recreated, runs resume |

---

## 5. AGENT MEMORY & LEARNING

| # | Action | Expected |
|---|--------|----------|
| 5.1 | Run agent first time | memory_context has: lastFindings, lastRunDate, runHistory[1] |
| 5.2 | Run agent second time | memory: compares with previous findings, notes changes |
| 5.3 | Run agent 5+ times | memory: baselines established (e.g., "active_projects": "47") |
| 5.4 | Data changes between runs | memory: anomaly detected ("project count changed from 47 to 48") |
| 5.5 | Check memory.learnedInsights | Contains patterns and known_issues from repeated observations |

### Learning Evolution Example

```
Run 1 (first):
  baselines: {} (empty)
  findings: "47 active projects, 5 with high risks"

Run 2:
  baselines: {"active_projects": "47", "high_risk_count": "5"}
  findings: "Same as before, SACHLO still has 6 critical risks"
  knownIssues: ["SACHLO SAP Grow has persistent critical risks"]

Run 5:
  baselines: {"active_projects": "47", "high_risk_count": "5", "top_risk_project": "SACHLO"}
  patterns: ["SACHLO risks never decrease", "project count stable at 47"]
  knownIssues: ["SACHLO SAP Grow - 6 critical risks unresolved for 5 checks"]
  anomalies: [] (nothing new)

Run 10 (data changed):
  baselines: {"active_projects": "48", "high_risk_count": "4"}
  patterns: ["SACHLO risks decreased from 6 to 4", "new project added"]
  anomalies: ["Project count increased from 47 to 48", "SACHLO risk count decreased"]
```

---

## 6. WHATSAPP AGENT CONVERSATION — Casual Chat

| # | WhatsApp Message | Expected Response |
|---|-----------------|-------------------|
| 6.1 | "hi Faria" | Friendly greeting + brief mention of what she does |
| 6.2 | "Faria how are you?" | Casual response referencing her work/last check |
| 6.3 | "Faria what do you do?" | Describes her task in her own words |
| 6.4 | "Faria what did you find?" | Shares last findings summary |
| 6.5 | "Faria how long have you been working?" | Mentions hire date, total runs, last check time |

---

## 7. WHATSAPP AGENT CONVERSATION — Status & History

| # | WhatsApp Message | Expected Response |
|---|-----------------|-------------------|
| 7.1 | "Faria status" | Last findings + when checked + run count |
| 7.2 | "Faria show me your history" | Recent runs with dates and findings |
| 7.3 | "Faria what have you learned?" | Shares baselines, patterns, known issues |
| 7.4 | "Faria any changes since last time?" | Compares current vs previous findings |
| 7.5 | "Faria when is your next check?" | Shows schedule + next_run_at |

---

## 8. WHATSAPP AGENT — Task Updates

| # | WhatsApp Message | Expected Response |
|---|-----------------|-------------------|
| 8.1 | "Faria, also track employee turnover" | Instructions appended, confirms |
| 8.2 | "Faria your new task is monitor budget overruns" | Instructions replaced, confirms |
| 8.3 | "Faria check every 15 minutes" | Schedule updated, cron rescheduled |
| 8.4 | "Faria run now" | Executes immediately, returns findings |
| 8.5 | "Faria, from now check every morning at 8am" | Schedule updated to "daily at 8am" |

---

## 9. WHATSAPP AGENT — Personality & Notification Updates

| # | WhatsApp Message | Expected Response |
|---|-----------------|-------------------|
| 9.1 | "Faria be more direct and brief" | Personality updated, confirms style change |
| 9.2 | "Faria notify me on email too" | notify_email set to TRUE |
| 9.3 | "Faria stop whatsapp notifications" | notify_whatsapp set to FALSE |
| 9.4 | "Faria cc ahmed@tmc.com on reports" | notify_recipients updated |
| 9.5 | "Faria be friendly and use bullet points" | Personality updated |

---

## 10. WHATSAPP — HIRING & PRIMARY AI INTERACTION

| # | WhatsApp Message | Expected Response |
|---|-----------------|-------------------|
| 10.1 | "hire an agent to monitor risks" | Primary AI directs to web portal |
| 10.2 | "I need someone to track sales" | Primary AI suggests hiring agent |
| 10.3 | "who is on my team?" | Primary AI lists active agents with names |
| 10.4 | Message with no agent name match | Goes to normal TMC-AI chat (not agent) |
| 10.5 | "Atlas" (just agent name, nothing else) | Agent greets: "Hi boss! I'm Atlas..." |

---

## 11. NOTIFICATIONS

| # | Setup | Expected |
|---|-------|----------|
| 11.1 | Agent with notify_email=true runs | Email sent with agent name in subject and header |
| 11.2 | Agent with notify_whatsapp=true runs | WhatsApp message: "*AgentName* just completed..." |
| 11.3 | Agent with CC recipients | Email sent to user + CC recipients |
| 11.4 | Agent with no notifications | Run completes silently, no email/WhatsApp |
| 11.5 | Notification shows agent name | Email: "[Atlas] 5 projects at risk" / WhatsApp: "*Atlas*: Found..." |

---

## 12. AGENT ISOLATION & SECURITY

| # | Test | Expected |
|---|------|----------|
| 12.1 | User A's agent cannot see User B's data | Agent scoped by userId |
| 12.2 | Agent from Tenant A cannot access Tenant B | Agent scoped by clientNumber |
| 12.3 | Circuit breaker: 3 errors → auto-pause | Agent status shows PAUSED, no more scheduled runs |
| 12.4 | Memory cap: 10KB limit | Memory truncated gracefully, recent data kept |
| 12.5 | Fired agent doesn't run | No scheduled/manual runs possible |

---

## 13. WHATSAPP AGENT SESSION (Conversation Stickiness)

| # | Action | Expected |
|---|--------|----------|
| 13.1 | Say "Faria" → then "kitne risks hain?" (no Faria prefix) | Second message still goes to Faria (session sticky) |
| 13.2 | Continue 3 more messages without saying "Faria" | All go to Faria — session active |
| 13.3 | Wait 10+ minutes idle → send message | Faria sends goodbye: "شکریہ Sir! میری بات ختم ہو رہی ہے..." then message goes to main AI |
| 13.4 | Say "thanks Faria" or "shukriya" during conversation | Faria says goodbye, session ends |
| 13.5 | Say "Atlas check revenue" while talking to Faria | Switches from Faria to Atlas |

---

## 14. WHATSAPP VOICE NOTES

| # | Action | Expected |
|---|--------|----------|
| 14.1 | Send voice note in English "How many projects?" | Transcribed → correct text response |
| 14.2 | Send voice note in Urdu "پروجیکٹس کتنے ہیں؟" | Transcribed → Urdu response |
| 14.3 | Send voice note in Roman Urdu "kitne projects hain" | Transcribed → Roman Urdu response |
| 14.4 | Send voice note saying "Faria status batao" | Transcribed → routed to Faria |
| 14.5 | Send very short voice note (<1 sec) | Graceful error: "Could not understand, please try again" |

---

## 15. WHATSAPP LANGUAGE MATCHING

| # | Message Language | Expected Response Language |
|---|-----------------|---------------------------|
| 15.1 | English: "How many projects?" | English response |
| 15.2 | Urdu script: "کتنے پروجیکٹس ہیں؟" | Urdu script response |
| 15.3 | Roman Urdu: "kitne projects hain" | Roman Urdu response |
| 15.4 | Mixed: "project mein kitne risk hain?" | Mixed Urdu/English |
| 15.5 | Agent Faria in Urdu: "Faria kia kr rhi ho?" | Faria responds in Roman Urdu with feminine form |

---

## 16. WHATSAPP GENDER-AWARE COMMUNICATION

| # | Setup | Expected |
|---|-------|----------|
| 16.1 | Boss=male(Sir), Agent Faria=female | Faria: "Sir, main ne check kia..." (feminine) |
| 16.2 | Boss=female(Ma'am), Agent Abdullah=male | Abdullah: "Ma'am, maine check kia..." (masculine) |
| 16.3 | Agent learns boss's preferred title via chat | "Mujhe Boss bulao" → agent switches to "Boss" |
| 16.4 | Agent uses correct self-reference | Female: "meri report", Male: "mera kaam" |
| 16.5 | Mixed language with correct gender | "Sir, meri latest finding yeh hai ke..." |

---

## 17. WHATSAPP EMAIL FROM AGENT CONVERSATION

| # | Action | Expected |
|---|--------|----------|
| 17.1 | Talk to Faria → "email me the details" | Faria sends email with her findings, professional format |
| 17.2 | Email subject | "[Faria] summary of findings..." |
| 17.3 | Email body | Professional email with greeting, findings, signature |
| 17.4 | Email has agent name in signature | "Best regards, Faria — AI Agent" |
| 17.5 | CC recipients if configured | Email to boss + CC |

---

## 18. AGENT BACKGROUND EXECUTION & ERROR REPORTING

| # | Scenario | Expected |
|---|----------|----------|
| 18.1 | Agent runs on schedule (every 5 min) | Runs appear in history with trigger: scheduled |
| 18.2 | Server restarts → agents resume | Cron jobs recreated on startup |
| 18.3 | Agent run fails | Error notification via email + WhatsApp |
| 18.4 | 3 consecutive failures | Circuit breaker opens, boss notified |
| 18.5 | Notification suppressed during active chat | Scheduled notification deferred if boss chatting (2 min) |

---

## Results Template

| Section | Total | Pass | Fail | Notes |
|---------|-------|------|------|-------|
| 1. Hiring | 5 | | | |
| 2. Firing | 5 | | | |
| 3. Manual Execution | 5 | | | |
| 4. Scheduled Execution | 5 | | | |
| 5. Memory & Learning | 5 | | | |
| 6. WA Casual Chat | 5 | | | |
| 7. WA Status & History | 5 | | | |
| 8. WA Task Updates | 5 | | | |
| 9. WA Personality & Notifications | 5 | | | |
| 10. WA Hiring & Primary AI | 5 | | | |
| 11. Notifications | 5 | | | |
| 12. Isolation & Security | 5 | | | |
| 13. WA Agent Session (Stickiness) | 5 | | | |
| 14. WA Voice Notes | 5 | | | |
| 15. WA Language Matching | 5 | | | |
| 16. WA Gender-Aware Communication | 5 | | | |
| 17. WA Email from Agent | 5 | | | |
| 18. Background Execution & Errors | 5 | | | |
| **TOTAL** | **90** | | | |
