import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../services/api';

/**
 * Connector setup guides — detailed step-by-step with URLs, exact click paths, and field mapping.
 * Opens in new tab, printable as PDF via browser print.
 * URL: /connector-guide?slug=todoist
 */

function getGuides(redirectUri) {
  const RU = redirectUri || 'http://localhost:4002/api/v1/connectors/oauth/callback';
  return {
  // ═══════════════ GOOGLE (OAuth) ═══════════════════════════

  gmail: {
    name: 'Gmail',
    type: 'OAuth (Google)',
    summary: 'Connect your Gmail to read, search, and send emails through the AI assistant.',
    sections: [
      {
        title: 'Option A — Quick Connect (if admin configured)',
        steps: [
          'Go to **My Connectors** page',
          'Find **Gmail** under EMAIL section',
          'Click **Configure**',
          'Click **Authorize (Admin App)** — you will be redirected to Google',
          'Sign in with your Google account and click **Allow**',
          'You will be redirected back — Gmail will show as **Connected**',
        ],
        note: 'This only works if your admin has already set up a Google OAuth app. If you see an error, use Option B.',
      },
      {
        title: 'Option B — Use your own Google OAuth App',
        steps: [
          'Go to **Google Cloud Console**: https://console.cloud.google.com/',
          'Create a new project (or select existing) from the top dropdown',
          'In the left menu, go to **APIs & Services → Credentials**',
          'Click **+ CREATE CREDENTIALS → OAuth client ID**',
          'If prompted, configure the **OAuth consent screen** first:\n   → User Type: **External** (or Internal if Workspace)\n   → App name: anything (e.g. "My TMC AI")\n   → Support email: your email\n   → Save and continue through all steps',
          'Back in Credentials, click **+ CREATE CREDENTIALS → OAuth client ID**',
          'Application type: **Web application**',
          'Name: anything (e.g. "TMC AI Gmail")',
          `Under **Authorized redirect URIs**, click **+ ADD URI** and paste:\n   \`${RU}\``,
          'Click **Create**',
          'You will see **Client ID** and **Client Secret** — copy both',
        ],
        note: 'Keep this window open — you will need to paste these values in the next step.',
      },
      {
        title: 'Enter credentials in TMC AI',
        steps: [
          'Go back to **My Connectors → Gmail → Configure**',
          'Scroll down to **Option 2 — Use Your Own App Credentials**',
          'Paste your **Client ID** in the "Client ID" field',
          'Paste your **Client Secret** in the "Client Secret" field',
          'The **Redirect URI** field is pre-filled — this is the same URL you added to Google Cloud Console',
          'Click **Save & Continue**',
          'Click **Authorize Now** — you will be redirected to Google',
          'Sign in and click **Allow**',
          'You will be redirected back — Gmail shows as **Connected**',
        ],
      },
      {
        title: 'Enable Gmail API',
        steps: [
          'In Google Cloud Console, go to **APIs & Services → Library**',
          'Search for **Gmail API** and click on it',
          'Click **Enable**',
          'Also search and enable **Google Calendar API** if you want calendar too',
        ],
        note: 'If you skip this, you may see a "Gmail API has not been used" error when connecting.',
      },
    ],
  },

  google_calendar: {
    name: 'Google Calendar',
    type: 'OAuth (Google)',
    summary: 'Connect your Google Calendar to view events, create meetings, and manage RSVPs.',
    sections: [
      {
        title: 'Quick Connect',
        steps: [
          'Same process as Gmail — if you already connected Gmail with your own app, Calendar will use the same credentials',
          'Go to **My Connectors → Google Calendar → Configure**',
          'Click **Authorize (Admin App)** or use your own Client ID/Secret (same as Gmail guide)',
          'Sign in with Google → Allow → Connected',
        ],
      },
      {
        title: 'If using your own app',
        steps: [
          'Follow the Gmail guide above to create a Google OAuth app',
          'Make sure you also enable **Google Calendar API** in APIs & Services → Library',
        ],
      },
    ],
  },

  google_tasks: {
    name: 'Google Tasks',
    type: 'OAuth (Google)',
    summary: 'Sync your Google Tasks bidirectionally with Open Items. Uses the same Google OAuth setup as Gmail.',
    sections: [
      { title: 'Connect', steps: [
        'If you already set up Gmail, you can use the **same Client ID and Secret**',
        'Go to **My Connectors → Google Tasks → Configure**',
        'Enter your **Client ID** and **Client Secret** (same as Gmail)',
        'Click **Save & Continue → Save Credentials → Authorize Now**',
        'In Google Cloud Console, make sure **Tasks API** is enabled:\n   → Go to APIs & Services → Library → Search "Tasks API" → Click Enable',
      ] },
    ],
  },

  ms_todo: {
    name: 'Microsoft To Do',
    type: 'OAuth (Microsoft)',
    summary: 'Sync your Microsoft To Do tasks with Open Items. Uses the same Microsoft Azure setup as Outlook.',
    sections: [
      { title: 'Setup', steps: [
        'Follow the **Microsoft Outlook** guide to create an Azure App Registration',
        'When adding API permissions (Step 5), also add: **Tasks.ReadWrite**',
        'Then go to **My Connectors → Microsoft To Do → Configure**',
        'Enter the same **Client ID** and **Client Secret** from your Azure app',
        'Click **Save & Continue → Authorize Now**',
      ] },
    ],
  },

  clickup_personal: {
    name: 'ClickUp',
    type: 'OAuth',
    summary: 'Sync your ClickUp tasks and lists with Open Items.',
    sections: [
      { title: 'Step 1: Create a ClickUp OAuth App', steps: [
        'Go to **https://app.clickup.com/settings/integrations** (or click your avatar → Settings → Integrations)',
        'Scroll down to **ClickUp API** section',
        'Click **Create an App**',
        `App Name: \`TMC AI\` → Redirect URL: paste \`${RU}\``,
        'Click **Create App**',
        'You will see **Client ID** and **Client Secret** — copy both',
      ] },
      { title: 'Step 2: Enter in TMC AI', steps: [
        'Go to **My Connectors → ClickUp → Configure**',
        'Paste **Client ID** and **Client Secret**',
        'Click **Save & Continue → Authorize Now**',
      ] },
    ],
  },

  notion_tasks: {
    name: 'Notion Tasks',
    type: 'OAuth (Notion)',
    summary: 'Use a Notion database as your task list, synced with Open Items.',
    sections: [
      { title: 'Step 1: Create a Notion Integration', steps: [
        'Go to **https://www.notion.so/my-integrations**',
        'Click **+ New integration**',
        'Name: `TMC AI Tasks` → Select your workspace → Click **Submit**',
        'Copy the **Internal Integration Token** (starts with `secret_...`)',
      ] },
      { title: 'Step 2: Share your Tasks database', steps: [
        'Open the Notion database you want to use as a task list',
        'Click **Share** (top-right) → **Invite** → Search for `TMC AI Tasks` → Add it',
        'Copy the **database ID** from the URL: `https://notion.so/YOUR_DB_ID?v=...`',
      ] },
      { title: 'Step 3: Enter in TMC AI', steps: [
        'Go to **My Connectors → Notion Tasks → Configure**',
        'Paste the **Integration Token** as Client ID',
        'Enter the **Database ID** as Client Secret (we use this field for the DB ID)',
        'Click **Save & Continue → Authorize Now**',
      ] },
    ],
  },

  slack: {
    name: 'Slack',
    type: 'OAuth (Slack)',
    summary: 'Read and send Slack messages. You need to create a Slack App in your workspace.',
    sections: [
      { title: 'Step 1: Create a Slack App', steps: [
        'Go to **https://api.slack.com/apps**',
        'Click **Create New App → From scratch**',
        'App Name: `TMC AI` → Pick your workspace → Click **Create App**',
      ] },
      { title: 'Step 2: Set up OAuth', steps: [
        'In the left sidebar, click **OAuth & Permissions**',
        'Scroll to **Redirect URLs** → Click **Add New Redirect URL**',
        `Paste: \`${RU}\``,
        'Click **Add** then **Save URLs**',
        'Scroll to **Scopes → Bot Token Scopes** → Add:\n   → `chat:write` (send messages)\n   → `channels:read` (list channels)\n   → `im:read` (read DMs)\n   → `im:history` (read DM history)',
      ] },
      { title: 'Step 3: Get credentials', steps: [
        'In the left sidebar, click **Basic Information**',
        'Scroll to **App Credentials**',
        'Copy **Client ID** and **Client Secret**',
      ] },
      { title: 'Step 4: Enter in TMC AI', steps: [
        'Go to **My Connectors → Slack → Configure**',
        'Paste **Client ID** and **Client Secret**',
        'Click **Save & Continue → Authorize Now**',
        'You will be redirected to Slack to approve the app for your workspace',
      ] },
    ],
  },

  ms_teams: {
    name: 'Microsoft Teams',
    type: 'OAuth (Microsoft)',
    summary: 'Read and send Microsoft Teams messages. Uses the same Azure setup as Outlook.',
    sections: [
      { title: 'Setup', steps: [
        'Follow the **Microsoft Outlook** guide to create an Azure App Registration',
        'When adding API permissions (Step 5), add: **Chat.ReadWrite**, **ChannelMessage.Send**',
        'Then go to **My Connectors → Microsoft Teams → Configure**',
        'Enter the same **Client ID** and **Client Secret**',
        'Click **Save & Continue → Authorize Now**',
      ] },
    ],
  },

  google_chat: {
    name: 'Google Chat',
    type: 'OAuth (Google)',
    summary: 'Read and send Google Chat messages. Uses the same Google OAuth setup as Gmail.',
    sections: [
      { title: 'Setup', steps: [
        'Use the **same Client ID and Secret** as Gmail',
        'In Google Cloud Console, enable **Google Chat API**:\n   → APIs & Services → Library → Search "Google Chat API" → Enable',
        'Go to **My Connectors → Google Chat → Configure**',
        'Enter your Client ID and Secret → Save & Continue → Authorize Now',
      ] },
    ],
  },

  google_drive_personal: {
    name: 'Google Drive (Personal)',
    type: 'OAuth (Google)',
    summary: 'Access your personal Google Drive files so the AI can read and reference them.',
    sections: [
      { title: 'Setup', steps: [
        'Use the **same Client ID and Secret** as Gmail',
        'In Google Cloud Console, enable **Google Drive API**:\n   → APIs & Services → Library → Search "Google Drive API" → Enable',
        'Go to **My Connectors → Google Drive → Configure**',
        'Enter your Client ID and Secret → Save & Continue → Authorize Now',
        'You will grant read-only access to your Drive files',
      ] },
    ],
  },

  onedrive_personal: {
    name: 'OneDrive',
    type: 'OAuth (Microsoft)',
    summary: 'Access your personal OneDrive files. Uses the same Azure setup as Outlook.',
    sections: [
      { title: 'Setup', steps: [
        'Follow the **Microsoft Outlook** guide to create an Azure App Registration',
        'When adding API permissions, add: **Files.Read**',
        'Go to **My Connectors → OneDrive → Configure**',
        'Enter the same Client ID and Secret → Save & Continue → Authorize Now',
      ] },
    ],
  },

  linkedin_personal: {
    name: 'LinkedIn',
    type: 'OAuth (LinkedIn)',
    summary: 'Read your LinkedIn profile, connections, and messages.',
    sections: [
      { title: 'Step 1: Create a LinkedIn App', steps: [
        'Go to **https://www.linkedin.com/developers/apps**',
        'Click **Create App**',
        'App name: `TMC AI` → LinkedIn Page: select your company page (or create one) → Upload a logo → Check the agreement → Click **Create app**',
      ] },
      { title: 'Step 2: Configure OAuth', steps: [
        'Go to the **Auth** tab',
        `Under **OAuth 2.0 settings → Authorized redirect URLs**, add:\n   \`${RU}\``,
        'Copy the **Client ID** and **Client Secret** shown on this page',
      ] },
      { title: 'Step 3: Request API access', steps: [
        'Go to the **Products** tab',
        'Request access to **Sign In with LinkedIn using OpenID Connect**',
        'This may take a few minutes to be approved',
      ] },
      { title: 'Step 4: Enter in TMC AI', steps: [
        'Go to **My Connectors → LinkedIn → Configure**',
        'Paste Client ID and Client Secret → Save & Continue → Authorize Now',
      ] },
    ],
  },

  twitter_x: {
    name: 'Twitter / X',
    type: 'OAuth (Twitter)',
    summary: 'Read mentions, DMs, and post on Twitter/X.',
    sections: [
      { title: 'Step 1: Create a Twitter Developer App', steps: [
        'Go to **https://developer.twitter.com/en/portal/dashboard**',
        'Sign in with your Twitter/X account',
        'You need a **Developer Account** — apply if you don\'t have one (free tier available)',
        'Once approved, click **+ Add App** → Name: `TMC AI`',
      ] },
      { title: 'Step 2: Get credentials', steps: [
        'Go to your app → **Keys and tokens** tab',
        'Under **OAuth 2.0**, copy **Client ID**',
        'Click **Regenerate** for Client Secret and copy it',
        'Under **User authentication settings**, click **Set up**',
        `Type: **Web App** → Callback URL: \`${RU}\``,
        'Save',
      ] },
      { title: 'Step 3: Enter in TMC AI', steps: [
        'Go to **My Connectors → Twitter/X → Configure**',
        'Paste Client ID and Client Secret → Save & Continue → Authorize Now',
      ] },
    ],
  },

  zoom: {
    name: 'Zoom',
    type: 'OAuth (Zoom)',
    summary: 'View and schedule Zoom meetings.',
    sections: [
      { title: 'Step 1: Create a Zoom App', steps: [
        'Go to **https://marketplace.zoom.us/develop/create**',
        'Sign in with your Zoom account',
        'Choose **OAuth** app type → Click **Create**',
        'App Name: `TMC AI` → Click **Create**',
      ] },
      { title: 'Step 2: Configure', steps: [
        'On the app page, copy **Client ID** and **Client Secret**',
        `Under **Redirect URL**, add:\n   \`${RU}\``,
        'Under **Scopes**, add: `meeting:read`, `meeting:write`',
        'Click **Save**',
      ] },
      { title: 'Step 3: Enter in TMC AI', steps: [
        'Go to **My Connectors → Zoom → Configure**',
        'Paste Client ID and Client Secret → Save & Continue → Authorize Now',
      ] },
    ],
  },

  notion_personal: {
    name: 'Notion (Personal)',
    type: 'OAuth (Notion)',
    summary: 'Read and create pages in your personal Notion workspace.',
    sections: [
      { title: 'Step 1: Create a Notion Integration', steps: [
        'Go to **https://www.notion.so/my-integrations**',
        'Click **+ New integration**',
        'Name: `TMC AI Personal` → Select your workspace → Submit',
        'Copy the **Internal Integration Token**',
      ] },
      { title: 'Step 2: Share pages with the integration', steps: [
        'Open any Notion page you want TMC AI to access',
        'Click **Share → Invite → TMC AI Personal** → Add',
        'Repeat for each page or database you want accessible',
      ],
        note: 'The integration can ONLY access pages you explicitly share with it. Your private pages stay private.',
      },
      { title: 'Step 3: Enter in TMC AI', steps: [
        'Go to **My Connectors → Notion → Configure**',
        'Paste the Integration Token as your Client ID',
        'Click **Save & Continue → Authorize Now**',
      ] },
    ],
  },

  // ═══════════════ MICROSOFT (OAuth) ═════════════════════════

  outlook: {
    name: 'Microsoft Outlook',
    type: 'OAuth (Microsoft)',
    summary: 'Connect your Microsoft Outlook / Office 365 email so the AI can read and send emails for you. You will need to create a small app registration in Microsoft Azure (free, takes 5 minutes).',
    sections: [
      {
        title: 'Step 1: Open Microsoft Azure Portal',
        steps: [
          'Open your browser and go to: **https://portal.azure.com/**',
          'Sign in with your **Microsoft / Office 365 account** (the same one you use for Outlook)',
          'You will see the Azure home page with a blue header — don\'t worry about all the options, we only need one thing',
        ],
      },
      {
        title: 'Step 2: Create an App Registration',
        steps: [
          'In the **search bar at the top** of the page, type: **App registrations**',
          'Click on **App registrations** from the dropdown results',
          'You will see a page with a list (probably empty). Click the **+ New registration** button at the top',
          `Fill in the form:\n   → **Name**: Type \`TMC AI\` (this is just a label, can be anything)\n   → **Supported account types**: Select the 3rd option: **"Accounts in any organizational directory... and personal Microsoft accounts"**\n   → **Redirect URI**: Select **Web** from the dropdown, then paste this URL:\n   \`${RU}\``,
          'Click the blue **Register** button at the bottom',
        ],
      },
      {
        title: 'Step 3: Copy your Client ID',
        steps: [
          'After clicking Register, you will be taken to the app\'s overview page',
          'Look for **Application (client) ID** — it\'s a long code like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`',
          '**Copy this value** — you will paste it into TMC AI later. This is your **Client ID**',
        ],
        note: 'Tip: Click the small copy icon next to the ID to copy it to your clipboard.',
      },
      {
        title: 'Step 4: Create a Client Secret',
        steps: [
          'On the same page, look at the **left sidebar menu**',
          'Click **Certificates & secrets**',
          'Click **+ New client secret**',
          'A small form appears:\n   → **Description**: Type `TMC AI`\n   → **Expires**: Select **24 months** (recommended)',
          'Click **Add**',
          'A new row appears in the table. Look for the column called **Value** (NOT "Secret ID")',
          '**Copy the Value immediately!** It looks like a long random string. This is your **Client Secret**',
        ],
        note: 'IMPORTANT: You can only see this secret value RIGHT NOW. If you leave this page without copying it, you will need to create a new secret. Copy it and save it somewhere safe.',
      },
      {
        title: 'Step 5: Add Email Permissions',
        steps: [
          'In the left sidebar, click **API permissions**',
          'Click **+ Add a permission**',
          'A panel opens on the right. Click **Microsoft Graph** (the first big option)',
          'Click **Delegated permissions**',
          'In the search box, type `Mail` and check these boxes:\n   → **Mail.Read** (read your emails)\n   → **Mail.Send** (send emails on your behalf)',
          'Also search for `User` and check: **User.Read**',
          'Click the blue **Add permissions** button at the bottom',
          'If you see an orange banner saying "Admin consent required" — that\'s OK for now, the permissions will still work for your own account',
        ],
      },
      {
        title: 'Step 6: Enter the values in TMC AI',
        steps: [
          'Go back to **TMC AI** in your browser',
          'Go to **My Connectors** page → Find **Microsoft Outlook**',
          'Click **Configure**',
          'You will see two empty fields:\n   → **Client ID**: Paste the Application (client) ID you copied in Step 3\n   → **Client Secret**: Paste the secret Value you copied in Step 4',
          'Click **Save & Continue →**',
          'You will see a summary showing your Client ID and masked secret',
          'Click **Save Credentials** → then click **Authorize Now →**',
          'You will be redirected to Microsoft to sign in and approve access',
          'After approving, you will be redirected back to TMC AI',
          'Microsoft Outlook will now show as **Connected** with a green badge!',
        ],
      },
    ],
  },

  outlook_calendar: {
    name: 'Outlook Calendar',
    type: 'OAuth (Microsoft)',
    summary: 'Connect your Outlook Calendar. Same setup as Outlook email.',
    sections: [
      {
        title: 'Connect',
        steps: [
          'Follow the **Microsoft Outlook** guide above to create an Azure app',
          'Add these extra permissions: **Calendars.ReadWrite**',
          'Then configure in My Connectors → Outlook Calendar',
        ],
      },
    ],
  },

  // ═══════════════ API KEY CONNECTORS ════════════════════════

  todoist: {
    name: 'Todoist',
    type: 'API Key',
    summary: 'Sync your Todoist tasks with Open Items.',
    sections: [
      {
        title: 'Get your Todoist API Token',
        steps: [
          'Open **Todoist** in your browser: https://todoist.com/',
          'Log in to your account',
          'Click your **profile icon** (top-left or top-right)',
          'Go to **Settings**',
          'Click **Integrations** tab (in the left sidebar)',
          'Scroll down to **Developer** section',
          'You will see your **API token** — it looks like: `0a1b2c3d4e5f6g7h8i9j0k`',
          'Click **Copy** or select all and copy',
        ],
        note: 'This token gives full access to your Todoist account. Keep it private.',
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors** page',
          'Find **Todoist** under TASKS section',
          'Click **Configure**',
          'Paste your API token in the **API Key** field',
          'Click **Save & Continue →**',
          'Review your saved credentials (token is masked)',
          'Click **Connect** — the system will call Todoist API to verify your token',
          'If successful → shows "Connection successful!" → Todoist is now **Connected**',
          'If error → check that your token is correct and try again',
        ],
      },
    ],
  },

  trello: {
    name: 'Trello',
    type: 'API Key + Token',
    summary: 'Sync your Trello boards and cards.',
    sections: [
      {
        title: 'Get your Trello API Key',
        steps: [
          'Go to https://trello.com/power-ups/admin',
          'Log in if needed',
          'Click on your Power-Up, or click **New** to create one',
          'On the Power-Up page, find **API Key** — copy it',
        ],
      },
      {
        title: 'Get your Trello Token',
        steps: [
          'On the same page where you see your API Key, click the **Token** link',
          'A new page opens asking you to authorize — click **Allow**',
          'A long token string appears — copy it',
        ],
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → Trello → Configure**',
          'Paste your **API Key** in the first field',
          'Paste your **Token** in the second field',
          'Click **Save & Continue → Connect**',
        ],
      },
    ],
  },

  hubspot: {
    name: 'HubSpot',
    type: 'API Key (Private App)',
    summary: 'Connect your HubSpot CRM to track contacts, deals, and tickets.',
    sections: [
      {
        title: 'Create a HubSpot Private App',
        steps: [
          'Log into **HubSpot**: https://app.hubspot.com/',
          'Click **Settings** (gear icon, top-right)',
          'In the left sidebar: **Integrations → Private Apps**',
          'Click **Create a private app**',
          'Name: "TMC AI" (or anything)',
          'Go to the **Scopes** tab',
          'Under CRM, enable: **crm.objects.contacts.read**, **crm.objects.deals.read**, **crm.objects.companies.read**',
          'Click **Create app** → Confirm',
          'Copy the **Access Token** shown',
        ],
        note: 'You can always come back to Settings → Private Apps to see or rotate the token.',
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → HubSpot → Configure**',
          'Paste the Access Token in the **Private App Token** field',
          'Click **Save & Continue → Connect**',
        ],
      },
    ],
  },

  jira: {
    name: 'Jira',
    type: 'API Token',
    summary: 'Connect your Jira to track issues, sprints, and backlogs.',
    sections: [
      {
        title: 'Get your Atlassian API Token',
        steps: [
          'Go to: https://id.atlassian.com/manage-profile/security/api-tokens',
          'Log in with your Atlassian account',
          'Click **Create API token**',
          'Label: "TMC AI" → Click **Create**',
          'Copy the token shown (you won\'t see it again!)',
        ],
      },
      {
        title: 'Find your Jira domain',
        steps: [
          'Your Jira domain is the URL you use to access Jira',
          'Example: if you go to **https://mycompany.atlassian.net/**, your domain is **mycompany.atlassian.net**',
        ],
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → Jira → Configure**',
          '**Jira Domain**: enter `mycompany.atlassian.net` (without https://)',
          '**Email**: the email you use to log into Atlassian',
          '**API Token**: paste the token you created',
          'Click **Save & Continue → Connect**',
        ],
      },
    ],
  },

  zendesk: {
    name: 'Zendesk',
    type: 'API Token',
    summary: 'Monitor support tickets and customer satisfaction.',
    sections: [
      {
        title: 'Get your Zendesk API Token',
        steps: [
          'Log into **Zendesk Admin Center**: https://yoursubdomain.zendesk.com/admin/',
          'Go to **Apps and integrations → APIs → Zendesk API**',
          'Make sure **Token Access** is enabled',
          'Click **Add API token**',
          'Description: "TMC AI" → **Save**',
          'Copy the token',
        ],
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → Zendesk → Configure**',
          '**Zendesk Subdomain**: just the subdomain part (e.g. "mycompany" from mycompany.zendesk.com)',
          '**Agent Email**: your Zendesk agent email',
          '**API Token**: paste the token',
          'Click **Save & Continue → Connect**',
        ],
      },
    ],
  },

  telegram: {
    name: 'Telegram',
    type: 'Bot Token',
    summary: 'Send and receive messages via a Telegram bot.',
    sections: [
      {
        title: 'Create a Telegram Bot',
        steps: [
          'Open **Telegram** on your phone or desktop',
          'Search for **@BotFather** (the official bot for creating bots)',
          'Send the command: **/newbot**',
          'BotFather will ask for a **name** — enter anything (e.g. "My TMC Assistant")',
          'BotFather will ask for a **username** — must end in "bot" (e.g. "mytmc_bot")',
          'BotFather will reply with your **Bot Token** — looks like: `110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`',
          'Copy this token',
        ],
      },
      {
        title: 'Get your Chat ID',
        steps: [
          'Send any message to your new bot in Telegram (just say "hello")',
          'Open this URL in your browser (replace YOUR_TOKEN with your bot token):\n   `https://api.telegram.org/botYOUR_TOKEN/getUpdates`',
          'In the JSON response, find: `"chat":{"id":123456789}`',
          'That number (e.g. **123456789**) is your Chat ID',
        ],
        note: 'If you see an empty result, make sure you sent a message to the bot first, then refresh the URL.',
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → Telegram → Configure**',
          '**Bot Token**: paste the token from BotFather',
          '**Chat ID**: enter the number you found',
          'Click **Save & Continue → Connect** — system will verify the bot token is valid',
        ],
      },
    ],
  },

  whatsapp: {
    name: 'WhatsApp',
    type: 'Meta Cloud API (Access Token)',
    summary: 'Connect WhatsApp Business API to send and receive messages. You need a Meta Business Account and a WhatsApp Business phone number. This setup takes about 15-20 minutes if you don\'t have a Meta Business account yet.',
    sections: [
      {
        title: 'Step 1: Create a Meta Business Account (skip if you already have one)',
        steps: [
          'Go to **https://business.facebook.com/** and log in with your Facebook account',
          'If you don\'t have a business account, click **Create Account** and follow the steps',
          'You need a verified business account to use WhatsApp API',
        ],
      },
      {
        title: 'Step 2: Set up WhatsApp in Meta Developer Portal',
        steps: [
          'Go to **https://developers.facebook.com/**',
          'Click **My Apps** (top-right) → **Create App**',
          'Select **Business** type → Click **Next**',
          'App name: `TMC AI WhatsApp` → Select your Business Account → Click **Create App**',
          'On the app dashboard, find **WhatsApp** and click **Set Up**',
          'You will see the **WhatsApp API Setup** page',
        ],
      },
      {
        title: 'Step 3: Get your Phone Number ID',
        steps: [
          'On the WhatsApp API Setup page, you\'ll see a **test phone number** provided by Meta',
          'Below it, you\'ll see **Phone Number ID** — it\'s a long number like `123456789012345`',
          '**Copy this Phone Number ID**',
          'If you want to use your own business number instead of the test number, click **Add phone number** and follow the verification process',
        ],
      },
      {
        title: 'Step 4: Get a Permanent Access Token',
        steps: [
          'The token shown on the API Setup page is **temporary** (expires in 24 hours). You need a permanent one.',
          'Go to **https://business.facebook.com/settings/system-users**',
          'Click **Add** to create a new System User:\n   → Name: `TMC AI`\n   → Role: **Admin**',
          'Click **Generate Token** on the system user you just created',
          'Select your app (`TMC AI WhatsApp`)',
          'Under permissions, check: **whatsapp_business_messaging**, **whatsapp_business_management**',
          'Click **Generate Token**',
          '**Copy the token** — this is your permanent Access Token',
        ],
        note: 'This permanent token does NOT expire. Keep it safe — anyone with this token can send messages from your WhatsApp Business number.',
      },
      {
        title: 'Step 5: Get your Business Account ID (optional)',
        steps: [
          'Go to **https://business.facebook.com/settings/whatsapp-business-accounts**',
          'Click on your WhatsApp Business Account',
          'The **Business Account ID** is shown in the URL or on the page — looks like `123456789012345`',
          'This is optional but helps with advanced features',
        ],
      },
      {
        title: 'Step 6: Enter the values in TMC AI',
        steps: [
          'Go to **My Connectors → WhatsApp → Configure**',
          'Fill in the form:\n   → **Phone Number**: Your phone number with country code (e.g. +923001234567)\n   → **Phone Number ID**: The ID from Step 3\n   → **Access Token**: The permanent token from Step 4\n   → **Business Account ID**: (optional) from Step 5',
          'Click **Save & Continue →**',
          'Click **Connect** — the system will call the WhatsApp API to verify your credentials',
          'If successful → WhatsApp shows as **Connected**',
          'If error → check that your Phone Number ID and Access Token are correct',
        ],
      },
    ],
  },

  sap: {
    name: 'SAP ERP',
    type: 'Credentials (URL + Username + Password)',
    summary: 'Connect to SAP for financial monitoring, project data, and risk tracking.',
    sections: [
      {
        title: 'Get SAP API access',
        steps: [
          'Contact your **SAP Basis/Admin team** and request REST API or OData access',
          'You need:\n   → **API URL**: The SAP server URL (e.g. https://sapserver.company.com:443/sap/opu/odata/)',
          '   → **Username**: Your SAP user ID (or a service account)',
          '   → **Password**: Your SAP password',
          '   → **Client number** (optional): e.g. "100" or "200"',
        ],
        note: 'Ask for a service account dedicated to TMC AI rather than using your personal SAP login.',
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → SAP ERP → Configure**',
          '**SAP API URL**: paste the full URL',
          '**Username**: SAP user ID',
          '**Password**: SAP password',
          '**Client Number**: enter if required',
          'Click **Save & Continue → Connect** — system will test connectivity to the URL',
        ],
      },
    ],
  },

  odoo: {
    name: 'Odoo ERP/CRM',
    type: 'API Key',
    summary: 'Connect to Odoo for CRM, invoicing, projects, and HR data.',
    sections: [
      {
        title: 'Get your Odoo API Key',
        steps: [
          'Log into your **Odoo** instance',
          'Click your **user avatar** (top-right) → **My Profile** or **Preferences**',
          'Go to **Account Security** section',
          'Click **API Keys** → **New API Key**',
          'Description: "TMC AI" → Click **Generate Key**',
          'Copy the key shown',
        ],
      },
      {
        title: 'Find your database name',
        steps: [
          'Your Odoo URL is something like: https://mycompany.odoo.com',
          'The database name is usually your company name or shown in Odoo settings',
          'If you use Odoo.sh, check Settings → Database Name',
        ],
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → Odoo → Configure**',
          '**Odoo URL**: your Odoo instance URL (e.g. https://mycompany.odoo.com)',
          '**Database**: your database name',
          '**API Key**: paste the key',
          'Click **Save & Continue → Connect**',
        ],
      },
    ],
  },

  notion_org: {
    name: 'Notion (Organization)',
    type: 'Integration Token',
    summary: 'Connect your organization Notion workspace.',
    sections: [
      {
        title: 'Create a Notion Integration',
        steps: [
          'Go to: https://www.notion.so/my-integrations',
          'Click **+ New integration**',
          'Name: "TMC AI"',
          'Select the workspace to connect',
          'Click **Submit**',
          'Copy the **Internal Integration Token** (starts with "secret_...")',
        ],
      },
      {
        title: 'Share pages with the integration',
        steps: [
          'Open any Notion page or database you want TMC AI to access',
          'Click **Share** (top-right) → **Invite**',
          'Search for "TMC AI" (your integration name) and add it',
          'Repeat for each page/database',
        ],
        note: 'The integration can only access pages explicitly shared with it.',
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → Notion (Org) → Configure**',
          'Paste the **Integration Token** in the API Key field',
          'Click **Save & Continue → Connect**',
        ],
      },
    ],
  },

  github: {
    name: 'GitHub',
    type: 'OAuth / Personal Access Token',
    summary: 'Monitor repos, issues, PRs, and deployments.',
    sections: [
      {
        title: 'Create a GitHub Personal Access Token',
        steps: [
          'Go to: https://github.com/settings/tokens',
          'Click **Generate new token** → **Fine-grained token** (recommended)',
          'Token name: "TMC AI"',
          'Expiration: 90 days (or custom)',
          'Repository access: select the repos you want to monitor',
          'Permissions: enable **Issues (Read)**, **Pull requests (Read)**, **Metadata (Read)**',
          'Click **Generate token** → copy it',
        ],
      },
      {
        title: 'Enter in TMC AI',
        steps: [
          'Go to **My Connectors → GitHub → Configure**',
          'Paste the token in the **API Key** field',
          'Click **Save & Continue → Connect**',
        ],
      },
    ],
  },
}; // end of return
} // end of getGuides

// Fallback for unknown connectors
const DEFAULT_GUIDE = {
  name: 'Connector',
  type: 'Various',
  summary: 'Setup guide for this connector.',
  sections: [
    {
      title: 'General Setup Steps',
      steps: [
        'Go to the service provider\'s website and log into your account',
        'Navigate to **Settings**, **Integrations**, **API**, or **Developer** section',
        'Create an API key, token, or OAuth app',
        'Copy the credentials',
        'Go to **My Connectors** in TMC AI',
        'Click **Configure** on the connector',
        'Paste your credentials in the form',
        'Click **Save & Continue → Connect**',
      ],
      note: 'Check the provider\'s documentation for specific instructions on generating API keys or OAuth credentials.',
    },
  ],
};

export default function ConnectorGuidePage() {
  const [searchParams] = useSearchParams();
  const [redirectUri, setRedirectUri] = useState('');
  const slug = searchParams.get('slug') || '';

  useEffect(() => {
    api.get('/connectors/oauth/redirect-uri')
      .then(r => setRedirectUri(r.data.redirectUri))
      .catch(() => setRedirectUri('http://localhost:4002/api/v1/connectors/oauth/callback'));
  }, []);

  const GUIDES = getGuides(redirectUri);
  const guide = GUIDES[slug] || { ...DEFAULT_GUIDE, name: slug.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) };

  return (
    <div style={{ height: '100vh', overflow: 'hidden', background: '#fff', color: '#222', fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif" }}>
      <div style={{ height: '100%', overflowY: 'auto', scrollbarWidth: 'thin' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '40px 24px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, borderBottom: '2px solid #cc6b4a', paddingBottom: 16 }}>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, color: '#111' }}>How to Configure {guide.name}</div>
            <div style={{ fontSize: 13, color: '#888', marginTop: 4 }}>TMC AI — Connector Setup Guide</div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: '#cc6b4a22', color: '#cc6b4a' }}>{guide.type}</span>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button onClick={() => window.print()} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #ccc', background: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
              Print / Save PDF
            </button>
            <button onClick={() => window.close()} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#cc6b4a', color: '#fff', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit' }}>
              Close
            </button>
          </div>
        </div>

        {/* Summary */}
        <div style={{ padding: 16, background: '#f0f7ff', border: '1px solid #d0e3ff', borderRadius: 10, marginBottom: 24, fontSize: 14, color: '#333', lineHeight: 1.6 }}>
          {guide.summary}
        </div>

        {/* Sections */}
        {guide.sections.map((section, si) => (
          <div key={si} style={{ marginBottom: 28 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#111', marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid #e5e5e5' }}>
              {section.title}
            </div>

            {/* Steps */}
            <div style={{ paddingLeft: 0 }}>
              {section.steps.map((step, i) => (
                <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'flex-start' }}>
                  <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#cc6b4a', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>
                    {i + 1}
                  </div>
                  <div style={{ fontSize: 14, color: '#333', lineHeight: 1.7, flex: 1 }}
                    dangerouslySetInnerHTML={{
                      __html: step
                        .replace(/\*\*(.*?)\*\*/g, '<strong style="color:#111">$1</strong>')
                        .replace(/`(.*?)`/g, '<code style="background:#f0f0f0;padding:2px 6px;border-radius:4px;font-size:12px;color:#c7254e">$1</code>')
                        .replace(/\n/g, '<br/>')
                    }}
                  />
                </div>
              ))}
            </div>

            {/* Note box */}
            {section.note && (
              <div style={{ marginTop: 8, padding: '10px 14px', background: '#fff8e1', border: '1px solid #ffe082', borderRadius: 8, fontSize: 13, color: '#795548', lineHeight: 1.5 }}>
                <strong>Note:</strong> {section.note}
              </div>
            )}
          </div>
        ))}

        {/* What values go where - quick reference */}
        <div style={{ marginTop: 32, padding: 20, background: '#f5f5f5', border: '1px solid #e0e0e0', borderRadius: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 10 }}>Quick Reference — Where to enter what</div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #ccc' }}>
                <th style={{ textAlign: 'left', padding: '6px 8px', color: '#555' }}>Field in TMC AI</th>
                <th style={{ textAlign: 'left', padding: '6px 8px', color: '#555' }}>Where to get it</th>
              </tr>
            </thead>
            <tbody>
              {slug === 'todoist' && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>API Key</td><td style={{ padding: '6px 8px' }}>Todoist → Settings → Integrations → Developer</td></tr>
              </>}
              {slug === 'trello' && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>API Key</td><td style={{ padding: '6px 8px' }}>trello.com/power-ups/admin → Your Power-Up</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Token</td><td style={{ padding: '6px 8px' }}>Click "Token" link next to API Key → Allow → Copy</td></tr>
              </>}
              {slug === 'jira' && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Jira Domain</td><td style={{ padding: '6px 8px' }}>Your Jira URL without https:// (e.g. mycompany.atlassian.net)</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Email</td><td style={{ padding: '6px 8px' }}>Your Atlassian account email</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>API Token</td><td style={{ padding: '6px 8px' }}>id.atlassian.com → Security → API tokens → Create</td></tr>
              </>}
              {slug === 'telegram' && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Bot Token</td><td style={{ padding: '6px 8px' }}>Telegram → @BotFather → /newbot → Copy token</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Chat ID</td><td style={{ padding: '6px 8px' }}>api.telegram.org/botYOUR_TOKEN/getUpdates → chat.id</td></tr>
              </>}
              {slug === 'whatsapp' && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Phone Number</td><td style={{ padding: '6px 8px' }}>Your phone with country code (e.g. +923001234567)</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Phone Number ID</td><td style={{ padding: '6px 8px' }}>Meta Developer Portal → WhatsApp → API Setup page</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Access Token</td><td style={{ padding: '6px 8px' }}>Meta Business Settings → System Users → Generate Token</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Business Account ID</td><td style={{ padding: '6px 8px' }}>(Optional) Meta Business Settings → WhatsApp Business Accounts</td></tr>
              </>}
              {(slug === 'gmail' || slug === 'google_calendar' || slug === 'google_tasks') && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Client ID</td><td style={{ padding: '6px 8px' }}>Google Cloud Console → APIs & Services → Credentials → OAuth client</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Client Secret</td><td style={{ padding: '6px 8px' }}>Same page as Client ID</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Redirect URI</td><td style={{ padding: '6px 8px' }}>Pre-filled in TMC AI — copy and add to Google OAuth app</td></tr>
              </>}
              {(slug === 'outlook' || slug === 'outlook_calendar') && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Client ID</td><td style={{ padding: '6px 8px' }}>Azure Portal → App registrations → Application (client) ID</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Client Secret</td><td style={{ padding: '6px 8px' }}>Azure Portal → Certificates & secrets → New client secret → Value</td></tr>
              </>}
              {slug === 'sap' && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>SAP API URL</td><td style={{ padding: '6px 8px' }}>From your SAP Basis/Admin team</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Username</td><td style={{ padding: '6px 8px' }}>SAP user ID or service account</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Password</td><td style={{ padding: '6px 8px' }}>SAP password for the user</td></tr>
              </>}
              {slug === 'odoo' && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Odoo URL</td><td style={{ padding: '6px 8px' }}>Your Odoo instance (e.g. https://mycompany.odoo.com)</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>Database</td><td style={{ padding: '6px 8px' }}>Odoo Settings → Database Name</td></tr>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>API Key</td><td style={{ padding: '6px 8px' }}>Your Profile → Account Security → API Keys</td></tr>
              </>}
              {!['todoist','trello','jira','telegram','whatsapp','gmail','google_calendar','google_tasks','outlook','outlook_calendar','sap','odoo'].includes(slug) && <>
                <tr style={{ borderBottom: '1px solid #eee' }}><td style={{ padding: '6px 8px' }}>API Key / Token</td><td style={{ padding: '6px 8px' }}>Provider's Settings → API / Integrations / Developer section</td></tr>
              </>}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div style={{ marginTop: 32, padding: 14, background: '#f0f0f0', borderRadius: 8, fontSize: 12, color: '#888', textAlign: 'center' }}>
          TMC AI Intelligence Platform — Connector Setup Guide — {guide.name} — {new Date().toLocaleDateString()}
        </div>
      </div>
      </div>

      <style>{`
        @media print {
          button { display: none !important; }
          div { break-inside: avoid; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}
