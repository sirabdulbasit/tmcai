# TMC AI Intelligence — User Management

## Overview

TMC AI provides a complete user management system with personalized AI interactions. Each user has an authenticated profile, a Job Description (managed by HR), custom AI instructions, conversation history, and scheduled tasks.

The AI adapts its responses based on who is asking — a Delivery Director gets project risks and timelines, a Sales Lead gets pipeline and revenue insights, an HR Manager gets people-related analytics.

---

## User Model

### Core Fields

| Field | Type | Source | Editable By |
|-------|------|--------|-------------|
| empcode | VARCHAR(20) | HR System | Admin only |
| name | VARCHAR(100) | HR System | Admin only |
| email | VARCHAR(100) | HR System | Admin only |
| department | VARCHAR(50) | HR System | Admin only |
| role | FK -> roles | Admin assignment | Admin only |

### Personalization Fields

| Field | Type | Source | Editable By | Purpose |
|-------|------|--------|-------------|---------|
| job_description | TEXT | Centralized HR Data (sync) | HR only (read-only for user) | AI understands user's responsibilities, suggests relevant analysis |
| about_me | TEXT | User self-writes | User | Personality, background, working style |
| instructions | TEXT | User self-writes | User | Custom AI behavior rules (e.g., "Always show PKR amounts", "Focus on risk analysis") |
| tone_preference | VARCHAR(30) | User self-selects | User | friendly, formal, executive, casual, technical |

### Job Description (JD) Flow

```
HR System (Centralized Data)
    |
    | Sync / Push
    v
TMC AI Database (job_description field)
    |
    | Read-only for user
    v
System Prompt -> AI adapts to user's JD
```

- **HR builds JD** for each employee in centralized HR data
- **Sync process** pulls JD into TMC AI's `users.job_description` field
- **User can view** their JD but cannot edit it
- **AI reads JD** on every request and adapts:
  - Delivery Director → project status, risks, timelines
  - Sales Manager → pipeline, revenue, client engagement
  - HR Manager → headcount, org structure, employee data
  - CEO → executive summaries, strategic insights

---

## Authentication

### Login Flow

```
1. Admin creates user → default PIN generated
2. User receives empcode + PIN
3. POST /api/user/login { empcode, pin }
4. Server validates bcrypt hash
5. Issues 64-char hex token in HttpOnly cookie
6. Token valid for 72 hours (configurable per user)
```

### Security

| Feature | Details |
|---------|---------|
| PIN storage | bcrypt (10 rounds) |
| Token | 64-char hex, HttpOnly cookie |
| Lockout | 5 failed attempts → 30 min lock |
| Session | Expires after `pin_expiry_hours` (default 72h) |

### PIN Management

| Action | Who Can Do It | Endpoint |
|--------|--------------|----------|
| Change own PIN | Any logged-in user | `POST /api/user/change-pin` |
| Reset someone's PIN | Admin only | `POST /api/user/users/:empcode/reset-pin` |

---

## Roles & Permissions

### Default Roles

| Role | Data Access | Admin? | Use Case |
|------|------------|--------|----------|
| admin | All sources, all departments | Yes | System administrators |
| management | All sources, all departments | No | C-suite, directors |
| hr | Google Drive → HR, Management | No | HR team |
| sales | Google Drive → Sales, Pre-Sales | No | Sales team |
| delivery | Google Drive → Delivery, Projects | No | Project managers, consultants |
| viewer | Google Drive → (limited) | No | General read-only access |

### How Roles Affect AI Responses

The AI receives the user's role + allowed departments in the system prompt:
- **management**: Full access, executive-level summaries, strategic recommendations
- **sales**: Sees client/revenue data, pipeline analysis, deal suggestions
- **delivery**: Sees project data, risk analysis, timeline tracking
- **hr**: Sees employee data, org structure, headcount analysis
- **viewer**: General data only, no sensitive HR/financial details

---

## User Profile & AI Personalization

### How Profile Shapes AI Behavior

When a user with this profile:
```json
{
  "job_description": "Director of Delivery - SAP Practice. Responsible for all SAP implementation projects, resource allocation, and delivery quality.",
  "about_me": "I manage 15 consultants across 8 active projects",
  "instructions": "Always flag project risks and delays. Show progress as percentages. Suggest resource reallocation when needed.",
  "tone_preference": "executive"
}
```

Asks "What should I focus on this week?" — the AI:
1. Checks their JD → knows they manage SAP delivery
2. Reads their instructions → prioritizes risks and delays
3. Applies their tone → executive, crisp, decision-focused
4. Proactively suggests → "Project X is at 32% with a critical risk. Consider reassigning 2 resources from Project Y (95% complete)."

### Profile API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/profile` | Yes | Get my profile (JD is read-only) |
| PUT | `/api/profile` | Yes | Update about_me, instructions, tone_preference |

**Note**: `job_description` is NOT editable via this endpoint. It's synced from HR centralized data.

### Tone Options

| Tone | AI Behavior |
|------|-------------|
| friendly | Warm, conversational, uses simple language |
| formal | Professional, structured, business language |
| executive | Crisp, data-driven, focuses on decisions and impact |
| casual | Relaxed, brief, direct |
| technical | Detailed, includes technical terms and specifics |

---

## Conversation History

Each user has isolated conversation threads. The AI uses the last 4 messages for context continuity.

### How It Works
1. First message in a session creates a new conversation
2. Subsequent messages with `conversationId` append to the same conversation
3. AI receives last 4 messages as context → understands "their", "it", "that project"
4. Title auto-generated from first user message

### Conversation API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/conversations` | Yes | List my conversations |
| GET | `/api/conversations/:id` | Yes | Get conversation with all messages |
| POST | `/api/conversations` | Yes | Create new conversation |
| PATCH | `/api/conversations/:id` | Yes | Rename conversation |
| DELETE | `/api/conversations/:id` | Yes | Archive conversation |

---

## Scheduled Tasks

Users can create AI-powered scheduled reports that run automatically and send results via email.

### Use Cases

| Schedule | Prompt | Cron | Notify |
|----------|--------|------|--------|
| Weekly Risk Report | "Summarize projects with critical risks" | `0 9 * * 1` (Mon 9am) | Delivery team |
| Daily Sales Pipeline | "Show today's pipeline status" | `0 8 * * *` (Daily 8am) | Sales manager |
| Monthly Revenue Summary | "Revenue breakdown by client, PKR and USD" | `0 10 1 * *` (1st of month) | CEO |
| Bi-weekly Project Status | "All projects: progress, schedule deviation, risks" | `0 9 1,15 * *` | PMO team |

### How It Works

```
1. User creates scheduled task (title + prompt + cron + email)
2. node-cron registers the job (timezone: Asia/Karachi)
3. At scheduled time:
   a. Fetch latest Drive data
   b. Run AI prompt with user's profile context
   c. Email result to specified recipients
   d. Store result in DB (last_result)
4. User can also run any task on-demand
```

### Scheduler API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/schedules` | Yes | List my scheduled tasks |
| POST | `/api/schedules` | Yes | Create new scheduled task |
| PATCH | `/api/schedules/:id` | Yes | Update task |
| DELETE | `/api/schedules/:id` | Yes | Delete task |
| POST | `/api/schedules/:id/run` | Yes | Run task immediately |

### Cron Expression Examples

| Expression | Meaning |
|-----------|---------|
| `0 9 * * 1` | Every Monday at 9:00 AM |
| `0 8 * * *` | Every day at 8:00 AM |
| `0 10 1 * *` | 1st of every month at 10:00 AM |
| `0 9 * * 1,4` | Every Monday and Thursday at 9:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `30 17 * * 5` | Every Friday at 5:30 PM |

---

## Admin Operations

### User CRUD

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/user/users` | Admin | Create new user |
| POST | `/api/user/users/:empcode/reset-pin` | Admin | Reset user's PIN |

### Create User Example

```json
POST /api/user/users
{
  "empcode": "EMP-1234",
  "name": "Ahmed Khan",
  "email": "ahmed.khan@tmc.com",
  "department": "Delivery",
  "roleId": 5,
  "pin": "654321"
}
```

### JD Sync (HR Admin)

HR updates Job Descriptions through the centralized data system. The sync process:
1. Reads JD data from centralized source (API/DB)
2. Matches by `empcode`
3. Updates `job_description` field in TMC AI `users` table
4. User sees updated JD on next login

```
POST /api/admin/sync-jd  (future endpoint)
{
  "empcode": "EMP-1234",
  "jobDescription": "Senior SAP Consultant - S/4HANA. Responsible for..."
}
```

---

## Database Tables

### users
```sql
id, empcode, name, email, department, role_id,
job_description,    -- synced from HR (read-only for user)
about_me,           -- user-written personality/background
instructions,       -- custom AI instructions
tone_preference,    -- friendly|formal|executive|casual|technical
is_active, last_login_at, created_at, updated_at
```

### login_config
```sql
empcode, auth_mode, pin_hash, pin_expiry_hours,
invitation_sent_at, updated_at
```

### access_tokens
```sql
id, token, user_id, role_context, expires_at,
failed_attempts, locked_until, is_revoked, created_at
```

### roles
```sql
id, name, allowed_sources[], allowed_departments[], is_admin, created_at
```

### scheduled_tasks
```sql
id, user_id, title, prompt, cron_expression, provider,
notify_email, notify_self, is_active,
last_run_at, last_result, last_error, next_run_at,
created_at, updated_at
```

---

## Full API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/user/login` | No | Login |
| POST | `/api/user/logout` | Yes | Logout |
| GET | `/api/user/me` | Yes | Current user |
| POST | `/api/user/change-pin` | Yes | Change PIN |
| POST | `/api/user/users` | Admin | Create user |
| POST | `/api/user/users/:empcode/reset-pin` | Admin | Reset PIN |
| GET | `/api/profile` | Yes | Get profile |
| PUT | `/api/profile` | Yes | Update profile (not JD) |
| GET | `/api/conversations` | Yes | List conversations |
| GET | `/api/conversations/:id` | Yes | Get conversation |
| POST | `/api/conversations` | Yes | New conversation |
| PATCH | `/api/conversations/:id` | Yes | Rename |
| DELETE | `/api/conversations/:id` | Yes | Archive |
| GET | `/api/schedules` | Yes | List tasks |
| POST | `/api/schedules` | Yes | Create task |
| PATCH | `/api/schedules/:id` | Yes | Update task |
| DELETE | `/api/schedules/:id` | Yes | Delete task |
| POST | `/api/schedules/:id/run` | Yes | Run now |
