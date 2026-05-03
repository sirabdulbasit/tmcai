# Cowork Runbook — MyOS Google OAuth App

**Owner:** cowork (ispcloud@imperialsoft.com.pk)
**Project:** `tmcai-491811` (already exists under ispcloud account)
**Time:** ~30 minutes, one-time
**Date:** 2026-04-21

## Context — why we're doing this

Currently MyOS uses an OAuth app (`822210030240-…`) that was registered years ago inside Haseeb's *personal* Google Cloud project ("My First Project" under `abdulhaseeb09@gmail.com`). That means:

- Users see *"app by abdulhaseeb09@gmail.com"* when they authorize → not OK for external clients.
- Only Haseeb's personal account can enable Google APIs on the project.
- Google verification + CASA assessment can't be done from a personal account.

We're moving the MyOS OAuth app into `tmcai-491811` (TallyMarks-owned via ispcloud). After this, every user at every client tenant sees *"MyOS wants to access your Google Account"* — clean SaaS experience — and no one has to touch GCP ever again.

## Step 1 — Sign into Google Cloud Console

1. Go to <https://console.cloud.google.com/>
2. Sign in as `ispcloud@imperialsoft.com.pk`
3. Project picker (top bar) → select **`tmcai-491811`**

## Step 2 — Enable 7 APIs on the project

APIs & Services → **Library** → search each and click **Enable**:

- Gmail API
- Google Calendar API
- Google Drive API
- Google Tasks API
- Google Chat API
- Google People API
- Google Sheets API

Each takes ~5 seconds to enable. Propagation is ~1 minute.

## Step 3 — Configure OAuth consent screen

APIs & Services → **OAuth consent screen** → **Edit App** (or **Get Started** if first time).

### App information

| Field | Value |
|---|---|
| User type | **External** |
| App name | `MyOS` |
| User support email | `ispcloud@imperialsoft.com.pk` |
| App logo | *(optional for Testing mode)* |

### App domain

| Field | Value |
|---|---|
| Application home page | `https://myos.tallymarks.ai` |
| Application privacy policy link | `https://myos.tallymarks.ai/privacy` |
| Application terms of service link | `https://myos.tallymarks.ai/terms` |
| Authorized domains | `tallymarks.ai` |

*(Pages don't have to exist yet for Testing mode. Placeholders fine.)*

### Developer contact

- `ispcloud@imperialsoft.com.pk`

### Scopes (click **Add or Remove Scopes**)

Paste each into the filter and check the box:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/calendar
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/tasks
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/chat.spaces
https://www.googleapis.com/auth/contacts.readonly
```

### Test users

Add these emails (Testing mode caps at 100; we'll add more or publish later):

- `haseeb@tmcltd.ai`
- `basit.ahmed@tmcltd.ai`
- `abdulhaseeb09@gmail.com`

### Publishing status

Leave as **Testing**. Verification submission is a separate future task.

## Step 4 — Create the OAuth 2.0 Client ID

APIs & Services → **Credentials** → **+ Create Credentials** → **OAuth client ID**.

| Field | Value |
|---|---|
| Application type | **Web application** |
| Name | `MyOS Web Client` |
| Authorized JavaScript origins | `http://localhost:5174`<br>`https://myos.tallymarks.ai` |
| Authorized redirect URIs | `http://localhost:4002/api/v1/connectors/oauth/callback`<br>`https://myos.tallymarks.ai/api/v1/connectors/oauth/callback` |

Click **Create**. A modal pops up with the Client ID and Client Secret — download the JSON or copy both values.

## Step 5 — Send back to the MyOS team

Reply with:

- **Client ID**: `NNNN-xxxxx.apps.googleusercontent.com`
- **Client Secret**: `GOCSPX-xxxxx`
- **Project number**: *(visible in Project dashboard as "Project number: ")*
- Confirmation that all 7 APIs are **Enabled**
- Confirmation that the 3 test users are added to the consent screen

## Step 6 — (Done by MyOS team after receiving above)

1. Replace `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` in `.env` (local + prod).
2. Run `SELECT switch_to_new_oauth_app()` helper (prepared SQL — see `scripts/switch_oauth_app.sql`) which:
   - Marks all existing google-family `user_connectors.status='disconnected'` so users are forced to re-authorize once against the new app.
   - Preserves all feed_events, open_items, decision_logs, etc.
3. Restart server.
4. Each user opens Connectors → clicks Configure on any Google connector → one-time re-auth → done.

## If anything fails

- **"Permission denied" when enabling an API** → ispcloud account isn't Owner/Editor on `tmcai-491811`. Add IAM role: Project Editor.
- **"This app is blocked" when testing** → user isn't on Test Users list. Add them in consent screen.
- **Scopes won't save** → Google sometimes requires filling all "App domain" fields before you can save scopes. Put placeholder URLs even if pages don't exist.

## Rollback

If something goes wrong, the old OAuth app (`822210030240-…`) is not deleted — it stays in Haseeb's personal project. Revert by putting its values back in `.env` and restarting. Users' existing tokens resume working.
