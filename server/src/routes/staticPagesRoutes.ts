import { Router } from 'express';

const router = Router();

const PAGE_STYLE = `
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; color: #333; line-height: 1.6; }
  h1 { color: #1a1a2e; border-bottom: 2px solid #e94560; padding-bottom: 10px; }
  h2 { color: #1a1a2e; margin-top: 30px; }
  .footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; color: #666; font-size: 0.9em; }
  a { color: #e94560; }
`;

router.get('/privacy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy - MyOS</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p><strong>Last updated:</strong> May 13, 2026</p>

  <h2>Introduction</h2>
  <p>MyOS ("we", "our", or "us") is an AI-powered executive assistant platform operated by TallyMarks Consulting (TMC). This Privacy Policy explains how we collect, use, and protect your information when you use our service.</p>

  <h2>Information We Collect</h2>
  <p>When you sign in with your Google account, we access the following data based on your granted permissions:</p>
  <ul>
    <li><strong>Profile Information:</strong> Your name, email address, and profile picture from your Google account.</li>
    <li><strong>Calendar Data:</strong> Events and schedules from Google Calendar to help manage your meetings and schedule.</li>
    <li><strong>Email Data:</strong> Email messages and metadata from Gmail to provide email management and AI-powered assistance.</li>
    <li><strong>Drive Files:</strong> Read-only access to your Google Drive documents to provide context-aware AI assistance.</li>
    <li><strong>Contacts:</strong> Read-only access to your contacts for smart recipient suggestions.</li>
    <li><strong>Tasks:</strong> Google Tasks data for productivity tracking and task management.</li>
    <li><strong>Chat Spaces:</strong> Google Chat spaces for team collaboration features.</li>
  </ul>

  <h2>How We Use Your Information</h2>
  <p>We use your data solely to provide the MyOS AI assistant service, including:</p>
  <ul>
    <li>Providing AI-powered responses grounded in your personal data context.</li>
    <li>Managing calendar events, composing emails, and creating tasks on your behalf.</li>
    <li>Searching and indexing your documents for context-aware assistance.</li>
    <li>Suggesting contacts and managing communications.</li>
  </ul>

  <h2>Data Storage and Security</h2>
  <p>Your data is processed securely using Google Cloud Platform infrastructure. We employ encryption in transit and at rest. OAuth tokens are stored securely and can be revoked at any time through your Google Account settings.</p>

  <h2>Data Sharing</h2>
  <p>We do not sell, trade, or share your personal data with third parties. Your data is only used to power the MyOS AI assistant for your personal use.</p>

  <h2>Your Rights</h2>
  <p>You can revoke MyOS's access to your Google data at any time by visiting <a href="https://myaccount.google.com/permissions">Google Account Permissions</a>. You may also request deletion of your account and associated data by contacting us.</p>

  <h2>Contact Us</h2>
  <p>If you have questions about this Privacy Policy, please contact us at <a href="mailto:support@tmcltd.com">support@tmcltd.com</a>.</p>

  <div class="footer">
    <p>&copy; 2026 TallyMarks Consulting. All rights reserved.</p>
  </div>
</body>
</html>`);
});

router.get('/terms', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service - MyOS</title>
  <style>${PAGE_STYLE}</style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p><strong>Last updated:</strong> May 13, 2026</p>

  <h2>Acceptance of Terms</h2>
  <p>By accessing or using MyOS ("the Service"), an AI-powered executive assistant platform operated by TallyMarks Consulting (TMC), you agree to be bound by these Terms of Service.</p>

  <h2>Description of Service</h2>
  <p>MyOS is an AI-powered executive assistant that integrates with Google Workspace services (Calendar, Gmail, Drive, Contacts, Tasks, and Chat) to help you manage your daily workflows through intelligent automation and AI-driven insights.</p>

  <h2>User Accounts</h2>
  <p>You must sign in with a valid Google account to use the Service. You are responsible for maintaining the security of your account and for all activities that occur under your account.</p>

  <h2>Acceptable Use</h2>
  <p>You agree to use the Service only for lawful purposes and in accordance with these Terms. You agree not to:</p>
  <ul>
    <li>Use the Service for any unlawful or unauthorized purpose.</li>
    <li>Attempt to gain unauthorized access to any part of the Service.</li>
    <li>Interfere with or disrupt the Service or its infrastructure.</li>
    <li>Use the Service to send spam or unsolicited communications.</li>
  </ul>

  <h2>Data and Privacy</h2>
  <p>Your use of the Service is also governed by our <a href="/privacy">Privacy Policy</a>. By using the Service, you consent to the collection and use of your data as described in the Privacy Policy.</p>

  <h2>Intellectual Property</h2>
  <p>The Service and its original content, features, and functionality are owned by TallyMarks Consulting and are protected by international copyright, trademark, and other intellectual property laws.</p>

  <h2>Limitation of Liability</h2>
  <p>The Service is provided "as is" without warranties of any kind. TallyMarks Consulting shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of the Service.</p>

  <h2>Termination</h2>
  <p>We may terminate or suspend your access to the Service at any time, without notice, for conduct that we believe violates these Terms or is harmful to other users, us, or third parties. You may terminate your account at any time by revoking access through your Google Account settings.</p>

  <h2>Changes to Terms</h2>
  <p>We reserve the right to modify these Terms at any time. We will notify users of significant changes. Continued use of the Service after changes constitutes acceptance of the new Terms.</p>

  <h2>Contact Us</h2>
  <p>If you have questions about these Terms, please contact us at <a href="mailto:support@tmcltd.com">support@tmcltd.com</a>.</p>

  <div class="footer">
    <p>&copy; 2026 TallyMarks Consulting. All rights reserved.</p>
  </div>
</body>
</html>`);
});

export default router;
