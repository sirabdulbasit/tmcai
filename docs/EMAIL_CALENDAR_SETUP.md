# Email & Calendar Integration — Setup Guide

**Last Updated**: 2026-03-30

---

## For Users (Self-Service)

### Step 1: Open Settings

1. Click the **gear icon** (bottom-left) or go to **Settings**
2. Scroll down to **"Email & Calendar"** section

### Step 2: Connect Your Google Account

1. Click **"Connect Google (Gmail + Calendar)"**
2. A Google sign-in window will open
3. Select your Google account (the one you want to connect)
4. Review the permissions and click **"Allow"**:
   - Read your emails
   - Send emails on your behalf
   - View and manage your calendar
5. The window will close automatically
6. Your Settings page will show: **Connected** with a green status

### Step 3: Test Your Connection

1. Click **"Test Connection"**
2. You should see: `Connection OK — Email: your@email.com, Calendars: X`
3. If you see an error, click **"Reconnect"** to try again

### Step 4: Start Using It

Once connected, you can ask the AI:

| What You Say | What Happens |
|---|---|
| "Check my emails" | AI reads and summarizes your recent inbox |
| "Any unread emails?" | Shows unread count and summaries |
| "Search emails from Ahmed" | Finds emails from a specific person |
| "Send email to ahmed@company.com about project update" | AI drafts and sends from YOUR email |
| "What's on my calendar today?" | Shows today's meetings and events |
| "What meetings do I have this week?" | Shows upcoming 7 days |
| "Schedule a meeting with team for Tuesday 2pm" | Creates a calendar event |
| "Find a free slot tomorrow for 1 hour" | Checks your calendar for availability |
| "Fetch critical risks and email me weekly" | Sets up a scheduled report |

---

## For Admins (Connecting Other Users)

### Option 1: User Self-Service (Recommended)

Tell users to follow the steps above from their own Settings page.

### Option 2: Admin Setup

1. Go to **Admin → Users tab**
2. Click **"Edit"** next to the user
3. Scroll to **"Email & Calendar Integration"**
4. Click **"Connect Google"**
5. Complete the Google OAuth with the user's account
6. Click **"Test Connection"** to verify

### Managing Integrations

| Action | Where | Who Can Do It |
|---|---|---|
| Connect own account | Settings page | Any user |
| Test own connection | Settings page | Any user |
| Disconnect own account | Settings page | Any user |
| Connect another user | Admin → Edit User | Admin / SuperAdmin only |
| Test another user | Admin → Edit User | Admin / SuperAdmin only |
| Disconnect another user | Admin → Edit User | Admin / SuperAdmin only |

---

## Troubleshooting

### "Access blocked: This app's request is invalid"

**Cause**: Google Cloud Console doesn't have the correct redirect URI.

**Fix (Admin/Developer)**:
1. Go to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Click your OAuth 2.0 Client ID
3. Under **Authorized redirect URIs**, add:
   ```
   http://localhost:4002/api/integration/callback
   ```
   For production, add:
   ```
   https://your-domain.com/api/integration/callback
   ```
4. Click **Save**

### "Integration token expired"

**Cause**: Google access token expired and couldn't auto-refresh.

**Fix**: Click **"Reconnect"** in Settings or Admin panel.

### "Test Connection failed"

**Cause**: APIs not enabled or permissions revoked.

**Fix**:
1. Ensure Gmail API is enabled: [Enable Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
2. Ensure Calendar API is enabled: [Enable Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
3. Click **"Reconnect"** to re-authorize

### "Permission denied" or "Insufficient scopes"

**Cause**: User didn't grant all required permissions during consent.

**Fix**: Click **"Reconnect"** — make sure to check ALL permission boxes in the Google consent screen.

### Status Indicators

| Status | Meaning | Action |
|---|---|---|
| **Active** (green) | Everything working | No action needed |
| **Expired** (yellow) | Token expired | Click Reconnect |
| **Error** (red) | Something broke | Check error message, Reconnect |
| **Not connected** (gray) | Not set up yet | Click Connect |

---

## Google Cloud Console Setup (One-Time, Developer/Admin)

This needs to be done once for the entire application:

### 1. Create/Configure OAuth Consent Screen

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Select your project
3. Navigate to **APIs & Services → OAuth consent screen**
4. Set up the consent screen:
   - App name: `TMC AI Intelligence`
   - Support email: your admin email
   - Authorized domains: your domain (for production)
5. **Scopes** — Add these:
   ```
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/gmail.send
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/userinfo.email
   ```
6. **Test users** — Add all email addresses that will connect (while app is in testing mode)

### 2. Configure OAuth Client

1. Go to **APIs & Services → Credentials**
2. Click your OAuth 2.0 Client ID (or create one)
3. Add **Authorized redirect URIs**:
   ```
   http://localhost:4002/api/integration/callback
   http://localhost:4002/api/auth/google/callback
   ```
   For production:
   ```
   https://your-domain.com/api/integration/callback
   https://your-domain.com/api/auth/google/callback
   ```
4. Save

### 3. Enable Required APIs

Enable these APIs in your Google Cloud project:

- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) (already enabled for data indexing)

### 4. Environment Variables

Add to your `.env` file:
```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
GOOGLE_INTEGRATION_REDIRECT_URI=http://localhost:4002/api/integration/callback
```

For production:
```
GOOGLE_INTEGRATION_REDIRECT_URI=https://your-domain.com/api/integration/callback
```

---

## Data Privacy

- Each user's tokens are stored on their own user record — no shared access
- Tokens are used ONLY when the user asks the AI to check email or calendar
- The AI reads email summaries (subject, from, snippet) — full email body only when explicitly asked
- Emails are NOT stored in the database — they are fetched live from Gmail each time
- Calendar events are NOT stored — fetched live from Google Calendar
- Users can disconnect at any time from Settings — all tokens are immediately deleted
- Admin can disconnect any user's integration if needed

---

## What the AI Can Do Once Connected

### Email

| Capability | Example Prompt |
|---|---|
| Read inbox | "Check my emails" |
| Unread count | "How many unread emails?" |
| Search emails | "Find emails from Ahmed about project" |
| Read specific email | "Read that email from CFO" |
| Send email | "Send email to ahmed@company.com about the PGC update" |
| Draft email | "Draft a follow-up email to Imran about the deal" |
| Summarize thread | "Summarize the email thread about budget approval" |

### Calendar

| Capability | Example Prompt |
|---|---|
| Today's schedule | "What's on my calendar today?" |
| Upcoming events | "What meetings do I have this week?" |
| Create event | "Schedule a meeting with Imran on Tuesday at 2pm" |
| Create with Meet | "Set up a video call with the team for tomorrow 10am" |
| Find free time | "When am I free tomorrow?" |
| Delete event | "Cancel my 3pm meeting" |

### Scheduled Reports (via Email)

| Capability | Example Prompt |
|---|---|
| Weekly risk report | "Fetch critical risks and email me every Monday 9am" |
| Daily project update | "Send me project status every morning at 8am" |
| Monthly revenue summary | "Email me revenue summary on the 1st of each month" |
