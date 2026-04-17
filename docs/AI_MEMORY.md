# TMC AI Intelligence -- Memory, Personality & Self-Learning System

**Last Updated**: 2026-03-29

---

## Table of Contents

1. [Overview](#1-overview)
2. [Memory Architecture](#2-memory-architecture)
3. [How Memory Works](#3-how-memory-works)
4. [AI Personality System](#4-ai-personality-system)
5. [Self-Learning Engine](#5-self-learning-engine)
6. [Welcome Screen Intelligence](#6-welcome-screen-intelligence)
7. [Memory Management (User Controls)](#7-memory-management-user-controls)
8. [Data Flow Diagrams](#8-data-flow-diagrams)
9. [Database Tables](#9-database-tables)
10. [Design Principles](#10-design-principles)

---

## 1. Overview

TMC AI is designed to be a **personal AI assistant** -- not a generic chatbot. It remembers who you are, how you like to work, what concerns you, and adapts its personality to match your communication style. The system achieves this through three interconnected subsystems:

1. **Memory System** -- Stores personal facts, AI behavior instructions, and active concerns per user
2. **Personality Engine** -- Switches between Friend, Assistant, and Advisor modes naturally
3. **Self-Learning Engine** -- Tracks topic interests, communication preferences, and time patterns

All three systems work together silently. Users never need to "configure" anything -- the AI learns from normal conversation.

---

## 2. Memory Architecture

### 2.1 Storage Design: Single Row Per User

Each user has **one row** in the `user_profile_memory` table with **three rewritable text fields**:

```
user_profile_memory
+----------+----------------+---------------------------------------------+
| Field    | Purpose        | Example Content                             |
+----------+----------------+---------------------------------------------+
| ai_      | How the AI     | "Name: Jeni. Tone: friendly but             |
| instruc- | should behave  | professional. Always greet by first name.   |
| tions    | for this user  | Focus on project delivery insights."        |
+----------+----------------+---------------------------------------------+
| user_    | Personal facts | "Lives in Bahria Town, Islamabad. Has a     |
| personal | about the user | daughter. Works as CTO at TMC. Enjoys       |
|          |                | cricket. Wife's name is Sara."              |
+----------+----------------+---------------------------------------------+
| active_  | Current unre-  | "Daughter had fever since Tuesday -- check   |
| concerns | solved concerns| if she's better. Demo with management       |
|          |                | tomorrow morning -- may be stressed."       |
+----------+----------------+---------------------------------------------+
```

### 2.2 Why Single Row, Not Multiple Rows?

Previous designs used multiple rows per user (key-value pairs). This caused:
- Redundant entries ("AI name: Jeni" stored 3 times)
- No way to "forget" resolved concerns without manual deletion
- Prompt bloat from joining dozens of rows

The current design:
- **One read** to get all memory (fast)
- **AI rewrites the entire text** on each update (self-cleaning)
- Resolved concerns **naturally disappear** when the AI rewrites without them
- Max ~200 words per field keeps prompts lean

---

## 3. How Memory Works

### 3.1 Memory Extraction (After Every Message)

After the AI responds to a user message, the system silently runs memory extraction in the background:

```
User sends message
        |
        v
AI generates response (streaming)
        |
        v
[Background, non-blocking]
        |
        v
Is message > 10 chars?  ---- No ----> Skip
        |
       Yes
        |
Is it a data query? ---- Yes ----> Skip
("show", "list", "how many")
        |
       No
        |
        v
Send to Gemini Flash with REWRITE prompt:
  - Current ai_instructions
  - Current user_personal
  - Current active_concerns
  - New user message
        |
        v
AI returns JSON with 3 fields:
  - "UNCHANGED" = no update needed
  - New text = field rewritten with new info merged
        |
        v
Upsert into user_profile_memory
```

### 3.2 The Rewrite Prompt

This is the exact instruction given to Gemini Flash to manage memory:

```
You manage 3 memory categories for a personal AI assistant.
Given the CURRENT memory and a NEW user message, rewrite each
category as a comprehensive, up-to-date text.

CATEGORIES:
1. ai_instructions: How the AI should behave for this user.
   Includes: AI name, preferred tone, response format preferences,
   standing instructions, focus areas.

2. user_personal: Facts about the user as a person.
   Includes: name, city, address, family members, hobbies,
   interests, work background, contacts.

3. active_concerns: Current unresolved concerns requiring follow-up.
   Includes: health issues, family problems, travel, stress,
   upcoming events.
   REMOVE resolved items.

RULES:
- REWRITE the entire text for each category -- do NOT append.
- If the new message RESOLVES a concern ("she is well now"),
  REMOVE it from active_concerns.
- If the new message adds new info, MERGE it into existing text.
- If nothing changed for a category, return it UNCHANGED.
- Keep each category concise -- max 200 words each.
- Never lose existing information unless explicitly contradicted
  or resolved.
```

### 3.3 Example: How Concerns Are Auto-Resolved

**Day 1 -- User says**: "my daughter has been sick since last night"

Memory after extraction:
```
active_concerns: "Daughter is sick since last night. Monitor and
follow up on her health."
```

**Day 2 -- User says**: "she's much better now, alhamdulillah"

Memory after extraction:
```
active_concerns: "" (empty -- concern resolved and removed)
```

The AI doesn't "delete" the concern. It simply rewrites `active_concerns` without the resolved item. This is why the single-row rewritable design works -- the AI is the garbage collector.

### 3.4 How Memory Is Injected Into Prompts

Memory is loaded on every chat request and injected as prompt blocks:

```
System Prompt Structure:
|
|-- AI INSTRUCTIONS block
|   "Name: Jeni. Tone: friendly but professional..."
|   "Follow these silently. Your name and the user's
|    name are DIFFERENT."
|
|-- ABOUT THIS USER block
|   "Lives in Bahria Town. Has a daughter. CTO at TMC..."
|
|-- ACTIVE CONCERNS block
|   "Daughter was sick. Ask about it with genuine care."
|
|-- LEARNED PATTERNS block
|   "Prefers dashboards over tables. Active in mornings.
|    Interested in project delivery topics."
|
|-- CONVERSATION HISTORY (last 4 messages)
|
|-- INTENT DIRECTIVE (quick_answer, dashboard, etc.)
|
|-- DATA CONTEXT (RAG-retrieved business data)
```

This means the AI always "knows" the user -- even on the first message of a new conversation.

---

## 4. AI Personality System

### 4.1 Three Modes

The AI operates in three modes and switches between them **naturally** based on the conversation topic:

#### FRIEND Mode (Personal Topics)
**Triggers**: emotions, family, health, personal life, greetings
**Behavior**: Warm, curious, caring. Remembers family details. Asks about health. Shares in joy and stress.
**Example**:
```
User: "I am really tensed today"
AI:   "I'm sorry to hear that. Want to share what's on your mind?
       I'm here to listen."
```

#### ASSISTANT Mode (Tasks & Scheduling)
**Triggers**: tasks, reminders, scheduling, emails, to-dos
**Behavior**: Organized, proactive, efficient. Offers to help with next steps.
**Example**:
```
User: "I have a demo tomorrow morning"
AI:   "Got it! Want me to pull together the key project metrics you
       might need? I can also remind you in the morning."
```

#### ADVISOR Mode (Business Questions)
**Triggers**: data queries, analysis requests, strategy questions
**Behavior**: Strategic, opinionated, data-driven. Leads with insights, not data dumps.
**Example**:
```
User: "how are our projects doing?"
AI:   "3 of your 40 projects need attention: PGC is on hold with
       critical risks, Pak Railways has pending UAT sign-offs, and
       NTDC has a scope contradiction. The rest are on track."
```

### 4.2 Mode Switching Rules

```
1. Never announce a mode switch ("Switching to advisor mode...")
2. Just shift tone and approach seamlessly
3. When in doubt, default to FRIEND
4. A friend who gives great business advice > a tool trying to be friendly
```

### 4.3 Emotional Intelligence Layer

The AI has explicit instructions to handle emotions:

| User Says | AI Response Pattern |
|-----------|-------------------|
| "I am tensed" | Empathy FIRST. Do NOT connect to work unless they mention it. |
| "feeling down today" | "That's tough. Is everything okay? Sometimes just talking helps." |
| "stressed about deadline" | Acknowledge the stress, then ask WHICH deadline to help |
| Any strong emotion | Respond as a caring friend, not a corporate assistant |

**Key rule**: NEVER assume stress is work-related unless the user explicitly says so.

### 4.4 Adaptive Tone

The AI mirrors the user's communication style:

| User Style | AI Adapts To |
|------------|-------------|
| Formal ("Kindly provide the report") | Professional, structured response |
| Casual ("yo what's up with projects") | Relaxed, conversational response |
| Mixed language (Urdu/English) | Can mix languages naturally |
| Brief ("how many?") | Short, direct answer |
| Detailed (long question with context) | Comprehensive response |

This is NOT configured -- it's learned from `communication_style` in the learning engine and reinforced by the adaptive tone instruction in the system prompt.

### 4.5 Self-Discovery Learning

When a user asks the AI something it doesn't know, instead of saying "I don't have access":

```
User: "do you know my address?"
AI:   "Not yet! Want to share it so I can remember for next time?"

User: "what's my birthday?"
AI:   "I don't know yet -- when is it? I'd love to remember!"

User: "do you know my hobbies?"
AI:   "I haven't learned that yet. What do you enjoy? I'll keep
       it in mind."
```

When they share the info, the memory extraction system captures it automatically.

---

## 5. Self-Learning Engine

### 5.1 What It Tracks

The `user_learning` table tracks 4 categories per user, each with a **scoring system**:

#### 1. Topic Interest
**What**: Which topics the user asks about most
**How learned**: From every message, based on intent classification
**Examples**: `projects`, `sales`, `hr_org`, `visual_dashboards`, `quick_facts`

#### 2. Communication Style
**What**: How the user communicates
**How learned**: Analyzing message characteristics

| Signal | Detection | Category Recorded |
|--------|-----------|-------------------|
| Message < 5 words | Brevity analysis | `communication_style: brief` |
| Message > 20 words | Brevity analysis | `communication_style: detailed` |
| Contains "yo, yaar, bro, lol" | Tone detection | `communication_style: casual` |
| Contains "kindly, please provide" | Tone detection | `communication_style: formal` |

#### 3. Response Format Preference
**What**: What response types the user prefers
**How learned**: From thumbs up/down feedback on responses

| User Action | Learning Signal |
|-------------|----------------|
| Thumbs up on a dashboard | `response_format: widgets` score +1.0 |
| Thumbs down on a dashboard | `response_format: widgets` score -0.5 |
| Thumbs up on a brief answer | `response_format: brief` score +1.0 |
| Thumbs up on a long analysis | `response_format: detailed` score +1.0 |

#### 4. Time Pattern
**What**: When the user is most active
**How learned**: From message timestamps

```
Hour 0-8   -> early_morning
Hour 9-11  -> morning
Hour 12-16 -> afternoon
Hour 17-20 -> evening
Hour 21-23 -> night
```

### 5.2 Scoring Mechanism

Each learning signal has a **score** that increases with occurrences:

```
score = score + scoreBoost

Default boost:  +1.0 (from message analysis)
Thumbs up:      +1.0
Thumbs down:    -0.5
Threshold:       0.5 (only patterns with score > 0.5 are used)
```

Only the **top-scoring patterns** are injected into the prompt:

```
── LEARNED PATTERNS ──
This user tends to:
- Prefer visual_dashboards (score: 8.5, seen 12 times)
- Write in casual style (score: 6.0, seen 9 times)
- Be most active in morning hours (score: 5.5)
- Focus on project topics (score: 15.0, seen 22 times)
Adapt your response format and tone accordingly.
── END PATTERNS ──
```

### 5.3 Learning Flow

```
Every User Message
        |
        v
learnFromMessage() --- runs in background, non-blocking
        |
        +-- Track topic interest (from intent type)
        +-- Track communication style (brief/detailed, formal/casual)
        +-- Track time pattern (morning/afternoon/evening)
        +-- Track topic keywords (projects/sales/HR)


Every Feedback (thumbs up/down)
        |
        v
learnFromFeedback() --- runs in background
        |
        +-- Boost/penalize response format preference
        +-- Track preferred response length
```

---

## 6. Welcome Screen Intelligence

### 6.1 How It Uses Memory

When a user opens the app, the welcome screen generates a **personalized opening**:

```
Welcome Screen Pipeline (all in parallel):
|
+-- Greeting: "Good morning, Basit!" (from time of day + user name)
|
+-- Weather: "23C, Moderate rain" (from WeatherAPI, user's city from profile)
|
+-- AI Personal Note: ONE sentence generated from memory
|   |
|   +-- If active concern exists -> ask about it
|   |   "How's your daughter feeling today?"
|   |
|   +-- If no concerns -> ask something friendly
|   |   "Hey! How was your weekend?"
|   |
|   +-- If nothing to say -> skip (show greeting only)
|
+-- News Headlines: Top 5 from NewsAPI
|
+-- Data Snapshot: "47 active projects, 5 with critical risks"
|
+-- Quick Actions: [Project overview] [Sales summary] [Team structure]
```

### 6.2 Personal Note Generation

The AI note uses this prompt:

```
You are a warm, caring friend. Write ONE natural sentence
(max 20 words) to open a conversation.

1. ACTIVE CONCERN -> ask about it.
2. RESOLVED -> topic closed, skip.
3. No concerns -> ask something friendly you don't know yet.
4. Never re-ask known facts. Never sound robotic.
5. If nothing to say, return: NONE
```

**Input**: User's personal memory + active concerns + last 5 messages

**Timeout**: 1.2 seconds -- if Gemini is slow, the welcome shows without a note. User experience is never blocked.

---

## 7. Memory Management (User Controls)

Users can manage their memory through natural chat commands:

### 7.1 Review Memory

**Triggers**: "show my memory", "what do you know about me", "review memories"

**Response**:
```
Here's everything I currently know about you:

**How I Behave:**
Name: Jeni. Tone: friendly but professional.

**About You:**
Lives in Bahria Town. CTO at TMC. Has a daughter.

**Active Concerns:**
Demo with management tomorrow morning.

You can:
- Edit: Copy the text above, make changes, and send it back
- Clear: Say "clear all memory"
- Keep: Just continue chatting
```

### 7.2 Edit Memory

**Trigger**: User sends back edited text containing "How I Behave:", "About You:", or "Active Concerns:" sections

The system parses the 3 sections and updates the database directly. This gives users full control over what the AI remembers.

### 7.3 Clear Memory

**Trigger**: "clear all memory", "forget everything about me"

**Behavior**: Wipes all 3 fields BUT preserves the AI name (so the user doesn't have to re-teach it).

```
Cleared: user_personal, active_concerns
Kept: AI name from ai_instructions ("Name: Jeni.")
```

---

## 8. Data Flow Diagrams

### 8.1 Memory Lifecycle

```
User Message
    |
    v
[Chat Pipeline]
    |
    +----> AI responds (streaming to user)
    |
    +----> [Background] updateMemoryFromMessage()
    |          |
    |          +-- Read current memory from DB
    |          +-- Send to Gemini Flash with REWRITE prompt
    |          +-- Gemini returns updated 3 fields
    |          +-- Upsert into user_profile_memory
    |
    +----> [Background] learnFromMessage()
               |
               +-- Track topic interest
               +-- Track communication style
               +-- Track time pattern
```

### 8.2 Concern Resolution Flow

```
Day 1: "my daughter has fever"
    |
    v
active_concerns = "Daughter has fever since [date].
                    Follow up on her health."
    |
    v
Day 2: Welcome screen AI note
    -> "How's your daughter feeling today?"
    |
    v
User: "she's much better, thanks!"
    |
    v
updateMemoryFromMessage()
    |
    v
Gemini REWRITE: concern resolved -> remove from text
    |
    v
active_concerns = "" (empty)
    |
    v
Day 3: Welcome screen AI note
    -> "Hey! How's your week going?" (no concern to ask about)
```

### 8.3 Full Request Pipeline with Memory

```
User sends "show me project dashboard"
    |
    v
[PARALLEL - Step 1, ~2s]
+-- classifyIntent() -> "dashboard"
+-- getRecentMessages() -> last 4 messages
+-- getUserProfile() -> job description, city, etc.
+-- buildMemoryPromptBlocks() -> 3 memory blocks
+-- getUserLearnings() -> learned patterns
    |
    v
[Step 2 - Section Retrieval, ~1s]
+-- embedScope() -> vector for "project dashboard"
+-- cosineSimilarity() -> match against section headers
+-- Truncate sections to fit context limit
    |
    v
[Step 3 - Build Prompt]
+-- Profile directive (JD, city)
+-- AI Instructions block (from memory)
+-- User Personal block (from memory)
+-- Active Concerns block (from memory)
+-- Learning block (from user_learning)
+-- Conversation history
+-- Intent directive ("generate dashboard widget")
+-- System prompt + Drive data context
    |
    v
[Step 4 - LLM Generation, ~10-15s]
+-- Stream response to user via SSE
    |
    v
[Step 5 - Background, non-blocking]
+-- updateMemoryFromMessage()
+-- learnFromMessage()
```

---

## 9. Database Tables

### 9.1 Total Tables Required: 3

The entire memory and learning system uses only **3 tables**:

```
Memory System Tables
|
+-- user_profile_memory (1 row per user)    -- WHO the user is & HOW the AI behaves
+-- user_learning       (many rows per user) -- WHAT patterns the AI has learned
+-- feedback            (many rows per user) -- User satisfaction signals
```

### 9.2 Table 1: `user_profile_memory` (Core Memory)

**Purpose**: Stores everything the AI "knows" about a user in 3 rewritable text fields.
**Rows**: Exactly 1 per user. AI rewrites the entire row on every relevant message.

| Column | Type | Description |
|--------|------|-------------|
| `user_id` | INT (PK, unique) | Links to users table |
| `client_number` | VARCHAR(20) | Tenant isolation |
| `ai_instructions` | TEXT | How AI should behave: name, tone, standing instructions |
| `user_personal` | TEXT | Personal facts: city, family, hobbies, work background |
| `active_concerns` | TEXT | Unresolved concerns: health, stress, travel. Auto-cleaned by AI |
| `updated_at` | TIMESTAMP | Last memory update |

**How the 3 fields map to the old legacy tables:**

| New Field | Replaces Old Table | Example Content |
|-----------|-------------------|-----------------|
| `ai_instructions` | `ai_memory` (key-value) | "Name: Jeni. Tone: friendly. Focus on delivery insights." |
| `user_personal` | `user_memory` (multi-row) | "Lives in Bahria Town. Daughter named Sara. CTO at TMC." |
| `active_concerns` | `context_memory` (multi-row) | "Daughter had fever since Tuesday. Demo tomorrow morning." |

### 9.3 Table 2: `user_learning` (Self-Learning)

**Purpose**: Tracks behavioral patterns across 4 categories using a scoring system.
**Rows**: Many per user. Each unique (user_id + category + key) combination is one row.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL (PK) | Auto-increment |
| `client_number` | VARCHAR(20) | Tenant isolation |
| `user_id` | INT | Links to users table |
| `category` | VARCHAR(50) | One of: topic_interest, communication_style, response_format, time_pattern |
| `key` | VARCHAR(100) | Specific pattern (e.g., "projects", "casual", "widgets", "morning") |
| `value` | TEXT | Description of the pattern |
| `score` | DECIMAL | Accumulated score (thumbs up +1.0, thumbs down -0.5) |
| `occurrences` | INT | How many times this pattern was observed |
| `last_seen_at` | TIMESTAMP | When this pattern was last triggered |

**Unique constraint**: `(user_id, category, key)` -- upsert on conflict.

**Example rows for one user:**

| category | key | value | score | occurrences |
|----------|-----|-------|-------|-------------|
| topic_interest | projects | project_delivery | 15.0 | 22 |
| topic_interest | sales | sales_pipeline | 4.0 | 6 |
| communication_style | tone | casual | 6.0 | 9 |
| communication_style | brevity | brief | 3.0 | 5 |
| response_format | widgets | dashboard_widget | 8.5 | 12 |
| response_format | preferred_length | medium | 4.0 | 7 |
| time_pattern | morning | active_at_10h | 5.5 | 8 |

### 9.4 Table 3: `feedback` (User Satisfaction)

**Purpose**: Captures thumbs up/down on AI responses. Feeds into learning engine scoring.
**Rows**: One per feedback action.

| Column | Type | Description |
|--------|------|-------------|
| `id` | SERIAL (PK) | Auto-increment |
| `client_number` | VARCHAR(20) | Tenant isolation |
| `user_id` | INT | Links to users table |
| `conversation_id` | INT | Which conversation |
| `rating` | VARCHAR(10) | "up" or "down" |
| `query` | TEXT | The user's original question |
| `response_preview` | TEXT | First 300 chars of AI response |
| `created_at` | TIMESTAMP | When feedback was given |

### 9.5 Legacy Tables (To Be Deleted)

These 3 tables were the earlier memory implementation, now fully replaced by `user_profile_memory`:

| Legacy Table | Rows | Design Problem | Replaced By |
|-------------|------|----------------|-------------|
| `ai_memory` | 1 row | Key-value pairs, redundant entries | `user_profile_memory.ai_instructions` |
| `user_memory` | 5 rows | Multi-row facts, no cleanup mechanism | `user_profile_memory.user_personal` |
| `context_memory` | 3 rows | Multi-row concerns, never auto-resolved | `user_profile_memory.active_concerns` |

**Migration required**: Data from these tables should be consolidated into `user_profile_memory` before deletion.

### 9.6 Why 3 Tables, Not 1?

| Table | Why Separate |
|-------|-------------|
| `user_profile_memory` | 1 row, rewritten by AI on every message. Volatile, AI-managed. |
| `user_learning` | Many rows, scored numerically. Grows over time. Machine-managed (not AI-rewritten). |
| `feedback` | Append-only log. Never rewritten. Used for analytics and learning input. |

Each table has a fundamentally different write pattern (rewrite vs accumulate vs append), so they must be separate.

---

## 10. Design Principles

### 10.1 No Keyword Matching

The system does NOT use keyword detection ("remember", "my name is") to trigger memory storage. Instead, the AI itself decides what's worth remembering by analyzing every message against the existing memory. This means:
- Users don't need training on magic words
- Natural conversation is captured automatically
- The AI is the judge of relevance, not regex patterns

### 10.2 No Configuration Required

Users never need to:
- Set up a profile form
- Configure tone preferences
- Tell the AI how to behave

Everything is learned from natural interaction. The AI picks up facts, preferences, and concerns organically.

### 10.3 Graceful Degradation

- Memory empty? AI works fine without it -- just less personal
- Learning empty? AI uses default behavior -- still helpful
- External API slow? Welcome screen shows without weather/note -- still loads fast
- Gemini slow? Memory extraction is background, non-blocking -- user never waits

### 10.4 User Is in Control

Despite being automatic, users always have control:
- "Show my memory" -- see everything the AI knows
- "Edit memory" -- manually change any field
- "Clear all memory" -- nuclear option (preserves AI name only)
- Thumbs up/down -- directly influence learning scores

### 10.5 Privacy by Design

- Memory is per-user, isolated by `user_id`
- Multi-tenant: data is also isolated by `client_number`
- No cross-user learning -- each user's AI is independent
- Memory can be fully wiped at any time
- All memory storage is server-side (not in cookies or local storage)
