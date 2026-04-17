# TMC AI Intelligence — User Roles & Access Control

**Last Updated**: 2026-03-28

## Overview

TMC AI uses a 4-tier role hierarchy designed for commercial multi-tenant deployment. Each role defines what data a user can access, which AI capabilities they can use, and what administrative actions they can perform.

Login is email + password only. The system resolves the tenant (client_number) automatically from the user's email — users never see or type their client number.

---

## Role Hierarchy

```
SuperAdmin (System-wide)
    |
    +-- Admin (Per-tenant)
          |
          +-- Standard (Full AI + company data)
          |
          +-- Basic (Limited AI + company data)
```

---

## Role Definitions

### 1. SuperAdmin

**Scope**: Entire platform (cross-tenant)

| Aspect | Access |
|--------|--------|
| **Tenants** | Create, manage, deactivate any tenant |
| **Users** | Create, manage, reset password for ANY user in ANY tenant |
| **System Config** | Full access to all system_config entries across all tenants |
| **Company Data** | Access all tenants' data (for support/debugging) |
| **AI Providers** | All providers, no restrictions |
| **Internet AI** | Full access (Claude, Gemini, GPT for internet queries) |
| **Settings** | Manage API keys, SMTP, encryption keys, global settings |
| **Audit Logs** | View all audit logs across all tenants |
| **Scheduled Tasks** | View/manage all scheduled tasks across tenants |

**Use Case**: Platform operator, SaaS owner. There should be very few SuperAdmins (1-3).

**Login**: Email + password. SuperAdmin users have `is_super_admin = true` on user record. They can switch between tenants.

---

### 2. Admin

**Scope**: Single tenant (their assigned client_number only)

| Aspect | Access |
|--------|--------|
| **Tenants** | Cannot create/manage tenants. Sees only their own tenant info |
| **Users** | Create, manage, reset password for users within their tenant only |
| **System Config** | Manage tenant-level config (not global API keys) |
| **Company Data** | Full access to all company data within their tenant |
| **AI Providers** | All providers, no restrictions |
| **Internet AI** | Full access (Claude, Gemini, GPT for internet queries) |
| **Settings** | Manage tenant-specific settings (not encryption keys) |
| **Audit Logs** | View audit logs for their tenant only |
| **Scheduled Tasks** | Create/manage scheduled tasks, assign to other users in tenant |
| **Roles** | Assign Standard/Basic roles to users. Cannot create other Admins (only SuperAdmin can) |

**Use Case**: Client's IT administrator, department head.

---

### 3. Standard

**Scope**: Single tenant, full AI capabilities

| Aspect | Access |
|--------|--------|
| **Tenants** | No access |
| **Users** | Can only manage their own profile (about_me, instructions, tone) |
| **System Config** | No access |
| **Company Data** | Access based on department/role filters (e.g., Sales sees sales data, Delivery sees project data) |
| **AI Providers** | All providers available |
| **Internet AI** | **Full access** — can use Claude/Gemini/GPT to query internet data, research, analysis |
| **Settings** | Own profile settings only |
| **Audit Logs** | No access |
| **Scheduled Tasks** | Create/manage their own scheduled tasks |
| **Chat History** | Own conversations only |

**Use Case**: Department managers, team leads, analysts — anyone who needs both company data AND internet AI research capability.

**Internet AI Examples**:
- "Compare our SAP implementation timeline with industry benchmarks"
- "What are the latest SAP S/4HANA best practices?"
- "Research competitor pricing for cloud services in Pakistan"
- "Summarize recent news about our client Engro Corporation"

---

### 4. Basic

**Scope**: Single tenant, limited AI capabilities

| Aspect | Access |
|--------|--------|
| **Tenants** | No access |
| **Users** | Can only manage their own profile |
| **System Config** | No access |
| **Company Data** | Access based on department/role filters |
| **AI Providers** | Limited to fast models (Gemini Flash, Groq) |
| **Internet AI** | **Very limited** — only conversational information: weather, currency rates, general news, time/date, basic facts |
| **Settings** | Own profile settings only |
| **Audit Logs** | No access |
| **Scheduled Tasks** | Create/manage their own (max 3 active tasks) |
| **Chat History** | Own conversations only |

**Use Case**: General staff, junior consultants — need company data access but don't need full internet research.

**Allowed Internet Queries** (Basic):
- "What's the weather in Karachi today?"
- "What's the PKR to USD exchange rate?"
- "What day is Eid this year?"
- "What's the latest news headline?"

**Blocked Internet Queries** (Basic):
- "Research SAP competitors" (research/analysis)
- "Find me information about company X" (external company research)
- "Write me a proposal template" (generative content from internet)
- "What are the best cloud providers?" (comparative analysis)

---

## Comparison Matrix

| Capability | SuperAdmin | Admin | Standard | Basic |
|-----------|-----------|-------|----------|-------|
| Cross-tenant access | Yes | No | No | No |
| Manage tenants | Yes | No | No | No |
| Manage users (own tenant) | Yes | Yes | No | No |
| Manage users (all tenants) | Yes | No | No | No |
| Promote to Admin | Yes | No | No | No |
| System config (global) | Yes | No | No | No |
| System config (tenant) | Yes | Yes | No | No |
| All company data | Yes | Yes | Dept-filtered | Dept-filtered |
| All AI providers | Yes | Yes | Yes | Flash/Groq only |
| Full internet AI | Yes | Yes | Yes | No |
| Conversational internet | Yes | Yes | Yes | Yes |
| Manage own profile | Yes | Yes | Yes | Yes |
| Own chat history | Yes | Yes | Yes | Yes |
| View audit logs | All tenants | Own tenant | No | No |
| Scheduled tasks | Unlimited | Unlimited | Unlimited | Max 3 |
| Widget dashboards | Yes | Yes | Yes | Yes |
| Export (CSV/Excel) | Yes | Yes | Yes | No |

---

## Login Flow

```
1. User visits /login
2. Enters: email + password (NO client number field)
3. Server looks up user by email (globally unique)
4. Resolves client_number from user record
5. Validates password (bcrypt)
6. Creates session with user's client_number + role
7. Redirects to chat

SuperAdmin: Can switch between tenants via a tenant selector dropdown
```

### Why No Client Number on Login?

| Approach | Problem |
|----------|---------|
| User types client number | Users forget it, typos, support burden |
| Email resolves tenant | Automatic, zero friction, industry standard (Slack, Teams, etc.) |

Email must be **globally unique** across all tenants (not just per-tenant unique). This is enforced by a database unique constraint on `users.email`.

---

## Database Schema

### roles table

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | Auto-increment |
| client_number | VARCHAR(20) FK | Tenant (NULL for SuperAdmin system role) |
| name | VARCHAR(50) | super_admin, admin, standard, basic |
| allowed_sources | TEXT[] | Data sources this role can access |
| allowed_departments | TEXT[] | Department data filters |
| is_admin | BOOLEAN | Admin-level access within tenant |
| is_super_admin | BOOLEAN | Cross-tenant platform access |
| max_scheduled_tasks | INT | Max active scheduled tasks (0 = unlimited) |
| allowed_providers | TEXT[] | AI providers this role can use |
| internet_access | VARCHAR(20) | 'full', 'limited', 'none' |
| created_at | TIMESTAMPTZ | |

### users table (relevant fields)

| Column | Type | Description |
|--------|------|-------------|
| email | VARCHAR(100) | **Globally unique** (not per-tenant) |
| role_id | INT FK | Links to roles table |
| is_super_admin | BOOLEAN | Platform-level SuperAdmin flag |

---

## Seed Data

### Default Roles (per tenant)

| name | is_admin | is_super_admin | allowed_providers | internet_access | max_tasks |
|------|----------|---------------|-------------------|-----------------|-----------|
| super_admin | true | true | ['all'] | full | 0 |
| admin | true | false | ['all'] | full | 0 |
| standard | false | false | ['all'] | full | 0 |
| basic | false | false | ['gemini-flash', 'groq'] | limited | 3 |

### Default SuperAdmin User

| Field | Value |
|-------|-------|
| email | admin@tmcai.com |
| password | (set during platform setup) |
| role | super_admin |
| is_super_admin | true |
| client_number | (system tenant or first tenant) |

---

## Implementation Notes

### Internet Access Control (Basic vs Standard)

The AI decides what's "internet" vs "company data" based on intent classification:

```
User query -> Intent classifier
    |
    If intent.source === 'company_data' -> Always allowed
    If intent.source === 'internet' AND role === 'basic':
        If intent.category in ['weather', 'currency', 'news', 'time', 'facts'] -> Allowed
        Else -> Blocked ("This query requires internet research. Please ask your admin to upgrade to Standard access.")
    If role === 'standard' or higher -> Always allowed
```

### Provider Restrictions (Basic)

```
If role === 'basic' AND provider not in role.allowed_providers:
    -> Auto-downgrade to gemini-flash
    -> Log downgrade in audit
```

### Scheduled Task Limits (Basic)

```
If role === 'basic' AND active_task_count >= role.max_scheduled_tasks:
    -> "Maximum 3 active scheduled tasks for your plan. Deactivate one to create a new one."
```

### SuperAdmin Tenant Switching

```
GET /api/admin/tenants -> List all tenants (SuperAdmin only)
POST /api/admin/switch-tenant { clientNumber } -> Switch context
    -> Updates session with new client_number
    -> All subsequent requests scoped to selected tenant
```

---

## API Changes Required

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/user/login` | No | Email + password only (no client_number) |
| GET | `/api/admin/tenants` | SuperAdmin | List all tenants |
| POST | `/api/admin/tenants` | SuperAdmin | Create new tenant |
| POST | `/api/admin/switch-tenant` | SuperAdmin | Switch tenant context |
| GET | `/api/admin/users` | Admin+ | List users in tenant |
| POST | `/api/admin/users` | Admin+ | Create user in tenant |
| PATCH | `/api/admin/users/:id/role` | Admin+ | Change user's role |

---

## Security Considerations

1. **SuperAdmin credentials** must be stored with extra security — consider requiring 2FA in future
2. **Email uniqueness** is enforced globally — prevents a user from existing in multiple tenants with the same email
3. **Role escalation** — only SuperAdmin can create Admin roles. Admin cannot promote to Admin.
4. **Tenant isolation** — Admin/Standard/Basic can never access data outside their tenant, even via API manipulation
5. **Provider downgrade** — Basic users who somehow send a request to Claude/GPT get auto-downgraded to Flash, not rejected (better UX)
6. **Audit logging** — all role-restricted actions (blocked queries, downgrades) are logged
