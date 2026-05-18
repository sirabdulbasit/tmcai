import prisma from '../db/prisma';
import { getCachedSections, getDataLastUpdated } from './indexCacheService';
import { buildSystemPrompt } from './promptService';
import { streamGemini } from './geminiService';
import { sendEmail } from './emailService';
import { getUserProfile } from './userProfileService';

/**
 * Morning Briefing — generates a personalized daily summary for each user.
 * Runs via scheduled task (cron: 0 8 * * 1-5 = weekdays 8am).
 *
 * Includes:
 * - Overnight data changes (if detectable)
 * - Key metrics summary
 * - Items needing attention based on user's role
 * - Upcoming deadlines
 */

export async function generateBriefing(userId: number): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return '';

  const profile = await getUserProfile(userId);
  const sections = getCachedSections();
  const dataUpdated = getDataLastUpdated();

  // Build a concise context from the most relevant sections
  const contextParts = sections.slice(0, 3).map(s => s.body).join('\n\n');
  const context = contextParts.slice(0, 30000);

  let profileBlock = '';
  if (profile?.jobDescription) profileBlock += `User role: ${profile.jobDescription}\n`;
  if (profile?.instructions) profileBlock += `Instructions: ${profile.instructions}\n`;
  if (profile?.preferredTitle) profileBlock += `Address the user as: ${profile.preferredTitle}\n`;

  const prompt = profileBlock +
    'Generate a concise MORNING BRIEFING for this user. Include:\n' +
    '1. Key numbers: total active projects, projects at risk, deals in pipeline\n' +
    '2. Items needing attention: overdue projects, critical risks, stalled deals\n' +
    '3. Quick wins: projects near completion, deals about to close\n' +
    'Keep it to 10-15 bullet points max. Be specific with numbers and names.\n' +
    'Format as clean HTML for email (no markdown).\n\n' +
    buildSystemPrompt(context, dataUpdated);

  let result = '';
  await streamGemini(prompt, 'Generate my morning briefing', (chunk) => { result += chunk; }, true);

  return result;
}

export async function sendMorningBriefing(userId: number): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  try {
    const briefing = await generateBriefing(userId);
    if (!briefing) return;

    const now = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    await sendEmail(user.email, `Your Morning Briefing — ${now}`, `
      <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #cc6b4a; font-size: 22px;">Good Morning, ${user.name.split(' ')[0]}!</h1>
        <p style="color: #888; font-size: 13px;">Here's your daily briefing for ${now}</p>
        <hr style="border: 1px solid #eee; margin: 16px 0;">
        <div style="line-height: 1.8; color: #333; font-size: 14px;">${briefing}</div>
        <hr style="border: 1px solid #eee; margin: 16px 0;">
        <p style="color: #999; font-size: 11px;">This is your automated morning briefing. Manage your settings in TMC AI.</p>
      </div>
    `);

    console.log(`[Briefing] Sent to ${user.email}`);
  } catch (err: any) {
    console.error(`[Briefing] Failed for ${user.email}:`, err.message);
  }
}
